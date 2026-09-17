import type { ImapFlow } from 'imapflow';
import { assertBatchSize, dedupeUids, MAX_PERMANENT_DELETE_UIDS } from './batch.js';
import { fetchExistingUids } from './existence.js';
import { resolveSpecialFolders } from './policy.js';
import { createMutationResult, type MutationResult } from './result.js';

export const PERMANENT_DELETE_CONFIRMATION_PHRASE = 'DELETE PERMANENTLY';

/** Stable, loggable reason code — never a free-form sentence — for why a live call was refused. */
export const LIVE_PERMANENT_DELETE_DISABLED_REASON = 'livePermanentDeleteDisabled';

export interface PermanentDeleteParams {
  sourceFolder: string;
  uids: number[];
  dryRun: boolean;
  confirm: boolean;
  acknowledgePermanentDeletion: boolean;
  confirmationPhrase: string;
}

export interface PermanentDeleteResult extends MutationResult {
  /**
   * True only when a fully-confirmed live call (`dryRun: false`, `confirm`,
   * `acknowledgePermanentDeletion`, and the exact `confirmationPhrase` all
   * correct) was refused anyway by the feature gate (introduced 0.4.0,
   * unchanged as of 0.4.2). Never true for a
   * dry-run — there is nothing to gate on a preview.
   */
  blocked?: boolean;
  blockReason?: string;
}

/**
 * `mail_delete_permanently` core (introduced 0.4.0, gate still active as of 0.4.2): implemented and fully testable —
 * schema validation, batch limits, the two-confirmation-plus-phrase gate,
 * and read-only Trash resolution all run for real — but a fully-confirmed
 * live call is refused by a hard feature gate before any IMAP mutating
 * command is even considered. See `expungeExactUids` below for the
 * UID-scoped deletion primitive this will call once a future, separately
 * authorized version lifts the gate, and SECURITY.md ("Permanent delete is
 * feature-gated off") for why.
 *
 * Validation order matters and is deliberate: batch size and the
 * confirm/acknowledge/phrase gate are pure input checks that reject before
 * any IMAP access at all (mirroring `mail_mark_spam` / `mail_unsubscribe`);
 * only after those pass does this function even call `client.list()` to
 * resolve the account's real Trash path.
 */
export async function deletePermanently(
  client: ImapFlow,
  {
    sourceFolder,
    uids,
    dryRun,
    confirm,
    acknowledgePermanentDeletion,
    confirmationPhrase,
  }: PermanentDeleteParams,
): Promise<PermanentDeleteResult> {
  const deduped = dedupeUids(uids);
  assertBatchSize(deduped, MAX_PERMANENT_DELETE_UIDS);

  if (!dryRun) {
    if (!confirm || !acknowledgePermanentDeletion) {
      throw new Error(
        'confirm=true and acknowledgePermanentDeletion=true are both required together with ' +
          'dryRun=false for mail_delete_permanently.',
      );
    }
    if (confirmationPhrase !== PERMANENT_DELETE_CONFIRMATION_PHRASE) {
      throw new Error(
        `confirmationPhrase must be exactly "${PERMANENT_DELETE_CONFIRMATION_PHRASE}" for a live ` +
          'mail_delete_permanently call.',
      );
    }
  }

  const folders = await client.list();
  const special = resolveSpecialFolders(folders);
  if (!special.trash) {
    throw new Error('Could not find a Trash folder on this account.');
  }
  if (sourceFolder !== special.trash) {
    throw new Error(
      `mail_delete_permanently only operates on the account's Trash folder ("${special.trash}"); ` +
        `refusing sourceFolder "${sourceFolder}".`,
    );
  }

  const result = createMutationResult(
    'mail_delete_permanently',
    dryRun,
    uids,
  ) as PermanentDeleteResult;

  // Read-only resolution against Trash — safe in both dry-run and live, and
  // the only IMAP access a dry-run ever performs.
  const lock = await client.getMailboxLock(sourceFolder, { readOnly: true });
  let existing: Set<number>;
  try {
    existing = await fetchExistingUids(client, deduped);
  } finally {
    lock.release();
  }
  result.matchedUids = deduped.filter((uid) => existing.has(uid));
  result.missingUids = deduped.filter((uid) => !existing.has(uid));

  if (dryRun) {
    return result;
  }

  // Feature gate (introduced 0.4.0, unchanged as of 0.4.2): every confirmation above was correct, but live
  // execution is refused unconditionally before any IMAP mutating command —
  // no messageFlagsAdd, no messageDelete, no EXPUNGE of any kind. Live
  // permanent deletion ships in a separate, explicitly authorized version.
  result.blocked = true;
  result.blockReason = LIVE_PERMANENT_DELETE_DISABLED_REASON;
  return result;
}

/**
 * The one function in this project that may ever issue a permanent
 * deletion. **Not called anywhere as of 0.4.2** — `deletePermanently` above
 * refuses before reaching this — but implemented and unit-tested now so a
 * future version's gate removal has a structurally-safe primitive ready,
 * per SECURITY.md's UID-scoped-only rule.
 *
 * Requires the connection to report the `UIDPLUS` capability BEFORE issuing
 * any command, and refuses (zero commands issued) if it does not.
 * `ImapFlow`'s own `messageDelete({ uid: true })` silently falls back to a
 * mailbox-wide, unscoped `EXPUNGE` when `UIDPLUS` is unavailable — confirmed
 * by reading `imapflow`'s own `commands/expunge.js`: "Without UIDPLUS: plain
 * EXPUNGE removes ALL messages flagged \Deleted in the mailbox." That
 * fallback would remove messages this call never authorized (e.g. ones
 * flagged `\Deleted` by another client), so this function never reaches
 * that code path at all rather than relying on it behaving safely.
 */
export async function expungeExactUids(
  client: ImapFlow,
  folder: string,
  uids: readonly number[],
): Promise<boolean> {
  if (uids.length === 0) {
    return true;
  }
  if (client.capabilities?.get('UIDPLUS') !== true) {
    throw new Error(
      'UID-scoped EXPUNGE (UIDPLUS) is not available on this connection; refusing to expunge — a ' +
        'mailbox-wide EXPUNGE fallback could remove unrelated messages already flagged \\Deleted.',
    );
  }

  const lock = await client.getMailboxLock(folder, { readOnly: false });
  try {
    await client.messageFlagsAdd([...uids], ['\\Deleted'], { uid: true });
    return await client.messageDelete([...uids], { uid: true });
  } finally {
    lock.release();
  }
}
