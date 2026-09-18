import type { ImapFlow } from 'imapflow';
import { mutationFailureMessage } from './error.js';
import {
  assertCreateFolderParentAllowed,
  customFolderPathFromSegments,
  findNameConflict,
  resolveSpecialFolders,
} from './policy.js';

export interface CreateFolderParams {
  name: string;
  /** Logical name of an existing custom folder to nest under, e.g. "Projects" — NOT a raw path like "Folders/Projects". */
  parent?: string | undefined;
  dryRun: boolean;
}

/**
 * Not a {@link import('./result.js').MutationResult}: folder creation has no
 * UID batch, so forcing it into that shape would be misleading. This is its
 * own small, purpose-fit result instead.
 */
export interface CreateFolderResult {
  operation: 'mail_create_folder';
  dryRun: boolean;
  path: string;
  alreadyExists: boolean;
  created: boolean;
  /** Set exactly when alreadyExists is true — what kind of existing mailbox the name collides with. */
  conflictType?: 'folder' | 'label';
  /** Set exactly when alreadyExists is true — the real Bridge path of the colliding mailbox. */
  conflictingPath?: string;
}

const RESERVED_NAMES = new Set([
  'inbox',
  'archive',
  'spam',
  'junk',
  'trash',
  'sent',
  'sent mail',
  'drafts',
  'all mail',
  'starred',
  'labels',
  'folders',
]);

export function validateCustomMailboxName(
  name: string,
  kind: 'Folder' | 'Label',
  delimiter = '/',
): void {
  if (name.trim().length === 0) {
    throw new Error(`${kind} name must not be empty.`);
  }
  if (name.trim() !== name) {
    throw new Error(`${kind} name must not have leading or trailing whitespace.`);
  }
  if ([...name].some((character) => character.charCodeAt(0) < 32 || character === '\x7f')) {
    throw new Error(`${kind} name must not contain control characters.`);
  }
  if (name === '.' || name === '..' || name.includes('/') || name.includes(delimiter)) {
    throw new Error(`${kind} name must not contain a path delimiter or traversal segment.`);
  }
  if (RESERVED_NAMES.has(name.toLowerCase())) {
    throw new Error(`"${name}" is a reserved ${kind.toLowerCase()} name.`);
  }
}

export function validateFolderName(name: string, delimiter = '/'): void {
  validateCustomMailboxName(name, 'Folder', delimiter);
}

/**
 * Creates a custom Proton folder.
 *
 * Every custom folder lives under Bridge's fixed `Folders/` namespace —
 * confirmed live: `CREATE "MCP Test"` at the true IMAP root was rejected by
 * Bridge itself ("invalid mailbox name [...]: operation not allowed"). This
 * is documented Proton/Bridge behavior, not a bug (see README.md "Proton
 * Bridge namespace: Folders/ and Labels/").
 *
 * Callers give a logical `name` and an optional logical `parent` — the name
 * of an *existing* custom folder to nest under, e.g. `"Projects"`, never a
 * raw path like `"Folders/Projects"`. This module is the only place that
 * prepends the `Folders` namespace (via `customFolderPathFromSegments`), so
 * there is no code path here that can create at IMAP root, under `Labels`,
 * or under a system folder — the real path is always built from logical
 * segments, never accepted as a caller-supplied full path.
 *
 * Also checks, locally and before ever issuing IMAP CREATE, for the
 * cross-namespace name collision confirmed live: Proton rejects a folder
 * name already used by a label (or vice versa), even though they are
 * physically different Bridge mailboxes — see `findNameConflict()` in
 * policy.ts. A collision (same-path duplicate OR cross-namespace) is
 * reported as `alreadyExists` with `conflictType`/`conflictingPath`, in
 * dry-run and live alike, and never reaches `mailboxCreate`.
 *
 * Resolves and validates everything even in dry-run; only `dryRun: false`
 * and no conflict calls `mailboxCreate`.
 *
 * The path shown for a dry-run preview is built from the first listed
 * folder's delimiter, since ImapFlow only resolves the authoritative
 * delimiter internally when `mailboxCreate` actually runs. This should match
 * in practice (IMAP servers use one consistent delimiter), but is a
 * best-effort preview, not a guarantee — see README.md ("Known Proton
 * Bridge limitations").
 */
export async function createFolder(
  client: ImapFlow,
  { name, parent, dryRun }: CreateFolderParams,
): Promise<CreateFolderResult> {
  validateFolderName(name);
  if (parent) {
    validateFolderName(parent);
  }

  const folders = await client.list();
  const delimiter = folders[0]?.delimiter ?? '/';
  validateFolderName(name, delimiter);
  if (parent) validateFolderName(parent, delimiter);
  const special = resolveSpecialFolders(folders);
  assertCreateFolderParentAllowed(special, parent);

  const path = customFolderPathFromSegments(parent ? [parent, name] : [name], delimiter);

  if (parent) {
    const parentPath = customFolderPathFromSegments([parent], delimiter);
    const parentFolder = folders.find((folder) => folder.path === parentPath);
    if (!parentFolder) {
      throw new Error(`No such parent folder: "${parent}" (resolved to "${parentPath}").`);
    }
  }

  // 1. Exact-path duplicate: this precise folder already exists.
  const existingSamePath = folders.find((folder) => folder.path === path);
  if (existingSamePath) {
    return {
      operation: 'mail_create_folder',
      dryRun,
      path,
      alreadyExists: true,
      created: false,
      conflictType: 'folder',
      conflictingPath: existingSamePath.path,
    };
  }

  // 2. Cross-namespace name collision: a label (or a folder elsewhere in
  // the account) already uses this name — see findNameConflict() for the
  // live-confirmed Proton rule this guards against.
  const conflict = findNameConflict(folders, name, delimiter);
  if (conflict) {
    return {
      operation: 'mail_create_folder',
      dryRun,
      path,
      alreadyExists: true,
      created: false,
      conflictType: conflict.type,
      conflictingPath: conflict.path,
    };
  }

  if (dryRun) {
    return { operation: 'mail_create_folder', dryRun, path, alreadyExists: false, created: false };
  }

  let response: Awaited<ReturnType<ImapFlow['mailboxCreate']>>;
  try {
    response = await client.mailboxCreate(path.split(delimiter));
  } catch {
    throw new Error(mutationFailureMessage('mailboxOperationFailed'));
  }
  return {
    operation: 'mail_create_folder',
    dryRun,
    path: response.path,
    alreadyExists: false,
    created: response.created,
  };
}
