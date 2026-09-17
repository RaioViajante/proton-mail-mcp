import type { ImapFlow } from 'imapflow';

/**
 * Explicit whitelist of IMAP flags this project will ever measure or
 * automatically restore across a mailbox transition (0.4.1). Never grown to
 * "whatever flags the message happens to carry" — only flags whose meaning
 * is unambiguous and safe to copy verbatim:
 *
 * - `\Seen` — read/unread. Live-confirmed regression (0.4.0): a
 *   Trash -> Archive restore silently turned an unread message read.
 * - `\Flagged` — Proton's "Starred" state, exposed over IMAP as this
 *   standard flag (see `resolveSpecialFolders`'s `\Flagged` -> `starred`
 *   mapping) rather than a separate mechanism.
 *
 * Deliberately excluded: `\Deleted` (a structural consequence of mailbox
 * transitions, never a durable user-facing state to preserve — copying it
 * blindly is exactly the kind of mistake `expungeExactUids()` guards
 * against elsewhere), `\Answered`/`\Draft` (no restore/trash flow in this
 * project can plausibly change these, and this project does not invent
 * preservation behavior for flags no live finding ever showed being lost),
 * and any non-standard/keyword flag (ambiguous semantics per-server).
 */
export const PRESERVABLE_FLAGS = ['\\Seen', '\\Flagged'] as const;

export type PreservableFlag = (typeof PRESERVABLE_FLAGS)[number];

/** Narrows a raw IMAP flag Set down to just the flags this project tracks, in a stable order. */
export function preservableFlagsOf(flags: ReadonlySet<string> | undefined): PreservableFlag[] {
  if (!flags) {
    return [];
  }
  return PRESERVABLE_FLAGS.filter((flag) => flags.has(flag));
}

/** Flags present in `before` but not `after` — need to be added back. */
export function flagsMissing(
  before: readonly PreservableFlag[],
  after: readonly PreservableFlag[],
): PreservableFlag[] {
  const afterSet = new Set(after);
  return before.filter((flag) => !afterSet.has(flag));
}

/** Flags present in `after` but not `before` — appeared as a side effect and were never part of the original state. */
export function flagsUnexpected(
  before: readonly PreservableFlag[],
  after: readonly PreservableFlag[],
): PreservableFlag[] {
  const beforeSet = new Set(before);
  return after.filter((flag) => !beforeSet.has(flag));
}

/**
 * Read-only fetch of one message's preservable flags in one mailbox, by
 * UID. Returns `undefined` if the UID is not found there (e.g. the
 * destination identity check that produced it was wrong, or the message
 * vanished between the move and this verification) — never guessed, and
 * always the caller's signal to skip repair for that message rather than
 * act on an assumed empty flag set.
 */
export async function fetchPreservableFlags(
  client: ImapFlow,
  folder: string,
  uid: number,
): Promise<PreservableFlag[] | undefined> {
  const lock = await client.getMailboxLock(folder, { readOnly: true });
  try {
    for await (const message of client.fetch([uid], { uid: true, flags: true }, { uid: true })) {
      if (message.uid === uid) {
        return preservableFlagsOf(message.flags);
      }
    }
    return undefined;
  } finally {
    lock.release();
  }
}
