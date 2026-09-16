import type { CopyResponseObject, ImapFlow } from 'imapflow';
import { assertBatchSize, dedupeUids } from './batch.js';
import { fetchExistingUids } from './existence.js';
import { assertFolderExists } from './policy.js';
import { createMutationResult, type MutationResult } from './result.js';
import { buildTransition, reconcileResultingUid } from './transitions.js';

export interface LabelParams {
  folder: string;
  label: string;
  uids: number[];
  dryRun: boolean;
}

export function labelPath(label: string): string {
  return `Labels/${label}`;
}

interface ResolvedMessage {
  uid: number;
  messageId: string | undefined;
}

async function resolveMessages(
  client: ImapFlow,
  folder: string,
  uids: readonly number[],
): Promise<ResolvedMessage[]> {
  // Defense in depth: filter the fetch response down to exactly the
  // requested set ourselves — never trust the transport to have honored the
  // requested UID range verbatim.
  const requested = new Set(uids);
  const lock = await client.getMailboxLock(folder, { readOnly: true });
  try {
    const resolved: ResolvedMessage[] = [];
    for await (const message of client.fetch(
      [...uids],
      { uid: true, envelope: true },
      { uid: true },
    )) {
      if (requested.has(message.uid)) {
        resolved.push({ uid: message.uid, messageId: message.envelope?.messageId });
      }
    }
    return resolved;
  } finally {
    lock.release();
  }
}

/**
 * Looks up the UID a message (identified by its Message-ID header) has
 * within `Labels/<label>`, if it currently carries that label. Label
 * mailboxes assign their own UIDs independent of the source folder, so
 * Message-ID correlation is the only reliable way to find "the same
 * message" across two mailboxes.
 */
async function findInLabelMailbox(
  client: ImapFlow,
  label: string,
  messageId: string | undefined,
): Promise<number | undefined> {
  if (!messageId) {
    return undefined;
  }
  const lock = await client.getMailboxLock(labelPath(label), { readOnly: true });
  try {
    const uids = await client.search({ header: { 'message-id': messageId } }, { uid: true });
    return uids && uids.length > 0 ? uids[0] : undefined;
  } finally {
    lock.release();
  }
}

/**
 * Applies a Proton label to messages by moving them into `Labels/<label>`.
 *
 * ## Bridge behavior this relies on — live-confirmed
 *
 * Per Proton's own documentation (proton.me/support/labels-in-bridge,
 * fetched 2026-09-16) and a live test against this project's own account:
 * moving a message into a Labels/ mailbox is special-cased by Bridge to
 * APPLY the label rather than relocate the message — the message stays in
 * its original folder (`folder`, same UID there — see
 * `originalUidStillValid: true` on the returned transition) *and* a
 * representation appears in `Labels/<label>`, generally under a different,
 * mailbox-local UID. This module implements exactly that mechanism (IMAP
 * MOVE into `Labels/<label>`), and skips messages Message-ID-correlated as
 * already labeled.
 */
