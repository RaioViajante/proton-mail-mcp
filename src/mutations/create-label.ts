import type { ImapFlow } from 'imapflow';
import { mutationFailureMessage } from './error.js';
import { validateCustomMailboxName } from './folders.js';
import { findNameConflict, LABELS_CONTAINER } from './policy.js';

export interface CreateLabelParams {
  name: string;
  dryRun: boolean;
}

export interface CreateLabelResult {
  operation: 'mail_create_label';
  dryRun: boolean;
  path: string;
  alreadyExists: boolean;
  created: boolean;
  conflictType?: 'folder' | 'label';
  conflictingPath?: string;
}

/** Creates only a flat label mailbox; it never opens or changes a message. */
export async function createLabel(
  client: ImapFlow,
  { name, dryRun }: CreateLabelParams,
): Promise<CreateLabelResult> {
  validateCustomMailboxName(name, 'Label');
  const folders = await client.list();
  const delimiter = folders[0]?.delimiter ?? '/';
  validateCustomMailboxName(name, 'Label', delimiter);
  const path = [LABELS_CONTAINER, name].join(delimiter);

  // Prefer an exact label duplicate when the listing contains conflicting
  // names in both namespaces; then apply the shared account-wide policy.
  const existing = folders.find((folder) => folder.path === path);
  const conflict = existing
    ? { type: 'label' as const, path: existing.path }
    : findNameConflict(folders, name, delimiter);
  if (conflict) {
    return {
      operation: 'mail_create_label',
      dryRun,
      path,
      alreadyExists: true,
      created: false,
      conflictType: conflict.type,
      conflictingPath: conflict.path,
    };
  }

  if (dryRun) {
    return { operation: 'mail_create_label', dryRun, path, alreadyExists: false, created: false };
  }

  let response: Awaited<ReturnType<ImapFlow['mailboxCreate']>>;
  try {
    response = await client.mailboxCreate([LABELS_CONTAINER, name]);
  } catch {
    throw new Error(mutationFailureMessage('mailboxOperationFailed'));
  }
  return {
    operation: 'mail_create_label',
    dryRun,
    path: response.path,
    alreadyExists: false,
    created: response.created,
  };
}
