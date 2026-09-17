import type { ForwardSourceContent } from '../mail/source-message.js';
import { FORWARD_SOURCE_BYTES_CAP } from '../mail/source-message.js';
import { MAX_BODY_CHARS } from '../security/untrusted-content.js';
import { hashBody } from './intent.js';
import {
  addressKey,
  normalizeEmailAddress,
  validateBody,
  validateRecipients,
  validateSubject,
} from './policy.js';
import { applyPrefixOnce, FWD_PREFIX_PATTERN } from './subject-prefix.js';
import type { SmtpMessage } from './transport.js';

/**
 * Pure forward-intent derivation (0.5.2) — the forward analogue of
 * `src/smtp/reply-intent.ts`'s `deriveReplyIntent`, shared identically by
 * `previewForward` and `sendForward`'s revalidation step.
 *
 * Recipients are ALWAYS caller-supplied (`validateRecipients`, reused
 * unchanged from `mail_send`'s policy) — never derived from the source
 * message in any way. Subject is always derived (`Fwd:`), never
 * caller-chosen. Content is plain-text only, deterministic, and treats the
 * source message as DATA: nothing in it is ever interpreted as an
 * instruction, and none of `wrapUntrustedText`'s internal
 * `UNTRUSTED_EMAIL_WARNING` framing is embedded in the actual outgoing
 * email — the human recipient gets a normal forwarded message, not internal
 * MCP security copy.
 */

const MAX_FORWARDED_HEADER_FIELD_LENGTH = 500;

function sortByAddressKey(addresses: readonly string[]): string[] {
  return [...addresses].sort((a, b) => addressKey(a).localeCompare(addressKey(b)));
}

/**
 * Normalizes a value shown inside the forwarded header block to a single
 * safe line: control characters (including CR/LF) collapsed to a space,
 * whitespace collapsed, length-capped. This is an anti-spoofing measure — a
 * malicious source header can never inject fake extra "From:"/"To:" lines
 * into the visible forwarded block — not a security boundary for the model.
 */
function sanitizeForwardedHeaderField(raw: string | null): string {
  if (!raw) return '(unknown)';
  // A fresh literal each call — see reply-intent.ts's identical note on why
  // a shared module-level global regex is never reused for `.replace`.
  // eslint-disable-next-line no-control-regex -- matching control characters is the entire point here
  const controlChars = /[\x00-\x1f\x7f]/g;
  const collapsed = raw.replace(controlChars, ' ').replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return '(unknown)';
  return collapsed.length > MAX_FORWARDED_HEADER_FIELD_LENGTH
    ? collapsed.slice(0, MAX_FORWARDED_HEADER_FIELD_LENGTH)
    : collapsed;
}

function buildForwardedBlock(source: ForwardSourceContent, boundedText: string): string {
  const from = sanitizeForwardedHeaderField(source.from);
  const date = sanitizeForwardedHeaderField(source.date);
  const subject = sanitizeForwardedHeaderField(source.subject);
  const to = sanitizeForwardedHeaderField(source.to.length > 0 ? source.to.join(', ') : null);
  return [
    '---------- Forwarded message ----------',
    `From: ${from}`,
    `Date: ${date}`,
    `Subject: ${subject}`,
    `To: ${to}`,
    '',
    boundedText,
  ].join('\n');
}

export interface ForwardIntent {
  from: string;
  /** Sorted (case-insensitive), deduped, caller-supplied — never from the source message. */
  to: string[];
  subject: string;
  introText: string;
  forwardedBlock: string;
  /** `introText + "\n\n" + forwardedBlock`, or just `forwardedBlock` with no intro. */
  text: string;
  bodyLength: number;
  introHash: string;
  forwardedContentHash: string;
  sourceFolder: string;
  sourceHasAttachments: boolean;
}

export interface ForwardIntentValidation {
  valid: boolean;
  reasons: string[];
  intent: ForwardIntent | null;
}

/**
 * Content-completeness/size checks are unconditional ineligibility gates,
 * never silent shortening (0.5.2, corrected per review): a `source` whose
 * RFC822 fetch could not be proven complete, or one with no
 * plain-text/HTML content at all, or one whose extracted text exceeds the
 * outbound bound, all make the forward `ineligible` rather than partially
 * or truncated forwarded.
 */
export function deriveForwardIntent(
  source: ForwardSourceContent,
  params: { to: string[]; text?: string | undefined },
  authorizedUsername: string,
): ForwardIntentValidation {
  const reasons: string[] = [];

  const from = normalizeEmailAddress(authorizedUsername);
  if (!from) {
    reasons.push('The configured Bridge account username is not a valid email address.');
  }

  const recipientResult = validateRecipients(params.to, []);
  reasons.push(...recipientResult.reasons);

  const rawIntro = params.text ?? '';
  let introText = '';
  let introValid = true;
  if (rawIntro.length > 0) {
    const introValidation = validateBody(rawIntro);
    introValid = introValidation.valid;
    reasons.push(...introValidation.reasons);
    if (introValidation.valid) {
      introText = rawIntro;
    }
  }

  // eslint-disable-next-line no-control-regex -- matching control characters is the entire point here
  const safeSourceSubject = (source.subject ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  const derivedSubject = applyPrefixOnce(safeSourceSubject, FWD_PREFIX_PATTERN, 'Fwd: ');
  const subjectResult = validateSubject(derivedSubject);
  reasons.push(...subjectResult.reasons);

  if (!source.sourceContentComplete) {
    reasons.push(
      'Source message content could not be confirmed complete within the 0.5.2 size bound ' +
        `(${FORWARD_SOURCE_BYTES_CAP} bytes); forwarding a possibly-partial message is refused.`,
    );
  } else if (source.plainText.length === 0) {
    reasons.push('Source message has no plain-text or HTML content available to forward.');
  } else if (source.plainText.length > MAX_BODY_CHARS) {
    reasons.push(
      `Forwarded content (${source.plainText.length} chars) exceeds the ${MAX_BODY_CHARS}-char ` +
        'outbound bound for this version; it will not be silently shortened.',
    );
  }

  const contentUsable =
    source.sourceContentComplete &&
    source.plainText.length > 0 &&
    source.plainText.length <= MAX_BODY_CHARS;

  const valid =
    Boolean(from) && recipientResult.valid && introValid && subjectResult.valid && contentUsable;

  if (!valid || !from) {
    return { valid: false, reasons, intent: null };
  }

  const forwardedBlock = buildForwardedBlock(source, source.plainText);
  const text = introText.length > 0 ? `${introText}\n\n${forwardedBlock}` : forwardedBlock;

  const intent: ForwardIntent = {
    from,
    to: sortByAddressKey(recipientResult.to),
    subject: derivedSubject,
    introText,
    forwardedBlock,
    text,
    bodyLength: text.length,
    introHash: hashBody(introText),
    forwardedContentHash: hashBody(forwardedBlock),
    sourceFolder: source.folder,
    sourceHasAttachments: source.hasAttachments,
  };

  return { valid: true, reasons, intent };
}

/** Pure, independently-testable SMTP message construction — no attachments, no threading headers, no caller-overridable fields beyond what `deriveForwardIntent` already validated. */
export function buildForwardMessage(intent: ForwardIntent): SmtpMessage {
  return {
    from: intent.from,
    to: intent.to,
    cc: [],
    subject: intent.subject,
    text: intent.text,
  };
}
