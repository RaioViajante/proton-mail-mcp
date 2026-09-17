import type { ListResponse } from 'imapflow';

/**
 * Central policy for special/protected folders. Every mutation tool goes
 * through this module instead of hardcoding folder names, so the rules
 * about what can never be a mutation destination live in exactly one place.
 */
export interface SpecialFolders {
  inbox?: string;
  archive?: string;
  spam?: string;
  trash?: string;
  sent?: string;
  drafts?: string;
  allMail?: string;
  starred?: string;
}

/** IMAP SPECIAL-USE attributes (RFC 6154), as reported by ImapFlow's `specialUse`. */
const SPECIAL_USE_KEY: Record<string, keyof SpecialFolders> = {
  '\\Inbox': 'inbox',
  '\\Archive': 'archive',
  '\\Junk': 'spam',
  '\\Trash': 'trash',
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\All': 'allMail',
  '\\Flagged': 'starred',
};

/**
 * Name-based fallback, used only for a slot that `specialUse` metadata left
 * unfilled. Bridge is expected to report `specialUse` for these, but this
 * project should not depend solely on the English name if it doesn't.
 */
const NAME_FALLBACK_KEY: Record<string, keyof SpecialFolders> = {
  inbox: 'inbox',
  archive: 'archive',
  spam: 'spam',
  junk: 'spam',
  trash: 'trash',
  sent: 'sent',
  'sent mail': 'sent',
  drafts: 'drafts',
  'all mail': 'allMail',
  starred: 'starred',
};

export function resolveSpecialFolders(folders: readonly ListResponse[]): SpecialFolders {
  const result: SpecialFolders = {};

  for (const folder of folders) {
    const key = folder.specialUse ? SPECIAL_USE_KEY[folder.specialUse] : undefined;
    if (key && !result[key]) {
      result[key] = folder.path;
    }
  }

  for (const folder of folders) {
    const key = NAME_FALLBACK_KEY[folder.name.trim().toLowerCase()];
    if (key && !result[key]) {
      result[key] = folder.path;
    }
  }

  return result;
}

/** A folder is selectable (can be opened/targeted) unless IMAP marks it `\Noselect`. */
export function isSelectable(folder: ListResponse): boolean {
  return !folder.flags.has('\\Noselect');
}

export function findFolder(
  folders: readonly ListResponse[],
  path: string,
): ListResponse | undefined {
  return folders.find((folder) => folder.path === path);
}

export function assertFolderExists(
  folders: readonly ListResponse[],
  path: string,
  label = 'folder',
): void {
  const folder = findFolder(folders, path);
  if (!folder) {
    throw new Error(`No such ${label}: "${path}".`);
  }
  if (!isSelectable(folder)) {
    throw new Error(
      `"${path}" is not a selectable mailbox (it looks like a container, not a real ${label}).`,
    );
  }
}

const BLOCKED_MOVE_DESTINATIONS: Partial<Record<keyof SpecialFolders, string>> = {
  trash: 'Moving messages to Trash is not supported in V2.',
  spam: 'Use mail_mark_spam to move messages to Spam, not mail_move.',
  sent: 'Moving messages into Sent is not allowed.',
  drafts: 'Moving messages into Drafts is not allowed.',
  allMail: 'Moving messages into All Mail is not allowed.',
};

/** Guards the generic `mail_move` destination against every protected special folder. */
export function assertMoveDestinationAllowed(
  special: SpecialFolders,
  destinationPath: string,
): void {
  if (isNamespaceContainer(destinationPath)) {
    throw new Error(`"${destinationPath}" is a namespace container, not a valid destination.`);
  }
  for (const [key, reason] of Object.entries(BLOCKED_MOVE_DESTINATIONS) as Array<
    [keyof SpecialFolders, string]
  >) {
    if (special[key] !== undefined && special[key] === destinationPath) {
      throw new Error(reason);
    }
  }
}

/**
 * Proton Bridge's fixed IMAP namespace, confirmed live: `CREATE "MCP Test"`
 * at the true IMAP root was rejected by Bridge itself ("invalid mailbox
 * name ... operation not allowed") — this is not a bug, it is how Bridge
 * requires custom Proton folders and labels to be addressed. Every custom
 * folder this project creates or targets lives under `Folders/...`; every
 * label lives under `Labels/...` (see `labelPath()` in mutations/labels.ts).
 * These two container names are fixed Bridge/Proton concepts, not
 * user-configurable, so they are hardcoded here rather than derived.
 */
