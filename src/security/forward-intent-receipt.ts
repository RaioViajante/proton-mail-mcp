import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { generateReceiptId } from './send-intent-receipt.js';
import type { ForwardIntent } from '../smtp/forward-intent.js';

/**
 * Signed forward-intent receipt (0.5.2) — the forward analogue of
 * `src/security/reply-intent-receipt.ts`; see that module's doc for the
 * shared design rationale (same Keychain secret as `mail_send`, own
 * domain-separated `SIGNING_KEY_INFO`/fingerprint-key strings, source
 * identity independent of Message-ID). This receipt additionally binds
 * `sourceHasAttachments`, so a live forward's required
 * `acknowledgeAttachmentsWillBeOmitted` flag can be checked against exactly
 * what was previewed, not a caller's unverified claim.
 */
export const FORWARD_INTENT_RECEIPT_VERSION = 1 as const;
export const FORWARD_INTENT_RECEIPT_TTL_MS = 15 * 60 * 1000;

export interface ForwardIntentReceiptEnvelope {
  v: typeof FORWARD_INTENT_RECEIPT_VERSION;
  sourceFingerprint: string;
  sourceFolder: string;
  to: string[];
  subject: string;
  introHash: string;
  forwardedContentHash: string;
  sourceHasAttachments: boolean;
  from: string;
  issuedAt: string;
  id: string;
  signature: string;
}

