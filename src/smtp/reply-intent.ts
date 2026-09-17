import { createHash } from 'node:crypto';
import type { ReplySourceHeaders } from '../mail/source-message.js';
import { hashBody } from './intent.js';
import { normalizeEmailAddress, validateBody, validateSubject } from './policy.js';
import { applyPrefixOnce, RE_PREFIX_PATTERN } from './subject-prefix.js';
import type { SmtpMessage } from './transport.js';

/**
 * Pure reply-intent derivation (0.5.2) — the reply analogue of
 * `src/smtp/intent.ts`'s `validateSendIntent`, shared identically by
 * `previewReply` and `sendReply`'s revalidation step so the two can never
 * disagree about what a given source message + caller text means.
 *
 * No `cc`, no caller-supplied `from`, no caller-supplied subject or
 * threading headers — every one of those is either fixed (`from` is always
 * the Bridge identity) or derived (subject, `to`, threading) from the
 * source message and this module alone. This is what makes "reply-all" and
 * "caller overrides threading" structurally absent, not just policy.
 */

/** Deliberately conservative RFC 5322 msg-id shape: `<local@domain>`, no nested angle brackets, no whitespace. Rejects the long tail rather than trying to accept every technically-legal form — same philosophy as `policy.ts`'s `ADDRESS_PATTERN`. */
export const MESSAGE_ID_PATTERN = /^<[^\s<>@]+@[^\s<>]+>$/;
export const MAX_MESSAGE_ID_LENGTH = 256;
/** Cap on the number of ids kept in a rebuilt `References` chain (oldest dropped first when a valid existing chain plus the new id would exceed this). */
export const MAX_REFERENCES_COUNT = 20;

function isValidMessageId(id: string): boolean {
  return id.length <= MAX_MESSAGE_ID_LENGTH && MESSAGE_ID_PATTERN.test(id);
}

/** `null` return means "unparseable as a whole" — see the module doc on why a partially-bad References header is discarded entirely rather than filtered id-by-id. */
function parseReferences(raw: string): string[] | null {
  const tokens = raw.split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return [];
  }
  for (const token of tokens) {
    if (!isValidMessageId(token)) {
      return null;
    }
  }
  return tokens;
}

function buildReferencesChain(existingIds: string[], sourceMessageId: string): string[] {
  const deduped = [...new Set(existingIds)];
  const combined = deduped.includes(sourceMessageId) ? deduped : [...deduped, sourceMessageId];
  if (combined.length <= MAX_REFERENCES_COUNT) {
    return combined;
  }
  // Keep the most recent ids (the tail) plus the newly-appended source id,
  // which is always last after the dedup/append above.
  return combined.slice(combined.length - MAX_REFERENCES_COUNT);
}

export interface ThreadingPlan {
  threadingAvailable: boolean;
  inReplyTo: string | null;
  references: string[];
}

/**
 * Threading is fully independent of recipient/subject/body eligibility —
 * see `src/security/reply-intent-receipt.ts`'s module doc. A missing or
 * malformed source Message-ID never makes a reply ineligible; it only
 * yields `threadingAvailable: false`. When the Message-ID IS valid but the
 * existing `References` chain is malformed/oversized, the historical chain
 * is discarded and replaced with exactly `[sourceMessageId]` — nothing
 * invented, only a chain that could not be trusted is not propagated.
 */
export function deriveThreading(source: ReplySourceHeaders): ThreadingPlan {
  const sourceId = source.messageId;
  if (!sourceId || !isValidMessageId(sourceId)) {
    return { threadingAvailable: false, inReplyTo: null, references: [] };
  }

  const noUsableChain =
    !source.references.headerPresent ||
    source.references.malformed ||
    source.references.raw === null;
  if (noUsableChain) {
    return { threadingAvailable: true, inReplyTo: sourceId, references: [sourceId] };
  }

  const parsedIds = parseReferences(source.references.raw!);
  if (parsedIds === null) {
    return { threadingAvailable: true, inReplyTo: sourceId, references: [sourceId] };
  }

  return {
    threadingAvailable: true,
    inReplyTo: sourceId,
    references: buildReferencesChain(parsedIds, sourceId),
  };
}

export function computeThreadingHash(inReplyTo: string | null, references: string[]): string {
  return createHash('sha256')
    .update(JSON.stringify({ inReplyTo, references }), 'utf8')
    .digest('hex');
}

interface RecipientResolution {
  recipient: string | null;
  recipientSource: 'replyTo' | 'from' | null;
  reasons: string[];
}

/**
 * Reply-To (if present, present means the raw header exists — see
 * `src/mail/source-message.ts`, not merely a non-empty `envelope.replyTo`)
 * then From, exactly one resulting address, never derived from the message
 * body. A present-but-unusable Reply-To (malformed, zero, or multiple
 * addresses) fails closed — it never silently falls back to From. A
 * self-sent source message (`From` is the caller's own identity, no
 * Reply-To) naturally resolves to replying to oneself; nothing alternate is
 * ever invented.
 */
