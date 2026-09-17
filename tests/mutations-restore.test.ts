import type { FetchMessageObject } from 'imapflow';
import { describe, expect, it } from 'vitest';
import { restoreFromTrash } from '../src/mutations/restore.js';
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
  fakeFolder({ path: 'Labels/Work', name: 'Work' }),
];

function fakeMessage(uid: number, messageId?: string): FetchMessageObject {
  return { seq: uid, uid, envelope: messageId ? { messageId } : undefined };
}

const liveIntent = { dryRun: false, confirm: true, acknowledgeRestoreFromTrash: true } as const;

describe('mail_restore_from_trash (restoreFromTrash) — destinations', () => {
  it('restores Trash -> INBOX', async () => {
    const fake = createFakeImapClient({ folders, fetchResults: [fakeMessage(10)] });
    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [10],
      destinationFolder: 'INBOX',
      ...liveIntent,
    });
    expect(result.changedUids).toEqual([10]);
    expect(result.moveRestored).toEqual([10]);
    expect(fake.messageMove).toHaveBeenCalledWith([10], 'INBOX', { uid: true });
  });

  it('restores Trash -> Archive', async () => {
    const fake = createFakeImapClient({ folders, fetchResults: [fakeMessage(10)] });
    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [10],
      destinationFolder: 'Archive',
      ...liveIntent,
    });
    expect(result.changedUids).toEqual([10]);
    expect(fake.messageMove).toHaveBeenCalledWith([10], 'Archive', { uid: true });
  });

  it('restores Trash -> a custom folder, resolved under Folders/', async () => {
    const fake = createFakeImapClient({ folders, fetchResults: [fakeMessage(10)] });
    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [10],
      destinationFolder: 'Projects',
      ...liveIntent,
    });
    expect(result.changedUids).toEqual([10]);
    expect(fake.messageMove).toHaveBeenCalledWith([10], 'Folders/Projects', { uid: true });
  });

  it('rejects a nonexistent destination folder', async () => {
    const fake = createFakeImapClient({ folders });
    await expect(
      restoreFromTrash(asImapFlow(fake), {
        uids: [10],
        destinationFolder: 'DoesNotExist',
        ...liveIntent,
      }),
    ).rejects.toThrow(/no such/i);
    expect(fake.messageMove).not.toHaveBeenCalled();
  });

  it('rejects Trash as a destination (Trash -> Trash)', async () => {
    const fake = createFakeImapClient({ folders });
    await expect(
      restoreFromTrash(asImapFlow(fake), {
        uids: [10],
        destinationFolder: 'Trash',
        ...liveIntent,
      }),
    ).rejects.toThrow();
    expect(fake.messageMove).not.toHaveBeenCalled();
  });

  it('rejects Spam as a destination (has its own dedicated, separately-gated tool)', async () => {
    const fake = createFakeImapClient({ folders });
    await expect(
      restoreFromTrash(asImapFlow(fake), {
        uids: [10],
        destinationFolder: 'Spam',
        ...liveIntent,
      }),
    ).rejects.toThrow();
    expect(fake.messageMove).not.toHaveBeenCalled();
  });

  it.each(['Sent', 'Drafts', 'All Mail'])('rejects %s as a destination', async (destination) => {
    const fake = createFakeImapClient({ folders });
    await expect(
      restoreFromTrash(asImapFlow(fake), {
        uids: [10],
        destinationFolder: destination,
        ...liveIntent,
      }),
    ).rejects.toThrow();
    expect(fake.messageMove).not.toHaveBeenCalled();
  });

  it('rejects a Labels/... reference as a destination', async () => {
    const fake = createFakeImapClient({ folders });
    await expect(
      restoreFromTrash(asImapFlow(fake), {
        uids: [10],
        destinationFolder: 'Labels/Work',
        ...liveIntent,
      }),
    ).rejects.toThrow(/is a label, not a folder/i);
    expect(fake.messageMove).not.toHaveBeenCalled();
  });

  it('rejects the bare namespace container "Folders"', async () => {
    const fake = createFakeImapClient({ folders });
    await expect(
      restoreFromTrash(asImapFlow(fake), {
        uids: [10],
        destinationFolder: 'Folders',
        ...liveIntent,
      }),
    ).rejects.toThrow(/namespace container/i);
  });

  it('throws when the account has no resolvable Trash folder', async () => {
    const fake = createFakeImapClient({
      folders: [fakeFolder({ path: 'INBOX', name: 'INBOX' })],
    });
    await expect(
      restoreFromTrash(asImapFlow(fake), { uids: [10], destinationFolder: 'INBOX', ...liveIntent }),
    ).rejects.toThrow(/could not find a trash folder/i);
  });

  it('the folder restore never touches flags — an IMAP MOVE preserves them by itself', async () => {
    const fake = createFakeImapClient({ folders, fetchResults: [fakeMessage(10)] });
    await restoreFromTrash(asImapFlow(fake), {
      uids: [10],
      destinationFolder: 'INBOX',
      ...liveIntent,
    });
    expect(fake.messageFlagsAdd).not.toHaveBeenCalled();
    expect(fake.messageFlagsRemove).not.toHaveBeenCalled();
  });
});

