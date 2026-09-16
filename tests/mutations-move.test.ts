import type { FetchMessageObject } from 'imapflow';
import { describe, expect, it } from 'vitest';
import { archiveMessages } from '../src/mutations/archive.js';
import { moveMessages } from '../src/mutations/move.js';
import { markAsSpam } from '../src/mutations/spam.js';
import { asImapFlow, createFakeImapClient, fakeFolder } from './fakes/imap-client.js';

const folders = [
  fakeFolder({ path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' }),
  fakeFolder({ path: 'Archive', name: 'Archive', specialUse: '\\Archive' }),
  fakeFolder({ path: 'Spam', name: 'Spam', specialUse: '\\Junk' }),
  fakeFolder({ path: 'Trash', name: 'Trash', specialUse: '\\Trash' }),
  fakeFolder({ path: 'Sent', name: 'Sent', specialUse: '\\Sent' }),
  fakeFolder({ path: 'Drafts', name: 'Drafts', specialUse: '\\Drafts' }),
  fakeFolder({ path: 'All Mail', name: 'All Mail', specialUse: '\\All' }),
  fakeFolder({ path: 'Folders', name: 'Folders', flags: new Set(['\\Noselect']) }),
  fakeFolder({ path: 'Labels', name: 'Labels', flags: new Set(['\\Noselect']) }),
  fakeFolder({ path: 'Folders/Projects', name: 'Projects', parentPath: 'Folders' }),
];

function fakeMessage(uid: number): FetchMessageObject {
  return { seq: uid, uid };
}

describe('mail_move (moveMessages)', () => {
  it('a bare logical custom-folder name resolves to Folders/<name> and never calls messageMove during dry-run', async () => {
    const fake = createFakeImapClient({ folders, fetchResults: [fakeMessage(10)] });

    const result = await moveMessages(asImapFlow(fake), {
      sourceFolder: 'INBOX',
      destinationFolder: 'Projects',
      uids: [10],
      dryRun: true,
    });

    expect(result.matchedUids).toEqual([10]);
    expect(result.changedUids).toEqual([]);
    expect(fake.messageMove).not.toHaveBeenCalled();
    expect(fake.lockCalls.every((call) => call.readOnly === true)).toBe(true);
  });

  it('live run moves matched UIDs to the resolved Folders/<name> path', async () => {
    const fake = createFakeImapClient({ folders, fetchResults: [fakeMessage(10)] });

    const result = await moveMessages(asImapFlow(fake), {
      sourceFolder: 'INBOX',
      destinationFolder: 'Projects',
      uids: [10],
      dryRun: false,
    });

    expect(result.changedUids).toEqual([10]);
    expect(fake.messageMove).toHaveBeenCalledWith([10], 'Folders/Projects', { uid: true });
  });

  it('an already-qualified Folders/<name> path (as mail_list_folders would report) resolves identically', async () => {
    const fake = createFakeImapClient({ folders, fetchResults: [fakeMessage(10)] });

    const result = await moveMessages(asImapFlow(fake), {
      sourceFolder: 'INBOX',
      destinationFolder: 'Folders/Projects',
      uids: [10],
      dryRun: false,
    });

    expect(result.changedUids).toEqual([10]);
    expect(fake.messageMove).toHaveBeenCalledWith([10], 'Folders/Projects', { uid: true });
  });

  it('refuses the bare namespace container "Folders" itself as a destination', async () => {
    const fake = createFakeImapClient({ folders });
    await expect(
      moveMessages(asImapFlow(fake), {
        sourceFolder: 'INBOX',
        destinationFolder: 'Folders',
        uids: [10],
        dryRun: true,
      }),
    ).rejects.toThrow(/namespace container/i);
    expect(fake.messageMove).not.toHaveBeenCalled();
  });

  it('refuses a destination inside the Labels namespace', async () => {
    const fake = createFakeImapClient({ folders });
    await expect(
      moveMessages(asImapFlow(fake), {
        sourceFolder: 'INBOX',
        destinationFolder: 'Labels/MCP Test',
        uids: [10],
        dryRun: true,
      }),
    ).rejects.toThrow(/is a label, not a folder/i);
    expect(fake.messageMove).not.toHaveBeenCalled();
  });

  it('rejects source === destination', async () => {
    const fake = createFakeImapClient({ folders });
    await expect(
      moveMessages(asImapFlow(fake), {
        sourceFolder: 'INBOX',
        destinationFolder: 'INBOX',
        uids: [10],
        dryRun: true,
      }),
    ).rejects.toThrow(/must be different/i);
  });

  it('rejects a nonexistent destination folder', async () => {
    const fake = createFakeImapClient({ folders });
    await expect(
      moveMessages(asImapFlow(fake), {
        sourceFolder: 'INBOX',
        destinationFolder: 'DoesNotExist',
        uids: [10],
        dryRun: true,
      }),
    ).rejects.toThrow(/no such/i);
  });

  it.each(['Trash', 'Spam', 'Sent', 'Drafts', 'All Mail'])(
    'refuses to move messages into protected destination %s',
    async (destination) => {
      const fake = createFakeImapClient({ folders });
      await expect(
        moveMessages(asImapFlow(fake), {
          sourceFolder: 'INBOX',
          destinationFolder: destination,
          uids: [10],
          dryRun: true,
        }),
      ).rejects.toThrow();
      expect(fake.messageMove).not.toHaveBeenCalled();
    },
  );

  it('allows Archive as a mail_move destination (only mail_archive enforces the archive-specific no-op guard)', async () => {
    const fake = createFakeImapClient({ folders, fetchResults: [fakeMessage(10)] });
    await expect(
      moveMessages(asImapFlow(fake), {
        sourceFolder: 'INBOX',
        destinationFolder: 'Archive',
        uids: [10],
        dryRun: true,
      }),
    ).resolves.toBeDefined();
  });
});

describe('mail_archive (archiveMessages)', () => {
  it('dry-run never calls messageMove', async () => {
    const fake = createFakeImapClient({ folders, fetchResults: [fakeMessage(10)] });
    const result = await archiveMessages(asImapFlow(fake), {
      folder: 'INBOX',
      uids: [10],
      dryRun: true,
    });
    expect(result.changedUids).toEqual([]);
    expect(fake.messageMove).not.toHaveBeenCalled();
  });

  it('live run moves messages to the resolved Archive folder', async () => {
    const fake = createFakeImapClient({ folders, fetchResults: [fakeMessage(10)] });
    const result = await archiveMessages(asImapFlow(fake), {
      folder: 'INBOX',
      uids: [10],
      dryRun: false,
    });
    expect(result.changedUids).toEqual([10]);
    expect(fake.messageMove).toHaveBeenCalledWith([10], 'Archive', { uid: true });
  });

  it('refuses Archive -> Archive as an unnecessary operation', async () => {
    const fake = createFakeImapClient({ folders });
    await expect(
      archiveMessages(asImapFlow(fake), { folder: 'Archive', uids: [10], dryRun: true }),
    ).rejects.toThrow(/already archive/i);
    expect(fake.messageMove).not.toHaveBeenCalled();
  });

  it('throws a clear error when the account has no resolvable Archive folder', async () => {
    const fake = createFakeImapClient({ folders: [fakeFolder({ path: 'INBOX', name: 'INBOX' })] });
    await expect(
      archiveMessages(asImapFlow(fake), { folder: 'INBOX', uids: [10], dryRun: true }),
    ).rejects.toThrow(/could not find an archive folder/i);
  });
});

describe('mail_mark_spam (markAsSpam)', () => {
  it('dry-run never calls messageMove even without confirm', async () => {
    const fake = createFakeImapClient({ folders, fetchResults: [fakeMessage(10)] });
    const result = await markAsSpam(asImapFlow(fake), {
      folder: 'INBOX',
      uids: [10],
      dryRun: true,
      confirm: false,
      acknowledgeFutureFiltering: false,
    });
    expect(result.changedUids).toEqual([]);
    expect(result.spamFilteringNotice?.futureFilteringEffect).toBe(true);
    expect(fake.messageMove).not.toHaveBeenCalled();
    expect(fake.messageFlagsAdd).not.toHaveBeenCalled();
    expect(fake.messageFlagsRemove).not.toHaveBeenCalled();
    expect(fake.messageCopy).not.toHaveBeenCalled();
    expect(fake.mailboxCreate).not.toHaveBeenCalled();
    expect(fake.lockCalls.every((call) => call.readOnly === true)).toBe(true);
  });

  it.each([
    [false, false],
    [true, false],
    [false, true],
  ])(
    'rejects live execution with confirm=%s and acknowledgeFutureFiltering=%s before IMAP access',
    async (confirm, acknowledgeFutureFiltering) => {
      const fake = createFakeImapClient({ folders, fetchResults: [fakeMessage(10)] });
      await expect(
        markAsSpam(asImapFlow(fake), {
          folder: 'INBOX',
          uids: [10],
          dryRun: false,
          confirm,
          acknowledgeFutureFiltering,
        }),
      ).rejects.toThrow(/confirm=true and acknowledgeFutureFiltering=true/);
      expect(fake.list).not.toHaveBeenCalled();
      expect(fake.getMailboxLock).not.toHaveBeenCalled();
      expect(fake.messageMove).not.toHaveBeenCalled();
      expect(fake.messageFlagsAdd).not.toHaveBeenCalled();
      expect(fake.messageFlagsRemove).not.toHaveBeenCalled();
      expect(fake.messageCopy).not.toHaveBeenCalled();
      expect(fake.mailboxCreate).not.toHaveBeenCalled();
    },
  );

  it('executes only with both confirmations and reports the Spam UID transition', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        INBOX: {
          fetchResults: [{ seq: 708, uid: 708, envelope: { messageId: '<spam@example.com>' } }],
        },
        Spam: { fetchResults: [{ seq: 3, uid: 3, envelope: { messageId: '<spam@example.com>' } }] },
      },
      moveResult: { path: 'INBOX', destination: 'Spam', uidMap: new Map([[708, 3]]) },
    });
    const result = await markAsSpam(asImapFlow(fake), {
      folder: 'INBOX',
      uids: [708],
      dryRun: false,
      confirm: true,
      acknowledgeFutureFiltering: true,
    });
    expect(result.changedUids).toEqual([708]);
    expect(fake.messageMove).toHaveBeenCalledWith([708], 'Spam', { uid: true });
    expect(result.spamFilteringNotice?.futureFilteringEffect).toBe(true);
    expect(result.spamFilteringNotice?.warning).toMatch(/future messages.*spam/i);
    expect(result.transitions).toEqual([
      {
        requestedUid: 708,
        sourceFolder: 'INBOX',
        destinationFolder: 'Spam',
        originalUidStillValid: false,
        resultingUid: 3,
      },
    ]);
  });

  it('refuses Spam -> Spam as an unnecessary operation', async () => {
    const fake = createFakeImapClient({ folders });
    await expect(
      markAsSpam(asImapFlow(fake), {
        folder: 'Spam',
        uids: [10],
        dryRun: true,
        confirm: false,
        acknowledgeFutureFiltering: false,
      }),
    ).rejects.toThrow(/already spam/i);
  });

  it('does not claim to manage Block or Allow lists', async () => {
    const fake = createFakeImapClient({ folders, fetchResults: [fakeMessage(10)] });
    const result = await markAsSpam(asImapFlow(fake), {
      folder: 'INBOX',
      uids: [10],
      dryRun: false,
      confirm: true,
      acknowledgeFutureFiltering: true,
    });
    expect(result).not.toHaveProperty('blockedSender');
    expect(result).not.toHaveProperty('addedToBlockList');
    expect(result).not.toHaveProperty('allowedSender');
    expect(result).not.toHaveProperty('addedToAllowList');
  });

  it('partial failure: reports per-uid errors without discarding the rest of the result', async () => {
    const fake = createFakeImapClient({
      folders,
      fetchResults: [fakeMessage(10), fakeMessage(11)],
      moveResult: false,
    });
    const result = await markAsSpam(asImapFlow(fake), {
      folder: 'INBOX',
      uids: [10, 11],
      dryRun: false,
      confirm: true,
      acknowledgeFutureFiltering: true,
    });
    expect(result.matchedUids.sort()).toEqual([10, 11]);
    expect(result.changedUids).toEqual([]);
    expect(result.errors).toHaveLength(2);
  });
});
