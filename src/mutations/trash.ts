import type { CopyResponseObject, ImapFlow } from 'imapflow';
import { assertBatchSize, dedupeUids } from './batch.js';
import { fetchExistingUids } from './existence.js';
import {
  listLabelFolders,
  resolveLabelMembership,
  toSortedLabelNames,
} from './label-membership.js';
import { assertFolderExists, resolveSpecialFolders } from './policy.js';
import { createMutationResult, type MutationResult } from './result.js';
import { buildTransition, reconcileResultingUid } from './transitions.js';

export interface TrashParams {
  sourceFolder: string;
  uids: number[];
  dryRun: boolean;
  confirm: boolean;
  acknowledgeTrashMove: boolean;
}

/**
 * Per-message label state around a Trash move. Proton may remove a
 * message's labels when it enters Trash (see README.md "Labels vs.
 * folders") — this project never assumes either way, only measures it:
 * `originalLabels` is captured before the move; `labelsAfterTrash` /
 * `labelsRemovedByTrash` are only populated once the move actually executed
 * (never during a dry-run, since nothing happened yet to remeasure). Label
 * *names* are not secrets and are safe to return; `Message-ID` — used
 * internally to correlate a message across mailboxes — never is.
 */
export interface TrashLabelImpact {
  uid: number;
  originalLabels: string[];
  labelsAfterTrash?: string[];
  labelsRemovedByTrash?: string[];
}

export interface TrashResult extends MutationResult {
  labelImpacts: TrashLabelImpact[];
}

interface ResolvedMessage {
  uid: number;
  messageId: string | undefined;
}

async function resolveSourceMessages(
  client: ImapFlow,
  folder: string,
  uids: readonly number[],
): Promise<ResolvedMessage[]> {
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
 * Moves explicit message UIDs to Trash and reports the label impact of doing
 * so. Trash is recoverable via `mail_restore_from_trash`, but is still
 * treated as a destructive operation (see `tools/trash.ts` annotations) and
 * gated the same way `mail_mark_spam` / `mail_unsubscribe` are: live
 * execution requires `confirm: true` AND `acknowledgeTrashMove: true`
 * together with `dryRun: false`, checked before any IMAP access at all.
 *
 * Mechanically this mirrors `mutations/move.ts`'s hardening (read-only
 * resolution, write-lock revalidation, UIDPLUS-verified-then-Message-ID
 * transition reconciliation) rather than reusing `moveMessagesCore`
 * directly, because this operation also needs each message's `Message-ID`
 * held across the whole call to measure label membership before and after —
 * see `mutations/label-membership.ts`.
 */
