import { describe, expect, it } from 'vitest';
import {
  assertCreateFolderParentAllowed,
  assertFolderExists,
  assertMoveDestinationAllowed,
  assertTrashSourceAllowed,
  customFolderPathFromSegments,
  findNameConflict,
  isLabelMailboxPath,
  isNamespaceContainer,
  isSelectable,
  resolveCustomFolderReference,
  resolveMoveDestination,
  resolveSpecialFolders,
} from '../src/mutations/policy.js';
import { fakeFolder } from './fakes/imap-client.js';

const folders = [
  fakeFolder({ path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' }),
  fakeFolder({ path: 'Archive', name: 'Archive', specialUse: '\\Archive' }),
  fakeFolder({ path: 'Spam', name: 'Spam', specialUse: '\\Junk' }),
  fakeFolder({ path: 'Trash', name: 'Trash', specialUse: '\\Trash' }),
  fakeFolder({ path: 'Sent', name: 'Sent', specialUse: '\\Sent' }),
  fakeFolder({ path: 'Drafts', name: 'Drafts', specialUse: '\\Drafts' }),
  fakeFolder({ path: 'All Mail', name: 'All Mail', specialUse: '\\All' }),
  fakeFolder({ path: 'Starred', name: 'Starred', specialUse: '\\Flagged' }),
  fakeFolder({ path: 'Folders', name: 'Folders', flags: new Set(['\\Noselect']) }),
  fakeFolder({ path: 'Labels/Work', name: 'Work' }),
];

describe('resolveSpecialFolders', () => {
  it('resolves every special folder via specialUse metadata', () => {
    const special = resolveSpecialFolders(folders);
    expect(special).toEqual({
      inbox: 'INBOX',
      archive: 'Archive',
      spam: 'Spam',
      trash: 'Trash',
      sent: 'Sent',
      drafts: 'Drafts',
      allMail: 'All Mail',
      starred: 'Starred',
    });
  });

  it('falls back to conventional names when specialUse metadata is absent', () => {
    const noMetadata = [
      fakeFolder({ path: 'INBOX', name: 'INBOX' }),
      fakeFolder({ path: 'Archive', name: 'Archive' }),
      fakeFolder({ path: 'Junk', name: 'Junk' }),
    ];
    const special = resolveSpecialFolders(noMetadata);
    expect(special.inbox).toBe('INBOX');
    expect(special.archive).toBe('Archive');
    expect(special.spam).toBe('Junk');
  });

  it('prefers specialUse over a conflicting name-based guess', () => {
    const custom = [
      fakeFolder({ path: 'My Archive Box', name: 'My Archive Box', specialUse: '\\Archive' }),
    ];
    expect(resolveSpecialFolders(custom).archive).toBe('My Archive Box');
  });
});

describe('isSelectable', () => {
  it('treats a folder without \\Noselect as selectable', () => {
    expect(isSelectable(fakeFolder({ path: 'INBOX', name: 'INBOX' }))).toBe(true);
  });

  it('treats a \\Noselect folder as not selectable', () => {
    expect(
      isSelectable(
        fakeFolder({ path: 'Folders', name: 'Folders', flags: new Set(['\\Noselect']) }),
      ),
    ).toBe(false);
  });
});

describe('assertFolderExists', () => {
  it('passes for an existing, selectable folder', () => {
    expect(() => assertFolderExists(folders, 'INBOX')).not.toThrow();
  });

  it('throws for a nonexistent folder', () => {
    expect(() => assertFolderExists(folders, 'DoesNotExist')).toThrow(/no such/i);
  });

  it('throws for a \\Noselect container', () => {
    expect(() => assertFolderExists(folders, 'Folders')).toThrow(/not a selectable mailbox/i);
  });
});

describe('assertMoveDestinationAllowed', () => {
  const special = resolveSpecialFolders(folders);

  it.each([
    ['Trash', /trash/i],
    ['Spam', /mail_mark_spam/i],
    ['Sent', /sent/i],
    ['Drafts', /drafts/i],
    ['All Mail', /all mail/i],
  ])('blocks moving to %s', (destination, expected) => {
    expect(() => assertMoveDestinationAllowed(special, destination)).toThrow(expected);
  });

  it('allows moving to an ordinary custom folder', () => {
    expect(() => assertMoveDestinationAllowed(special, 'Labels/Work')).not.toThrow();
  });

  it('allows moving to Archive via mail_move (mail_archive is the dedicated tool, not a block)', () => {
    expect(() => assertMoveDestinationAllowed(special, 'Archive')).not.toThrow();
  });
});

describe('assertCreateFolderParentAllowed', () => {
  const special = resolveSpecialFolders(folders);

  it('allows an undefined parent (top-level folder)', () => {
    expect(() => assertCreateFolderParentAllowed(special, undefined)).not.toThrow();
  });

  it.each(['Spam', 'Trash', 'Archive', 'Sent', 'Drafts', 'All Mail'])(
    'blocks creating a folder inside %s',
    (parent) => {
      expect(() => assertCreateFolderParentAllowed(special, parent)).toThrow(/cannot create/i);
    },
  );

  it('allows creating a folder inside an ordinary parent', () => {
    expect(() => assertCreateFolderParentAllowed(special, 'Labels/Work')).not.toThrow();
  });
});

describe('isNamespaceContainer', () => {
  it('is true only for the bare "Folders" and "Labels" containers', () => {
    expect(isNamespaceContainer('Folders')).toBe(true);
    expect(isNamespaceContainer('Labels')).toBe(true);
  });

  it('is false for a concrete child mailbox, even one named exactly like a container', () => {
    expect(isNamespaceContainer('Folders/Projects')).toBe(false);
    expect(isNamespaceContainer('Labels/Work')).toBe(false);
    expect(isNamespaceContainer('Archive')).toBe(false);
  });
});

describe('customFolderPathFromSegments', () => {
  it('builds a top-level custom folder path', () => {
    expect(customFolderPathFromSegments(['MCP Test'], '/')).toBe('Folders/MCP Test');
  });

  it('builds a nested custom folder path using the given delimiter', () => {
    expect(customFolderPathFromSegments(['Projects', 'GitHub'], '/')).toBe(
      'Folders/Projects/GitHub',
    );
    expect(customFolderPathFromSegments(['Projects', 'GitHub'], '.')).toBe(
      'Folders.Projects.GitHub',
    );
  });

  it('rejects an empty segment list', () => {
    expect(() => customFolderPathFromSegments([], '/')).toThrow(/must not be empty/i);
  });

  it('rejects a blank segment (no traversal/escape via an empty path part)', () => {
    expect(() => customFolderPathFromSegments(['Projects', ''], '/')).toThrow(/must not be empty/i);
    expect(() => customFolderPathFromSegments(['  '], '/')).toThrow(/must not be empty/i);
  });

  it('rejects a segment literally named "Folders" or "Labels"', () => {
    expect(() => customFolderPathFromSegments(['Folders'], '/')).toThrow();
    expect(() => customFolderPathFromSegments(['Projects', 'Labels'], '/')).toThrow();
  });
});

describe('resolveCustomFolderReference', () => {
  it('resolves a bare top-level logical name', () => {
    expect(resolveCustomFolderReference('MCP Test', '/')).toBe('Folders/MCP Test');
  });

  it('resolves a logical nested path in one string', () => {
    expect(resolveCustomFolderReference('Projects/GitHub', '/')).toBe('Folders/Projects/GitHub');
  });

  it('is idempotent on an already-fully-qualified Folders/... path', () => {
    expect(resolveCustomFolderReference('Folders/MCP Test', '/')).toBe('Folders/MCP Test');
    expect(resolveCustomFolderReference('Folders/Projects/GitHub', '/')).toBe(
      'Folders/Projects/GitHub',
    );
  });

  it('rejects the bare "Folders" namespace root', () => {
    expect(() => resolveCustomFolderReference('Folders', '/')).toThrow(/namespace container/i);
  });

  it('rejects the bare "Labels" namespace root', () => {
    expect(() => resolveCustomFolderReference('Labels', '/')).toThrow(/is a label, not a folder/i);
  });

  it('rejects anything under the Labels namespace', () => {
    expect(() => resolveCustomFolderReference('Labels/MCP Test', '/')).toThrow(
      /is a label, not a folder/i,
    );
  });

  it('rejects an empty reference', () => {
    expect(() => resolveCustomFolderReference('', '/')).toThrow(/must not be empty/i);
    expect(() => resolveCustomFolderReference('   ', '/')).toThrow(/must not be empty/i);
  });

  it('rejects a path with an empty segment (traversal/escape attempt)', () => {
    expect(() => resolveCustomFolderReference('Projects//GitHub', '/')).toThrow(
      /must not be empty/i,
    );
    expect(() => resolveCustomFolderReference('/MCP Test', '/')).toThrow(/must not be empty/i);
  });
});

describe('resolveMoveDestination', () => {
  const special = resolveSpecialFolders(folders);

  it('passes a literal system special folder through unchanged', () => {
    expect(resolveMoveDestination(special, 'Archive', '/')).toBe('Archive');
  });

  it('resolves a bare custom folder name under Folders/', () => {
    expect(resolveMoveDestination(special, 'MCP Test', '/')).toBe('Folders/MCP Test');
  });

  it('is idempotent on an already-qualified Folders/... path', () => {
    expect(resolveMoveDestination(special, 'Folders/MCP Test', '/')).toBe('Folders/MCP Test');
  });

  it('rejects a Labels/... reference', () => {
    expect(() => resolveMoveDestination(special, 'Labels/Work', '/')).toThrow(
      /is a label, not a folder/i,
    );
  });

  it('rejects the bare "Folders" namespace root', () => {
    expect(() => resolveMoveDestination(special, 'Folders', '/')).toThrow(/namespace container/i);
  });
});

describe('isLabelMailboxPath', () => {
  it('is true for the bare "Labels" container', () => {
    expect(isLabelMailboxPath('Labels', '/')).toBe(true);
  });

  it('is true for a concrete Labels/<name> mailbox', () => {
    expect(isLabelMailboxPath('Labels/Work', '/')).toBe(true);
    expect(isLabelMailboxPath('Labels/Newsletters e ofertas', '/')).toBe(true);
  });

  it('is false for an ordinary folder, even one containing "Labels" as a substring', () => {
    expect(isLabelMailboxPath('INBOX', '/')).toBe(false);
    expect(isLabelMailboxPath('Archive', '/')).toBe(false);
    expect(isLabelMailboxPath('Folders/Labels Archive', '/')).toBe(false);
  });

  it('respects the given delimiter', () => {
    expect(isLabelMailboxPath('Labels.Work', '.')).toBe(true);
    expect(isLabelMailboxPath('Labels/Work', '.')).toBe(false);
  });
});

describe('assertTrashSourceAllowed', () => {
  it('rejects a concrete Labels/<name> mailbox as a trash source', () => {
    expect(() => assertTrashSourceAllowed('Labels/Work', '/')).toThrow(/label mailbox/i);
  });

  it('rejects the bare "Labels" container as a trash source', () => {
    expect(() => assertTrashSourceAllowed('Labels', '/')).toThrow(/label mailbox/i);
  });

  it.each(['INBOX', 'Archive', 'Folders/Projects'])('allows %s as a trash source', (path) => {
    expect(() => assertTrashSourceAllowed(path, '/')).not.toThrow();
  });
});

describe('findNameConflict', () => {
  // Confirmed live: Proton rejected `CREATE "Folders/MCP Test"` with a 409
  // ("Label or folder with this name already exists") while only
  // `Labels/MCP Test` existed — folders and labels share one name per
  // account, even though they are physically distinct Bridge mailboxes.
  const withNamespaceEntries = [
    ...folders,
    fakeFolder({ path: 'Folders/Projects', name: 'Projects', parentPath: 'Folders' }),
  ];

  it('reports a label conflict for a name already used by a label', () => {
    expect(findNameConflict(withNamespaceEntries, 'Work', '/')).toEqual({
      type: 'label',
      path: 'Labels/Work',
    });
  });

  it('reports a folder conflict for a name already used by a folder', () => {
    expect(findNameConflict(withNamespaceEntries, 'Projects', '/')).toEqual({
      type: 'folder',
      path: 'Folders/Projects',
    });
  });

  it('reports no conflict for a name that is available in both namespaces', () => {
    expect(findNameConflict(withNamespaceEntries, 'Totally New Name', '/')).toBeUndefined();
  });

  it('is reusable for a hypothetical label-side check (same function answers both directions)', () => {
    // No mail_create_label tool exists yet, but the same function already
    // answers "is this name taken, and by what" regardless of which side
    // is asking.
    const conflict = findNameConflict(withNamespaceEntries, 'Projects', '/');
    expect(conflict?.type).toBe('folder');
  });
});
