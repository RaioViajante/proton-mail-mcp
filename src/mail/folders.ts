import type { ImapFlow } from 'imapflow';

export interface MailFolder {
  path: string;
  name: string;
  specialUse?: string;
}

/** Lists mailboxes via IMAP LIST. Does not open or lock any mailbox. */
export async function listFolders(client: ImapFlow): Promise<MailFolder[]> {
  const entries = await client.list();
  return entries.map((entry) => ({
    path: entry.path,
    name: entry.name,
    ...(entry.specialUse ? { specialUse: entry.specialUse } : {}),
  }));
}
