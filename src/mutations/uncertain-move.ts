import type { ImapFlow } from 'imapflow';

/**
 * A candidate whose `messageMove` call threw — the connection may have
 * dropped, or the response may have been lost, at any point relative to the
 * server actually processing the command. This project must never guess
 * which: a thrown `messageMove` used to be treated as a clean failure
 * everywhere (mark every UID in the batch as errored, nothing changed) —
 * live-observed 0.4.0 behavior this hardens, since the command could just as
 * easily have already succeeded server-side before the transport failed.
 */
export interface UncertainMoveCandidate {
  uid: number;
  messageId: string | undefined;
}

export interface UncertainMoveClassification {
  /** Confirmed via Message-ID: absent from source, present exactly once in destination. Safe to treat as moved. */
  moved: number[];
  /** Confirmed via Message-ID: still present in source. Safe to treat as never moved — no double-move risk. */
  notMoved: number[];
  /** Neither could be proven. Never guessed either way; never retried automatically. */
  uncertain: number[];
}

/**
 * Read-only-only reconciliation for a batch of UIDs after their
 * `messageMove` call threw. Never issues another `messageMove` (no
 * double-move risk) and never rolls anything back — this only answers "what
 * actually happened", via the same Message-ID correlation primitive
 * `mutations/transitions.ts` already uses for the happy path, never
 * subject/sender/position.
 *
 * A candidate with no `messageId` (envelope fetch failed to resolve one) is
 * unconditionally `uncertain` — there is nothing safe to correlate on. Any
 * exception during the read-only checks themselves (the connection is still
 * down) also lands every remaining candidate in `uncertain` rather than
 * letting a partial read masquerade as a full answer.
 */
export async function classifyUncertainMove(
  client: ImapFlow,
  sourceFolder: string,
  destinationFolder: string,
  candidates: readonly UncertainMoveCandidate[],
): Promise<UncertainMoveClassification> {
  const result: UncertainMoveClassification = { moved: [], notMoved: [], uncertain: [] };
  const withMessageId = candidates.filter(
    (candidate): candidate is UncertainMoveCandidate & { messageId: string } =>
      Boolean(candidate.messageId),
  );
  for (const candidate of candidates) {
    if (!candidate.messageId) {
      result.uncertain.push(candidate.uid);
    }
  }
  if (withMessageId.length === 0) {
    return result;
  }

  let stillInSource: Map<string, boolean>;
  try {
    const lock = await client.getMailboxLock(sourceFolder, { readOnly: true });
    try {
      stillInSource = new Map();
      for (const candidate of withMessageId) {
        const uids = await client.search(
          { header: { 'message-id': candidate.messageId } },
          { uid: true },
        );
        stillInSource.set(candidate.messageId, Boolean(uids && uids.length > 0));
      }
    } finally {
      lock.release();
    }
  } catch {
    for (const candidate of withMessageId) {
      result.uncertain.push(candidate.uid);
    }
    return result;
  }

  const needsDestinationCheck = withMessageId.filter(
    (candidate) => stillInSource.get(candidate.messageId) === false,
  );
  for (const candidate of withMessageId) {
    if (stillInSource.get(candidate.messageId) === true) {
      result.notMoved.push(candidate.uid);
    }
  }

  if (needsDestinationCheck.length === 0) {
    return result;
  }

  try {
    const lock = await client.getMailboxLock(destinationFolder, { readOnly: true });
    try {
      for (const candidate of needsDestinationCheck) {
        const uids = await client.search(
          { header: { 'message-id': candidate.messageId } },
          { uid: true },
        );
        if (uids && uids.length === 1) {
          result.moved.push(candidate.uid);
        } else {
          result.uncertain.push(candidate.uid);
        }
      }
    } finally {
      lock.release();
    }
  } catch {
    for (const candidate of needsDestinationCheck) {
      result.uncertain.push(candidate.uid);
    }
  }

  return result;
}
