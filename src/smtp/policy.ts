/**
 * Validation and normalization primitives for `mail_send` / `mail_send_preview`
 * (0.5.0). Every function here is pure and side-effect-free — no IMAP, no
 * SMTP, no IO — so the exact same validation runs identically in preview and
 * in live send, and can be unit-tested directly. See `src/smtp/intent.ts`
 * for how these combine into one send intent.
 */

/** Combined To+Cc ceiling (0.5.0 conservative default — see README.md). */
export const MAX_SEND_RECIPIENTS = 5;
/** Plain-text subject only; no header folding in this version, so this is comfortably under one unfolded RFC 5322 line. */
export const MAX_SUBJECT_LENGTH = 500;
/** Plain-text body ceiling (0.5.0) — generous for a real message, small enough to bound cost/blast radius of a single send. */
export const MAX_BODY_LENGTH = 50_000;

/** Any C0 control character or DEL — never legal in a header value or an address; the concrete CRLF-injection defense. */
// eslint-disable-next-line no-control-regex -- matching control characters is the entire point here
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;

/**
 * Deliberately conservative — rejects the wide long tail of technically
 * legal-but-obscure RFC 5322 address forms (quoted local parts, comments)
 * rather than trying to accept everything real mail servers accept. This
 * project generates addresses for outbound mail it composes itself, not a
 * general-purpose address parser: a narrower grammar here is strictly a
 * smaller attack surface, never a functionality regression this version
 * depends on.
 */
const ADDRESS_PATTERN =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/;

export interface FieldValidation {
  valid: boolean;
  reasons: string[];
}

function ok(): FieldValidation {
  return { valid: true, reasons: [] };
}

function fail(...reasons: string[]): FieldValidation {
  return { valid: false, reasons };
}

/**
 * Normalizes one address for comparison/storage: trims surrounding
 * whitespace only — never lowercases the local part (case-sensitive per RFC
 * 5322) — and rejects anything containing a control character (CR, LF,
 * NUL, ...) before it can ever reach a header. Returns `null` for anything
 * structurally unsafe or not address-shaped; callers must treat `null` as a
 * rejection, never a "best effort" pass-through.
 */
