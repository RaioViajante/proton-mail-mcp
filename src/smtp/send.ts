import {
  validateSendIntentReceipt,
  type SendReceiptRejectionReason,
} from '../security/send-intent-receipt.js';
import type { ResolvedSmtpConfig } from './config.js';
import { validateSendIntent, type RawSendParams } from './intent.js';
import type { SmtpOutcome } from './outcome.js';

/** Stable, loggable reason code — never a free-form sentence — for why a live call was refused, mirroring `LIVE_PERMANENT_DELETE_DISABLED_REASON`. */
export const LIVE_SEND_DISABLED_REASON = 'liveSendDisabled';

export type SendOutcome = SmtpOutcome | 'blocked';

export interface SendParams extends RawSendParams {
  /** Pass back exactly the `sendIntentReceipt` `mail_send_preview` returned — never modified. Required for a live call; ignored for a dry run. */
  sendIntentReceipt?: unknown;
  dryRun: boolean;
  confirm: boolean;
  acknowledgeExternalSend: boolean;
}

export interface SendResult {
  operation: 'mail_send';
  dryRun: boolean;
  intentValidated: boolean;
  from: string | null;
  to: string[];
  cc: string[];
  subject: string;
  bodyLength: number;
  reasons: string[];
  /** Every field below is present only for a live (`dryRun: false`) call — a dry-run never attempts anything, so nothing below is meaningful yet. */
  connectionEstablished?: boolean;
  authenticated?: boolean;
  submissionAttempted?: boolean;
  acceptedRecipients?: string[];
  rejectedRecipients?: string[];
  smtpResponseCategory?: string | null;
  outcome?: SendOutcome;
  deliveryUncertain?: boolean;
  /** Always `null` in 0.5.0 — this project does not yet observe or model the Bridge's own Sent-folder behavior after a submission; see SECURITY.md ("Sent-folder placement is not modeled yet"). */
  sentFolderObserved?: null;
  blocked?: boolean;
  blockReason?: string;
}

function receiptRejectionMessage(reason: SendReceiptRejectionReason): string {
  switch (reason) {
    case 'malformedReceipt':
      return 'sendIntentReceipt is malformed or missing required fields.';
    case 'signingSecretUnavailable':
      return (
        'No send-signing secret is provisioned; live mail_send cannot verify any receipt (run ' +
        'scripts/configure-send-signing.sh).'
      );
    case 'signatureInvalid':
      return 'sendIntentReceipt signature is invalid.';
    case 'expired':
      return 'sendIntentReceipt has expired; call mail_send_preview again.';
    case 'intentMismatch':
      return (
        'sendIntentReceipt does not match the payload given to mail_send — from/to/cc/subject/' +
        'body differ from what was previewed.'
      );
  }
}

/**
 * `mail_send` core (0.5.0): implemented and fully testable — intent
 * validation, the dryRun/confirm/acknowledgeExternalSend consent gate, and
 * full `sendIntentReceipt` verification all run for real — but a
 * fully-confirmed live call with a valid receipt is refused by a hard
 * feature gate before any SMTP connection is even attempted. See
 * `src/smtp/transport.ts`'s `submitSmtp`, never called from this path in
 * 0.5.0, and SECURITY.md ("Live SMTP submission is feature-gated off"). This
 * mirrors `mutations/permanent-delete.ts`'s `deletePermanently` exactly.
 *
 * Validation order is deliberate: the consent gate is a pure input check
 * that rejects before any other work (mirrors every other mutation in this
 * project); intent validation runs next and is identical to what
 * `mail_send_preview` runs, so the two can never silently disagree about
 * what "valid" means; only once a valid intent exists does receipt
 * verification run, since a receipt is meaningless without something to
 * compare it against; only once every one of those passes does the feature
 * gate get a chance to block the (otherwise fully legitimate) live attempt.
 */
export function sendMail(
  params: SendParams,
  smtpConfig: ResolvedSmtpConfig,
  signingSecret: Buffer | undefined,
): SendResult {
  const { dryRun, confirm, acknowledgeExternalSend, sendIntentReceipt } = params;

  if (!dryRun && (!confirm || !acknowledgeExternalSend)) {
    throw new Error(
      'confirm=true and acknowledgeExternalSend=true are both required together with dryRun=false ' +
        'for mail_send.',
    );
  }

  const validation = validateSendIntent(params, smtpConfig.username);
  const base = {
    operation: 'mail_send' as const,
    dryRun,
    from: validation.intent?.from ?? null,
    to: validation.intent?.to ?? [],
    cc: validation.intent?.cc ?? [],
    subject: params.subject,
    bodyLength: params.text.length,
  };

  if (dryRun) {
    return { ...base, intentValidated: validation.valid, reasons: validation.reasons };
  }

  if (!validation.valid || !validation.intent) {
    return {
      ...base,
      intentValidated: false,
      reasons: validation.reasons,
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

  const receiptValidation = validateSendIntentReceipt(
    sendIntentReceipt,
    signingSecret,
    validation.intent,
  );
  if (!receiptValidation.valid) {
    return {
      ...base,
      intentValidated: true,
      reasons: [...validation.reasons, receiptRejectionMessage(receiptValidation.reason)],
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

  // Feature gate (0.5.0): consent gate, intent validation, and receipt
  // verification all passed, but live SMTP submission is refused
  // unconditionally, before any network connection is attempted. Live send
  // ships in a separate, explicitly authorized version after dedicated
  // live validation.
  return {
    ...base,
    intentValidated: true,
    reasons: validation.reasons,
    connectionEstablished: false,
    authenticated: false,
    submissionAttempted: false,
    acceptedRecipients: [],
    rejectedRecipients: [],
    smtpResponseCategory: null,
    outcome: 'blocked',
    deliveryUncertain: false,
    sentFolderObserved: null,
    blocked: true,
    blockReason: LIVE_SEND_DISABLED_REASON,
  };
}
