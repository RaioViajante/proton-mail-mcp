import type { CopyResponseObject, ImapFlow } from 'imapflow';
import { assertBatchSize, dedupeUids } from './batch.js';
import { fetchExistingUids } from './existence.js';
import {
  fetchPreservableFlags,
  flagsMissing,
  flagsUnexpected,
  preservableFlagsOf,
  type PreservableFlag,
} from './flags.js';
import {
  listLabelFolders,
  resolveLabelMembership,
  toSortedLabelNames,
} from './label-membership.js';
import { assertFolderExists, assertTrashSourceAllowed, resolveSpecialFolders } from './policy.js';
import { createMutationResult, type MutationResult } from './result.js';
import { buildTransition, reconcileResultingUid } from './transitions.js';
import { classifyUncertainMove } from './uncertain-move.js';

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

/**
 * Per-message flag state around a Trash move (0.4.1). `mail_trash` never
 * repairs a flag divergence itself — see `mutations/restore.ts` for the
 * tool that does — this only measures it, the same "report, never assume"
 * posture `labelImpacts` already takes for labels.
 */
export interface TrashFlagImpact {
  uid: number;
  originalFlags: PreservableFlag[];
  flagsAfterTrash?: PreservableFlag[];
  flagsRemovedByTrash?: PreservableFlag[];
  flagsAddedByTrash?: PreservableFlag[];
}

export interface TrashResult extends MutationResult {
  labelImpacts: TrashLabelImpact[];
  flagImpacts: TrashFlagImpact[];
  /**
   * True once this call could not prove, via safe read-only checks, whether
   * a UID whose `messageMove` call threw actually moved or not (see
   * `mutations/uncertain-move.ts`). Never set from a clean success or a
   * clean, confirmed failure.
   */
  requiresRefresh?: boolean;
}

interface ResolvedMessage {
  uid: number;
  messageId: string | undefined;
  flags: PreservableFlag[];
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
      { uid: true, envelope: true, flags: true },
      { uid: true },
    )) {
      if (requested.has(message.uid)) {
        resolved.push({
          uid: message.uid,
          messageId: message.envelope?.messageId,
          flags: preservableFlagsOf(message.flags),
        });
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
 * see `mutations/label-membership.ts`. As of 0.4.1 it also measures the
 * message's preservable flags (`\Seen`, `\Flagged`) the same way, and never
 * assumes a `messageMove` failure is clean if the connection may have
 * dropped after the command reached the server — see
 * `mutations/uncertain-move.ts`.
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
  const delimiter = folders[0]?.delimiter ?? '/';
  assertTrashSourceAllowed(sourceFolder, delimiter);
  assertFolderExists(folders, sourceFolder, 'source folder');

  const result = createMutationResult('mail_trash', dryRun, uids) as TrashResult;
  result.labelImpacts = [];
  result.flagImpacts = [];

  const resolved = await resolveSourceMessages(client, sourceFolder, deduped);
  const resolvedSet = new Set(resolved.map((message) => message.uid));
  result.matchedUids = deduped.filter((uid) => resolvedSet.has(uid));
  result.missingUids = deduped.filter((uid) => !resolvedSet.has(uid));

  if (result.matchedUids.length === 0) {
    return result;
  }

  const labelFolders = listLabelFolders(folders, delimiter);
  const messageIdByUid = new Map(resolved.map((message) => [message.uid, message.messageId]));
  const flagsByUid = new Map(resolved.map((message) => [message.uid, message.flags]));

  // Captured before any mutation: what labels/flags each matched message
  // currently carries. Read-only (SEARCH/FETCH only) — never a write, so
  // this runs unconditionally, dry-run or live.
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
    result.flagImpacts.push({ uid, originalFlags: flagsByUid.get(uid) ?? [] });
  }

  if (dryRun) {
    return result;
  }

  let moveResponse: CopyResponseObject | false | undefined;
  let uncertainUids: number[] = [];
  let threwException = false;

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
      result.flagImpacts = result.flagImpacts.filter((impact) => !staleSet.has(impact.uid));
    }

    if (result.matchedUids.length === 0) {
      return result;
    }

    try {
      moveResponse = await client.messageMove(result.matchedUids, special.trash, { uid: true });
    } catch (error) {
      // The command may have reached the server before the connection or
      // response was lost — never assume a clean failure here (see
      // mutations/uncertain-move.ts).
      threwException = true;
      const classification = await classifyUncertainMove(
        client,
        sourceFolder,
        special.trash,
        result.matchedUids.map((uid) => ({ uid, messageId: messageIdByUid.get(uid) })),
      );
      uncertainUids = classification.uncertain;
      result.changedUids = classification.moved;
      for (const uid of classification.notMoved) {
        result.errors.push({
          uid,
          message: error instanceof Error ? error.message : 'Unknown IMAP error.',
        });
      }
      for (const uid of classification.uncertain) {
        result.errors.push({
          uid,
          message:
            'The move command failed or the connection dropped, and it could not be confirmed ' +
            'read-only whether the message actually moved. Re-check with mail_search before ' +
            'retrying — this was not retried automatically.',
        });
      }
      moveResponse = undefined;
    }
    if (moveResponse) {
      result.changedUids = [...result.matchedUids];
    } else if (!threwException) {
      for (const uid of result.matchedUids) {
        result.errors.push({ uid, message: 'IMAP server rejected the move to Trash.' });
      }
    }
  } finally {
    writeLock.release();
  }

  if (uncertainUids.length > 0) {
    result.requiresRefresh = true;
  }

  if (result.changedUids.length === 0) {
    return result;
  }

  // Resolve post-move UID transitions (server UIDPLUS mapping, verified,
  // then Message-ID correlation — never a guess; see transitions.ts), and
  // re-measure label/flag state for exactly the messages that actually
  // moved, so the impact fields reflect what really happened, not a
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
    const labelImpact = result.labelImpacts.find((entry) => entry.uid === uid);
    if (labelImpact) {
      const afterPaths = messageId
        ? (afterMembership.get(messageId) ?? new Set<string>())
        : new Set<string>();
      const afterNames = toSortedLabelNames(afterPaths, delimiter);
      const afterSet = new Set(afterNames);
      labelImpact.labelsAfterTrash = afterNames;
      labelImpact.labelsRemovedByTrash = labelImpact.originalLabels.filter(
        (label) => !afterSet.has(label),
      );
    }

    // Flags are a property of one specific mailbox/UID pair — unlike label
    // membership (Message-ID correlation alone), verifying them needs a
    // confirmed resultingUid in Trash. An unconfirmed destination identity
    // means this project cannot safely fetch (or, in mail_restore_from_trash,
    // repair) that message's flags — never guessed.
    const flagImpact = result.flagImpacts.find((entry) => entry.uid === uid);
    if (flagImpact && resultingUid !== undefined) {
      const fetched = await fetchPreservableFlags(client, special.trash, resultingUid);
      if (fetched !== undefined) {
        flagImpact.flagsAfterTrash = fetched;
        flagImpact.flagsRemovedByTrash = flagsMissing(flagImpact.originalFlags, fetched);
        flagImpact.flagsAddedByTrash = flagsUnexpected(flagImpact.originalFlags, fetched);
      }
    }
  }
  result.transitions = transitions;

  return result;
}