describe('mail_restore_from_trash (restoreFromTrash) — confirmation gate & dry-run', () => {
  it.each([
    [false, false],
    [true, false],
    [false, true],
  ])(
    'rejects live execution with confirm=%s and acknowledgeRestoreFromTrash=%s before IMAP access',
    async (confirm, acknowledgeRestoreFromTrash) => {
      const fake = createFakeImapClient({ folders, fetchResults: [fakeMessage(10)] });
      await expect(
        restoreFromTrash(asImapFlow(fake), {
          uids: [10],
          destinationFolder: 'INBOX',
          dryRun: false,
          confirm,
          acknowledgeRestoreFromTrash,
        }),
      ).rejects.toThrow(/confirm=true and acknowledgeRestoreFromTrash=true/);
      expect(fake.list).not.toHaveBeenCalled();
      expect(fake.messageMove).not.toHaveBeenCalled();
    },
  );

  it('dry-run never calls messageMove and opens only read-only locks', async () => {
    const fake = createFakeImapClient({ folders, fetchResults: [fakeMessage(10)] });
    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [10],
      destinationFolder: 'INBOX',
      dryRun: true,
      confirm: false,
      acknowledgeRestoreFromTrash: false,
    });
    expect(result.changedUids).toEqual([]);
    expect(result.moveRestored).toEqual([]);
    expect(fake.messageMove).not.toHaveBeenCalled();
    expect(fake.lockCalls.every((call) => call.readOnly === true)).toBe(true);
  });
});

describe('mail_restore_from_trash (restoreFromTrash) — stale/missing uids', () => {
  it('a uid present during read-only resolution but gone by write-lock time is not restored', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        Trash: {
          fetchSequence: [[fakeMessage(5), fakeMessage(6)], [fakeMessage(6)]],
        },
      },
    });

    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5, 6],
      destinationFolder: 'INBOX',
      ...liveIntent,
    });

    expect(result.changedUids).toEqual([6]);
    expect(result.missingUids).toContain(5);
    expect(fake.messageMove).toHaveBeenCalledWith([6], 'INBOX', { uid: true });
  });

  it('reports a requested uid absent from Trash as missing', async () => {
    const fake = createFakeImapClient({ folders, fetchResults: [] });
    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [99],
      destinationFolder: 'INBOX',
      ...liveIntent,
    });
    expect(result.missingUids).toEqual([99]);
    expect(result.changedUids).toEqual([]);
  });
});

describe('mail_restore_from_trash (restoreFromTrash) — UID reconciliation', () => {
  it('reports the resulting UID transition after restore', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        Trash: { fetchResults: [fakeMessage(5, '<a@example.com>')] },
        INBOX: { fetchResults: [fakeMessage(9, '<a@example.com>')] },
      },
      moveResult: { path: 'Trash', destination: 'INBOX', uidMap: new Map([[5, 9]]) },
    });

    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'INBOX',
      ...liveIntent,
    });

    expect(result.transitions).toEqual([
      {
        requestedUid: 5,
        sourceFolder: 'Trash',
        destinationFolder: 'INBOX',
        originalUidStillValid: false,
        resultingUid: 9,
      },
    ]);
    expect(result.requiresRefresh).toBe(false);
  });

  it('identity mismatch: a wrong uidMap entry is never trusted, falls back to requiresRefresh', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        Trash: { fetchResults: [fakeMessage(5, '<a@example.com>')] },
        INBOX: { fetchResults: [fakeMessage(9, '<different@example.com>')] },
      },
      moveResult: { path: 'Trash', destination: 'INBOX', uidMap: new Map([[5, 9]]) },
    });

    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'INBOX',
      ...liveIntent,
    });

    expect(result.transitions).toEqual([
      {
        requestedUid: 5,
        sourceFolder: 'Trash',
        destinationFolder: 'INBOX',
        originalUidStillValid: false,
        requiresRefresh: true,
      },
    ]);
    expect(result.requiresRefresh).toBe(true);
  });
});

