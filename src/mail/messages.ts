import type {
  FetchMessageObject,
  ImapFlow,
  MessageAddressObject,
  MessageStructureObject,
} from 'imapflow';
import PostalMime from 'postal-mime';
import type { Address } from 'postal-mime';
import { htmlToPlainText, wrapUntrustedText } from '../security/untrusted-content.js';

export interface MessageSummary {
  uid: number;
  from: string | null;
  to: string[];
  subject: string | null;
  date: string | null;
  unread: boolean;
  hasAttachments: boolean;
}

export interface MessageDetail {
  uid: number;
  from: string | null;
  to: string[];
  subject: string | null;
  date: string | null;
  body: {
    warning: string;
    text: string;
    truncated: boolean;
    originalLength: number;
    representation: 'plain' | 'html-converted' | 'none';
  };
  attachments: AttachmentMeta[];
}

export interface AttachmentMeta {
  filename: string | null;
  contentType: string;
  sizeBytes: number | null;
}

export interface ListMessagesParams {
  folder: string;
  limit: number;
  unreadOnly: boolean;
}

/**
 * Safety cap on the raw RFC822 source fetched for a single message, guarding
 * memory use against a pathologically large message. This is independent of
 * (and larger than) {@link import('../security/untrusted-content.js').MAX_BODY_CHARS},
 * which bounds the text actually returned to the caller.
 */
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;

function formatEnvelopeAddress(address: MessageAddressObject | undefined): string | null {
  if (!address) return null;
  if (address.name && address.address) return `${address.name} <${address.address}>`;
  return address.address ?? address.name ?? null;
}

function formatParsedAddress(address: Address | undefined): string | null {
  if (!address) return null;
  if (address.group) {
    return address.name || null;
  }
  return address.name ? `${address.name} <${address.address}>` : address.address;
}

function attachmentSizeBytes(content: ArrayBuffer | Uint8Array | string): number | null {
  if (content instanceof ArrayBuffer || content instanceof Uint8Array) {
    return content.byteLength;
  }
  return null;
}

/** Exported for reuse by `src/mail/source-message.ts` (forward's attachment detection) — this walker never reads attachment content, only `bodyStructure` metadata. */
export function nodeHasOwnAttachment(node: MessageStructureObject): boolean {
  if (node.disposition === 'attachment') return true;
  if (node.type.startsWith('multipart/')) return false;
  const filename = node.dispositionParameters?.filename ?? node.parameters?.name;
  return Boolean(filename) && node.disposition !== 'inline';
}

export function hasAttachments(node: MessageStructureObject | undefined): boolean {
  if (!node) return false;
  if (nodeHasOwnAttachment(node)) return true;
  return (node.childNodes ?? []).some(hasAttachments);
}

export function toSummary(message: FetchMessageObject): MessageSummary {
  const envelope = message.envelope;
  return {
    uid: message.uid,
    from: formatEnvelopeAddress(envelope?.from?.[0]),
    to: (envelope?.to ?? [])
      .map((address) => formatEnvelopeAddress(address))
      .filter((address): address is string => address !== null),
    subject: envelope?.subject ?? null,
    date: envelope?.date ? new Date(envelope.date).toISOString() : null,
    unread: !(message.flags?.has('\\Seen') ?? false),
    hasAttachments: hasAttachments(message.bodyStructure),
  };
}

/**
 * Lists the most recent messages in a folder without ever fetching the whole
 * mailbox: the non-unread path selects a bounded sequence-number range
 * (`total-limit+1:*`) and the unread path narrows via IMAP SEARCH before
 * fetching. Opens the mailbox read-only, so listing never sets \Seen.
 */
export async function listMessages(
  client: ImapFlow,
  params: ListMessagesParams,
): Promise<MessageSummary[]> {
  const lock = await client.getMailboxLock(params.folder, { readOnly: true });
  try {
    const mailbox = client.mailbox;
    if (!mailbox || mailbox.exists === 0) {
      return [];
    }

    const summaries: MessageSummary[] = [];

    if (params.unreadOnly) {
      const uids = await client.search({ seen: false }, { uid: true });
      if (!uids || uids.length === 0) {
        return [];
      }
      const selected = uids.slice(-params.limit);
      for await (const message of client.fetch(
        selected,
        { uid: true, envelope: true, flags: true, bodyStructure: true },
        { uid: true },
      )) {
        summaries.push(toSummary(message));
      }
    } else {
      const total = mailbox.exists;
      const start = Math.max(1, total - params.limit + 1);
      for await (const message of client.fetch(`${start}:*`, {
        uid: true,
        envelope: true,
        flags: true,
        bodyStructure: true,
      })) {
        summaries.push(toSummary(message));
      }
    }

    summaries.sort((a, b) => b.uid - a.uid);
    return summaries.slice(0, params.limit);
  } finally {
    lock.release();
  }
}

/**
 * Fetches a single message by its persistent UID and returns safe metadata
 * plus a bounded, explicitly-untrusted plain-text body. Opens the mailbox
 * read-only, so reading a message never sets \Seen. Attachment binaries are
 * never fetched or returned — only metadata derived from the parsed MIME
 * structure.
 */
export async function getMessage(
  client: ImapFlow,
  folder: string,
  uid: number,
): Promise<MessageDetail> {
  const lock = await client.getMailboxLock(folder, { readOnly: true });
  try {
    const message = await client.fetchOne(
      uid,
      { uid: true, source: { maxLength: MAX_SOURCE_BYTES } },
      { uid: true },
    );

    if (!message || !message.source) {
      throw new Error(`Message with UID ${uid} was not found in folder "${folder}".`);
    }

    const parsed = await PostalMime.parse(message.source);

    const plainText = parsed.text?.trim() ?? '';
    let representation: MessageDetail['body']['representation'];
    let rawBody: string;
    if (plainText.length > 0) {
      representation = 'plain';
      rawBody = plainText;
    } else if (parsed.html) {
      representation = 'html-converted';
      rawBody = htmlToPlainText(parsed.html);
    } else {
      representation = 'none';
      rawBody = '';
    }

    const { warning, text, truncated, originalLength } = wrapUntrustedText(rawBody);

    return {
      uid: message.uid,
      from: formatParsedAddress(parsed.from),
      to: (parsed.to ?? [])
        .map((address) => formatParsedAddress(address))
        .filter((address): address is string => address !== null),
      subject: parsed.subject ?? null,
      date: parsed.date ?? null,
      body: { warning, text, truncated, originalLength, representation },
      attachments: parsed.attachments.map((attachment) => ({
        filename: attachment.filename,
        contentType: attachment.mimeType,
        sizeBytes: attachmentSizeBytes(attachment.content),
      })),
    };
  } finally {
    lock.release();
  }
}
