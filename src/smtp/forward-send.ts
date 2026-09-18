import type { ForwardSourceContent } from '../mail/source-message.js';
import { LIVE_FORWARD_DISABLED } from './feature-gates.js';
import { consumeReceiptNonce } from '../security/send-intent-replay-guard.js';
import {
  computeForwardSourceFingerprint,
  FORWARD_INTENT_RECEIPT_TTL_MS,
  validateForwardIntentReceipt,
  type ForwardReceiptRejectionReason,
} from '../security/forward-intent-receipt.js';
import { buildForwardMessage, deriveForwardIntent } from './forward-intent.js';
import { sanitizeRecipientList, type SmtpOutcome } from './outcome.js';
import type { ResolvedSmtpConfig } from './config.js';
import { submitSmtp, type SmtpSendFn } from './transport.js';

export interface ForwardSendParams {
  sourceFolder: string;
  uid: number;
  to: string[];
  text?: string | undefined;
  /** Pass back exactly the `forwardIntentReceipt` `mail_forward_preview` returned — never modified. */
  forwardIntentReceipt?: unknown;
  dryRun: boolean;
  confirm: boolean;
  acknowledgeExternalForward: boolean;
  /** Must be true when the (verified) receipt says the source has attachments. Checked against the RECEIPT's `sourceHasAttachments`, never a caller-supplied claim. */
  acknowledgeAttachmentsWillBeOmitted: boolean;
}

export interface ForwardSendDeps {
  getPassword: () => Promise<string>;
  sendFn?: SmtpSendFn;
  /** Test-only state isolation; production always uses the user's config directory. */
  replayStateDir?: string;
  /** Test-only override of {@link LIVE_FORWARD_DISABLED} — see `src/smtp/reply-send.ts`'s identical `liveDisabled` for the rationale. */
  liveDisabled?: boolean;
}

