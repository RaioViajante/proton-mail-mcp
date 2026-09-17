import type { ReplySourceHeaders } from '../mail/source-message.js';
import {
  computeReplySourceFingerprint,
  receiptFieldsFromReplyIntent,
  signReplyIntentReceipt,
  type ReplyIntentReceiptEnvelope,
} from '../security/reply-intent-receipt.js';
import { computeThreadingHash, deriveReplyIntent } from './reply-intent.js';

export interface ReplyPreviewResult {
  operation: 'mail_reply_preview';
  sourceFolder: string;
  uid: number;
  targetRecipient: string | null;
  derivedSubject: string;
  textLength: number;
  eligible: boolean;
  reasons: string[];
  threadingAvailable: boolean;
  /** Present only when eligible AND a send-signing secret is provisioned. Opaque — pass back to `mail_reply` unmodified. */
  replyIntentReceipt?: ReplyIntentReceiptEnvelope;
}

/**
 * Read-only. Derives exactly what `mail_reply` would submit — recipient
 * (Reply-To then From, never multiple), subject (`Re:` prefix, never
 * doubled), threading — from `source` (already fetched, read-only, via
 * `fetchReplySourceHeaders`) and the caller's reply text, and reports
 * eligibility. Makes zero additional IMAP calls and zero SMTP connections.
 * Issues a signed `replyIntentReceipt` when eligible and a send-signing
 * secret is provisioned (the same Keychain secret `mail_send` uses).
 */
export function previewReply(
  source: ReplySourceHeaders,
  params: { text: string },
  authorizedUsername: string,
  signingSecret: Buffer | undefined,
): ReplyPreviewResult {
  const validation = deriveReplyIntent(source, params, authorizedUsername);

  const base = {
    operation: 'mail_reply_preview' as const,
    sourceFolder: source.folder,
    uid: source.uid,
    targetRecipient: validation.intent?.to ?? null,
    derivedSubject: validation.intent?.subject ?? '',
    textLength: params.text.length,
    threadingAvailable: validation.intent?.threadingAvailable ?? false,
  };

  if (!validation.valid || !validation.intent) {
    return { ...base, eligible: false, reasons: validation.reasons };
  }

  if (!signingSecret) {
    return {
      ...base,
      eligible: true,
      reasons: [
        ...validation.reasons,
        'No send-signing secret is provisioned (run scripts/configure-send-signing.sh); no ' +
          'replyIntentReceipt was issued. Live mail_reply fails closed without one.',
      ],
    };
  }

  const sourceFingerprint = computeReplySourceFingerprint(signingSecret, {
    folder: source.folder,
    uidValidity: source.uidValidity,
    uid: source.uid,
    from: source.from,
    subject: source.subject,
    date: source.date,
    messageId: source.messageId,
  });
  const threadingHash = computeThreadingHash(
    validation.intent.inReplyTo,
    validation.intent.references,
  );
  const issuedAt = new Date().toISOString();
  const receipt = signReplyIntentReceipt(
    signingSecret,
    receiptFieldsFromReplyIntent(validation.intent, sourceFingerprint, threadingHash, issuedAt),
  );

  return {
    ...base,
    eligible: true,
    reasons: validation.reasons,
    replyIntentReceipt: receipt,
  };
}