export async function trashMessages(
  client: ImapFlow,
  { sourceFolder, uids, dryRun, confirm, acknowledgeTrashMove }: TrashParams,
): Promise<TrashResult> {
  if (!dryRun && (!confirm || !acknowledgeTrashMove)) {
    throw new Error(
      'confirm=true and acknowledgeTrashMove=true are both required together with dryRun=false ' +
        'for mail_trash.',
    );
  }

  const deduped = dedupeUids(uids);
  assertBatchSize(deduped);

  const folders = await client.list();
  const special = resolveSpecialFolders(folders);
  if (!special.trash) {
    throw new Error('Could not find a Trash folder on this account.');
  }
  if (sourceFolder === special.trash) {
    throw new Error('The source folder is already Trash; there is nothing to trash.');
  }
  assertFolderExists(folders, sourceFolder, 'source folder');

  const result = createMutationResult('mail_trash', dryRun, uids) as TrashResult;
  result.labelImpacts = [];

  const resolved = await resolveSourceMessages(client, sourceFolder, deduped);
  const resolvedSet = new Set(resolved.map((message) => message.uid));
  result.matchedUids = deduped.filter((uid) => resolvedSet.has(uid));
  result.missingUids = deduped.filter((uid) => !resolvedSet.has(uid));

  if (result.matchedUids.length === 0) {
    return result;
  }

  const delimiter = folders[0]?.delimiter ?? '/';
  const labelFolders = listLabelFolders(folders, delimiter);
  const messageIdByUid = new Map(resolved.map((message) => [message.uid, message.messageId]));

  // Captured before any mutation: what labels each matched message currently
  // carries. Read-only (SEARCH only) against every Labels/<name> mailbox —
  // never a write, so this runs unconditionally, dry-run or live.
  const beforeMembership = await resolveLabelMembership(
    client,
    labelFolders,
    result.matchedUids.map((uid) => messageIdByUid.get(uid)),
  );
  for (const uid of result.matchedUids) {
    const messageId = messageIdByUid.get(uid);
    const paths = messageId
      ? (beforeMembership.get(messageId) ?? new Set<string>())
      : new Set<string>();
    result.labelImpacts.push({ uid, originalLabels: toSortedLabelNames(paths, delimiter) });
  }

  if (dryRun) {
    return result;
  }

  let moveResponse: CopyResponseObject | false | undefined;

  const writeLock = await client.getMailboxLock(sourceFolder, { readOnly: false });
  try {
    // Revalidate immediately after acquiring the write lock — see
    // mutations/move.ts for why: a UID resolved under the read-only lock may
    // have been moved/deleted by another client in the gap. Selection can
    // only shrink here, never grow.
    const stillPresent = await fetchExistingUids(client, result.matchedUids);
    const staleUids = result.matchedUids.filter((uid) => !stillPresent.has(uid));
    if (staleUids.length > 0) {
      result.matchedUids = result.matchedUids.filter((uid) => stillPresent.has(uid));
      result.missingUids = [...result.missingUids, ...staleUids];
      const staleSet = new Set(staleUids);
      result.labelImpacts = result.labelImpacts.filter((impact) => !staleSet.has(impact.uid));
    }

    if (result.matchedUids.length === 0) {
      return result;
    }

    moveResponse = await client.messageMove(result.matchedUids, special.trash, { uid: true });
    if (moveResponse) {
      result.changedUids = [...result.matchedUids];
    } else {
      for (const uid of result.matchedUids) {
        result.errors.push({ uid, message: 'IMAP server rejected the move to Trash.' });
      }
    }
  } catch (error) {
    for (const uid of result.matchedUids) {
      result.errors.push({
        uid,
        message: error instanceof Error ? error.message : 'Unknown IMAP error.',
      });
    }
  } finally {
    writeLock.release();
  }

  if (result.changedUids.length === 0) {
    return result;
  }

  // Resolve post-move UID transitions (server UIDPLUS mapping, verified,
  // then Message-ID correlation — never a guess; see transitions.ts), and
  // re-measure label membership for exactly the messages that actually
  // moved, so `labelsRemovedByTrash` reflects what really happened, not a
  // prediction.
  const uidMap = moveResponse ? moveResponse.uidMap : undefined;
  const afterMembership = await resolveLabelMembership(
    client,
    labelFolders,
    result.changedUids.map((uid) => messageIdByUid.get(uid)),
  );

  const transitions = [];
  for (const uid of result.changedUids) {
    const resultingUid = await reconcileResultingUid(
      client,
      special.trash,
      uid,
      uidMap,
      messageIdByUid.get(uid),
    );
    transitions.push(buildTransition(uid, sourceFolder, special.trash, false, resultingUid));

    const messageId = messageIdByUid.get(uid);
    const impact = result.labelImpacts.find((entry) => entry.uid === uid);
    if (impact) {
      const afterPaths = messageId
        ? (afterMembership.get(messageId) ?? new Set<string>())
        : new Set<string>();
      const afterNames = toSortedLabelNames(afterPaths, delimiter);
      const afterSet = new Set(afterNames);
      impact.labelsAfterTrash = afterNames;
      impact.labelsRemovedByTrash = impact.originalLabels.filter((label) => !afterSet.has(label));
    }
  }
  result.transitions = transitions;

  return result;
}
