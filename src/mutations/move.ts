import type { CopyResponseObject, ImapFlow, ListResponse } from 'imapflow';
import { assertBatchSize, dedupeUids } from './batch.js';
import { fetchExistingMessages, fetchExistingUids } from './existence.js';
import { mutationFailureMessage } from './error.js';
import {
  assertFolderExists,
  assertMoveDestinationAllowed,
  resolveMoveDestination,
  resolveSpecialFolders,
} from './policy.js';
import { createMutationResult, type MutationResult } from './result.js';
import { buildTransition, reconcileResultingUid } from './transitions.js';

export interface MoveParams {
  sourceFolder: string;
  destinationFolder: string;
  uids: number[];
  dryRun: boolean;
}

/**
 * Core move mechanics shared by mail_move, mail_archive, and mail_mark_spam.
 * Deliberately does NOT enforce the generic protected-destination policy —
 * callers with a fixed, pre-vetted destination (Archive, Spam) apply their
 * own narrower guards instead. Only the free-form {@link moveMessages} below
 * (used by mail_move) applies the full policy.
 */
export async function moveMessagesCore(
  client: ImapFlow,
  { sourceFolder, destinationFolder, uids, dryRun }: MoveParams,
  operation: string,
  folders: readonly ListResponse[],
): Promise<MutationResult> {
  const deduped = dedupeUids(uids);
  assertBatchSize(deduped);

  if (sourceFolder === destinationFolder) {
    throw new Error('Source and destination folders must be different.');
  }

  assertFolderExists(folders, sourceFolder, 'source folder');
  assertFolderExists(folders, destinationFolder, 'destination folder');

  const result = createMutationResult(operation, dryRun, uids);

  const readLock = await client.getMailboxLock(sourceFolder, { readOnly: true });
  let resolved: Awaited<ReturnType<typeof fetchExistingMessages>>;
  try {
    resolved = await fetchExistingMessages(client, deduped);
  } finally {
    readLock.release();
  }
  const resolvedSet = new Set(resolved.map((message) => message.uid));
  result.matchedUids = deduped.filter((uid) => resolvedSet.has(uid));
  result.missingUids = deduped.filter((uid) => !resolvedSet.has(uid));

  if (dryRun || result.matchedUids.length === 0) {
    return result;
  }

  // Captured from resolution, for the Message-ID fallback in transition
  // reconciliation below (used only if the server has no UIDPLUS mapping).
  const messageIdByUid = new Map(resolved.map((message) => [message.uid, message.messageId]));
  let moveResponse: CopyResponseObject | false | undefined;

  const writeLock = await client.getMailboxLock(sourceFolder, { readOnly: false });
  try {
    // Revalidate immediately after acquiring the write lock: a UID resolved
    // moments ago under the read-only lock may have been moved, deleted, or
    // expunged by another client in the gap between the two locks. Never
    // mutate a UID we haven't just re-confirmed exists — the selection can
    // shrink here, never grow.
    const stillPresent = await fetchExistingUids(client, result.matchedUids);
    const staleUids = result.matchedUids.filter((uid) => !stillPresent.has(uid));
    if (staleUids.length > 0) {
      result.matchedUids = result.matchedUids.filter((uid) => stillPresent.has(uid));
      result.missingUids = [...result.missingUids, ...staleUids];
    }

    if (result.matchedUids.length === 0) {
      return result;
    }

    moveResponse = await client.messageMove(result.matchedUids, destinationFolder, {
      uid: true,
    });
    if (moveResponse) {
      result.changedUids = [...result.matchedUids];
    } else {
      for (const uid of result.matchedUids) {
        result.errors.push({ uid, message: 'IMAP server rejected the move.' });
      }
    }
  } catch {
    for (const uid of result.matchedUids) {
      result.errors.push({
        uid,
        message: mutationFailureMessage('mailboxOperationFailed'),
      });
    }
  } finally {
    writeLock.release();
  }

  // IMAP UIDs are mailbox-local: the moved message's UID in
  // destinationFolder is not requestedUid, and confirmed live it is often
  // different even for a simple two-folder move. Resolve it via the
  // server's own UIDPLUS mapping first, Message-ID correlation second,
  // never a guess — see mutations/transitions.ts. Runs after the write
  // lock on sourceFolder is released, since resolving in destinationFolder
  // needs its own lock on this same connection.
  if (result.changedUids.length > 0) {
    const uidMap = moveResponse ? moveResponse.uidMap : undefined;
    const transitions = [];
    for (const uid of result.changedUids) {
      const resultingUid = await reconcileResultingUid(
        client,
        destinationFolder,
        uid,
        uidMap,
        messageIdByUid.get(uid),
      );
      transitions.push(buildTransition(uid, sourceFolder, destinationFolder, false, resultingUid));
    }
    result.transitions = transitions;
  }

  return result;
}

/**
 * Free-form move used by mail_move: resolves the folder list once,
 * normalizes `destinationFolder` (a bare custom-folder name like
 * `"MCP Test"`, an already-qualified `"Folders/MCP Test"` path, or a
 * literal system folder name like `"Archive"` are all accepted — see
 * {@link resolveMoveDestination}), and enforces the full
 * protected-destination policy (no Trash, no Spam via this tool, no
 * Sent/Drafts/All Mail, no bare namespace container) before ever touching
 * IMAP.
 */
export async function moveMessages(client: ImapFlow, params: MoveParams): Promise<MutationResult> {
  const folders = await client.list();
  const special = resolveSpecialFolders(folders);
  const delimiter = folders[0]?.delimiter ?? '/';
  const destinationFolder = resolveMoveDestination(special, params.destinationFolder, delimiter);
  assertMoveDestinationAllowed(special, destinationFolder);
  return moveMessagesCore(client, { ...params, destinationFolder }, 'mail_move', folders);
}
