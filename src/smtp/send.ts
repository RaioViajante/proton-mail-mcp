import {
  SEND_INTENT_RECEIPT_TTL_MS,
  validateSendIntentReceipt,
  type SendReceiptRejectionReason,
} from '../security/send-intent-receipt.js';
import { consumeReceiptNonce } from '../security/send-intent-replay-guard.js';
import type { ResolvedSmtpConfig } from './config.js';
import { validateSendIntent, type RawSendParams } from './intent.js';
import { sanitizeRecipientList, type SmtpOutcome } from './outcome.js';
import { submitSmtp, type SmtpSendFn } from './transport.js';

export type SendOutcome = SmtpOutcome;

export interface SendParams extends RawSendParams {
  /** Pass back exactly the `sendIntentReceipt` `mail_send_preview` returned — never modified. Required for a live call; ignored for a dry run. */
  sendIntentReceipt?: unknown;
  dryRun: boolean;
  confirm: boolean;
  acknowledgeExternalSend: boolean;
}

export interface SendMailDeps {
  /**
   * Resolves the Bridge SMTP password from the macOS Keychain (see
   * `src/bridge/config.ts`'s `getBridgePassword`). Only ever invoked for a
   * live call, and only after consent, intent, receipt, and replay-guard
   * checks have ALL already passed — a dry run, or a live call rejected by
   * any earlier check, never calls this and therefore never touches the
   * Keychain.
   */
  getPassword: () => Promise<string>;
  /** Test seam only — see `src/smtp/transport.ts`'s `SmtpSendFn`. Omitted in production, where `submitSmtp` uses the real nodemailer transport. */
  sendFn?: SmtpSendFn;
  /** Test-only state isolation; production always uses the user's config directory. */
  replayStateDir?: string;
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
  /**
   * Only present for a dry run when a `sendIntentReceipt` was supplied:
   * whether it would pass full verification (structure, signature, expiry,
   * exact intent match) right now. A dry run NEVER consumes the
   * replay-guard nonce, even when this is `true` — checking a receipt this
   * way must never cost the caller their one live attempt with it. See
   * `src/security/send-intent-replay-guard.ts`.
   */
  receiptValid?: boolean;
  /** Every field below is present only for a live (`dryRun: false`) call — a dry-run never attempts anything, so nothing below is meaningful yet. */
  connectionEstablished?: boolean;
  authenticated?: boolean;
  submissionAttempted?: boolean;
  acceptedRecipients?: string[];
  rejectedRecipients?: string[];
  smtpResponseCategory?: string | null;
  outcome?: SendOutcome;
  deliveryUncertain?: boolean;
  /** Always `null` in 0.5.1 — this project does not yet observe or model the Bridge's own Sent-folder behavior after a submission; see SECURITY.md ("Sent-folder placement is not modeled yet"). */
  sentFolderObserved?: null;
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

/** Shared shape for every pre-submission live rejection (invalid intent, invalid receipt, replayed receipt) — zero SMTP attempt, every phase flag false. `intentValidated` is `false` only for the invalid-intent case; a receipt/replay rejection still had a valid intent. */
function preSubmissionRejection(
  base: Pick<SendResult, 'operation' | 'dryRun' | 'from' | 'to' | 'cc' | 'subject' | 'bodyLength'>,
  intentValidated: boolean,
  reasons: string[],
): SendResult {
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

/**
 * `mail_send` core (0.5.1, "Controlled Live SMTP"): live submission is no
 * longer feature-gated off — every protection built and unit-tested in
 * 0.5.0 (consent gate, intent validation, full `sendIntentReceipt`
 * verification) now actually guards a real SMTP submission via
 * `src/smtp/transport.ts`'s `submitSmtp`, plus one new check this version
 * adds: the replay guard (`src/security/send-intent-replay-guard.ts`) —
 * see its module doc and SECURITY.md ("Send-intent receipt replay").
 *
 * Validation order is deliberate and unchanged in spirit from 0.5.0: the
 * consent gate rejects before any other work; intent validation runs next
 * (identical to `mail_send_preview`, so the two can never disagree); only
 * once a valid intent exists does receipt verification run; only once the
 * receipt verifies does the replay guard consume its one-time nonce —
 * **irreversibly, regardless of what happens next** — and only after that
 * does this function ever ask for a credential or open a socket. Each check
 * is a pure, zero-network gate until the very last step.
 */
export async function sendMail(
  params: SendParams,
  smtpConfig: ResolvedSmtpConfig,
  signingSecret: Buffer | undefined,
  deps?: SendMailDeps,
): Promise<SendResult> {
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
    const result: SendResult = {
      ...base,
      intentValidated: validation.valid,
      reasons: [...validation.reasons],
    };
    // Dry-run receipt check (0.5.1, section 12): informational only, zero
    // SMTP, and — critically — never consumes the replay-guard nonce. Only
    // runs when a receipt was actually supplied and there's a valid intent
    // to check it against; an invalid intent has nothing for the receipt to
    // match, so it's left unchecked rather than reported as a confusing
    // double failure.
    if (sendIntentReceipt !== undefined && validation.intent) {
      const receiptCheck = validateSendIntentReceipt(
        sendIntentReceipt,
        signingSecret,
        validation.intent,
      );
      result.receiptValid = receiptCheck.valid;
      if (!receiptCheck.valid) {
        result.reasons = [...result.reasons, receiptRejectionMessage(receiptCheck.reason)];
      }
    }
    return result;
  }

  if (!validation.valid || !validation.intent) {
    return preSubmissionRejection(base, false, validation.reasons);
  }

  const receiptValidation = validateSendIntentReceipt(
    sendIntentReceipt,
    signingSecret,
    validation.intent,
  );
  if (!receiptValidation.valid) {
    return preSubmissionRejection(base, true, [
      ...validation.reasons,
      receiptRejectionMessage(receiptValidation.reason),
    ]);
  }

  // Replay guard (0.5.1): the receipt's nonce is consumed HERE — before a
  // credential is even requested, let alone a socket opened — so a second
  // call presenting this exact receipt (concurrent or sequential, whatever
  // happened to the first attempt) can never reach a second SMTP attempt.
  // See src/security/send-intent-replay-guard.ts for exactly what this does
  // and does not guarantee.
  const receiptExpiresAt =
    Date.parse(receiptValidation.receipt.issuedAt) + SEND_INTENT_RECEIPT_TTL_MS;
  const nonce = consumeReceiptNonce(
    receiptValidation.receipt.id,
    receiptExpiresAt,
    Date.now(),
    deps?.replayStateDir,
  );
  if (!nonce.consumed) {
    return preSubmissionRejection(base, true, [
      ...validation.reasons,
      'sendIntentReceipt has already been used for a previous mail_send attempt; call ' +
        'mail_send_preview again for a fresh receipt (see SECURITY.md, "Send-intent receipt ' +
        'replay").',
    ]);
  }

  // Every check above passed and the receipt is now irrevocably spent. This
  // is the one path in this project that may submit a live email.
  if (!deps) {
    // Internal wiring invariant, not a caller-facing input problem — the
    // registered `mail_send` tool always supplies `deps`; only a test or a
    // future internal caller could hit this.
    throw new Error('sendMail: deps.getPassword is required once dryRun=false reaches submission.');
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
    {
      from: validation.intent.from,
      to: validation.intent.to,
      cc: validation.intent.cc,
      subject: validation.intent.subject,
      text: params.text,
    },
    deps.sendFn,
  );

  const knownRecipients = [...validation.intent.to, ...validation.intent.cc];

  return {
    ...base,
    intentValidated: true,
    reasons: [...validation.reasons, ...attempt.reasons],
    connectionEstablished: attempt.connectionEstablished,
    authenticated: attempt.authenticated,
    submissionAttempted: attempt.submissionAttempted,
    acceptedRecipients: sanitizeRecipientList(attempt.acceptedRecipients, knownRecipients),
    rejectedRecipients: sanitizeRecipientList(attempt.rejectedRecipients, knownRecipients),
    smtpResponseCategory: attempt.smtpResponseCategory,
    outcome: attempt.outcome,
    deliveryUncertain: attempt.deliveryUncertain,
    sentFolderObserved: null,
  };
}