describe('mail_restore_from_trash (restoreFromTrash) — labelsToRestore', () => {
  it('dry-run reports a requested label that does not exist, without mutating anything', async () => {
    const fake = createFakeImapClient({ folders, fetchResults: [fakeMessage(10)] });
    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [10],
      destinationFolder: 'INBOX',
      labelsToRestore: ['Ghost'],
      dryRun: true,
      confirm: false,
      acknowledgeRestoreFromTrash: false,
    });

    expect(result.labelsRequested).toEqual(['Ghost']);
    expect(result.labelsFailed).toEqual([
      { uid: 10, label: 'Ghost', reason: 'Label does not exist; not created automatically.' },
    ]);
    expect(result.labelsRestored).toEqual([]);
    expect(fake.messageMove).not.toHaveBeenCalled();
  });

  it('a missing label requested live is reported in labelsFailed without rolling back the move', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        Trash: { fetchResults: [fakeMessage(5, '<a@example.com>')] },
        INBOX: { fetchResults: [fakeMessage(9, '<a@example.com>')] },
      },
      moveResult: { path: 'Trash', destination: 'INBOX', uidMap: new Map([[5, 9]]) },
    });

    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'INBOX',
      labelsToRestore: ['Ghost'],
      ...liveIntent,
    });

    expect(result.moveRestored).toEqual([5]);
    expect(result.labelsFailed).toEqual([
      { uid: 5, label: 'Ghost', reason: 'Label does not exist; not created automatically.' },
    ]);
    expect(result.labelsRestored).toEqual([]);
  });

  it('restores one existing label onto the restored message', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        Trash: { fetchResults: [fakeMessage(5, '<a@example.com>')] },
        INBOX: { fetchResults: [fakeMessage(9, '<a@example.com>')] },
        'Labels/Work': { searchResult: [] },
      },
      moveResult: { path: 'Trash', destination: 'INBOX', uidMap: new Map([[5, 9]]) },
    });

    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'INBOX',
      labelsToRestore: ['Work'],
      ...liveIntent,
    });

    expect(result.labelsRestored).toEqual([{ uid: 5, label: 'Work' }]);
    expect(result.labelsFailed).toEqual([]);
    expect(fake.messageMove).toHaveBeenCalledWith([9], 'Labels/Work', { uid: true });
  });

  it('restores multiple existing labels onto the restored message', async () => {
    const fake = createFakeImapClient({
      folders: [...folders, fakeFolder({ path: 'Labels/Personal', name: 'Personal' })],
      mailboxes: {
        Trash: { fetchResults: [fakeMessage(5, '<a@example.com>')] },
        INBOX: { fetchResults: [fakeMessage(9, '<a@example.com>')] },
        'Labels/Work': { searchResult: [] },
        'Labels/Personal': { searchResult: [] },
      },
      moveResult: { path: 'Trash', destination: 'INBOX', uidMap: new Map([[5, 9]]) },
    });

    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'INBOX',
      labelsToRestore: ['Work', 'Personal'],
      ...liveIntent,
    });

    expect(result.labelsRestored?.map((entry) => entry.label).sort()).toEqual(['Personal', 'Work']);
    expect(result.labelsFailed).toEqual([]);
  });

  it('move succeeds but label restoration partially fails — reports both, no rollback', async () => {
    const fake = createFakeImapClient({
      folders: [...folders, fakeFolder({ path: 'Labels/Personal', name: 'Personal' })],
      mailboxes: {
        Trash: { fetchResults: [fakeMessage(5, '<a@example.com>')] },
        INBOX: { fetchResults: [fakeMessage(9, '<a@example.com>')] },
        'Labels/Work': { searchResult: [] },
        'Labels/Personal': { searchResult: [] },
      },
      moveResult: { path: 'Trash', destination: 'INBOX', uidMap: new Map([[5, 9]]) },
    });

    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'INBOX',
      labelsToRestore: ['Work', 'Ghost'],
      ...liveIntent,
    });

    // The folder restore itself is unaffected by the label outcome.
    expect(result.moveRestored).toEqual([5]);
    expect(result.labelsRestored).toEqual([{ uid: 5, label: 'Work' }]);
    expect(result.labelsFailed).toEqual([
      { uid: 5, label: 'Ghost', reason: 'Label does not exist; not created automatically.' },
    ]);
  });

  it('does not reapply a label to a uid whose destination identity requires a refresh', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        Trash: { fetchResults: [fakeMessage(5, '<a@example.com>')] },
        // No matching Message-ID in INBOX and no uidMap entry -> the
        // reconciliation cannot determine a resultingUid.
        INBOX: { fetchResults: [] },
        'Labels/Work': { searchResult: [] },
      },
    });

    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'INBOX',
      labelsToRestore: ['Work'],
      ...liveIntent,
    });

    expect(result.requiresRefresh).toBe(true);
    expect(result.labelsFailed?.[0]?.reason).toMatch(/requiresRefresh/);
    expect(fake.messageMove).toHaveBeenCalledTimes(1); // only the folder restore, no label move attempted
  });
});
