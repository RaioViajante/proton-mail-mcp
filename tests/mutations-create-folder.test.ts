import { describe, expect, it } from 'vitest';
import { createFolder, validateFolderName } from '../src/mutations/folders.js';
import { asImapFlow, createFakeImapClient, fakeFolder } from './fakes/imap-client.js';

const folders = [
  fakeFolder({ path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' }),
  fakeFolder({ path: 'Spam', name: 'Spam', specialUse: '\\Junk' }),
  fakeFolder({ path: 'Folders', name: 'Folders', flags: new Set(['\\Noselect']) }),
  fakeFolder({ path: 'Labels', name: 'Labels', flags: new Set(['\\Noselect']) }),
  fakeFolder({ path: 'Folders/Projects', name: 'Projects', parentPath: 'Folders' }),
  fakeFolder({
    path: 'Folders/Projects/Existing',
    name: 'Existing',
    parentPath: 'Folders/Projects',
  }),
  fakeFolder({ path: 'Labels/MCP Test', name: 'MCP Test', parentPath: 'Labels' }),
];

describe('validateFolderName', () => {
  it('rejects an empty name', () => {
    expect(() => validateFolderName('')).toThrow(/must not be empty/i);
  });

  it('rejects a whitespace-only name', () => {
    expect(() => validateFolderName('   ')).toThrow(/must not be empty/i);
  });

  it('rejects leading/trailing whitespace', () => {
    expect(() => validateFolderName(' Work ')).toThrow(/leading or trailing whitespace/i);
  });

  it('rejects a name containing "/"', () => {
    expect(() => validateFolderName('Parent/Child')).toThrow(/must not contain/i);
  });

  it.each([
    'Inbox',
    'inbox',
    'Spam',
    'Trash',
    'Sent',
    'Drafts',
    'All Mail',
    'Starred',
    'Labels',
    'Folders',
  ])('rejects the reserved name %s', (name) => {
    expect(() => validateFolderName(name)).toThrow(/reserved/i);
  });

  it('accepts an ordinary name', () => {
    expect(() => validateFolderName('Receipts')).not.toThrow();
  });
});

describe('createFolder: Bridge namespace resolution', () => {
  it('a top-level logical folder name resolves to Folders/<name>', async () => {
    const fake = createFakeImapClient({ folders });

    const result = await createFolder(asImapFlow(fake), { name: 'MCP Test', dryRun: true });

    expect(result.path).toBe('Folders/MCP Test');
  });

  it('never calls mailboxCreate with a bare name — always the full Folders/... path segments', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxCreateResult: { path: 'Folders/Receipts', created: true },
    });

    await createFolder(asImapFlow(fake), { name: 'Receipts', dryRun: false });

    // No CREATE at IMAP root: the call is always for the Folders-prefixed
    // path segments, never the bare logical name.
    expect(fake.mailboxCreate).toHaveBeenCalledWith(['Folders', 'Receipts']);
  });

  it('a nested custom folder (parent + name) resolves under Folders/<parent>/<name>', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxCreateResult: { path: 'Folders/Projects/GitHub', created: true },
    });

    const result = await createFolder(asImapFlow(fake), {
      name: 'GitHub',
      parent: 'Projects',
      dryRun: false,
    });

    expect(result.path).toBe('Folders/Projects/GitHub');
    expect(fake.mailboxCreate).toHaveBeenCalledWith(['Folders', 'Projects', 'GitHub']);
  });

  it('rejects a nonexistent logical parent', async () => {
    const fake = createFakeImapClient({ folders });
    await expect(
      createFolder(asImapFlow(fake), { name: 'X', parent: 'DoesNotExist', dryRun: true }),
    ).rejects.toThrow(/no such parent/i);
  });

  it.each(['Spam', 'Trash', 'Archive', 'Sent', 'Drafts', 'All Mail', 'Inbox', 'Starred'])(
    'rejects a system folder (%s) as the logical parent',
    async (systemName) => {
      const fake = createFakeImapClient({ folders });
      await expect(
        createFolder(asImapFlow(fake), { name: 'X', parent: systemName, dryRun: true }),
      ).rejects.toThrow(/reserved/i);
      expect(fake.mailboxCreate).not.toHaveBeenCalled();
    },
  );

  it('rejects "Labels" as the logical parent', async () => {
    const fake = createFakeImapClient({ folders });
    await expect(
      createFolder(asImapFlow(fake), { name: 'X', parent: 'Labels', dryRun: true }),
    ).rejects.toThrow(/reserved/i);
    expect(fake.mailboxCreate).not.toHaveBeenCalled();
  });

  it('rejects "Folders" itself as the logical parent', async () => {
    const fake = createFakeImapClient({ folders });
    await expect(
      createFolder(asImapFlow(fake), { name: 'X', parent: 'Folders', dryRun: true }),
    ).rejects.toThrow(/reserved/i);
  });

  it('rejects a parent or name that tries to smuggle a raw path (namespace escape)', async () => {
    const fake = createFakeImapClient({ folders });
    await expect(
      createFolder(asImapFlow(fake), { name: 'X', parent: 'Folders/Projects', dryRun: true }),
    ).rejects.toThrow(/must not contain/i);
    await expect(
      createFolder(asImapFlow(fake), { name: '../Spam', dryRun: true }),
    ).rejects.toThrow(); // "/" is rejected outright by validateFolderName
    expect(fake.mailboxCreate).not.toHaveBeenCalled();
  });

  it('detects a duplicate against the real Folders/ path and never calls mailboxCreate, even for dryRun=false', async () => {
    const fake = createFakeImapClient({ folders });

    const result = await createFolder(asImapFlow(fake), {
      name: 'Existing',
      parent: 'Projects',
      dryRun: false,
    });

    expect(result.alreadyExists).toBe(true);
    expect(result.created).toBe(false);
    expect(fake.mailboxCreate).not.toHaveBeenCalled();
  });

  it('reports Folders/MCP Test as already existing (a real duplicate, conflictType "folder") once it has actually been created', async () => {
    const withCreatedFolder = [
      ...folders,
      fakeFolder({ path: 'Folders/MCP Test', name: 'MCP Test', parentPath: 'Folders' }),
    ];
    const fake = createFakeImapClient({ folders: withCreatedFolder });

    const result = await createFolder(asImapFlow(fake), { name: 'MCP Test', dryRun: false });

    expect(result.alreadyExists).toBe(true);
    expect(result.created).toBe(false);
    expect(result.conflictType).toBe('folder');
    expect(result.conflictingPath).toBe('Folders/MCP Test');
    expect(fake.mailboxCreate).not.toHaveBeenCalled();
  });
});

