import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { generateReceiptId } from './send-intent-receipt.js';
import type { ReplyIntent } from '../smtp/reply-intent.js';

/**
 * Signed reply-intent receipt (0.5.2), the same preview/send binding
 * `send-intent-receipt.ts` provides for `mail_send`, adapted for
 * `mail_reply_preview` → `mail_reply`. Signed with the SAME Keychain secret
 * `mail_send` uses (`SEND_SIGNING_KEYCHAIN_SERVICE` /
 * `getSendIntentSigningSecretOrUndefined`, `src/bridge/config.ts` — no new
 * Keychain entry is provisioned for this), but with its OWN domain-separated
 * `SIGNING_KEY_INFO` string, so a valid `sendIntentReceipt` can never verify
 * as a reply receipt or vice versa even if their JSON payloads happened to
 * overlap in shape — see SECURITY.md ("Receipt cross-purpose attacks").
 *
 * ## Source identity vs. threading (0.5.2 design)
 *
 * `sourceFingerprint` binds `folder`/`uidValidity`/`uid` (the durable IMAP
 * identity handle) plus `from`/`subject`/`date` for tamper-evidence —
 * `messageId` is folded in ONLY when the source message has one, but is
 * never required: a message with no (or a malformed) `Message-ID` still gets
 * a fully valid, computable fingerprint and a normal, eligible (if
 * unthreaded) reply. Threading availability is an entirely separate
 * property — see `src/smtp/reply-intent.ts`.
 *
 * ## What is never in this receipt
 *
 * No raw Message-ID, no source message body, no signing secret. `to` is
 * always exactly one address (see `src/smtp/reply-intent.ts` — reply-all is
 * structurally absent, never just policy).
 */
export const REPLY_INTENT_RECEIPT_VERSION = 1 as const;

/** Same window as `send-intent-receipt.ts` — see its rationale. */
export const REPLY_INTENT_RECEIPT_TTL_MS = 15 * 60 * 1000;

export interface ReplyIntentReceiptEnvelope {
  v: typeof REPLY_INTENT_RECEIPT_VERSION;
  sourceFingerprint: string;
  sourceFolder: string;
  to: string;
  subject: string;
  bodyHash: string;
  threadingHash: string;
  from: string;
  issuedAt: string;
  id: string;
  signature: string;
}

