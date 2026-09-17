import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { PRESERVABLE_FLAGS, type PreservableFlag } from '../mutations/flags.js';

/**
 * Durable restore receipt (0.4.2).
 *
 * ## Why this exists
 *
 * A live finding against 0.4.1 showed Trash is not an authoritative source
 * for "the message's original state": Proton Bridge can drop a message's
 * labels *asynchronously*, sometime after `mail_trash`'s own immediate
 * post-move check already reported them intact. By the time
 * `mail_restore_from_trash` later measured Trash's "before" state for that
 * same message, the labels were already gone — so 0.4.1's automatic
 * preservation had nothing to restore, and reported a clean, fully-repaired
 * result while two labels were permanently lost. See README.md ("Async
 * label loss: why Trash is not authoritative") and SECURITY.md.
 *
 * The fix is to capture the pre-Trash snapshot once, at `mail_trash` time —
 * before any possible async decay — and hand it back to the caller as a
 * signed, opaque receipt. `mail_restore_from_trash` accepts that receipt
 * back and, once verified, treats it as authoritative in place of whatever
 * Trash happens to show by restore time.
 *
 * ## Statelessness
 *
 * This project keeps no server-side history of trashed messages. The
 * receipt is the caller's problem to hold onto between the two calls — the
 * server that issued it does not remember it existed. What makes this safe
 * despite the receipt therefore round-tripping through an untrusted
 * caller/model is that every field is authenticated (see "Integrity" below):
 * a receipt that was not issued by this exact server install, or that was
 * modified in any way after issuance, fails verification and is never
 * trusted for automatic repair.
 *
 * ## Integrity
 *
 * Every receipt is HMAC-SHA256-signed with a per-install secret that lives
 * only in the macOS Keychain (see `src/bridge/config.ts`,
 * `RECEIPT_SIGNING_KEYCHAIN_SERVICE`) — never the Bridge IMAP password,
 * never written to config.json, never committed. Two independent subkeys are
 * derived from that one secret via HMAC (a minimal HKDF-like construction,
 * `node:crypto` only, no extra dependency) so the "sign the receipt" and
 * "fingerprint this Message-ID" operations never reuse the same key
 * material for two different purposes:
 *
 * - a **signing key**, covering every field below `signature`;
 * - an **identity key**, used only to derive `identity` from the message's
 *   `Message-ID` header.
 *
 * `identity` is a *keyed* fingerprint (HMAC), not a bare `sha256(Message-ID)`
 * hash — without the install secret, a keyed fingerprint cannot be
 * dictionary-attacked or correlated across receipts the way a plain hash
 * could be. It travels only inside the receipt itself; nothing in this
 * project returns it as a separate top-level field.
 *
 * ## Identity binding
 *
 * The raw `Message-ID` header is never included in the receipt, never
 * logged, and never returned by any tool in this project — only its keyed
 * fingerprint. `mail_restore_from_trash` re-derives the same fingerprint
 * from the live Trash message's current `Message-ID` and compares it,
 * constant-time, against the receipt's `identity` before trusting anything
 * else in it. A mismatch — the receipt was issued for a different message,
 * whether by an honest mistake or a deliberate swap — fails closed: the
 * receipt is rejected outright and no label or flag is ever applied from
 * it. See `verifyRestoreReceipt` in `src/mutations/restore.ts` usage.
 */
export const RESTORE_RECEIPT_VERSION = 1 as const;

export interface RestoreReceiptEnvelope {
  v: typeof RESTORE_RECEIPT_VERSION;
  /** The folder the message was trashed FROM — informational, and the optional basis for restore-to-original-source. */
  sourceFolder: string;
  /** Full label membership immediately before the Trash move (sorted, deduplicated). */
  originalLabels: string[];
  /** Preservable flags (`\Seen`, `\Flagged`) immediately before the Trash move. */
  originalFlags: PreservableFlag[];
  /** Keyed (HMAC) fingerprint of the message's Message-ID — never the raw header. */
  identity: string;
  /** ISO-8601 timestamp of when this receipt was issued. */
  issuedAt: string;
  /** Hex HMAC-SHA256 over every field above, using a signing-only derived subkey. */
  signature: string;
}

export const RestoreReceiptEnvelopeSchema = z
  .object({
    v: z.literal(RESTORE_RECEIPT_VERSION),
    sourceFolder: z.string().min(1),
    // Bounded well above any realistic label count on one message — defense
    // in depth against a malformed/oversized receipt being parsed at all,
    // not a limit this project expects a real account to ever approach.
    originalLabels: z.array(z.string().min(1).max(200)).max(200),
    originalFlags: z.array(z.enum(PRESERVABLE_FLAGS)),
    identity: z.string().regex(/^[0-9a-f]{64}$/, 'identity must be a 64-char hex SHA-256 HMAC'),
    issuedAt: z.string().min(1),
    signature: z.string().regex(/^[0-9a-f]{64}$/, 'signature must be a 64-char hex SHA-256 HMAC'),
  })
  .strict();

