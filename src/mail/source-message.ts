import type { ImapFlow } from 'imapflow';
import PostalMime from 'postal-mime';
import { htmlToPlainText } from '../security/untrusted-content.js';
import { hasAttachments } from './messages.js';

/**
 * Minimal, separated source-message fetches for `mail_reply`/`mail_forward`
 * (0.5.2). Deliberately NOT `src/mail/messages.ts`'s `getMessage` (which
 * always does a full RFC822 source fetch + PostalMime parse): reply and
 * forward have very different data needs, and neither reuses that path —
 * see the module-level split below. `mail_get_message`'s existing
 * `MessageDetail` contract is untouched by this file.
 */

/** Any C0 control character or DEL — mirrors `src/smtp/policy.ts`'s identical pattern, duplicated locally to avoid depending on a private constant. */
// eslint-disable-next-line no-control-regex -- matching control characters is the entire point here
const HEADER_CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;

/** Byte bound for the raw `References` header, checked before any parsing — see `src/smtp/reply-intent.ts` for what happens beyond this (per-id validation, `MAX_REFERENCES_COUNT`). */
export const MAX_REFERENCES_HEADER_BYTES = 8192;
/** Byte bound for the raw `Reply-To` header. A legitimate single-address Reply-To is always far under this; anything larger is treated as malformed, never truncated-and-used. */
export const MAX_REPLY_TO_HEADER_BYTES = 4096;
/** Conservative cap on the RFC822 source bytes fetched for a forward — see `fetchForwardSourceContent`'s truncation handling below and README/SECURITY for the documented 0.5.2 limitation this implies. */
export const FORWARD_SOURCE_BYTES_CAP = 512 * 1024;

interface FoldedHeaderResult {
  present: boolean;
  value: string;
  oversized: boolean;
}

/**
 * RFC 5322 header unfolding for a fixed whitelist of header names, mirroring
 * `src/unsubscribe/headers.ts`'s `foldHeaders` but reporting, per header,
 * whether it was present at all — distinct from an empty/absent value — and
 * whether its folded value exceeded the caller-supplied byte bound. Unlike
 * `foldHeaders`'s fixed 8192-char silent truncation, an oversized value here
 * is flagged (`oversized: true`) and never truncated-and-used by a caller.
 */
function foldNamedHeaders(
  raw: Buffer,
  maxBytesByHeader: Readonly<Record<string, number>>,
): Map<string, FoldedHeaderResult> {
  const result = new Map<string, FoldedHeaderResult>();
  const headerNames = new Set(Object.keys(maxBytesByHeader));
  const lines = raw.toString('utf8').split(/\r?\n/);
  let current = '';

  for (const line of lines) {
    if (/^[ \t]/.test(line) && current) {
      const entry = result.get(current);
      if (entry) {
        entry.value = `${entry.value} ${line.trim()}`;
        if (Buffer.byteLength(entry.value, 'utf8') > maxBytesByHeader[current]!) {
          entry.oversized = true;
        }
      }
      continue;
    }
    const colon = line.indexOf(':');
    const name = colon > 0 ? line.slice(0, colon).toLowerCase().trim() : '';
    if (name && headerNames.has(name) && !result.has(name)) {
      current = name;
      const value = line.slice(colon + 1).trim();
      const oversized = Buffer.byteLength(value, 'utf8') > maxBytesByHeader[name]!;
      result.set(name, { present: true, value, oversized });
    } else {
      // Either an unrelated header, or a second occurrence of an
      // already-captured one (first occurrence wins, mirrors foldHeaders) —
      // its continuation lines must not be appended to the wrong entry.
      current = '';
    }
  }
  return result;
}

function uidValidityOf(client: ImapFlow): string | null {
  const mailbox = client.mailbox;
  if (!mailbox || typeof mailbox === 'boolean') return null;
  return mailbox.uidValidity !== undefined ? mailbox.uidValidity.toString() : null;
}

export interface ReplySourceHeaders {
  folder: string;
  uid: number;
  /** `MailboxObject.uidValidity` is a `bigint` — stringified for identity hashing/JSON use. */
  uidValidity: string | null;
  from: string | null;
  /** Raw, internal-only. Never returned from any tool's output — see `src/smtp/reply-intent.ts`. */
  messageId: string | null;
  subject: string | null;
  date: string | null;
  replyTo: {
    /** True iff a `Reply-To` header exists on the source message at all — the sole "absent vs. present" signal (see module doc: `envelope.replyTo` alone cannot be trusted for this per RFC 3501). */
    headerPresent: boolean;
    /** Oversized or contains control characters. When true, `addresses` is always `[]` — the address list is never consulted. */
    malformed: boolean;
    /** IMAP-server-parsed addresses (`envelope.replyTo`), only meaningful when `headerPresent && !malformed`. */
    addresses: string[];
  };
  references: {
    headerPresent: boolean;
    /** Oversized (byte bound exceeded before any per-id parsing). When true, `raw` is `null`. */
    malformed: boolean;
    raw: string | null;
  };
}

/**
 * Fetches only what `mail_reply_preview`/`mail_reply` need to derive a
 * recipient, subject, and threading plan: `ENVELOPE` (cheap — from,
 * messageId, subject, date) plus the raw `References`/`Reply-To` header
 * bytes. **Never fetches the message source, body, or attachment data.**
 * Read-only mailbox lock — never marks the message as read.
 */
