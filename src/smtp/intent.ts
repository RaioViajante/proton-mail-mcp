import { createHash } from 'node:crypto';
import {
  addressKey,
  validateBody,
  validateRecipients,
  validateSender,
  validateSubject,
} from './policy.js';

/**
 * A fully validated, normalized "what would actually be sent" — the one
 * shape shared by `mail_send_preview`, `mail_send`, and the send-intent
 * receipt (`src/security/send-intent-receipt.ts`). Building this exactly
 * once and reusing it everywhere is what makes "the receipt matches what's
 * about to be sent" a structural guarantee rather than something each call
 * site has to remember to check consistently.
 */
export interface SendIntent {
  from: string;
  /** Sorted (case-insensitive) — recipient ORDER never changes what a send intent means, only the SET does. See send-intent-receipt.ts. */
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  bodyLength: number;
  /** Hex SHA-256 of `text` (UTF-8) — the receipt carries this, never the body itself. */
  bodyHash: string;
}

export interface RawSendParams {
  from?: string | undefined;
  to: readonly string[];
  cc?: readonly string[] | undefined;
  subject: string;
  text: string;
}

export interface SendIntentValidation {
  valid: boolean;
  reasons: string[];
  intent: SendIntent | null;
}

function sortByAddressKey(addresses: readonly string[]): string[] {
  return [...addresses].sort((a, b) => addressKey(a).localeCompare(addressKey(b)));
}

export function hashBody(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Runs every policy check (sender, recipients, subject, body) and, only if
 * all pass, builds the normalized {@link SendIntent}. Never throws — every
 * failure is collected into `reasons` — so both `mail_send_preview` (which
 * must report eligibility without throwing) and `mail_send` (which returns a
 * structured `rejected` outcome rather than throwing for caller-input
 * problems) can share this one implementation.
 */
export function validateSendIntent(
  params: RawSendParams,
  authorizedUsername: string,
): SendIntentValidation {
  const reasons: string[] = [];

  const senderResult = validateSender(params.from, authorizedUsername);
  reasons.push(...senderResult.reasons);

  const recipientResult = validateRecipients(params.to, params.cc ?? []);
  reasons.push(...recipientResult.reasons);

  const subjectResult = validateSubject(params.subject);
  reasons.push(...subjectResult.reasons);

  const bodyResult = validateBody(params.text);
  reasons.push(...bodyResult.reasons);

  const valid =
    senderResult.valid && recipientResult.valid && subjectResult.valid && bodyResult.valid;

  if (!valid || !senderResult.from) {
    return { valid: false, reasons, intent: null };
  }

  const intent: SendIntent = {
    from: senderResult.from,
    to: sortByAddressKey(recipientResult.to),
    cc: sortByAddressKey(recipientResult.cc),
    subject: params.subject,
    text: params.text,
    bodyLength: params.text.length,
    bodyHash: hashBody(params.text),
  };

  return { valid: true, reasons, intent };
}
