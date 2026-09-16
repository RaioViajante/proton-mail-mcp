import type { ImapFlow } from 'imapflow';

/**
 * IMAP UIDs are unique only within one mailbox — never globally. Any
 * operation that puts a message in a different mailbox (mail_move,
 * mail_archive, mail_mark_spam, mail_remove_label) can — and, confirmed
 * live for all of these, sometimes does — give it a new UID there. A
 * `UidTransition` is how a mutation result tells the caller what UID (if
 * any) is now safe to use, instead of leaving them to keep reusing the
 * `requestedUid` and hitting `missingUids` on their next call.
 *
 * `mail_apply_label` is the one case where the *source* folder's UID stays
 * valid too (confirmed live: Bridge keeps the message in its original
 * folder when applying a label) — `originalUidStillValid` distinguishes
 * that from every other operation, where it does not.
 */
export interface UidTransition {
  /** The UID the caller passed in for this message. */
  requestedUid: number;
  sourceFolder: string;
  destinationFolder: string;
  /**
   * True only for mail_apply_label: `requestedUid` remains usable in
   * `sourceFolder` after this operation. False for every operation that
   * relocates the message (mail_move, mail_archive, mail_mark_spam,
   * mail_remove_label) — `requestedUid` must not be reused there.
   */
  originalUidStillValid: boolean;
  /** The UID this message now has in `destinationFolder`, when it could be determined without guessing. */
  resultingUid?: number;
  /**
   * True when `resultingUid` could not be determined safely. The mutation
   * still completed — this is not an error — but the caller must
   * re-list/re-search `destinationFolder` before targeting this message
   * again; never assume `requestedUid` still applies there.
   */
  requiresRefresh?: boolean;
}

export function buildTransition(
  requestedUid: number,
  sourceFolder: string,
  destinationFolder: string,
  originalUidStillValid: boolean,
  resultingUid: number | undefined,
): UidTransition {
  return resultingUid === undefined
    ? {
        requestedUid,
        sourceFolder,
        destinationFolder,
        originalUidStillValid,
        requiresRefresh: true,
      }
    : { requestedUid, sourceFolder, destinationFolder, originalUidStillValid, resultingUid };
}

/**
 * Determines the UID a message now has in `destinationFolder`, without
 * ever guessing. Resolution order:
 *
 * 1. **The server's own UIDPLUS mapping** — `uidMap`, from ImapFlow's
 *    `messageMove`/`messageCopy` response, keyed by the UID the message
 *    had in whichever mailbox was the source of that specific move call.
 *    Authoritative; no further IMAP round trip needed.
 * 2. **Message-ID correlation** (`SEARCH HEADER Message-ID`) in
 *    `destinationFolder` — used only when step 1 has no answer, and only
 *    trusted when it resolves to exactly one match. Subject, sender, and
 *    mailbox position are never used for this — see README.md ("IMAP UID
 *    semantics") — because none of them reliably identify one message.
 *
 * Returns `undefined` if neither resolves unambiguously. That is not an
 * error condition for the caller of this function — it is the signal to
 * build a transition with `requiresRefresh: true` instead of a guess.
 */
export async function reconcileResultingUid(
  client: ImapFlow,
  destinationFolder: string,
  sourceSideUid: number,
  uidMap: Map<number, number> | undefined,
  messageId: string | undefined,
): Promise<number | undefined> {
  const mapped = uidMap?.get(sourceSideUid);
  if (mapped !== undefined) {
    return mapped;
  }

  if (!messageId) {
    return undefined;
  }

  const lock = await client.getMailboxLock(destinationFolder, { readOnly: true });
  try {
    const uids = await client.search({ header: { 'message-id': messageId } }, { uid: true });
    if (uids && uids.length === 1) {
      return uids[0];
    }
    // Zero matches (not found yet — e.g. server hasn't indexed it) or more
    // than one (ambiguous, cannot safely pick) both mean: do not guess.
    return undefined;
  } finally {
    lock.release();
  }
}