function deriveRecipient(source: ReplySourceHeaders): RecipientResolution {
  if (source.replyTo.headerPresent) {
    if (source.replyTo.malformed) {
      return {
        recipient: null,
        recipientSource: null,
        reasons: [
          'Reply-To header is malformed (oversized or contains control characters); refusing to ' +
            'guess a recipient.',
        ],
      };
    }
    if (source.replyTo.addresses.length === 0) {
      return {
        recipient: null,
        recipientSource: null,
        reasons: [
          'Reply-To header is present but no usable address could be parsed from it; no From ' +
            'fallback is applied once a Reply-To header exists.',
        ],
      };
    }
    if (source.replyTo.addresses.length > 1) {
      return {
        recipient: null,
        recipientSource: null,
        reasons: [
          'Reply-To specifies multiple addresses; this project never replies to more than one ' +
            'recipient (no reply-all).',
        ],
      };
    }
    const normalized = normalizeEmailAddress(source.replyTo.addresses[0]!);
    if (!normalized) {
      return {
        recipient: null,
        recipientSource: null,
        reasons: ['Reply-To address failed validation.'],
      };
    }
    return { recipient: normalized, recipientSource: 'replyTo', reasons: [] };
  }

  if (!source.from) {
    return {
      recipient: null,
      recipientSource: null,
      reasons: ['Source message has no From address and no Reply-To header; no viable recipient.'],
    };
  }
  const normalizedFrom = normalizeEmailAddress(source.from);
  if (!normalizedFrom) {
    return {
      recipient: null,
      recipientSource: null,
      reasons: ['Source message From address failed validation; no viable recipient.'],
    };
  }
  return { recipient: normalizedFrom, recipientSource: 'from', reasons: [] };
}

export interface ReplyIntent {
  from: string;
  /** Always exactly one address — see `deriveRecipient`. */
  to: string;
  recipientSource: 'replyTo' | 'from';
  subject: string;
  text: string;
  bodyLength: number;
  bodyHash: string;
  sourceFolder: string;
  threadingAvailable: boolean;
  /** Internal — never returned from any tool output. */
  inReplyTo: string | null;
  /** Internal — never returned from any tool output. */
  references: string[];
}

export interface ReplyIntentValidation {
  valid: boolean;
  reasons: string[];
  intent: ReplyIntent | null;
}

export function deriveReplyIntent(
  source: ReplySourceHeaders,
  params: { text: string },
  authorizedUsername: string,
): ReplyIntentValidation {
  const reasons: string[] = [];

  const from = normalizeEmailAddress(authorizedUsername);
  if (!from) {
    reasons.push('The configured Bridge account username is not a valid email address.');
  }

  const recipientResult = deriveRecipient(source);
  reasons.push(...recipientResult.reasons);

  const bodyResult = validateBody(params.text);
  reasons.push(...bodyResult.reasons);

  // A fresh literal each call, never a shared module-level global regex — a
  // stateful shared global regex's `lastIndex` would silently skip matches
  // on later calls.
  // eslint-disable-next-line no-control-regex -- matching control characters is the entire point here
  const safeSourceSubject = (source.subject ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  const derivedSubject = applyPrefixOnce(safeSourceSubject, RE_PREFIX_PATTERN, 'Re: ');
  const subjectResult = validateSubject(derivedSubject);
  reasons.push(...subjectResult.reasons);

  const threading = deriveThreading(source);

  const valid =
    Boolean(from) && Boolean(recipientResult.recipient) && bodyResult.valid && subjectResult.valid;

  if (!valid || !from || !recipientResult.recipient || !recipientResult.recipientSource) {
    return { valid: false, reasons, intent: null };
  }

  const intent: ReplyIntent = {
    from,
    to: recipientResult.recipient,
    recipientSource: recipientResult.recipientSource,
    subject: derivedSubject,
    text: params.text,
    bodyLength: params.text.length,
    bodyHash: hashBody(params.text),
    sourceFolder: source.folder,
    threadingAvailable: threading.threadingAvailable,
    inReplyTo: threading.inReplyTo,
    references: threading.references,
  };

  return { valid: true, reasons, intent };
}

/**
 * Pure, independently-testable SMTP message construction from an already-derived
 * intent — proves "caller cannot override threading headers" without ever
 * needing the live feature gate open: nothing here reads any caller input
 * other than what `deriveReplyIntent` already validated.
 */
export function buildReplyMessage(intent: ReplyIntent): SmtpMessage {
  return {
    from: intent.from,
    to: [intent.to],
    cc: [],
    subject: intent.subject,
    text: intent.text,
    ...(intent.threadingAvailable && intent.inReplyTo
      ? { inReplyTo: intent.inReplyTo, references: intent.references }
      : {}),
  };
}