const SIGNING_KEY_INFO = 'proton-mail-mcp:restore-receipt:signature:v1';
const IDENTITY_KEY_INFO = 'proton-mail-mcp:restore-receipt:identity:v1';

/** Minimal HKDF-like subkey derivation: HMAC(secret, purpose-specific info string). */
function deriveSubkey(secret: Buffer, info: string): Buffer {
  return createHmac('sha256', secret).update(info, 'utf8').digest();
}

/** Message-IDs are compared byte-for-byte after trimming surrounding whitespace only — never lowercased (the local part is case-sensitive per RFC 5322). */
export function normalizeMessageId(messageId: string): string {
  return messageId.trim();
}

export function deriveIdentityFingerprint(secret: Buffer, messageId: string): string {
  const key = deriveSubkey(secret, IDENTITY_KEY_INFO);
  return createHmac('sha256', key).update(normalizeMessageId(messageId), 'utf8').digest('hex');
}

function signingPayloadString(fields: Omit<RestoreReceiptEnvelope, 'signature'>): string {
  // Field order is fixed by this object literal, not derived from caller
  // input, so JSON.stringify is deterministic here without needing a
  // general-purpose canonicalizer.
  return JSON.stringify({
    v: fields.v,
    sourceFolder: fields.sourceFolder,
    originalLabels: fields.originalLabels,
    originalFlags: fields.originalFlags,
    identity: fields.identity,
    issuedAt: fields.issuedAt,
  });
}

export function signRestoreReceipt(
  secret: Buffer,
  fields: Omit<RestoreReceiptEnvelope, 'signature'>,
): RestoreReceiptEnvelope {
  const key = deriveSubkey(secret, SIGNING_KEY_INFO);
  const signature = createHmac('sha256', key)
    .update(signingPayloadString(fields), 'utf8')
    .digest('hex');
  return { ...fields, signature };
}

/** Constant-time comparison of two hex-encoded digests of potentially-differing length. */
function hexDigestsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function verifyRestoreReceiptSignature(
  secret: Buffer,
  envelope: RestoreReceiptEnvelope,
): boolean {
  const key = deriveSubkey(secret, SIGNING_KEY_INFO);
  const expected = createHmac('sha256', key)
    .update(signingPayloadString(envelope), 'utf8')
    .digest('hex');
  return hexDigestsEqual(expected, envelope.signature);
}

export function identityFingerprintMatches(
  secret: Buffer,
  envelope: RestoreReceiptEnvelope,
  liveMessageId: string,
): boolean {
  const expected = deriveIdentityFingerprint(secret, liveMessageId);
  return hexDigestsEqual(expected, envelope.identity);
}

/**
 * Outcome of validating a caller-supplied receipt against the live Trash
 * message it's being used for. Every rejection reason is a stable code —
 * never a sentence containing the (untrusted) receipt content — safe to
 * return and to log.
 */
export type ReceiptRejectionReason =
  | 'malformedReceipt'
  | 'unsupportedVersion'
  | 'signingSecretUnavailable'
  | 'signatureInvalid'
  | 'noMessageIdToVerify'
  | 'identityMismatch';

export type ReceiptValidationResult =
  | { valid: true; receipt: RestoreReceiptEnvelope }
  | { valid: false; reason: ReceiptRejectionReason };

/**
 * Full validation pipeline for one caller-supplied receipt: structure ->
 * signature -> identity, in that order, matching the "fail closed" model —
 * the first failing check wins and nothing downstream is even attempted.
 * `secret` is `undefined` when this server install has no receipt-signing
 * secret provisioned yet (see `getReceiptSigningSecretOrUndefined` in
 * `src/bridge/config.ts`) — that is itself a rejection, not a fallback to
 * trusting the receipt unverified.
 */
export function validateRestoreReceipt(
  raw: unknown,
  secret: Buffer | undefined,
  liveMessageId: string | undefined,
): ReceiptValidationResult {
  const parsed = RestoreReceiptEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    // z.literal(RESTORE_RECEIPT_VERSION) already rejects an unsupported
    // version as a structural mismatch; both are reported the same way,
    // since neither can be interpreted further.
    return { valid: false, reason: 'malformedReceipt' };
  }
  if (!secret) {
    return { valid: false, reason: 'signingSecretUnavailable' };
  }
  if (!verifyRestoreReceiptSignature(secret, parsed.data)) {
    return { valid: false, reason: 'signatureInvalid' };
  }
  if (!liveMessageId) {
    return { valid: false, reason: 'noMessageIdToVerify' };
  }
  if (!identityFingerprintMatches(secret, parsed.data, liveMessageId)) {
    return { valid: false, reason: 'identityMismatch' };
  }
  return { valid: true, receipt: parsed.data };
}
