import type { ReplySourceHeaders } from '../mail/source-message.js';
import { LIVE_REPLY_DISABLED } from './feature-gates.js';
import { consumeReceiptNonce } from '../security/send-intent-replay-guard.js';
import {
  computeReplySourceFingerprint,
  REPLY_INTENT_RECEIPT_TTL_MS,
  validateReplyIntentReceipt,
  type ReplyReceiptRejectionReason,
} from '../security/reply-intent-receipt.js';
import { buildReplyMessage, computeThreadingHash, deriveReplyIntent } from './reply-intent.js';
import { sanitizeRecipientList, type SmtpOutcome } from './outcome.js';
import type { ResolvedSmtpConfig } from './config.js';
import { submitSmtp, type SmtpSendFn } from './transport.js';

export interface ReplySendParams {
  sourceFolder: string;
  uid: number;
  text: string;
  /** Pass back exactly the `replyIntentReceipt` `mail_reply_preview` returned — never modified. */
  replyIntentReceipt?: unknown;
  dryRun: boolean;
  confirm: boolean;
  acknowledgeExternalReply: boolean;
}

export interface ReplySendDeps {
  getPassword: () => Promise<string>;
  sendFn?: SmtpSendFn;
  /**
   * Test-only override of {@link LIVE_REPLY_DISABLED}. Production callers
   * (`src/tools/reply.ts`) never set this — it exists purely so the
   * post-gate nonce-consumption-and-submission path is unit-testable now,
   * without flipping the real feature-gate constant. Defaults to the real
   * gate.
   */
  liveDisabled?: boolean;
}

export interface ReplySendResult {
  operation: 'mail_reply';
  dryRun: boolean;
  sourceFolder: string;
  uid: number;
  intentValidated: boolean;
  to: string | null;
  subject: string;
  bodyLength: number;
  reasons: string[];
  /** Dry-run only, informational — never consumes the replay-guard nonce. */
  receiptValid?: boolean;
  connectionEstablished?: boolean;
  authenticated?: boolean;
  submissionAttempted?: boolean;
  acceptedRecipients?: string[];
  rejectedRecipients?: string[];
  smtpResponseCategory?: string | null;
  outcome?: SmtpOutcome;
  deliveryUncertain?: boolean;
  sentFolderObserved?: null;
}

function replyReceiptRejectionMessage(reason: ReplyReceiptRejectionReason): string {
  switch (reason) {
    case 'malformedReceipt':
      return 'replyIntentReceipt is malformed or missing required fields.';
    case 'signingSecretUnavailable':
      return (
        'No send-signing secret is provisioned; live mail_reply cannot verify any receipt (run ' +
        'scripts/configure-send-signing.sh).'
      );
    case 'signatureInvalid':
      return 'replyIntentReceipt signature is invalid.';
    case 'expired':
      return 'replyIntentReceipt has expired; call mail_reply_preview again.';
    case 'intentMismatch':
      return (
        'replyIntentReceipt does not match the current source message and/or reply text — the ' +
        'source may have changed since preview, or the payload was altered.'
      );
  }
}

function preSubmissionRejection(
  base: Pick<
    ReplySendResult,
    'operation' | 'dryRun' | 'sourceFolder' | 'uid' | 'to' | 'subject' | 'bodyLength'
  >,
  intentValidated: boolean,
  reasons: string[],
): ReplySendResult {
  return {
    ...base,
    intentValidated,
    reasons,
    connectionEstablished: false,
    authenticated: false,
    submissionAttempted: false,
    acceptedRecipients: [],
    rejectedRecipients: [],
    smtpResponseCategory: null,
    outcome: 'rejected',
    deliveryUncertain: false,
    sentFolderObserved: null,
  };
}

/** `null` secret is fine here — every caller only uses this to feed `validateReplyIntentReceipt`, which checks secret presence before ever comparing these values. */
function computeIdentity(
  source: ReplySourceHeaders,
  intent: { inReplyTo: string | null; references: string[] },
  signingSecret: Buffer | undefined,
): { sourceFingerprint: string; threadingHash: string } {
  const threadingHash = computeThreadingHash(intent.inReplyTo, intent.references);
  const sourceFingerprint = signingSecret
    ? computeReplySourceFingerprint(signingSecret, {
        folder: source.folder,
        uidValidity: source.uidValidity,
        uid: source.uid,
        from: source.from,
        subject: source.subject,
        date: source.date,
        messageId: source.messageId,
      })
    : '';
  return { sourceFingerprint, threadingHash };
}

/**
 * `mail_reply` core (0.5.2). `source` MUST be a fresh, just-fetched
 * `fetchReplySourceHeaders` result (the tool handler fetches it immediately
 * before calling this, never reusing a value from an earlier preview call)
 * — re-deriving the intent from it is exactly how a source message that
 * changed since preview is caught: the recomputed `sourceFingerprint`/
 * `threadingHash`/recipient/subject won't match the receipt, and
 * `validateReplyIntentReceipt` rejects before any credential is requested.
 *
 * Gate/replay ordering (0.5.2, corrected from `mail_send`'s ordering):
 * consent gate -> intent validation -> receipt validation -> **feature gate**
 * -> replay-guard nonce consumption -> credential -> SMTP. The feature gate
 * runs BEFORE nonce consumption specifically so a gate-blocked call (always
 * true in this version) never burns an otherwise-valid receipt — it caused
 * no external side effect, so it was never a real "attempt". Once live ships
 * in a future task, the ordering downstream of the gate reduces to exactly
 * `mail_send`'s at-most-once semantics.
 */
