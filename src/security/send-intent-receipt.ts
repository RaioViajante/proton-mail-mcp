import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { SendIntent } from '../smtp/intent.js';

/**
 * Signed send-intent receipt (0.5.0).
 *
 * ## Why this exists
 *
 * `mail_send_preview` computes exactly what would be sent and reports it;
 * `mail_send` actually submits over SMTP. Nothing structurally ties those
 * two calls together — without a receipt, a caller (or a compromised
 * intermediate step) could preview message A and then call `mail_send` with
 * message B, and this project would have no way to tell the two apart. This
 * receipt is the same fix `restoreReceipt` (`src/security/restore-receipt.ts`)
 * applies to the Trash/restore round-trip, adapted to the preview/send
 * round-trip: `mail_send_preview` signs exactly what it validated, and
 * `mail_send` refuses to submit unless the payload it was given re-derives,
 * field for field, to that exact signed intent.
 *
 * ## Statelessness (through 0.5.0) and the 0.5.1 replay exception
 *
 * Through 0.5.0, this project kept no server-side memory of a previewed
 * send — live submission was unconditionally gated off, so a receipt being
 * replayable had no consequence yet. 0.5.1 lifts that gate, which makes
 * replay a real concern: a receipt is valid for its full
 * {@link SEND_INTENT_RECEIPT_TTL_MS} window, so without something to stop
 * it, a caller (or a buggy/compromised client) calling `mail_send` twice
 * with the same still-valid receipt could submit the same message twice.
 * `id` below (a random per-receipt nonce, included in the signed payload) is
 * the deliberately minimal fix: `src/security/send-intent-replay-guard.ts`
 * keeps a small in-memory, process-lifetime set of already-consumed
 * receipt ids and refuses to submit a second time for the same one. This is
 * an explicit, documented, narrow exception to "no server-side memory" —
 * not a general session/history store, bounded to exactly the TTL window,
 * and gone on process restart (see that module's doc comment and
 * SECURITY.md, "Send-intent receipt replay" for the limitations this
 * accepts). Every other field is authenticated (see "Integrity" below), so
 * a receipt that was not issued by this exact server install, or that was
 * modified in any way after issuance, fails verification and is never
 * trusted.
 *
 * ## Integrity
 *
 * HMAC-SHA256-signed with a per-install secret that lives only in the macOS
 * Keychain (see `src/bridge/config.ts`, `SEND_SIGNING_KEYCHAIN_SERVICE`) —
 * never the Bridge password, never the restore-receipt secret, never written
 * to config.json, never committed. A single signing-only derived subkey is
 * used (unlike `restoreReceipt`, there is no separate "identity" concept
 * here to key independently: this receipt only ever needs to prove "this is
 * exactly the intent I previously validated", not bind itself to some other
 * object's identity).
 *
 * ## Body handling
 *
 * The receipt carries `bodyHash` (SHA-256 of the plain-text body) — never
 * the body itself. This keeps a receipt small and keeps the actual message
 * content out of anything that might end up logged or displayed alongside a
 * receipt.
 *
 * ## Recipient order
 *
 * `to`/`cc` are signed in normalized (case-insensitively sorted) order — see
 * `src/smtp/intent.ts`, `SendIntent.to`/`.cc` — so re-listing the same
 * recipient set in a different order between preview and live never causes a
 * spurious mismatch; adding, removing, or moving an address between `to` and
 * `cc` always does.
 *
 * ## Expiry
 *
 * Unlike a restore receipt (which has no natural staleness window — Trash
 * state doesn't "expire"), a send intent that's hours old is a stronger
 * signal something went wrong in the calling flow. Receipts older than
 * {@link SEND_INTENT_RECEIPT_TTL_MS} are rejected (`expired`), independent
 * of signature validity.
 */
export const SEND_INTENT_RECEIPT_VERSION = 1 as const;

/** 15 minutes — generous for an interactive preview-then-send flow, short enough that a leaked/logged receipt is not a standing capability. */
export const SEND_INTENT_RECEIPT_TTL_MS = 15 * 60 * 1000;

export interface SendIntentReceiptEnvelope {
  v: typeof SEND_INTENT_RECEIPT_VERSION;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  bodyHash: string;
  issuedAt: string;
  /** Random per-receipt nonce (16 bytes, hex) — the replay-guard's single-use key; see "Statelessness" above. Signed like every other field, so it cannot be stripped or swapped without invalidating the signature. */
  id: string;
  signature: string;
}

export const SendIntentReceiptEnvelopeSchema = z
  .object({
    v: z.literal(SEND_INTENT_RECEIPT_VERSION),
    from: z.string().min(1).max(254),
    to: z.array(z.string().min(1).max(254)).max(50),
    cc: z.array(z.string().min(1).max(254)).max(50),
    subject: z.string().max(2000),
    bodyHash: z.string().regex(/^[0-9a-f]{64}$/, 'bodyHash must be a 64-char hex SHA-256 digest'),
    issuedAt: z.string().min(1),
    id: z.string().regex(/^[0-9a-f]{32}$/, 'id must be a 32-char hex nonce'),
    signature: z.string().regex(/^[0-9a-f]{64}$/, 'signature must be a 64-char hex SHA-256 HMAC'),
  })
  .strict();

