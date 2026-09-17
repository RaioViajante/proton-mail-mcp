import type { ImapFlow } from 'imapflow';
import { applyLabel, labelPath } from './labels.js';
import { moveMessagesCore } from './move.js';
import {
  assertMoveDestinationAllowed,
  resolveMoveDestination,
  resolveSpecialFolders,
} from './policy.js';
import type { MutationResult } from './result.js';

export interface RestoreParams {
  uids: number[];
  destinationFolder: string;
  labelsToRestore?: string[] | undefined;
  dryRun: boolean;
  confirm: boolean;
  acknowledgeRestoreFromTrash: boolean;
}

export interface RestoreLabelOutcome {
  /** The original Trash-side UID the caller requested this restore for. */
  uid: number;
  label: string;
}

export interface RestoreLabelFailure extends RestoreLabelOutcome {
  reason: string;
}

export interface RestoreResult extends MutationResult {
  /** Alias of `changedUids`, named for this operation's own vocabulary. */
  moveRestored: number[];
  labelsRequested?: string[];
  labelsRestored?: RestoreLabelOutcome[];
  labelsFailed?: RestoreLabelFailure[];
  /**
   * True once any part of this call (the folder move or a label reapply)
   * could not confirm the message's destination identity without guessing.
   * Absent for dry-run, since nothing executed yet to be uncertain about.
   */
  requiresRefresh?: boolean;
}

/**
 * Restores explicit UIDs from Trash into an explicit destination folder,
 * optionally reapplying labels that may have been removed by the Trash move
 * (see `mutations/trash.ts`). Reuses the same destination policy `mail_move`
 * enforces (`resolveMoveDestination` + `assertMoveDestinationAllowed`) —
 * Trash, Spam, Sent, Drafts, All Mail, and any namespace container or
 * `Labels/...` reference are all rejected as a restore destination, exactly
 * as they are for `mail_move`. Spam is rejected outright rather than given a
 * separate ad-hoc acknowledgement parameter: `mail_mark_spam` already exists
 * as the single, specifically-gated way to put a message in Spam.
 *
 * The folder move and any label reapply are two separate IMAP operations —
 * this is never presented as atomic. If the move succeeds but a label
 * reapply fails (label doesn't exist, IMAP rejects it, destination identity
 * unconfirmed), the move is never rolled back; the partial outcome is
 * reported via `labelsRestored` / `labelsFailed`, never hidden.
 */
export async function restoreFromTrash(
  client: ImapFlow,
  {
    uids,
    destinationFolder: rawDestination,
    labelsToRestore,
    dryRun,
    confirm,
    acknowledgeRestoreFromTrash,
  }: RestoreParams,
): Promise<RestoreResult> {
  if (!dryRun && (!confirm || !acknowledgeRestoreFromTrash)) {
    throw new Error(
      'confirm=true and acknowledgeRestoreFromTrash=true are both required together with ' +
        'dryRun=false for mail_restore_from_trash.',
    );
  }

  const folders = await client.list();
  const special = resolveSpecialFolders(folders);
  if (!special.trash) {
    throw new Error('Could not find a Trash folder on this account.');
  }

  const delimiter = folders[0]?.delimiter ?? '/';
  const destinationFolder = resolveMoveDestination(special, rawDestination, delimiter);
  assertMoveDestinationAllowed(special, destinationFolder);

  const moveResult = await moveMessagesCore(
    client,
    { sourceFolder: special.trash, destinationFolder, uids, dryRun },
    'mail_restore_from_trash',
    folders,
  );

  const result = moveResult as RestoreResult;
  result.moveRestored = [...result.changedUids];

  if (!dryRun && result.transitions) {
    result.requiresRefresh = result.transitions.some(
      (transition) => transition.requiresRefresh === true,
    );
  }

  const dedupedLabels = Array.from(new Set(labelsToRestore ?? []));
  if (dedupedLabels.length === 0) {
    return result;
  }

  result.labelsRequested = dedupedLabels;
  result.labelsRestored = [];
  result.labelsFailed = [];

  if (dryRun) {
    // Read-only prediction only: which requested labels currently exist as
    // mailboxes. Never calls applyLabel (which would mutate) during a
    // dry-run — see the "DRY-RUN CONTRACT" this project follows throughout.
    for (const label of dedupedLabels) {
      const exists = folders.some((folder) => folder.path === labelPath(label));
      if (!exists) {
        for (const uid of result.matchedUids) {
          result.labelsFailed.push({
            uid,
            label,
            reason: 'Label does not exist; not created automatically.',
          });
        }
      }
    }
    return result;
  }

  if (result.changedUids.length === 0) {
    for (const label of dedupedLabels) {
      for (const uid of uids) {
        result.labelsFailed.push({
          uid,
          label,
          reason: 'Message was not restored; label not applied.',
        });
      }
    }
    return result;
  }

  // Only reapply labels to messages whose destination identity was
  // confirmed without guessing (see transitions.ts) — never target a
  // resultingUid this project isn't sure about.
  const transitionByRequestedUid = new Map(
    (result.transitions ?? []).map((transition) => [transition.requestedUid, transition]),
  );
  const confirmed: Array<{ requestedUid: number; resultingUid: number }> = [];
  for (const uid of result.changedUids) {
    const transition = transitionByRequestedUid.get(uid);
    if (transition?.resultingUid !== undefined) {
      confirmed.push({ requestedUid: uid, resultingUid: transition.resultingUid });
    } else {
      result.requiresRefresh = true;
      for (const label of dedupedLabels) {
        result.labelsFailed.push({
          uid,
          label,
          reason:
            'Destination identity not confirmed (requiresRefresh); label not applied automatically.',
        });
      }
    }
  }

  if (confirmed.length === 0) {
    return result;
  }

  // Re-list immediately before reapplying: confirms each requested label
  // still exists as a mailbox right now, not from the listing fetched at the
  // top of this call. Labels are never auto-created.
  const freshFolders = await client.list();
  const resultingUidToRequestedUid = new Map(
    confirmed.map((entry) => [entry.resultingUid, entry.requestedUid]),
  );

  for (const label of dedupedLabels) {
    const labelExists = freshFolders.some((folder) => folder.path === labelPath(label));
    if (!labelExists) {
      for (const { requestedUid } of confirmed) {
        result.labelsFailed.push({
          uid: requestedUid,
          label,
          reason: 'Label does not exist; not created automatically.',
        });
      }
      continue;
    }

    try {
      const applyResult = await applyLabel(client, {
        folder: destinationFolder,
        label,
        uids: confirmed.map((entry) => entry.resultingUid),
        dryRun: false,
      });

      for (const resultingUid of [...applyResult.changedUids, ...applyResult.skippedUids]) {
        const requestedUid = resultingUidToRequestedUid.get(resultingUid);
        if (requestedUid !== undefined) {
          result.labelsRestored.push({ uid: requestedUid, label });
        }
      }
      for (const error of applyResult.errors) {
        const requestedUid = resultingUidToRequestedUid.get(error.uid);
        if (requestedUid !== undefined) {
          result.labelsFailed.push({ uid: requestedUid, label, reason: error.message });
        }
      }
      for (const missingUid of applyResult.missingUids) {
        const requestedUid = resultingUidToRequestedUid.get(missingUid);
        if (requestedUid !== undefined) {
          result.labelsFailed.push({
            uid: requestedUid,
            label,
            reason: 'Message was not found in the destination folder when applying the label.',
          });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error applying label.';
      for (const { requestedUid } of confirmed) {
        result.labelsFailed.push({ uid: requestedUid, label, reason: message });
      }
    }
  }

  return result;
}