export interface ForwardSendResult {
  operation: 'mail_forward';
  dryRun: boolean;
  sourceFolder: string;
  uid: number;
  intentValidated: boolean;
  to: string[];
  subject: string;
  bodyLength: number;
  reasons: string[];
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

function forwardReceiptRejectionMessage(reason: ForwardReceiptRejectionReason): string {
  switch (reason) {
    case 'malformedReceipt':
      return 'forwardIntentReceipt is malformed or missing required fields.';
    case 'signingSecretUnavailable':
      return (
        'No send-signing secret is provisioned; live mail_forward cannot verify any receipt (run ' +
        'scripts/configure-send-signing.sh).'
      );
    case 'signatureInvalid':
      return 'forwardIntentReceipt signature is invalid.';
    case 'expired':
      return 'forwardIntentReceipt has expired; call mail_forward_preview again.';
    case 'intentMismatch':
      return (
        'forwardIntentReceipt does not match the current source message and/or payload — the ' +
        'source may have changed since preview, or the payload was altered.'
      );
  }
}

function preSubmissionRejection(
  base: Pick<
    ForwardSendResult,
    'operation' | 'dryRun' | 'sourceFolder' | 'uid' | 'to' | 'subject' | 'bodyLength'
  >,
  intentValidated: boolean,
  reasons: string[],
): ForwardSendResult {
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

function computeFingerprint(
  source: ForwardSourceContent,
  signingSecret: Buffer | undefined,
): string {
  if (!signingSecret) return '';
  return computeForwardSourceFingerprint(signingSecret, {
    folder: source.folder,
    uidValidity: source.uidValidity,
    uid: source.uid,
    from: source.from,
    subject: source.subject,
    date: source.date,
    messageId: source.messageId,
  });
}

/**
 * `mail_forward` core (0.5.2). `source` MUST be a fresh, just-fetched
 * `fetchForwardSourceContent` result — see `src/smtp/reply-send.ts`'s
 * identical revalidation rationale. Gate/replay ordering matches
 * `sendReply` exactly: consent gate -> intent validation -> receipt
 * validation -> attachment-acknowledgement check (against the VERIFIED
 * receipt's `sourceHasAttachments`, never a caller claim) -> feature gate ->
 * replay-guard nonce consumption -> credential -> SMTP. The feature gate
 * runs BEFORE nonce consumption so a gate-blocked call never burns the receipt.
 */
export async function sendForward(
  source: ForwardSourceContent | null,
  params: ForwardSendParams,
  smtpConfig: ResolvedSmtpConfig,
  signingSecret: Buffer | undefined,
  deps?: ForwardSendDeps,
): Promise<ForwardSendResult> {
  const { dryRun, confirm, acknowledgeExternalForward, forwardIntentReceipt } = params;

  if (!dryRun && (!confirm || !acknowledgeExternalForward)) {
    throw new Error(
      'confirm=true and acknowledgeExternalForward=true are both required together with ' +
        'dryRun=false for mail_forward.',
    );
  }

  const outerBase = {
    operation: 'mail_forward' as const,
    dryRun,
    sourceFolder: params.sourceFolder,
    uid: params.uid,
    bodyLength: (params.text ?? '').length,
  };

  if (!source) {
    const reasons = ['Message not found in the specified folder.'];
    if (dryRun) {
      return { ...outerBase, to: [], subject: '', intentValidated: false, reasons };
    }
    return preSubmissionRejection({ ...outerBase, to: [], subject: '' }, false, reasons);
  }

  const validation = deriveForwardIntent(
    source,
    { to: params.to, text: params.text },
    smtpConfig.username,
  );
  const base = {
    ...outerBase,
    to: validation.intent?.to ?? [],
    subject: validation.intent?.subject ?? '',
    bodyLength: validation.intent?.bodyLength ?? outerBase.bodyLength,
  };

  const sourceFingerprint = computeFingerprint(source, signingSecret);

  if (dryRun) {
    const result: ForwardSendResult = {
      ...base,
      intentValidated: validation.valid,
      reasons: [...validation.reasons],
    };
    if (forwardIntentReceipt !== undefined && validation.intent) {
      const receiptCheck = validateForwardIntentReceipt(
        forwardIntentReceipt,
        signingSecret,
        validation.intent,
        sourceFingerprint,
      );
      result.receiptValid = receiptCheck.valid;
      if (!receiptCheck.valid) {
        result.reasons = [...result.reasons, forwardReceiptRejectionMessage(receiptCheck.reason)];
      }
    }
    return result;
  }

  if (!validation.valid || !validation.intent) {
    return preSubmissionRejection(base, false, validation.reasons);
  }

  const receiptValidation = validateForwardIntentReceipt(
    forwardIntentReceipt,
    signingSecret,
    validation.intent,
    sourceFingerprint,
  );
  if (!receiptValidation.valid) {
    return preSubmissionRejection(base, true, [
      ...validation.reasons,
      forwardReceiptRejectionMessage(receiptValidation.reason),
    ]);
  }

  if (
    receiptValidation.receipt.sourceHasAttachments &&
    !params.acknowledgeAttachmentsWillBeOmitted
  ) {
    return preSubmissionRejection(base, true, [
      ...validation.reasons,
      'Source message has attachments that would be omitted from this forward; ' +
        'acknowledgeAttachmentsWillBeOmitted=true is required.',
    ]);
  }

  // Feature gate BEFORE the replay guard — see sendReply's identical
  // rationale in src/smtp/reply-send.ts.
  const liveDisabled = deps?.liveDisabled ?? LIVE_FORWARD_DISABLED;
  if (liveDisabled) {
    return preSubmissionRejection(base, true, [
      ...validation.reasons,
      'Live mail_forward is disabled by the feature gate; forward preview and dry-run remain ' +
        'available, and this receipt was NOT consumed and remains usable (until it expires).',
    ]);
  }

  const receiptExpiresAt =
    Date.parse(receiptValidation.receipt.issuedAt) + FORWARD_INTENT_RECEIPT_TTL_MS;
  const nonce = consumeReceiptNonce(
    `forward:${receiptValidation.receipt.id}`,
    receiptExpiresAt,
    Date.now(),
    deps?.replayStateDir,
  );
  if (!nonce.consumed) {
    return preSubmissionRejection(base, true, [
      ...validation.reasons,
      'forwardIntentReceipt has already been used for a previous mail_forward attempt; call ' +
        'mail_forward_preview again for a fresh receipt.',
    ]);
  }

  if (!deps) {
    throw new Error(
      'sendForward: deps.getPassword is required once dryRun=false reaches submission.',
    );
  }

  let password: string;
  try {
    password = await deps.getPassword();
  } catch {
    return {
      ...base,
      intentValidated: true,
      reasons: [...validation.reasons, 'Could not retrieve the Bridge SMTP credential.'],
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
    buildForwardMessage(validation.intent),
    deps.sendFn,
  );

  return {
    ...base,
    intentValidated: true,
    reasons: [...validation.reasons, ...attempt.reasons],
    connectionEstablished: attempt.connectionEstablished,
    authenticated: attempt.authenticated,
    submissionAttempted: attempt.submissionAttempted,
    acceptedRecipients: sanitizeRecipientList(attempt.acceptedRecipients, validation.intent.to),
    rejectedRecipients: sanitizeRecipientList(attempt.rejectedRecipients, validation.intent.to),
    smtpResponseCategory: attempt.smtpResponseCategory,
    outcome: attempt.outcome,
    deliveryUncertain: attempt.deliveryUncertain,
    sentFolderObserved: null,
  };
}