export function normalizeEmailAddress(raw: string): string | null {
  if (CONTROL_CHAR_PATTERN.test(raw)) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 254) {
    return null;
  }
  if (!ADDRESS_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/** Case-insensitive per RFC 5321 §2.4 recommendation for comparing whole addresses in this project's own dedup/authorization checks (this project never relies on local-part case sensitivity for any decision). */
export function addressKey(address: string): string {
  return address.toLowerCase();
}

/**
 * Sender policy (0.5.0): `From` is never caller-controlled beyond
 * confirming it matches the one mailbox identity this Bridge account
 * actually is — there is no reliable, simple way to enumerate additional
 * Bridge-authorized aliases, so this project takes the most conservative
 * option named in the task: exactly the configured account identity, never
 * anything else. See SECURITY.md ("Sender identity is never caller-chosen").
 */
export function validateSender(
  rawFrom: string | undefined,
  authorizedUsername: string,
): { valid: boolean; from: string | null; reasons: string[] } {
  const authorized = normalizeEmailAddress(authorizedUsername);
  if (!authorized) {
    return {
      valid: false,
      from: null,
      reasons: ['The configured Bridge account username is not a valid email address.'],
    };
  }
  if (rawFrom === undefined) {
    return { valid: true, from: authorized, reasons: [] };
  }
  const normalized = normalizeEmailAddress(rawFrom);
  if (!normalized) {
    return { valid: false, from: null, reasons: ['"from" is not a valid email address.'] };
  }
  if (addressKey(normalized) !== addressKey(authorized)) {
    return {
      valid: false,
      from: null,
      reasons: [
        `"from" must be the configured Bridge account identity ("${authorized}"); arbitrary ` +
          'sender addresses are never permitted (see SECURITY.md, "Sender identity is never ' +
          'caller-chosen").',
      ],
    };
  }
  return { valid: true, from: authorized, reasons: [] };
}

export interface RecipientValidation {
  valid: boolean;
  to: string[];
  cc: string[];
  reasons: string[];
}

/**
 * Recipient policy (0.5.0): explicit inputs only (never derived from a
 * message body — the caller passing addresses is the only path in), each
 * address individually validated/normalized, deduplicated across To+Cc
 * combined (case-insensitive), and capped at {@link MAX_SEND_RECIPIENTS}
 * total. No automatic expansion of any kind (no mailing lists, no "reply
 * all" style derivation).
 */
export function validateRecipients(
  rawTo: readonly string[],
  rawCc: readonly string[] = [],
): RecipientValidation {
  const reasons: string[] = [];

  if (rawTo.length === 0) {
    reasons.push('"to" must contain at least one recipient.');
  }

  const seen = new Set<string>();
  const to: string[] = [];
  const cc: string[] = [];
  let malformed = false;
  let duplicates = false;

  for (const raw of rawTo) {
    const normalized = normalizeEmailAddress(raw);
    if (!normalized) {
      malformed = true;
      continue;
    }
    const key = addressKey(normalized);
    if (seen.has(key)) {
      duplicates = true;
      continue;
    }
    seen.add(key);
    to.push(normalized);
  }
  for (const raw of rawCc) {
    const normalized = normalizeEmailAddress(raw);
    if (!normalized) {
      malformed = true;
      continue;
    }
    const key = addressKey(normalized);
    if (seen.has(key)) {
      duplicates = true;
      continue;
    }
    seen.add(key);
    cc.push(normalized);
  }

  if (malformed) {
    reasons.push('One or more recipient addresses are malformed or contain control characters.');
  }
  if (duplicates) {
    reasons.push('Duplicate recipients (after normalization) were removed from the request.');
  }

  const total = to.length + cc.length;
  if (total > MAX_SEND_RECIPIENTS) {
    reasons.push(
      `At most ${MAX_SEND_RECIPIENTS} recipients are allowed between "to" and "cc" combined ` +
        `(got ${total}).`,
    );
  }

  const valid =
    rawTo.length > 0 && !malformed && to.length + cc.length > 0 && total <= MAX_SEND_RECIPIENTS;
  return { valid, to, cc, reasons };
}

/** Subject policy (0.5.0): non-empty, bounded, and no control characters of any kind — the CRLF-header-injection defense for this field. */
export function validateSubject(rawSubject: string): FieldValidation {
  if (CONTROL_CHAR_PATTERN.test(rawSubject)) {
    return fail('"subject" must not contain control characters (including CR/LF).');
  }
  const trimmed = rawSubject.trim();
  if (trimmed.length === 0) {
    return fail('"subject" must not be empty.');
  }
  if (rawSubject.length > MAX_SUBJECT_LENGTH) {
    return fail(`"subject" must be at most ${MAX_SUBJECT_LENGTH} characters.`);
  }
  return ok();
}

/**
 * Body policy (0.5.0): plain text only, UTF-8, non-empty, bounded. This
 * project never interprets a caller-supplied body as anything other than
 * literal message content — it is composed into the outbound message
 * verbatim, never executed, evaluated, or treated as an instruction (see
 * SECURITY.md, "Untrusted input cannot expand a send" — the caller here is
 * trusted input, but the same non-interpretation rule the read path applies
 * to untrusted email bodies applies symmetrically here to what this project
 * ever does with body text).
 */
/** An unpaired UTF-16 surrogate cannot round-trip through UTF-8 (it gets silently replaced with U+FFFD) — reject rather than send a corrupted body. */
const LONE_SURROGATE_PATTERN =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function validateBody(rawText: string): FieldValidation {
  if (rawText.length === 0) {
    return fail('"text" must not be empty.');
  }
  if (rawText.length > MAX_BODY_LENGTH) {
    return fail(`"text" must be at most ${MAX_BODY_LENGTH} characters.`);
  }
  if (LONE_SURROGATE_PATTERN.test(rawText)) {
    return fail('"text" contains an invalid (unpaired) UTF-16 surrogate.');
  }
  return ok();
}