const SIGNING_KEY_INFO = 'proton-mail-mcp:send-intent-receipt:signature:v1';

function deriveSigningKey(secret: Buffer): Buffer {
  return createHmac('sha256', secret).update(SIGNING_KEY_INFO, 'utf8').digest();
}

function signingPayloadString(fields: Omit<SendIntentReceiptEnvelope, 'signature'>): string {
  // Field order is fixed by this object literal, not derived from caller
  // input, so JSON.stringify is deterministic here without needing a
  // general-purpose canonicalizer — same approach as restore-receipt.ts.
  return JSON.stringify({
    v: fields.v,
    from: fields.from,
    to: fields.to,
    cc: fields.cc,
    subject: fields.subject,
    bodyHash: fields.bodyHash,
    issuedAt: fields.issuedAt,
    id: fields.id,
  });
}

export function signSendIntentReceipt(
  secret: Buffer,
  fields: Omit<SendIntentReceiptEnvelope, 'signature'>,
): SendIntentReceiptEnvelope {
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

export function verifySendIntentReceiptSignature(
  secret: Buffer,
  envelope: SendIntentReceiptEnvelope,
): boolean {
  const key = deriveSigningKey(secret);
  const expected = createHmac('sha256', key)
    .update(signingPayloadString(envelope), 'utf8')
    .digest('hex');
  return hexDigestsEqual(expected, envelope.signature);
}

/** 16 random bytes, hex-encoded — the replay-guard nonce for one receipt. Generated fresh by `mail_send_preview` on every call, never reused, never derived from the intent (so it carries no information about the message). */
export function generateReceiptId(): string {
  return randomBytes(16).toString('hex');
}

/** Builds the unsigned receipt fields from a validated {@link SendIntent} — the single place that maps one shape to the other, so preview and verification can never disagree on what "the intent" means. */
export function receiptFieldsFromIntent(
  intent: SendIntent,
  issuedAt: string,
  id: string = generateReceiptId(),
): Omit<SendIntentReceiptEnvelope, 'signature'> {
  return {
    v: SEND_INTENT_RECEIPT_VERSION,
    from: intent.from,
    to: intent.to,
    cc: intent.cc,
    subject: intent.subject,
    bodyHash: intent.bodyHash,
    issuedAt,
    id,
  };
}

/** True iff every intent-defining field of `envelope` matches `intent` exactly — the "preview of A cannot send B" check, independent of signature/expiry. */
export function receiptMatchesIntent(
  envelope: SendIntentReceiptEnvelope,
  intent: SendIntent,
): boolean {
  return (
    envelope.from === intent.from &&
    envelope.subject === intent.subject &&
    envelope.bodyHash === intent.bodyHash &&
    envelope.to.length === intent.to.length &&
    envelope.to.every((address, index) => address === intent.to[index]) &&
    envelope.cc.length === intent.cc.length &&
    envelope.cc.every((address, index) => address === intent.cc[index])
  );
}

function isExpired(issuedAt: string, now: number): boolean {
  const issuedMs = Date.parse(issuedAt);
  if (Number.isNaN(issuedMs)) {
    return true;
  }
  return now - issuedMs > SEND_INTENT_RECEIPT_TTL_MS || now < issuedMs;
}

/**
 * Reasons are stable codes — never a free-form sentence containing the
 * (untrusted) receipt content — safe to return and to log, mirroring
 * `ReceiptRejectionReason` in restore-receipt.ts.
 */
export type SendReceiptRejectionReason =
  | 'malformedReceipt'
  | 'signingSecretUnavailable'
  | 'signatureInvalid'
  | 'expired'
  | 'intentMismatch';

export type SendReceiptValidationResult =
  | { valid: true; receipt: SendIntentReceiptEnvelope }
  | { valid: false; reason: SendReceiptRejectionReason };

/**
 * Full validation pipeline for one caller-supplied receipt against the
 * intent `mail_send` is about to submit: structure -> signature -> expiry ->
 * exact intent match, in that order — fail closed, first failing check wins.
 * `secret` is `undefined` when this server install has no send-signing
 * secret provisioned yet — that is itself a rejection, never a fallback to
 * trusting the receipt unverified.
 */
export function validateSendIntentReceipt(
  raw: unknown,
  secret: Buffer | undefined,
  intent: SendIntent,
  now: number = Date.now(),
): SendReceiptValidationResult {
  const parsed = SendIntentReceiptEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    return { valid: false, reason: 'malformedReceipt' };
  }
  if (!secret) {
    return { valid: false, reason: 'signingSecretUnavailable' };
  }
  if (!verifySendIntentReceiptSignature(secret, parsed.data)) {
    return { valid: false, reason: 'signatureInvalid' };
  }
  if (isExpired(parsed.data.issuedAt, now)) {
    return { valid: false, reason: 'expired' };
  }
  if (!receiptMatchesIntent(parsed.data, intent)) {
    return { valid: false, reason: 'intentMismatch' };
  }
  return { valid: true, receipt: parsed.data };
}
