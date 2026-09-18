import type { ImapFlow } from 'imapflow';
import { assertBatchSize, dedupeUids } from './batch.js';
import { mutationFailureMessage } from './error.js';
import { fetchExistingUids } from './existence.js';
import { assertFolderExists } from './policy.js';
import { createMutationResult, type MutationResult } from './result.js';

export interface ReadStateParams {
  folder: string;
  uids: number[];
  dryRun: boolean;
}

interface ExistingState {
  uid: number;
  seen: boolean;
}

/**
 * Resolution phase, shared by mark-read and mark-unread: opens the mailbox
 * **read-only**, checks which requested UIDs exist and their current
 * `\Seen` state. Runs unconditionally, including when dryRun is true — a
 * dry-run must still resolve everything, it just never opens a write lock.
 */
async function resolveExisting(
  client: ImapFlow,
  folder: string,
  uids: readonly number[],
): Promise<ExistingState[]> {
  // Defense in depth: never trust the server/transport to have honored the
  // requested UID range verbatim — filter the fetch response down to
  // exactly the requested set ourselves, so the selection can never expand.
  const requested = new Set(uids);
  const lock = await client.getMailboxLock(folder, { readOnly: true });
  try {
    const found: ExistingState[] = [];
    for await (const message of client.fetch(
      [...uids],
      { uid: true, flags: true },
      { uid: true },
    )) {
      if (requested.has(message.uid)) {
        found.push({ uid: message.uid, seen: message.flags?.has('\\Seen') ?? false });
      }
    }
    return found;
  } finally {
    lock.release();
  }
}

async function setReadState(
  client: ImapFlow,
  { folder, uids, dryRun }: ReadStateParams,
  operation: 'mail_mark_read' | 'mail_mark_unread',
  desiredSeen: boolean,
): Promise<MutationResult> {
  const deduped = dedupeUids(uids);
  assertBatchSize(deduped);

  const folders = await client.list();
  assertFolderExists(folders, folder);

  const result = createMutationResult(operation, dryRun, uids);

  const existing = await resolveExisting(client, folder, deduped);
  const existingUids = new Set(existing.map((entry) => entry.uid));
  result.matchedUids = existing.map((entry) => entry.uid);
  result.missingUids = deduped.filter((uid) => !existingUids.has(uid));

  const toChange = existing.filter((entry) => entry.seen !== desiredSeen).map((entry) => entry.uid);
  result.skippedUids = existing
    .filter((entry) => entry.seen === desiredSeen)
    .map((entry) => entry.uid);

  if (dryRun || toChange.length === 0) {
    return result;
  }

  const lock = await client.getMailboxLock(folder, { readOnly: false });
  try {
    // Revalidate immediately after acquiring the write lock: a UID resolved
    // moments ago under the read-only lock may have been moved/deleted by
    // another client in the gap between the two locks. Never mutate a UID
    // we haven't just re-confirmed exists — the selection can shrink here,
    // never grow.
    const stillPresent = await fetchExistingUids(client, toChange);
    const staleUids = toChange.filter((uid) => !stillPresent.has(uid));
    const finalTargets = toChange.filter((uid) => stillPresent.has(uid));
    if (staleUids.length > 0) {
      const staleSet = new Set(staleUids);
      result.matchedUids = result.matchedUids.filter((uid) => !staleSet.has(uid));
      result.missingUids = [...result.missingUids, ...staleUids];
    }

    if (finalTargets.length === 0) {
      return result;
    }

    const flagMethod = desiredSeen
      ? client.messageFlagsAdd.bind(client)
      : client.messageFlagsRemove.bind(client);
    const ok = await flagMethod(finalTargets, ['\\Seen'], { uid: true });
    if (ok) {
      result.changedUids = finalTargets;
    } else {
      for (const uid of finalTargets) {
        result.errors.push({ uid, message: 'IMAP server rejected the flag change.' });
      }
    }
  } catch {
    for (const uid of toChange) {
      result.errors.push({
        uid,
        message: mutationFailureMessage('mailboxOperationFailed'),
      });
    }
  } finally {
    lock.release();
  }

  return result;
}

export function markRead(client: ImapFlow, params: ReadStateParams): Promise<MutationResult> {
  return setReadState(client, params, 'mail_mark_read', true);
}

export function markUnread(client: ImapFlow, params: ReadStateParams): Promise<MutationResult> {
  return setReadState(client, params, 'mail_mark_unread', false);
}
