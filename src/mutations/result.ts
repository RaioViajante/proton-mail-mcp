import type { UidTransition } from './transitions.js';

/**
 * Structured, uniform result shape every mutation tool returns. Never carries
 * message subjects/bodies — only UIDs, paths, and short error strings — so
 * nothing derived from email content ends up in a result someone might log.
 */
export interface MutationError {
  uid: number;
  message: string;
}

export interface SpamFilteringNotice {
  futureFilteringEffect: true;
  warning: string;
}

export interface MutationResult {
  operation: string;
  dryRun: boolean;
  requestedUids: number[];
  /** UIDs that exist in the source folder and are eligible for this operation. */
  matchedUids: number[];
  /** UIDs actually changed. Always empty when dryRun is true. */
  changedUids: number[];
  /** Matched UIDs that needed no change (e.g. already read, already labeled). */
  skippedUids: number[];
  /** Requested UIDs that do not exist in the source folder. */
  missingUids: number[];
  errors: MutationError[];
  /**
   * Present only for operations that changed a message's mailbox
   * membership (mail_move, mail_archive, mail_mark_spam,
   * mail_remove_label, mail_apply_label) AND actually executed
   * (`dryRun: false` and at least one UID in `changedUids`) — a dry-run
   * never has transitions, since nothing happened yet to describe. See
   * `mutations/transitions.ts` ("IMAP UIDs are unique only within one
   * mailbox").
   */
  transitions?: UidTransition[];
  /** Present on both dry-run and live mail_mark_spam results. */
  spamFilteringNotice?: SpamFilteringNotice;
}

export function createMutationResult(
  operation: string,
  dryRun: boolean,
  requestedUids: readonly number[],
): MutationResult {
  return {
    operation,
    dryRun,
    requestedUids: [...requestedUids],
    matchedUids: [],
    changedUids: [],
    skippedUids: [],
    missingUids: [],
    errors: [],
  };
}
