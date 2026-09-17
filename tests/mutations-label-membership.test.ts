import { describe, expect, it } from 'vitest';
import {
  labelNameFromPath,
  listLabelFolders,
  resolveLabelMembership,
  toSortedLabelNames,
} from '../src/mutations/label-membership.js';
import { asImapFlow, createFakeImapClient, fakeFolder } from './fakes/imap-client.js';

const folders = [
  fakeFolder({ path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' }),
  fakeFolder({ path: 'Labels', name: 'Labels', flags: new Set(['\\Noselect']) }),
  fakeFolder({ path: 'Labels/Work', name: 'Work' }),
  fakeFolder({ path: 'Labels/Personal', name: 'Personal' }),
];

describe('listLabelFolders', () => {
  it('returns only concrete Labels/... mailboxes, never the bare Labels container', () => {
    const result = listLabelFolders(folders, '/').map((folder) => folder.path);
    expect(result.sort()).toEqual(['Labels/Personal', 'Labels/Work']);
  });
});

describe('labelNameFromPath', () => {
  it('strips the Labels/ prefix', () => {
    expect(labelNameFromPath('Labels/Work', '/')).toBe('Work');
  });

  it('returns the path unchanged if it has no Labels/ prefix', () => {
    expect(labelNameFromPath('INBOX', '/')).toBe('INBOX');
  });
});

describe('toSortedLabelNames', () => {
  it('converts paths to sorted logical names', () => {
    expect(toSortedLabelNames(new Set(['Labels/Work', 'Labels/Personal']), '/')).toEqual([
      'Personal',
      'Work',
    ]);
  });

  it('returns an empty array for an empty set', () => {
    expect(toSortedLabelNames(new Set(), '/')).toEqual([]);
  });
});

describe('resolveLabelMembership', () => {
  it('reports which label mailboxes contain a correlated copy of each message', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        'Labels/Work': { searchResult: [1] },
        'Labels/Personal': { searchResult: [] },
      },
    });

    const result = await resolveLabelMembership(asImapFlow(fake), listLabelFolders(folders, '/'), [
      '<a@example.com>',
    ]);

    expect(result.get('<a@example.com>')).toEqual(new Set(['Labels/Work']));
  });

  it('skips undefined message ids and never opens a lock when there are no label folders', async () => {
    const fake = createFakeImapClient({ folders });
    const result = await resolveLabelMembership(asImapFlow(fake), [], [undefined, 'x']);
    // 'x' still gets an entry (empty set: no labels exist to check against);
    // undefined is never a key.
    expect(Array.from(result.keys())).toEqual(['x']);
    expect(result.get('x')).toEqual(new Set());
    expect(fake.getMailboxLock).not.toHaveBeenCalled();
  });

  it('only ever opens each label mailbox read-only', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: { 'Labels/Work': { searchResult: [] }, 'Labels/Personal': { searchResult: [] } },
    });

    await resolveLabelMembership(asImapFlow(fake), listLabelFolders(folders, '/'), [
      '<a@example.com>',
    ]);

    expect(fake.lockCalls.every((call) => call.readOnly === true)).toBe(true);
  });
});