export async function sendReply(
  source: ReplySourceHeaders | null,
  params: ReplySendParams,
  smtpConfig: ResolvedSmtpConfig,
  signingSecret: Buffer | undefined,
  deps?: ReplySendDeps,
): Promise<ReplySendResult> {
  const { dryRun, confirm, acknowledgeExternalReply, replyIntentReceipt } = params;

  if (!dryRun && (!confirm || !acknowledgeExternalReply)) {
    throw new Error(
      'confirm=true and acknowledgeExternalReply=true are both required together with ' +
        'dryRun=false for mail_reply.',
    );
  }

  const outerBase = {
    operation: 'mail_reply' as const,
    dryRun,
    sourceFolder: params.sourceFolder,
    uid: params.uid,
    bodyLength: params.text.length,
  };

  if (!source) {
    const reasons = ['Message not found in the specified folder.'];
    if (dryRun) {
      return { ...outerBase, to: null, subject: '', intentValidated: false, reasons };
    }
    return preSubmissionRejection({ ...outerBase, to: null, subject: '' }, false, reasons);
  }

  const validation = deriveReplyIntent(source, { text: params.text }, smtpConfig.username);
  const base = {
    ...outerBase,
    to: validation.intent?.to ?? null,
    subject: validation.intent?.subject ?? '',
  };

  const identity = validation.intent
    ? computeIdentity(source, validation.intent, signingSecret)
    : { sourceFingerprint: '', threadingHash: '' };

  if (dryRun) {
    const result: ReplySendResult = {
      ...base,
      intentValidated: validation.valid,
      reasons: [...validation.reasons],
    };
    // Dry-run receipt check: informational only, zero SMTP, never consumes
    // the replay-guard nonce — mirrors mail_send's identical guarantee.
    if (replyIntentReceipt !== undefined && validation.intent) {
      const receiptCheck = validateReplyIntentReceipt(
        replyIntentReceipt,
        signingSecret,
        validation.intent,
        identity.sourceFingerprint,
        identity.threadingHash,
      );
      result.receiptValid = receiptCheck.valid;
      if (!receiptCheck.valid) {
        result.reasons = [...result.reasons, replyReceiptRejectionMessage(receiptCheck.reason)];
      }
    }
    return result;
  }

  if (!validation.valid || !validation.intent) {
    return preSubmissionRejection(base, false, validation.reasons);
  }

  const receiptValidation = validateReplyIntentReceipt(
    replyIntentReceipt,
    signingSecret,
    validation.intent,
    identity.sourceFingerprint,
    identity.threadingHash,
  );
  if (!receiptValidation.valid) {
    return preSubmissionRejection(base, true, [
      ...validation.reasons,
      replyReceiptRejectionMessage(receiptValidation.reason),
    ]);
  }

  // Feature gate BEFORE the replay guard (corrected 0.5.2 ordering — see
  // this function's doc comment): a blocked live reply must not consume the
  // receipt's one-time nonce.
  const liveDisabled = deps?.liveDisabled ?? LIVE_REPLY_DISABLED;
  if (liveDisabled) {
    return preSubmissionRejection(base, true, [
      ...validation.reasons,
      'Live mail_reply is disabled in this version (0.5.2); reply preview and dry-run remain ' +
        'available, and this receipt was NOT consumed and remains usable (until it expires). A ' +
        'separate task will validate and enable live reply.',
    ]);
  }

  const receiptExpiresAt =
    Date.parse(receiptValidation.receipt.issuedAt) + REPLY_INTENT_RECEIPT_TTL_MS;
  const nonce = consumeReceiptNonce(`reply:${receiptValidation.receipt.id}`, receiptExpiresAt);
  if (!nonce.consumed) {
    return preSubmissionRejection(base, true, [
      ...validation.reasons,
      'replyIntentReceipt has already been used for a previous mail_reply attempt; call ' +
        'mail_reply_preview again for a fresh receipt.',
    ]);
  }

  if (!deps) {
    throw new Error(
      'sendReply: deps.getPassword is required once dryRun=false reaches submission.',
    );
  }

  let password: string;
  try {
    password = await deps.getPassword();
  } catch (error) {
    return {
      ...base,
      intentValidated: true,
      reasons: [
        ...validation.reasons,
        error instanceof Error ? error.message : 'Could not retrieve the Bridge SMTP credential.',
      ],
      connectionEstablished: false,
      authenticated: false,
      submissionAttempted: false,
      acceptedRecipients: [],
      rejectedRecipients: [],
      smtpResponseCategory: null,
      outcome: 'failed',
      deliveryUncertain: false,
      sentFolderObserved: null,
    };
  }

  const attempt = await submitSmtp(
    smtpConfig,
    password,
    buildReplyMessage(validation.intent),
    deps.sendFn,
  );

  return {
    ...base,
    intentValidated: true,
    reasons: [...validation.reasons, ...attempt.reasons],
    connectionEstablished: attempt.connectionEstablished,
    authenticated: attempt.authenticated,
    submissionAttempted: attempt.submissionAttempted,
    acceptedRecipients: sanitizeRecipientList(attempt.acceptedRecipients, [validation.intent.to]),
    rejectedRecipients: sanitizeRecipientList(attempt.rejectedRecipients, [validation.intent.to]),
    smtpResponseCategory: attempt.smtpResponseCategory,
    outcome: attempt.outcome,
    deliveryUncertain: attempt.deliveryUncertain,
    sentFolderObserved: null,
  };
}