export const FOLDERS_CONTAINER = 'Folders';
export const LABELS_CONTAINER = 'Labels';

/** True for the bare namespace container itself (`Folders` or `Labels`) — never a valid concrete target. */
export function isNamespaceContainer(path: string): boolean {
  return path === FOLDERS_CONTAINER || path === LABELS_CONTAINER;
}

/**
 * True for the bare `Labels` container or any `Labels/<name>` mailbox. A
 * label mailbox is a *view* of messages that physically live in a real
 * folder elsewhere (see README.md "Labels vs. folders") — never a
 * message's own location.
 */
export function isLabelMailboxPath(path: string, delimiter: string): boolean {
  const prefix = `${LABELS_CONTAINER}${delimiter}`;
  return path === LABELS_CONTAINER || path.startsWith(prefix);
}

/**
 * Guards `mail_trash`'s `sourceFolder` specifically — not the shared
 * move/archive path, which is deliberately left unchanged (see
 * `mutations/move.ts`, `mutations/archive.ts`). A label mailbox must never
 * be accepted as the origin of a destructive relocation: it is a view of a
 * message, not the physical location the message is being relocated away
 * from, and treating it as one would move the message's real copy out of
 * whatever folder it actually lives in based on nothing but which label
 * view happened to be queried. `assertFolderExists` already rejects the
 * bare `Folders`/`Labels` namespace containers (both `\Noselect`) and any
 * path that isn't a real, listed mailbox — this only adds the one gap that
 * check leaves open: a concrete, selectable `Labels/<name>` mailbox.
 */
export function assertTrashSourceAllowed(sourceFolder: string, delimiter: string): void {
  if (isLabelMailboxPath(sourceFolder, delimiter)) {
    throw new Error(
      `"${sourceFolder}" is a label mailbox, not a physical location — it is a view of a message ` +
        "that lives in a real folder elsewhere. Use the message's real folder as sourceFolder for " +
        'mail_trash, not a Labels/... reference.',
    );
  }
}

/**
 * Builds the real Bridge path for a custom folder from logical path
 * segments (e.g. `["Projects", "GitHub"]` with delimiter `/` →
 * `"Folders/Projects/GitHub"`). This is the single place that prepends the
 * `Folders` namespace — nothing in this project should string-concatenate
 * `"Folders/"` by hand anywhere else.
 */
export function customFolderPathFromSegments(
  segments: readonly string[],
  delimiter: string,
): string {
  const cleaned = segments.map((segment) => segment.trim());
  if (cleaned.length === 0 || cleaned.some((segment) => segment.length === 0)) {
    throw new Error('Folder path segments must not be empty.');
  }
  if (cleaned.some((segment) => segment === FOLDERS_CONTAINER || segment === LABELS_CONTAINER)) {
    throw new Error(
      `A folder path segment must not be "${FOLDERS_CONTAINER}" or "${LABELS_CONTAINER}".`,
    );
  }
  return [FOLDERS_CONTAINER, ...cleaned].join(delimiter);
}

/**
 * Resolves a caller-supplied custom-folder reference — a bare logical name
 * (`"MCP Test"`), a logical nested path (`"Projects/GitHub"`), or an
 * already-fully-qualified Bridge path (`"Folders/MCP Test"`, e.g. as
 * returned by `mail_list_folders`) — into the real Bridge mailbox path
 * under `Folders/...`. Idempotent: resolving an already-resolved path
 * returns it unchanged. Rejects anything that would resolve under `Labels`
 * or at a bare namespace root, and rejects empty path segments (no
 * traversal/escape out of the `Folders` namespace).
 */
export function resolveCustomFolderReference(reference: string, delimiter: string): string {
  const trimmed = reference.trim();
  if (trimmed.length === 0) {
    throw new Error('Folder reference must not be empty.');
  }

  const labelsPrefix = `${LABELS_CONTAINER}${delimiter}`;
  if (trimmed === LABELS_CONTAINER || trimmed.startsWith(labelsPrefix)) {
    throw new Error(
      `"${reference}" is a label, not a folder — use mail_apply_label / mail_remove_label instead.`,
    );
  }

  if (trimmed === FOLDERS_CONTAINER) {
    throw new Error(`"${FOLDERS_CONTAINER}" is a namespace container, not a concrete folder.`);
  }

  const foldersPrefix = `${FOLDERS_CONTAINER}${delimiter}`;
  const logicalPart = trimmed.startsWith(foldersPrefix)
    ? trimmed.slice(foldersPrefix.length)
    : trimmed;

  return customFolderPathFromSegments(logicalPart.split(delimiter), delimiter);
}

