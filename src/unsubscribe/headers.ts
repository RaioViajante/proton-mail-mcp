import type { ImapFlow } from 'imapflow';

/**
 * Fetches exactly the headers `mail_unsubscribe_preview` / `mail_unsubscribe`
 * need for a single message, by explicit UID. Deliberately self-contained
 * rather than reusing `analysis/metadata.ts`'s bulk header folder: this is a
 * security-decision path (eligibility + authentication signal for an
 * external HTTP side effect), and keeping its header parsing isolated makes
 * it easier to audit on its own, independent of the unrelated triage/stats
 * feature. The mailbox is always opened read-only — this module never marks
 * a message as read and never mutates anything.
 */

const UNSUBSCRIBE_HEADER_NAMES = [
  'list-id',
  'list-unsubscribe',
  'list-unsubscribe-post',
  'authentication-results',
  'dkim-signature',
];

export interface RawUnsubscribeHeaders {
  listId: string | undefined;
  listUnsubscribe: string | undefined;
  listUnsubscribePost: string | undefined;
  /**
   * Only the FIRST (topmost) occurrence is kept. A compliant receiving MTA
   * (Proton's own) prepends its own Authentication-Results header on
   * receipt, so the topmost occurrence is the receiving system's own
   * verdict — never a sender-forged header further down the stack. See
   * SECURITY.md ("Authentication trust boundary").
   */
  authenticationResults: string | undefined;
  dkimSignaturePresent: boolean;
}

export interface ResolvedUnsubscribeMessage {
  uid: number;
  messageId: string | undefined;
  fromDomain: string | null;
  headers: RawUnsubscribeHeaders;
}

/** RFC 5322 header unfolding: a line starting with whitespace continues the previous header. */
function foldHeaders(raw: Buffer): Map<string, string> {
  const result = new Map<string, string>();
  const lines = raw.toString('utf8').split(/\r?\n/);
  let current = '';
  for (const line of lines) {
    if (/^[ \t]/.test(line) && current) {
      result.set(current, `${result.get(current) ?? ''} ${line.trim()}`.slice(0, 8192));
      continue;
    }
    const colon = line.indexOf(':');
    current = colon > 0 ? line.slice(0, colon).toLowerCase().trim() : '';
    if (current && UNSUBSCRIBE_HEADER_NAMES.includes(current) && !result.has(current)) {
      result.set(
        current,
        line
          .slice(colon + 1)
          .trim()
          .slice(0, 8192),
      );
    } else if (!current || !UNSUBSCRIBE_HEADER_NAMES.includes(current)) {
      current = '';
    }
  }
  return result;
}

function extractDomain(address: string | undefined): string | null {
  if (!address) return null;
  const at = address.lastIndexOf('@');
  if (at < 0 || at === address.length - 1) return null;
  return address.slice(at + 1).toLowerCase();
}

/**
 * Fetches one message's identity (UID, Message-ID, From domain) and
 * unsubscribe-relevant headers. Returns undefined if the UID no longer
 * exists in `folder` — callers must treat that as "cannot proceed", never as
 * an empty-but-eligible result.
 */
export async function fetchUnsubscribeHeaders(
  client: ImapFlow,
  folder: string,
  uid: number,
): Promise<ResolvedUnsubscribeMessage | undefined> {
  const lock = await client.getMailboxLock(folder, { readOnly: true });
  try {
    const message = await client.fetchOne(
      uid,
      { uid: true, envelope: true, headers: UNSUBSCRIBE_HEADER_NAMES },
      { uid: true },
    );
    if (!message) {
      return undefined;
    }
    const folded = foldHeaders(message.headers ?? Buffer.alloc(0));
    return {
      uid: message.uid,
      messageId: message.envelope?.messageId,
      fromDomain: extractDomain(message.envelope?.from?.[0]?.address),
      headers: {
        listId: folded.get('list-id'),
        listUnsubscribe: folded.get('list-unsubscribe'),
        listUnsubscribePost: folded.get('list-unsubscribe-post'),
        authenticationResults: folded.get('authentication-results'),
        dkimSignaturePresent: folded.has('dkim-signature'),
      },
    };
  } finally {
    lock.release();
  }
}

/** True when every header the eligibility decision depends on is byte-identical to a prior fetch. Used for revalidation immediately before the network side effect. */
export function headersIdentical(a: RawUnsubscribeHeaders, b: RawUnsubscribeHeaders): boolean {
  return (
    a.listUnsubscribe === b.listUnsubscribe &&
    a.listUnsubscribePost === b.listUnsubscribePost &&
    a.authenticationResults === b.authenticationResults &&
    a.dkimSignaturePresent === b.dkimSignaturePresent
  );
}