export async function applyLabel(
  client: ImapFlow,
  { folder, label, uids, dryRun }: LabelParams,
): Promise<MutationResult> {
  const deduped = dedupeUids(uids);
  assertBatchSize(deduped);

  const folders = await client.list();
  assertFolderExists(folders, folder, 'source folder');
  assertFolderExists(folders, labelPath(label), 'label');

  const result = createMutationResult('mail_apply_label', dryRun, uids);

  const resolved = await resolveMessages(client, folder, deduped);
  const resolvedSet = new Set(resolved.map((message) => message.uid));
  result.matchedUids = resolved.map((message) => message.uid);
  result.missingUids = deduped.filter((uid) => !resolvedSet.has(uid));

  const toApply: ResolvedMessage[] = [];
  for (const message of resolved) {
    const existingUid = await findInLabelMailbox(client, label, message.messageId);
    if (existingUid !== undefined) {
      result.skippedUids.push(message.uid);
    } else {
      toApply.push(message);
    }
  }

  if (dryRun || toApply.length === 0) {
    return result;
  }

  // Revalidate label membership immediately before executing: this mailbox
  // (Labels/<label>) is not the one whose write lock we hold below, so — per
  // "revalidate at every mailbox involved" — it gets its own fresh check
  // here instead, catching a label applied to one of these messages by
  // something else since the resolution pass above.
  const stillUnlabeled: ResolvedMessage[] = [];
  for (const message of toApply) {
    const existingUid = await findInLabelMailbox(client, label, message.messageId);
    if (existingUid !== undefined) {
      result.skippedUids.push(message.uid);
    } else {
      stillUnlabeled.push(message);
    }
  }

  if (stillUnlabeled.length === 0) {
    return result;
  }

  const messageIdByUid = new Map(resolved.map((message) => [message.uid, message.messageId]));
  let moveResponse: CopyResponseObject | false | undefined;

  const lock = await client.getMailboxLock(folder, { readOnly: false });
  try {
    // Revalidate immediately after acquiring the write lock: a UID resolved
    // moments ago may have been moved/deleted from `folder` by another
    // client in the gap between the two locks. Never mutate a UID we
    // haven't just re-confirmed exists — the selection can shrink here,
    // never grow.
    const candidateUids = stillUnlabeled.map((message) => message.uid);
    const stillPresent = await fetchExistingUids(client, candidateUids);
    const staleUids = candidateUids.filter((uid) => !stillPresent.has(uid));
    const finalTargets = candidateUids.filter((uid) => stillPresent.has(uid));
    if (staleUids.length > 0) {
      const staleSet = new Set(staleUids);
      result.matchedUids = result.matchedUids.filter((uid) => !staleSet.has(uid));
      result.missingUids = [...result.missingUids, ...staleUids];
    }

    if (finalTargets.length === 0) {
      return result;
    }

    moveResponse = await client.messageMove(finalTargets, labelPath(label), { uid: true });
    if (moveResponse) {
      result.changedUids = finalTargets;
    } else {
      for (const uid of finalTargets) {
        result.errors.push({ uid, message: 'IMAP server rejected applying the label.' });
      }
    }
  } catch (error) {
    for (const message of stillUnlabeled) {
      result.errors.push({
        uid: message.uid,
        message: error instanceof Error ? error.message : 'Unknown IMAP error.',
      });
    }
  } finally {
    lock.release();
  }

  // The original folder UID stays valid (confirmed live) — this transition
  // is purely informational about the *additional* identity the message
  // now has in Labels/<label>. Resolved via the server's UIDPLUS mapping
  // first, Message-ID correlation second, never a guess.
  if (result.changedUids.length > 0) {
    const uidMap = moveResponse ? moveResponse.uidMap : undefined;
    const transitions = [];
    for (const uid of result.changedUids) {
      const resultingUid = await reconcileResultingUid(
        client,
        labelPath(label),
        uid,
        uidMap,
        messageIdByUid.get(uid),
      );
      transitions.push(buildTransition(uid, folder, labelPath(label), true, resultingUid));
    }
    result.transitions = transitions;
  }

  return result;
}

/**
 * Removes a Proton label by moving the corresponding message (found by
 * Message-ID correlation) out of `Labels/<label>` back into `folder`.
 *
 * Per the same Proton documentation cited in {@link applyLabel}: "If you
 * open the label folder ... and move the message into a folder such as
 * Inbox or Archive, the label will be removed." Live-confirmed, with one
 * important nuance beyond what the documentation states: unlike
 * `applyLabel`, **the original folder UID is NOT guaranteed to stay
 * valid** — a live test observed a message move from `INBOX` UID 705 back
 * to `INBOX` UID 706 after label removal (no duplication, no data loss, no
 * flag change — just a new UID in the same folder). Callers must treat
 * `requestedUid` as invalid after this operation and use the returned
 * transition's `resultingUid` (or `requiresRefresh`) instead — see
 * README.md ("IMAP UID semantics").
 */