export interface NameConflict {
  type: 'folder' | 'label';
  path: string;
}

/**
 * Checks whether `logicalName` collides with an existing custom folder or
 * label ANYWHERE in the account, regardless of nesting.
 *
 * Confirmed live, not just from documentation: with an existing label
 * `Labels/MCP Test`, `CREATE "Folders/MCP Test"` was rejected by Proton's
 * backend itself —
 *
 * ```
 * 8 NO 409 POST https://mail-api.proton.me/core/v4/labels: Label or folder
 * with this name already exists (Code=2500, Status=409)
 * ```
 *
 * — even though `Folders/...` and `Labels/...` are physically distinct
 * Bridge mailboxes. Proton folders and labels share one logical name
 * namespace per account; this function is the local, pre-flight check for
 * that rule, so a known collision never has to make a round trip to Bridge
 * to be discovered.
 *
 * Scope note (documented limitation, not invented behavior): the live
 * confirmation above is for a top-level name. Whether Proton's uniqueness
 * constraint is truly global across every nesting depth, or narrower (e.g.
 * scoped only to siblings under the same parent), has not been separately
 * verified. This function checks globally — the conservative direction,
 * since it can only ever produce an over-cautious local rejection (pick a
 * different name) rather than a false "looks fine" that then fails live at
 * CREATE. Narrow this only after a live test specifically exercises nested
 * naming.
 *
 * Shared by `mail_create_folder` and `mail_create_label`: it answers
 * "name taken by a folder" / "name taken by a label" / "name available"
 * from either direction.
 */
export function findNameConflict(
  folders: readonly ListResponse[],
  logicalName: string,
  delimiter: string,
): NameConflict | undefined {
  const target = logicalName.trim();
  const foldersPrefix = `${FOLDERS_CONTAINER}${delimiter}`;
  const labelsPrefix = `${LABELS_CONTAINER}${delimiter}`;

  for (const folder of folders) {
    if (folder.name !== target) {
      continue;
    }
    if (folder.path.startsWith(foldersPrefix)) {
      return { type: 'folder', path: folder.path };
    }
    if (folder.path.startsWith(labelsPrefix)) {
      return { type: 'label', path: folder.path };
    }
  }

  return undefined;
}

/** Parent folders that must never receive a newly created child folder. */
const BLOCKED_CREATE_PARENT_KEYS: ReadonlyArray<keyof SpecialFolders> = [
  'spam',
  'trash',
  'archive',
  'sent',
  'drafts',
  'allMail',
];

export function assertCreateFolderParentAllowed(
  special: SpecialFolders,
  parentPath: string | undefined,
): void {
  if (!parentPath) {
    return;
  }
  for (const key of BLOCKED_CREATE_PARENT_KEYS) {
    if (special[key] !== undefined && special[key] === parentPath) {
      throw new Error(`Cannot create a folder inside "${parentPath}".`);
    }
  }
}

/**
 * Resolves what `mail_move` was actually given as a destination into the
 * real Bridge mailbox path:
 *
 * - a value that already exactly matches a resolved system special folder
 *   (e.g. `"Archive"`) is passed through unchanged — protected-destination
 *   rules still apply afterwards, via {@link assertMoveDestinationAllowed};
 * - anything else is treated as a custom-folder reference and resolved
 *   under the `Folders/` namespace via {@link resolveCustomFolderReference}
 *   (which itself rejects `Labels` and the bare namespace roots).
 *
 * This is what lets the tool accept either a bare logical name
 * (`"MCP Test"`) or the exact path `mail_list_folders` would report
 * (`"Folders/MCP Test"`) and resolve both to the same real destination.
 */
export function resolveMoveDestination(
  special: SpecialFolders,
  rawDestination: string,
  delimiter: string,
): string {
  const specialPaths = new Set(Object.values(special));
  if (specialPaths.has(rawDestination)) {
    return rawDestination;
  }
  return resolveCustomFolderReference(rawDestination, delimiter);
}