export async function fetchReplySourceHeaders(
  client: ImapFlow,
  folder: string,
  uid: number,
): Promise<ReplySourceHeaders | null> {
  const lock = await client.getMailboxLock(folder, { readOnly: true });
  try {
    const uidValidity = uidValidityOf(client);
    const message = await client.fetchOne(
      uid,
      { uid: true, envelope: true, headers: ['references', 'reply-to'] },
      { uid: true },
    );
    if (!message) {
      return null;
    }

    const folded = foldNamedHeaders(message.headers ?? Buffer.alloc(0), {
      references: MAX_REFERENCES_HEADER_BYTES,
      'reply-to': MAX_REPLY_TO_HEADER_BYTES,
    });
    const referencesEntry = folded.get('references');
    const replyToEntry = folded.get('reply-to');

    const replyToMalformed = Boolean(
      replyToEntry &&
      (replyToEntry.oversized || HEADER_CONTROL_CHAR_PATTERN.test(replyToEntry.value)),
    );
    const referencesMalformed = Boolean(referencesEntry?.oversized);

    return {
      folder,
      uid: message.uid,
      uidValidity,
      from: message.envelope?.from?.[0]?.address ?? null,
      messageId: message.envelope?.messageId ?? null,
      subject: message.envelope?.subject ?? null,
      date: message.envelope?.date ? new Date(message.envelope.date).toISOString() : null,
      replyTo: {
        headerPresent: replyToEntry?.present ?? false,
        malformed: replyToMalformed,
        addresses:
          replyToEntry?.present && !replyToMalformed
            ? (message.envelope?.replyTo ?? [])
                .map((address) => address.address)
                .filter((address): address is string => Boolean(address))
            : [],
      },
      references: {
        headerPresent: referencesEntry?.present ?? false,
        malformed: referencesMalformed,
        raw: referencesEntry?.present && !referencesMalformed ? referencesEntry.value : null,
      },
    };
  } finally {
    lock.release();
  }
}

export interface ForwardSourceContent {
  folder: string;
  uid: number;
  uidValidity: string | null;
  from: string | null;
  to: string[];
  /** Raw, internal-only — folds into the source fingerprint, never returned directly. */
  messageId: string | null;
  subject: string | null;
  date: string | null;
  hasAttachments: boolean;
  /**
   * False whenever the fetched RFC822 source cannot be proven complete
   * (the server didn't report a size, or the bounded fetch returned fewer
   * bytes than the message's true total size) — see `fetchForwardSourceContent`.
   * `deriveForwardIntent` (`src/smtp/forward-intent.ts`) treats `false` as an
   * unconditional ineligibility, never a "best effort" partial forward.
   */
  sourceContentComplete: boolean;
  /** Extracted plain text (or HTML-converted fallback); `''` when the source was incomplete, or when the message genuinely has neither a plain-text nor an HTML part. */
  plainText: string;
}

/**
 * Fetches only what `mail_forward_preview`/`mail_forward` need: `ENVELOPE`
 * (cheap), `BODYSTRUCTURE` (structure only — feeds `hasAttachments` without
 * ever downloading attachment content), the server-reported total message
 * size, and a **byte-capped** RFC822 source (`FORWARD_SOURCE_BYTES_CAP`) used
 * only to extract plain text. This is a deliberate trade-off in place of
 * true selective per-MIME-part fetching (see README.md/SECURITY.md) — a
 * documented 0.5.2 limitation, not a silent one: `sourceContentComplete`
 * exists specifically so a truncated fetch is never mistaken for the whole
 * message. Read-only mailbox lock — never marks the message as read.
 */
export async function fetchForwardSourceContent(
  client: ImapFlow,
  folder: string,
  uid: number,
): Promise<ForwardSourceContent | null> {
  const lock = await client.getMailboxLock(folder, { readOnly: true });
  try {
    const uidValidity = uidValidityOf(client);
    const message = await client.fetchOne(
      uid,
      {
        uid: true,
        envelope: true,
        bodyStructure: true,
        size: true,
        source: { maxLength: FORWARD_SOURCE_BYTES_CAP },
      },
      { uid: true },
    );
    if (!message) {
      return null;
    }

    const base = {
      folder,
      uid: message.uid,
      uidValidity,
      from: message.envelope?.from?.[0]?.address ?? null,
      to: (message.envelope?.to ?? [])
        .map((address) => address.address)
        .filter((address): address is string => Boolean(address)),
      messageId: message.envelope?.messageId ?? null,
      subject: message.envelope?.subject ?? null,
      date: message.envelope?.date ? new Date(message.envelope.date).toISOString() : null,
      hasAttachments: hasAttachments(message.bodyStructure),
    };

    // Completeness must be provable, not assumed: no reported size, or fewer
    // bytes returned than the true total, both mean "cannot prove this is
    // the whole message" — fail closed rather than parse a possibly-partial
    // buffer and pretend the result is the full plain text.
    const sourceBytes = message.source?.byteLength ?? 0;
    const sourceContentComplete =
      message.source !== undefined && message.size !== undefined && sourceBytes >= message.size;

    if (!sourceContentComplete || !message.source) {
      return { ...base, sourceContentComplete: false, plainText: '' };
    }

    const parsed = await PostalMime.parse(message.source);
    const plainText = parsed.text?.trim() || (parsed.html ? htmlToPlainText(parsed.html) : '');

    return { ...base, sourceContentComplete: true, plainText };
  } finally {
    lock.release();
  }
}