export const ForwardIntentReceiptEnvelopeSchema = z
  .object({
    v: z.literal(FORWARD_INTENT_RECEIPT_VERSION),
    sourceFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    sourceFolder: z.string().min(1).max(500),
    to: z.array(z.string().min(1).max(254)).min(1).max(50),
    subject: z.string().max(2000),
    introHash: z.string().regex(/^[0-9a-f]{64}$/),
    forwardedContentHash: z.string().regex(/^[0-9a-f]{64}$/),
    sourceHasAttachments: z.boolean(),
    from: z.string().min(1).max(254),
    issuedAt: z.string().min(1),
    id: z.string().regex(/^[0-9a-f]{32}$/),
    signature: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

const SIGNING_KEY_INFO = 'proton-mail-mcp:forward-intent-receipt:signature:v1';
const FINGERPRINT_KEY_INFO = 'proton-mail-mcp:forward-intent-receipt:source-fingerprint:v1';

function deriveSigningKey(secret: Buffer): Buffer {
  return createHmac('sha256', secret).update(SIGNING_KEY_INFO, 'utf8').digest();
}

function deriveFingerprintKey(secret: Buffer): Buffer {
  return createHmac('sha256', secret).update(FINGERPRINT_KEY_INFO, 'utf8').digest();
}

export interface ForwardSourceIdentityInput {
  folder: string;
  uidValidity: string | null;
  uid: number;
  from: string | null;
  subject: string | null;
  date: string | null;
  /** Optional — never required for identity, mirrors `reply-intent-receipt.ts`. */
  messageId: string | null;
}

export function computeForwardSourceFingerprint(
  secret: Buffer,
  input: ForwardSourceIdentityInput,
): string {
  const key = deriveFingerprintKey(secret);
  const payload = JSON.stringify({
    folder: input.folder,
    uidValidity: input.uidValidity,
    uid: input.uid,
    from: input.from,
    subject: input.subject,
    date: input.date,
    messageId: input.messageId,
  });
  return createHmac('sha256', key).update(payload, 'utf8').digest('hex');
}

function signingPayloadString(fields: Omit<ForwardIntentReceiptEnvelope, 'signature'>): string {
  return JSON.stringify({
    v: fields.v,
    sourceFingerprint: fields.sourceFingerprint,
    sourceFolder: fields.sourceFolder,
    to: fields.to,
    subject: fields.subject,
    introHash: fields.introHash,
    forwardedContentHash: fields.forwardedContentHash,
    sourceHasAttachments: fields.sourceHasAttachments,
    from: fields.from,
    issuedAt: fields.issuedAt,
    id: fields.id,
  });
}

export function signForwardIntentReceipt(
  secret: Buffer,
  fields: Omit<ForwardIntentReceiptEnvelope, 'signature'>,
): ForwardIntentReceiptEnvelope {
  const key = deriveSigningKey(secret);
  const signature = createHmac('sha256', key)
    .update(signingPayloadString(fields), 'utf8')
    .digest('hex');
  return { ...fields, signature };
}

function hexDigestsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function verifyForwardIntentReceiptSignature(
  secret: Buffer,
  envelope: ForwardIntentReceiptEnvelope,
): boolean {
  const key = deriveSigningKey(secret);
  const expected = createHmac('sha256', key)
    .update(signingPayloadString(envelope), 'utf8')
    .digest('hex');
  return hexDigestsEqual(expected, envelope.signature);
}

export function receiptFieldsFromForwardIntent(
  intent: ForwardIntent,
  sourceFingerprint: string,
  issuedAt: string,
  id: string = generateReceiptId(),
): Omit<ForwardIntentReceiptEnvelope, 'signature'> {
  return {
    v: FORWARD_INTENT_RECEIPT_VERSION,
    sourceFingerprint,
    sourceFolder: intent.sourceFolder,
    to: intent.to,
    subject: intent.subject,
    introHash: intent.introHash,
    forwardedContentHash: intent.forwardedContentHash,
    sourceHasAttachments: intent.sourceHasAttachments,
    from: intent.from,
    issuedAt,
    id,
  };
}

export function receiptMatchesForwardIntent(
  envelope: ForwardIntentReceiptEnvelope,
  intent: ForwardIntent,
  sourceFingerprint: string,
): boolean {
  return (
    envelope.sourceFingerprint === sourceFingerprint &&
    envelope.sourceFolder === intent.sourceFolder &&
    envelope.to.length === intent.to.length &&
    envelope.to.every((address, index) => address === intent.to[index]) &&
    envelope.subject === intent.subject &&
    envelope.introHash === intent.introHash &&
    envelope.forwardedContentHash === intent.forwardedContentHash &&
    envelope.sourceHasAttachments === intent.sourceHasAttachments &&
    envelope.from === intent.from
  );
}

function isExpired(issuedAt: string, now: number): boolean {
  const issuedMs = Date.parse(issuedAt);
  if (Number.isNaN(issuedMs)) {
    return true;
  }
  return now - issuedMs > FORWARD_INTENT_RECEIPT_TTL_MS || now < issuedMs;
}

export type ForwardReceiptRejectionReason =
  | 'malformedReceipt'
  | 'signingSecretUnavailable'
  | 'signatureInvalid'
  | 'expired'
  | 'intentMismatch';

export type ForwardReceiptValidationResult =
  | { valid: true; receipt: ForwardIntentReceiptEnvelope }
  | { valid: false; reason: ForwardReceiptRejectionReason };

export function validateForwardIntentReceipt(
  raw: unknown,
  secret: Buffer | undefined,
  intent: ForwardIntent,
  sourceFingerprint: string,
  now: number = Date.now(),
): ForwardReceiptValidationResult {
  const parsed = ForwardIntentReceiptEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    return { valid: false, reason: 'malformedReceipt' };
  }
  if (!secret) {
    return { valid: false, reason: 'signingSecretUnavailable' };
  }
  if (!verifyForwardIntentReceiptSignature(secret, parsed.data)) {
    return { valid: false, reason: 'signatureInvalid' };
  }
  if (isExpired(parsed.data.issuedAt, now)) {
    return { valid: false, reason: 'expired' };
  }
  if (!receiptMatchesForwardIntent(parsed.data, intent, sourceFingerprint)) {
    return { valid: false, reason: 'intentMismatch' };
  }
  return { valid: true, receipt: parsed.data };
}
