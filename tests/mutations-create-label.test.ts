import { describe, expect, it } from 'vitest';
import { createLabel } from '../src/mutations/create-label.js';
import { asImapFlow, createFakeImapClient, fakeFolder } from './fakes/imap-client.js';

const folders = [
  fakeFolder({ path: 'INBOX', name: 'INBOX' }),
  fakeFolder({ path: 'Folders', name: 'Folders' }),
  fakeFolder({ path: 'Labels', name: 'Labels' }),
  fakeFolder({ path: 'Folders/Financeiro', name: 'Financeiro', parentPath: 'Folders' }),
  fakeFolder({ path: 'Labels/Existing', name: 'Existing', parentPath: 'Labels' }),
];

describe('createLabel', () => {
  it('previews a logical name under Labels without any mutation or mailbox lock', async () => {
    const fake = createFakeImapClient({ folders });
    expect(
      await createLabel(asImapFlow(fake), { name: 'Newsletters e ofertas', dryRun: true }),
    ).toEqual({
      operation: 'mail_create_label',
      dryRun: true,
      path: 'Labels/Newsletters e ofertas',
      alreadyExists: false,
      created: false,
    });
    expect(fake.list).toHaveBeenCalledOnce();
    expect(fake.mailboxCreate).not.toHaveBeenCalled();
    expect(fake.getMailboxLock).not.toHaveBeenCalled();
    expect(fake.messageMove).not.toHaveBeenCalled();
    expect(fake.messageCopy).not.toHaveBeenCalled();
    expect(fake.messageFlagsAdd).not.toHaveBeenCalled();
    expect(fake.messageFlagsRemove).not.toHaveBeenCalled();
  });

  it('creates only Labels/<name> live, without applying it to a message', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxCreateResult: { path: 'Labels/Newsletters e ofertas', created: true },
    });
    const result = await createLabel(asImapFlow(fake), {
      name: 'Newsletters e ofertas',
      dryRun: false,
    });
    expect(result.created).toBe(true);
    expect(result.path).toBe('Labels/Newsletters e ofertas');
    expect(fake.mailboxCreate).toHaveBeenCalledExactlyOnceWith(['Labels', 'Newsletters e ofertas']);
    expect(fake.getMailboxLock).not.toHaveBeenCalled();
    expect(fake.messageMove).not.toHaveBeenCalled();
    expect(fake.messageCopy).not.toHaveBeenCalled();
    expect(fake.messageFlagsAdd).not.toHaveBeenCalled();
    expect(fake.messageFlagsRemove).not.toHaveBeenCalled();
  });

  it.each([
    ['Existing', 'label', 'Labels/Existing'],
    ['Financeiro', 'folder', 'Folders/Financeiro'],
  ] as const)('blocks %s collision locally even with dryRun=false', async (name, type, path) => {
    const fake = createFakeImapClient({ folders });
    const result = await createLabel(asImapFlow(fake), { name, dryRun: false });
    expect(result).toMatchObject({
      alreadyExists: true,
      created: false,
      conflictType: type,
      conflictingPath: path,
    });
    expect(fake.mailboxCreate).not.toHaveBeenCalled();
  });

  it('allows a different name from existing folders', async () => {
    const fake = createFakeImapClient({ folders });
    const result = await createLabel(asImapFlow(fake), { name: 'Newsletters', dryRun: true });
    expect(result.alreadyExists).toBe(false);
  });

  it.each([
    '',
    ' ',
    ' News',
    'News ',
    'Folders/News',
    'Labels/News',
    'Labels',
    'Inbox',
    'Spam',
    'Trash',
    'Archive',
    'Sent',
    'Drafts',
    'All Mail',
    '.',
    '..',
    '../News',
    'News/Deals',
    'News//Deals',
    'News\r\nDeals',
  ])('rejects unsafe or reserved name %j without CREATE', async (name) => {
    const fake = createFakeImapClient({ folders });
    await expect(createLabel(asImapFlow(fake), { name, dryRun: false })).rejects.toThrow();
    expect(fake.mailboxCreate).not.toHaveBeenCalled();
  });

  it('uses the listed IMAP delimiter and rejects that delimiter inside the logical name', async () => {
    const dotted = [
      fakeFolder({ path: 'INBOX', name: 'INBOX', delimiter: '.' }),
      fakeFolder({ path: 'Labels', name: 'Labels', delimiter: '.' }),
    ];
    const fake = createFakeImapClient({
      folders: dotted,
      mailboxCreateResult: { path: 'Labels.News', created: true },
    });
    expect((await createLabel(asImapFlow(fake), { name: 'News', dryRun: false })).path).toBe(
      'Labels.News',
    );
    expect(fake.mailboxCreate).toHaveBeenCalledWith(['Labels', 'News']);
    await expect(
      createLabel(asImapFlow(fake), { name: 'News.Deals', dryRun: false }),
    ).rejects.toThrow(/delimiter/i);
    expect(fake.mailboxCreate).toHaveBeenCalledTimes(1);
  });
});
