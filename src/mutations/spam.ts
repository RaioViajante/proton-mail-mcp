import type { ImapFlow } from 'imapflow';
import { moveMessagesCore } from './move.js';
import { resolveSpecialFolders } from './policy.js';
import type { MutationResult, SpamFilteringNotice } from './result.js';

export interface MarkSpamParams {
  folder: string;
  uids: number[];
  dryRun: boolean;
  confirm: boolean;
  /**
   * A second, independent acknowledgement — required alongside `confirm`
   * whenever `dryRun: false` — that this operation can have a persistent,
   * account-level effect beyond the moved message itself. See
   * `SPAM_FILTERING_WARNING` below and README.md ("Spam vs. Archive/Move
   * vs. Block").
   */
  acknowledgeFutureFiltering: boolean;
}

/**
 * Live-confirmed, not assumed: after `mail_mark_spam` moved a test message
 * to Spam through Proton Mail Bridge, the sender also appeared in Proton's
 * account-level Spam List — observed via the Proton Mail web UI
 * (Settings → Proton Mail → Filters → Spam, block, and allow lists), which
 * this project has no supported way to query or confirm itself. This is
 * NOT the same as Proton Block (a separate, stronger, account-level
 * feature this project does not implement, manage, or claim to affect).
 */
export const SPAM_FILTERING_WARNING =
  'This is not a simple move: live testing confirmed that Proton also added the sender to its Spam ' +
  'List after the Bridge MOVE to Spam. Future messages from that sender may be filtered to Spam. ' +
  'The tool only moves the selected message; it does not manage the Spam List. This is not Proton Block.';

function spamFilteringNotice(): SpamFilteringNotice {
  return { futureFilteringEffect: true, warning: SPAM_FILTERING_WARNING };
}

/**
 * Moves the given messages to Spam. This is the ONLY tool that may target
 * Spam (mail_move explicitly refuses it — see policy.ts).
 *
 * Stronger than a normal move, live-confirmed: it moves the selected
 * message(s), AND Proton appears to treat that as signal for its own
 * account-level Spam List for the sender — see `SPAM_FILTERING_WARNING`.
 * Because of that persistent, sender-level effect, executing this
 * (`dryRun: false`) requires BOTH `confirm: true` and
 * `acknowledgeFutureFiltering: true`; either missing rejects the call
 * locally before any IMAP command is issued. This tool never manages
 * Proton's Block or Allow lists, and never unsubscribes from anything —
 * see README.md ("Spam vs. Archive/Move vs. Block").
 */
export async function markAsSpam(
  client: ImapFlow,
  { folder, uids, dryRun, confirm, acknowledgeFutureFiltering }: MarkSpamParams,
): Promise<MutationResult> {
  if (!dryRun && (!confirm || !acknowledgeFutureFiltering)) {
    throw new Error(
      'confirm=true and acknowledgeFutureFiltering=true are both required together with dryRun=false ' +
        'for mail_mark_spam.',
    );
  }

  const folders = await client.list();
  const special = resolveSpecialFolders(folders);

  if (!special.spam) {
    throw new Error('Could not find a Spam folder on this account.');
  }
  if (folder === special.spam) {
    throw new Error('The source folder is already Spam; there is nothing to do.');
  }

  const result = await moveMessagesCore(
    client,
    { sourceFolder: folder, destinationFolder: special.spam, uids, dryRun },
    'mail_mark_spam',
    folders,
  );

  // Attached to every result — dry-run preview and live alike — since this
  // is a constant fact about what the operation does, not a per-call
  // computed outcome.
  result.spamFilteringNotice = spamFilteringNotice();

  return result;
}