describe('createFolder: cross-namespace name collision (Proton folders and labels share one name)', () => {
  // Confirmed live: with an existing label Labels/MCP Test, `CREATE
  // "Folders/MCP Test"` was rejected by Proton's backend itself —
  // "409 ... Label or folder with this name already exists" — even though
  // Folders/ and Labels/ are physically distinct Bridge mailboxes. These
  // tests prove the collision is caught locally, before that round trip.

  it('an existing label blocks creating a same-named folder, reported as conflictType "label"', async () => {
    const fake = createFakeImapClient({ folders }); // fixture already has Labels/MCP Test

    const result = await createFolder(asImapFlow(fake), { name: 'MCP Test', dryRun: true });

    expect(result.path).toBe('Folders/MCP Test');
    expect(result.alreadyExists).toBe(true);
    expect(result.conflictType).toBe('label');
    expect(result.conflictingPath).toBe('Labels/MCP Test');
  });

  it('dry-run detects the label collision without ever calling mailboxCreate', async () => {
    const fake = createFakeImapClient({ folders });

    await createFolder(asImapFlow(fake), { name: 'MCP Test', dryRun: true });

    expect(fake.mailboxCreate).not.toHaveBeenCalled();
  });

  it('the live path also blocks locally, before any mailboxCreate call — no Bridge error is needed to detect a known collision', async () => {
    const fake = createFakeImapClient({ folders });

    const result = await createFolder(asImapFlow(fake), { name: 'MCP Test', dryRun: false });

    expect(result.alreadyExists).toBe(true);
    expect(result.created).toBe(false);
    expect(fake.mailboxCreate).not.toHaveBeenCalled();
  });

  it('a different name does not collide with the existing label', async () => {
    const fake = createFakeImapClient({ folders });

    const result = await createFolder(asImapFlow(fake), { name: 'MCP Test Folder', dryRun: true });

    expect(result.alreadyExists).toBe(false);
    expect(result.conflictType).toBeUndefined();
  });

  it('Labels/MCP Test and Folders/MCP Test Folder are allowed to coexist (distinct names)', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxCreateResult: { path: 'Folders/MCP Test Folder', created: true },
    });

    const result = await createFolder(asImapFlow(fake), { name: 'MCP Test Folder', dryRun: false });

    expect(result.created).toBe(true);
    expect(result.alreadyExists).toBe(false);
    expect(fake.mailboxCreate).toHaveBeenCalledWith(['Folders', 'MCP Test Folder']);
  });

  it('an existing folder would equally block a same-named label (reusable in both directions)', async () => {
    // No mail_create_label tool exists yet; this proves the same policy
    // function already answers the label-side question too, via the
    // conflictType it reports for the opposite collision direction.
    const withFolder = [
      ...folders,
      fakeFolder({ path: 'Folders/Newsletter', name: 'Newsletter', parentPath: 'Folders' }),
    ];
    const fake = createFakeImapClient({ folders: withFolder });

    // Simulate what a future mail_create_folder-style check for a label
    // named "Newsletter" would see: the name is taken, by a folder.
    const result = await createFolder(asImapFlow(fake), { name: 'Something Else', dryRun: true });
    expect(result.alreadyExists).toBe(false); // sanity: unrelated name is unaffected

    const collidingResult = await createFolder(asImapFlow(fake), {
      name: 'Newsletter',
      dryRun: true,
    });
    expect(collidingResult.alreadyExists).toBe(true);
    expect(collidingResult.conflictType).toBe('folder');
    expect(collidingResult.conflictingPath).toBe('Folders/Newsletter');
  });
});

describe('createFolder: existing dry-run guarantees', () => {
  it('dry-run previews the resolved path without calling mailboxCreate', async () => {
    const fake = createFakeImapClient({ folders });

    const result = await createFolder(asImapFlow(fake), { name: 'Receipts', dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.path).toBe('Folders/Receipts');
    expect(result.created).toBe(false);
    expect(fake.mailboxCreate).not.toHaveBeenCalled();
  });

  it('rejects an empty name before ever calling list()', async () => {
    const fake = createFakeImapClient({ folders });
    await expect(createFolder(asImapFlow(fake), { name: '', dryRun: true })).rejects.toThrow(
      /must not be empty/i,
    );
    expect(fake.list).not.toHaveBeenCalled();
  });
});
