import type { ImapFlow, SearchObject } from 'imapflow';
import { type MessageSummary, toSummary } from './messages.js';

export interface SearchMailParams {
  folder: string;
  from?: string | undefined;
  to?: string | undefined;
  subject?: string | undefined;
  text?: string | undefined;
  since?: string | undefined;
  before?: string | undefined;
  unreadOnly: boolean;
  limit: number;
}

function buildQuery(params: SearchMailParams): SearchObject {
  const query: SearchObject = {};
  if (params.from) query.from = params.from;
  if (params.to) query.to = params.to;
  if (params.subject) query.subject = params.subject;
  if (params.text) query.text = params.text;
  if (params.since) query.since = params.since;
  if (params.before) query.before = params.before;
  if (params.unreadOnly) query.seen = false;
  if (Object.keys(query).length === 0) query.all = true;
  return query;
}

/**
 * Searches a single folder using structured IMAP SEARCH criteria. The search
 * itself only returns matching UIDs (no full-mailbox scan); only the last
 * `limit` matches are then fetched for their summary metadata. Opens the
 * mailbox read-only, so searching never sets \Seen.
 */
export async function searchMail(
  client: ImapFlow,
  params: SearchMailParams,
): Promise<MessageSummary[]> {
  const lock = await client.getMailboxLock(params.folder, { readOnly: true });
  try {
    const mailbox = client.mailbox;
    if (!mailbox || mailbox.exists === 0) {
      return [];
    }

    const uids = await client.search(buildQuery(params), { uid: true });
    if (!uids || uids.length === 0) {
      return [];
    }

    const selected = uids.slice(-params.limit);
    const summaries: MessageSummary[] = [];
    for await (const message of client.fetch(
      selected,
      { uid: true, envelope: true, flags: true, bodyStructure: true },
      { uid: true },
    )) {
      summaries.push(toSummary(message));
    }

    summaries.sort((a, b) => b.uid - a.uid);
    return summaries.slice(0, params.limit);
  } finally {
    lock.release();
  }
}
