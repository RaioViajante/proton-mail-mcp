import type { ImapFlow } from 'imapflow';
import { moveMessagesCore } from './move.js';
import { resolveSpecialFolders } from './policy.js';
import type { MutationResult } from './result.js';

export interface ArchiveParams {
  folder: string;
  uids: number[];
  dryRun: boolean;
}

export async function archiveMessages(
  client: ImapFlow,
  { folder, uids, dryRun }: ArchiveParams,
): Promise<MutationResult> {
  const folders = await client.list();
  const special = resolveSpecialFolders(folders);

  if (!special.archive) {
    throw new Error('Could not find an Archive folder on this account.');
  }
  if (folder === special.archive) {
    throw new Error('The source folder is already Archive; there is nothing to archive.');
  }

  return moveMessagesCore(
    client,
    { sourceFolder: folder, destinationFolder: special.archive, uids, dryRun },
    'mail_archive',
    folders,
  );
}