export async function removeLabel(
  client: ImapFlow,
  { folder, label, uids, dryRun }: LabelParams,
): Promise<MutationResult> {
  const deduped = dedupeUids(uids);
  assertBatchSize(deduped);

  const folders = await client.list();
  assertFolderExists(folders, folder, 'source folder');
  assertFolderExists(folders, labelPath(label), 'label');

  const result = createMutationResult('mail_remove_label', dryRun, uids);

  const resolved = await resolveMessages(client, folder, deduped);
  const resolvedSet = new Set(resolved.map((message) => message.uid));
  result.matchedUids = resolved.map((message) => message.uid);
  result.missingUids = deduped.filter((uid) => !resolvedSet.has(uid));

  const targets: Array<{ sourceUid: number; labelUid: number }> = [];
  for (const message of resolved) {
    const labelUid = await findInLabelMailbox(client, label, message.messageId);
    if (labelUid === undefined) {
      result.skippedUids.push(message.uid);
    } else {
      targets.push({ sourceUid: message.uid, labelUid });
    }
  }

  if (dryRun || targets.length === 0) {
    return result;
  }

  const messageIdBySourceUid = new Map(resolved.map((message) => [message.uid, message.messageId]));
  let moveResponse: CopyResponseObject | false | undefined;
  let finalTargets: Array<{ sourceUid: number; labelUid: number }> = [];

  const lock = await client.getMailboxLock(labelPath(label), { readOnly: false });
  try {
    // Revalidate immediately after acquiring the write lock on the mailbox
    // actually being written to (Labels/<label>): a labelUid resolved
    // moments ago may have been unlabeled/moved by another client in the
    // gap between the two locks. Never mutate a UID we haven't just
    // re-confirmed exists — the selection can shrink here, never grow.
    const labelUids = targets.map((target) => target.labelUid);
    const stillPresent = await fetchExistingUids(client, labelUids);
    const staleTargets = targets.filter((target) => !stillPresent.has(target.labelUid));
    finalTargets = targets.filter((target) => stillPresent.has(target.labelUid));
    if (staleTargets.length > 0) {
      const staleSourceUids = new Set(staleTargets.map((target) => target.sourceUid));
      result.matchedUids = result.matchedUids.filter((uid) => !staleSourceUids.has(uid));
      result.missingUids = [
        ...result.missingUids,
        ...staleTargets.map((target) => target.sourceUid),
      ];
    }

    if (finalTargets.length === 0) {
      return result;
    }

    const finalLabelUids = finalTargets.map((target) => target.labelUid);
    moveResponse = await client.messageMove(finalLabelUids, folder, { uid: true });
    if (moveResponse) {
      result.changedUids = finalTargets.map((target) => target.sourceUid);
    } else {
      for (const target of finalTargets) {
        result.errors.push({
          uid: target.sourceUid,
          message: 'IMAP server rejected removing the label.',
        });
      }
    }
  } catch (error) {
    for (const target of targets) {
      result.errors.push({
        uid: target.sourceUid,
        message: error instanceof Error ? error.message : 'Unknown IMAP error.',
      });
    }
  } finally {
    lock.release();
  }

  // The requestedUid (the original folder UID) is NOT guaranteed to stay
  // valid here — live-confirmed (see doc comment above). uidMap is keyed by
  // the labelUid, since that was the source side of THIS move call.
  if (result.changedUids.length > 0) {
    const uidMap = moveResponse ? moveResponse.uidMap : undefined;
    const labelUidBySourceUid = new Map(
      finalTargets.map((target) => [target.sourceUid, target.labelUid]),
    );
    const transitions = [];
    for (const sourceUid of result.changedUids) {
      const labelUid = labelUidBySourceUid.get(sourceUid);
      const resultingUid =
        labelUid === undefined
          ? undefined
          : await reconcileResultingUid(
              client,
              folder,
              labelUid,
              uidMap,
              messageIdBySourceUid.get(sourceUid),
            );
      transitions.push(buildTransition(sourceUid, labelPath(label), folder, false, resultingUid));
    }
    result.transitions = transitions;
  }

  return result;
}