export const ReplyIntentReceiptEnvelopeSchema = z
  .object({
    v: z.literal(REPLY_INTENT_RECEIPT_VERSION),
    sourceFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    sourceFolder: z.string().min(1).max(500),
    to: z.string().min(1).max(254),
    subject: z.string().max(2000),
    bodyHash: z.string().regex(/^[0-9a-f]{64}$/),
    threadingHash: z.string().regex(/^[0-9a-f]{64}$/),
    from: z.string().min(1).max(254),
    issuedAt: z.string().min(1),
    id: z.string().regex(/^[0-9a-f]{32}$/),
    signature: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

const SIGNING_KEY_INFO = 'proton-mail-mcp:reply-intent-receipt:signature:v1';
const FINGERPRINT_KEY_INFO = 'proton-mail-mcp:reply-intent-receipt:source-fingerprint:v1';

function deriveSigningKey(secret: Buffer): Buffer {
  return createHmac('sha256', secret).update(SIGNING_KEY_INFO, 'utf8').digest();
}

function deriveFingerprintKey(secret: Buffer): Buffer {
  return createHmac('sha256', secret).update(FINGERPRINT_KEY_INFO, 'utf8').digest();
}

export interface ReplySourceIdentityInput {
  folder: string;
  uidValidity: string | null;
  uid: number;
  from: string | null;
  subject: string | null;
  date: string | null;
  /** Optional — a missing Message-ID never blocks fingerprint computation. */
  messageId: string | null;
}

/**
 * HMAC-SHA256, keyed via its own domain-separated subkey — never a plain
 * hash — so a fingerprint cannot be produced or checked without the
 * send-signing secret. `messageId` is an optional extra input, never
 * required: see the module doc's "Source identity vs. threading" note.
 */
export function computeReplySourceFingerprint(
  secret: Buffer,
  input: ReplySourceIdentityInput,
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

function signingPayloadString(fields: Omit<ReplyIntentReceiptEnvelope, 'signature'>): string {
  return JSON.stringify({
    v: fields.v,
    sourceFingerprint: fields.sourceFingerprint,
    sourceFolder: fields.sourceFolder,
    to: fields.to,
    subject: fields.subject,
    bodyHash: fields.bodyHash,
    threadingHash: fields.threadingHash,
    from: fields.from,
    issuedAt: fields.issuedAt,
    id: fields.id,
  });
}

export function signReplyIntentReceipt(
  secret: Buffer,
  fields: Omit<ReplyIntentReceiptEnvelope, 'signature'>,
): ReplyIntentReceiptEnvelope {
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

export function verifyReplyIntentReceiptSignature(
  secret: Buffer,
  envelope: ReplyIntentReceiptEnvelope,
): boolean {
  const key = deriveSigningKey(secret);
  const expected = createHmac('sha256', key)
    .update(signingPayloadString(envelope), 'utf8')
    .digest('hex');
  return hexDigestsEqual(expected, envelope.signature);
}

export function receiptFieldsFromReplyIntent(
  intent: ReplyIntent,
  sourceFingerprint: string,
  threadingHash: string,
  issuedAt: string,
  id: string = generateReceiptId(),
): Omit<ReplyIntentReceiptEnvelope, 'signature'> {
  return {
    v: REPLY_INTENT_RECEIPT_VERSION,
    sourceFingerprint,
    sourceFolder: intent.sourceFolder,
    to: intent.to,
    subject: intent.subject,
    bodyHash: intent.bodyHash,
    threadingHash,
    from: intent.from,
    issuedAt,
    id,
  };
}

export function receiptMatchesReplyIntent(
  envelope: ReplyIntentReceiptEnvelope,
  intent: ReplyIntent,
  sourceFingerprint: string,
  threadingHash: string,
): boolean {
  return (
    envelope.sourceFingerprint === sourceFingerprint &&
    envelope.sourceFolder === intent.sourceFolder &&
    envelope.to === intent.to &&
    envelope.subject === intent.subject &&
    envelope.bodyHash === intent.bodyHash &&
    envelope.threadingHash === threadingHash &&
    envelope.from === intent.from
  );
}

function isExpired(issuedAt: string, now: number): boolean {
  const issuedMs = Date.parse(issuedAt);
  if (Number.isNaN(issuedMs)) {
    return true;
  }
  return now - issuedMs > REPLY_INTENT_RECEIPT_TTL_MS || now < issuedMs;
}

export type ReplyReceiptRejectionReason =
  | 'malformedReceipt'
  | 'signingSecretUnavailable'
  | 'signatureInvalid'
  | 'expired'
  | 'intentMismatch';

export type ReplyReceiptValidationResult =
  | { valid: true; receipt: ReplyIntentReceiptEnvelope }
  | { valid: false; reason: ReplyReceiptRejectionReason };

/**
 * Full validation pipeline, fail-closed, first failing check wins: structure
 * -> signature -> expiry -> exact intent+identity+threading match. A
 * `sendIntentReceipt` or `forwardIntentReceipt` fails at either the schema
 * (different field set) or, even for an accidentally-compatible payload, the
 * signature check (different derived key) — never reaches intent matching.
 */
export function validateReplyIntentReceipt(
  raw: unknown,
  secret: Buffer | undefined,
  intent: ReplyIntent,
  sourceFingerprint: string,
  threadingHash: string,
  now: number = Date.now(),
): ReplyReceiptValidationResult {
  const parsed = ReplyIntentReceiptEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    return { valid: false, reason: 'malformedReceipt' };
  }
  if (!secret) {
    return { valid: false, reason: 'signingSecretUnavailable' };
  }
  if (!verifyReplyIntentReceiptSignature(secret, parsed.data)) {
    return { valid: false, reason: 'signatureInvalid' };
  }
  if (isExpired(parsed.data.issuedAt, now)) {
    return { valid: false, reason: 'expired' };
  }
  if (!receiptMatchesReplyIntent(parsed.data, intent, sourceFingerprint, threadingHash)) {
    return { valid: false, reason: 'intentMismatch' };
  }
  return { valid: true, receipt: parsed.data };
}
