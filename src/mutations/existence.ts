import type { ImapFlow } from 'imapflow';

/**
 * Checks which of `uids` still exist in the CURRENTLY OPEN mailbox. Must be
 * called while a lock (read-only or read-write) is already held for that
 * mailbox — this opens no lock of its own. Filters the fetch response down
 * to exactly the requested set, never trusting the transport to have
 * honored the requested UID range verbatim.
 *
 * Used both for the initial read-only resolution and — this is the part
 * that matters for correctness — again immediately after a mutation
 * function acquires its write lock, to catch a UID that was moved/deleted
 * by something else in the gap between the two locks. See each
 * mutations/*.ts module's write phase for how the result of a stale re-check
 * is folded back into matchedUids/missingUids.
 */
export async function fetchExistingUids(
  client: ImapFlow,
  uids: readonly number[],
): Promise<Set<number>> {
  if (uids.length === 0) {
    return new Set();
  }
  const requested = new Set(uids);
  const found = new Set<number>();
  for await (const message of client.fetch([...uids], { uid: true }, { uid: true })) {
    if (requested.has(message.uid)) {
      found.add(message.uid);
    }
  }
  return found;
}

export interface ExistingMessage {
  uid: number;
  messageId: string | undefined;
}

/**
 * Same purpose as {@link fetchExistingUids}, plus each message's
 * `Message-ID` header — needed by callers that may later have to reconcile
 * which UID a message ends up with in a different mailbox (see
 * `mutations/transitions.ts`). Only used for the initial read-only
 * resolution, where that header is worth the extra fetch cost; the
 * write-lock revalidation pass reuses the cheaper `fetchExistingUids`.
 */
export async function fetchExistingMessages(
  client: ImapFlow,
  uids: readonly number[],
): Promise<ExistingMessage[]> {
  if (uids.length === 0) {
    return [];
  }
  const requested = new Set(uids);
  const found: ExistingMessage[] = [];
  for await (const message of client.fetch(
    [...uids],
    { uid: true, envelope: true },
    { uid: true },
  )) {
    if (requested.has(message.uid)) {
      found.push({ uid: message.uid, messageId: message.envelope?.messageId });
    }
  }
  return found;
}
