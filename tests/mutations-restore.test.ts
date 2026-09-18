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
  fakeFolder({ path: 'Labels/Personal', name: 'Personal' }),
];

function fakeMessage(uid: number, messageId?: string, flags?: string[]): FetchMessageObject {
  return {
    seq: uid,
    uid,
    envelope: messageId ? { messageId } : undefined,
    flags: flags ? new Set(flags) : undefined,
  };
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

  it('dry-run never calls messageMove/messageFlagsAdd/messageFlagsRemove and opens only read-only locks', async () => {
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
    expect(fake.messageFlagsAdd).not.toHaveBeenCalled();
    expect(fake.messageFlagsRemove).not.toHaveBeenCalled();
    expect(fake.lockCalls.every((call) => call.readOnly === true)).toBe(true);
    expect(result.requiresRefresh).toBeUndefined();
    expect(result.partialSuccess).toBeUndefined();
  });

  it('dry-run reports current flags and labels as a preview, without an "after" measurement', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        Trash: { fetchResults: [fakeMessage(5, '<a@example.com>', ['\\Seen'])] },
        'Labels/Work': { searchResult: [1] },
        'Labels/Personal': { searchResult: [] },
      },
    });
    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'INBOX',
      dryRun: true,
      confirm: false,
      acknowledgeRestoreFromTrash: false,
    });
    expect(result.originalFlags).toEqual([{ uid: 5, flags: ['\\Seen'] }]);
    expect(result.originalLabels).toEqual([{ uid: 5, labels: ['Work'] }]);
    expect(result.flagsAfterMove).toBeUndefined();
    expect(result.labelsAfterMove).toBeUndefined();
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
  it('reports the resulting UID transition after restore, requiresRefresh false on a clean confirmation', async () => {
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
    expect(result.partialSuccess).toBe(false);
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
    expect(result.partialSuccess).toBe(true);
  });
});

describe('mail_restore_from_trash (restoreFromTrash) — live finding regression: labels lost on restore', () => {
  it('detects two labels missing after the move and reapplies both automatically', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        Trash: { fetchResults: [fakeMessage(5, '<a@example.com>')] },
        INBOX: { fetchResults: [fakeMessage(9, '<a@example.com>')] },
        // Present before the move (originalLabels), absent after — exactly
        // the live-observed bug: Trash -> Archive silently dropped both.
        'Labels/Work': { searchSequence: [[1], []] },
        'Labels/Personal': { searchSequence: [[1], []] },
      },
      moveResult: { path: 'Trash', destination: 'INBOX', uidMap: new Map([[5, 9]]) },
    });

    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'INBOX',
      ...liveIntent,
    });

    expect(result.originalLabels).toEqual([{ uid: 5, labels: ['Personal', 'Work'] }]);
    expect(result.labelsAfterMove).toEqual([{ uid: 5, labels: [] }]);
    expect(result.labelsRestored?.map((entry) => entry.label).sort()).toEqual(['Personal', 'Work']);
    expect(result.labelsFailed).toEqual([]);
    // Reapplied by moving the restored (resultingUid) message into each
    // label mailbox — never a second move of the message itself.
    expect(fake.messageMove).toHaveBeenCalledWith([9], 'Labels/Work', { uid: true });
    expect(fake.messageMove).toHaveBeenCalledWith([9], 'Labels/Personal', { uid: true });
  });
});

describe('mail_restore_from_trash (restoreFromTrash) — live finding regression: \\Seen flipped on restore', () => {
  it('detects unread -> read after the move and removes \\Seen automatically', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        // unread=true in Trash: no \Seen flag.
        Trash: { fetchResults: [fakeMessage(5, '<a@example.com>')] },
        // The move flips it to read (\Seen present) — the exact live bug.
        INBOX: { fetchResults: [fakeMessage(9, '<a@example.com>', ['\\Seen'])] },
        'Labels/Work': { searchResult: [] },
        'Labels/Personal': { searchResult: [] },
      },
      moveResult: { path: 'Trash', destination: 'INBOX', uidMap: new Map([[5, 9]]) },
    });

    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'INBOX',
      ...liveIntent,
    });

    expect(result.originalFlags).toEqual([{ uid: 5, flags: [] }]);
    expect(result.flagsAfterMove).toEqual([{ uid: 5, flags: ['\\Seen'] }]);
    expect(result.flagsRestored).toEqual([{ uid: 5, flag: '\\Seen' }]);
    expect(result.flagsFailed).toEqual([]);
    expect(fake.messageFlagsRemove).toHaveBeenCalledWith([9], ['\\Seen'], { uid: true });
    expect(fake.messageFlagsAdd).not.toHaveBeenCalled();
  });

  it('preserves \\Flagged (Starred) the same way — not just \\Seen', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        // Starred in Trash.
        Trash: { fetchResults: [fakeMessage(5, '<a@example.com>', ['\\Flagged'])] },
        // The move drops it.
        INBOX: { fetchResults: [fakeMessage(9, '<a@example.com>')] },
        'Labels/Work': { searchResult: [] },
        'Labels/Personal': { searchResult: [] },
      },
      moveResult: { path: 'Trash', destination: 'INBOX', uidMap: new Map([[5, 9]]) },
    });

    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'INBOX',
      ...liveIntent,
    });

    expect(result.originalFlags).toEqual([{ uid: 5, flags: ['\\Flagged'] }]);
    expect(result.flagsAfterMove).toEqual([{ uid: 5, flags: [] }]);
    expect(result.flagsRestored).toEqual([{ uid: 5, flag: '\\Flagged' }]);
    expect(fake.messageFlagsAdd).toHaveBeenCalledWith([9], ['\\Flagged'], { uid: true });
    expect(fake.messageFlagsRemove).not.toHaveBeenCalled();
  });
});

describe('mail_restore_from_trash (restoreFromTrash) — live finding regression: both simultaneously', () => {
  it('reproduces the exact real-world bug (2 labels lost + unread -> read) and repairs both', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        Trash: { fetchResults: [fakeMessage(5, '<a@example.com>')] },
        INBOX: { fetchResults: [fakeMessage(9, '<a@example.com>', ['\\Seen'])] },
        'Labels/Work': { searchSequence: [[1], []] },
        'Labels/Personal': { searchSequence: [[1], []] },
      },
      moveResult: { path: 'Trash', destination: 'INBOX', uidMap: new Map([[5, 9]]) },
    });

    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'INBOX',
      ...liveIntent,
    });

    expect(result.labelsRestored?.map((entry) => entry.label).sort()).toEqual(['Personal', 'Work']);
    expect(result.flagsRestored).toEqual([{ uid: 5, flag: '\\Seen' }]);
    expect(result.labelsFailed).toEqual([]);
    expect(result.flagsFailed).toEqual([]);
    expect(result.requiresRefresh).toBe(false);
    expect(result.partialSuccess).toBe(false);
  });
});

describe('mail_restore_from_trash (restoreFromTrash) — labelsToRestore (extras) semantics', () => {
  it('with no extras, original labels are still preserved without passing labelsToRestore', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        Trash: { fetchResults: [fakeMessage(5, '<a@example.com>')] },
        INBOX: { fetchResults: [fakeMessage(9, '<a@example.com>')] },
        'Labels/Work': { searchSequence: [[1], []] },
        'Labels/Personal': { searchResult: [] },
      },
      moveResult: { path: 'Trash', destination: 'INBOX', uidMap: new Map([[5, 9]]) },
    });

    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'INBOX',
      ...liveIntent,
    });

    expect(result.labelsRequested).toBeUndefined();
    expect(result.labelsRestored).toEqual([{ uid: 5, label: 'Work' }]);
  });

  it('one extra is applied in addition to (never instead of) automatic preservation', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        Trash: { fetchResults: [fakeMessage(5, '<a@example.com>')] },
        INBOX: { fetchResults: [fakeMessage(9, '<a@example.com>')] },
        // Work survived the trash trip; Personal is a fresh extra request.
        'Labels/Work': { searchResult: [1] },
        'Labels/Personal': { searchResult: [] },
      },
      moveResult: { path: 'Trash', destination: 'INBOX', uidMap: new Map([[5, 9]]) },
    });

    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'INBOX',
      labelsToRestore: ['Personal'],
      ...liveIntent,
    });

    expect(result.labelsRequested).toEqual(['Personal']);
    expect(result.labelsRestored).toEqual([{ uid: 5, label: 'Personal' }]);
  });

  it('multiple extras are all applied', async () => {
    const fake = createFakeImapClient({
      folders,
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
  });

  it('a duplicate extra that matches an already-preserved original label is applied once, not twice', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        Trash: { fetchResults: [fakeMessage(5, '<a@example.com>')] },
        INBOX: { fetchResults: [fakeMessage(9, '<a@example.com>')] },
        // Work was lost by the move (needs auto-repair) AND requested again as an extra.
        'Labels/Work': { searchSequence: [[1], []] },
        'Labels/Personal': { searchResult: [] },
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
    expect(fake.messageMove).toHaveBeenCalledWith([9], 'Labels/Work', { uid: true });
    // Exactly one call into Labels/Work despite Work being both auto-detected
    // missing AND requested as an extra.
    expect(fake.messageMove.mock.calls.filter((call) => call[1] === 'Labels/Work')).toHaveLength(1);
  });

  it('a nonexistent extra is rejected before any move — dry-run', async () => {
    const fake = createFakeImapClient({ folders, fetchResults: [fakeMessage(10)] });
    await expect(
      restoreFromTrash(asImapFlow(fake), {
        uids: [10],
        destinationFolder: 'INBOX',
        labelsToRestore: ['Ghost'],
        dryRun: true,
        confirm: false,
        acknowledgeRestoreFromTrash: false,
      }),
    ).rejects.toThrow(/does not exist/i);
    expect(fake.messageMove).not.toHaveBeenCalled();
  });

  it('a nonexistent extra is rejected before any move — live', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        Trash: { fetchResults: [fakeMessage(5, '<a@example.com>')] },
        INBOX: { fetchResults: [fakeMessage(9, '<a@example.com>')] },
      },
      moveResult: { path: 'Trash', destination: 'INBOX', uidMap: new Map([[5, 9]]) },
    });
    await expect(
      restoreFromTrash(asImapFlow(fake), {
        uids: [5],
        destinationFolder: 'INBOX',
        labelsToRestore: ['Ghost'],
        ...liveIntent,
      }),
    ).rejects.toThrow(/does not exist/i);
    expect(fake.messageMove).not.toHaveBeenCalled();
  });

  it('an existing extra label is never created, never applied to a uid whose identity was not confirmed', async () => {
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

  it('an existing extra label reapplies while a different one fails to apply — reports both, no rollback of the move', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        Trash: { fetchResults: [fakeMessage(5, '<a@example.com>')] },
        INBOX: { fetchResults: [fakeMessage(9, '<a@example.com>')] },
        'Labels/Work': { searchResult: [] },
        'Labels/Personal': { searchResult: [] },
      },
    });
    fake.messageMove
      .mockReturnValueOnce({ path: 'Trash', destination: 'INBOX', uidMap: new Map([[5, 9]]) }) // main restore
      .mockReturnValueOnce({ path: 'INBOX', destination: 'Labels/Work', uidMap: new Map() }) // Work succeeds
      .mockReturnValueOnce(false); // Personal rejected by the server

    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'INBOX',
      labelsToRestore: ['Work', 'Personal'],
      ...liveIntent,
    });

    expect(result.moveRestored).toEqual([5]);
    expect(result.labelsRestored).toEqual([{ uid: 5, label: 'Work' }]);
    expect(result.labelsFailed).toEqual([
      { uid: 5, label: 'Personal', reason: 'IMAP server rejected applying the label.' },
    ]);
    expect(result.partialSuccess).toBe(true);
  });
});

describe('mail_restore_from_trash (restoreFromTrash) — failure paths', () => {
  it('all label repairs failing still reports the successful move, no rollback', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        Trash: { fetchResults: [fakeMessage(5, '<a@example.com>')] },
        INBOX: { fetchResults: [fakeMessage(9, '<a@example.com>')] },
        'Labels/Work': { searchSequence: [[1], []] },
        'Labels/Personal': { searchSequence: [[1], []] },
      },
    });
    fake.messageMove
      .mockReturnValueOnce({ path: 'Trash', destination: 'INBOX', uidMap: new Map([[5, 9]]) })
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false);

    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'INBOX',
      ...liveIntent,
    });

    expect(result.moveRestored).toEqual([5]);
    expect(result.labelsRestored).toEqual([]);
    expect(result.labelsFailed?.map((entry) => entry.label).sort()).toEqual(['Personal', 'Work']);
    expect(result.partialSuccess).toBe(true);
  });

  it('flag repair failing is reported without rolling back the move or the labels', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        Trash: { fetchResults: [fakeMessage(5, '<a@example.com>')] },
        INBOX: { fetchResults: [fakeMessage(9, '<a@example.com>', ['\\Seen'])] },
        'Labels/Work': { searchResult: [] },
        'Labels/Personal': { searchResult: [] },
      },
      moveResult: { path: 'Trash', destination: 'INBOX', uidMap: new Map([[5, 9]]) },
      flagsOk: false,
    });

    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'INBOX',
      ...liveIntent,
    });

    expect(result.moveRestored).toEqual([5]);
    expect(result.flagsRestored).toEqual([]);
    expect(result.flagsFailed).toEqual([
      { uid: 5, flag: '\\Seen', reason: 'IMAP server rejected the flag change.' },
    ]);
    expect(result.partialSuccess).toBe(true);
  });

  it('label repair succeeds while flag repair fails — both reported independently', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        Trash: { fetchResults: [fakeMessage(5, '<a@example.com>')] },
        INBOX: { fetchResults: [fakeMessage(9, '<a@example.com>', ['\\Seen'])] },
        'Labels/Work': { searchSequence: [[1], []] },
        'Labels/Personal': { searchResult: [] },
      },
      moveResult: { path: 'Trash', destination: 'INBOX', uidMap: new Map([[5, 9]]) },
      flagsOk: false,
    });

    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'INBOX',
      ...liveIntent,
    });

    expect(result.labelsRestored).toEqual([{ uid: 5, label: 'Work' }]);
    expect(result.flagsFailed).toEqual([
      { uid: 5, flag: '\\Seen', reason: 'IMAP server rejected the flag change.' },
    ]);
  });

  it('flag repair succeeds while label repair fails — both reported independently', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        Trash: { fetchResults: [fakeMessage(5, '<a@example.com>')] },
        INBOX: { fetchResults: [fakeMessage(9, '<a@example.com>', ['\\Seen'])] },
        'Labels/Work': { searchSequence: [[1], []] },
        'Labels/Personal': { searchResult: [] },
      },
    });
    fake.messageMove
      .mockReturnValueOnce({ path: 'Trash', destination: 'INBOX', uidMap: new Map([[5, 9]]) })
      .mockReturnValueOnce(false);

    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'INBOX',
      ...liveIntent,
    });

    expect(result.flagsRestored).toEqual([{ uid: 5, flag: '\\Seen' }]);
    expect(result.labelsFailed).toEqual([
      { uid: 5, label: 'Work', reason: 'IMAP server rejected applying the label.' },
    ]);
  });

  it('identity cannot be reconciled -> no repair is attempted on a guessed UID', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        Trash: { fetchResults: [fakeMessage(5, '<a@example.com>')] },
        INBOX: { fetchResults: [] }, // no message-id match, no uidMap
        'Labels/Work': { searchSequence: [[1], []] },
      },
    });

    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'INBOX',
      ...liveIntent,
    });

    expect(result.requiresRefresh).toBe(true);
    expect(fake.messageFlagsAdd).not.toHaveBeenCalled();
    expect(fake.messageFlagsRemove).not.toHaveBeenCalled();
    expect(fake.messageMove).toHaveBeenCalledTimes(1); // only the restore move itself
  });

  it('an unexpected label present after the move is reported, never removed automatically', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        Trash: { fetchResults: [fakeMessage(5, '<a@example.com>')] },
        INBOX: { fetchResults: [fakeMessage(9, '<a@example.com>')] },
        // Not present before the move, present after — an unexplained addition.
        'Labels/Work': { searchSequence: [[], [1]] },
        'Labels/Personal': { searchResult: [] },
      },
      moveResult: { path: 'Trash', destination: 'INBOX', uidMap: new Map([[5, 9]]) },
    });

    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'INBOX',
      ...liveIntent,
    });

    expect(result.labelsUnexpected).toEqual([{ uid: 5, labels: ['Work'] }]);
    expect(result.labelsRestored).toEqual([]);
    // Only the restore move itself — never a removeLabel-style move
    // touching Labels/Work for an unexplained addition.
    expect(fake.messageMove).toHaveBeenCalledTimes(1);
    expect(fake.messageMove).toHaveBeenCalledWith([5], 'INBOX', { uid: true });
  });

  it('destination disappears during post-move verification -> requiresRefresh, no guessed repair', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        Trash: { fetchResults: [fakeMessage(5, '<a@example.com>', ['\\Seen'])] },
        // Present for the transition confirmation fetch, gone for the
        // subsequent flag-verification fetch.
        INBOX: { fetchSequence: [[fakeMessage(9, '<a@example.com>')], []] },
        'Labels/Work': { searchResult: [] },
        'Labels/Personal': { searchResult: [] },
      },
      moveResult: { path: 'Trash', destination: 'INBOX', uidMap: new Map([[5, 9]]) },
    });

    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'INBOX',
      ...liveIntent,
    });

    expect(result.moveRestored).toEqual([5]);
    expect(result.requiresRefresh).toBe(true);
    expect(result.flagsAfterMove).toEqual([]);
    expect(fake.messageFlagsAdd).not.toHaveBeenCalled();
    expect(fake.messageFlagsRemove).not.toHaveBeenCalled();
  });

  it('reconnect after MOVE before response: read-only reconciliation confirms the move without a second attempt', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        Trash: { fetchResults: [fakeMessage(5, '<a@example.com>')], searchResult: [] },
        INBOX: { fetchResults: [fakeMessage(9, '<a@example.com>')], searchResult: [9] },
      },
    });
    fake.messageMove.mockImplementationOnce(() => {
      throw new Error('A12 NO fake@example.test <fake-id@example.test> /tmp/private-fixture');
    });

    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'INBOX',
      ...liveIntent,
    });

    expect(result.changedUids).toEqual([5]);
    expect(result.moveRestored).toEqual([5]);
    expect(fake.messageMove).toHaveBeenCalledTimes(1); // never retried
  });

  it('reconnect after MOVE before response, and the message is confirmed NOT moved: reported as an error, not silently dropped', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        // Still present in Trash -> the move never actually happened.
        Trash: { fetchResults: [fakeMessage(5, '<a@example.com>')], searchResult: [5] },
        INBOX: { fetchResults: [], searchResult: [] },
      },
    });
    fake.messageMove.mockImplementationOnce(() => {
      throw new Error('A12 NO fake@example.test <fake-id@example.test> /tmp/private-fixture');
    });

    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'INBOX',
      ...liveIntent,
    });

    expect(result.changedUids).toEqual([]);
    expect(result.errors).toEqual([{ uid: 5, message: 'Mailbox operation failed.' }]);
    expect(JSON.stringify(result)).not.toContain('fake@example.test');
    expect(fake.messageMove).toHaveBeenCalledTimes(1);
  });

  it('reconnect leaves the outcome genuinely unprovable: requiresRefresh, never guessed, never retried', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        Trash: { fetchResults: [fakeMessage(5, '<a@example.com>')], searchResult: [] },
        INBOX: { fetchResults: [], searchResult: [] },
      },
    });
    fake.messageMove.mockImplementationOnce(() => {
      throw new Error('socket hang up');
    });

    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'INBOX',
      ...liveIntent,
    });

    expect(result.changedUids).toEqual([]);
    expect(result.requiresRefresh).toBe(true);
    expect(result.partialSuccess).toBe(true);
    expect(fake.messageMove).toHaveBeenCalledTimes(1);
  });

  it('reconnect after a confirmed move, before repair: the move is still reported, never swallowed by the failure', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        Trash: { fetchResults: [fakeMessage(5, '<a@example.com>')] },
        INBOX: { fetchResults: [fakeMessage(9, '<a@example.com>')] },
        'Labels/Work': { searchSequence: [[1], []] },
        'Labels/Personal': { searchResult: [] },
      },
      moveResult: { path: 'Trash', destination: 'INBOX', uidMap: new Map([[5, 9]]) },
    });
    // 1st fetch: resolveTrashMessages (Trash). 2nd: write-lock revalidation
    // (Trash). 3rd: post-move flag verification fetch (INBOX) — drop the
    // connection there, after the move has already succeeded.
    fake.fetch
      .mockImplementationOnce(function* () {
        yield fakeMessage(5, '<a@example.com>');
      })
      .mockImplementationOnce(function* () {
        yield fakeMessage(5, '<a@example.com>');
      })
      .mockImplementationOnce(() => {
        throw new Error('connection reset');
      });

    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'INBOX',
      ...liveIntent,
    });

    expect(result.moveRestored).toEqual([5]);
    expect(result.requiresRefresh).toBe(true);
    expect(result.partialSuccess).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
    // Never a second attempt to move the restored message again.
    expect(fake.messageMove).toHaveBeenCalledTimes(1);
  });

  it('reconnect during label repair (thrown, not a false return) is captured as labelsFailed, no crash', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        Trash: { fetchResults: [fakeMessage(5, '<a@example.com>')] },
        INBOX: { fetchResults: [fakeMessage(9, '<a@example.com>')] },
        'Labels/Work': { searchSequence: [[1], []] },
        'Labels/Personal': { searchResult: [] },
      },
    });
    fake.messageMove
      .mockReturnValueOnce({ path: 'Trash', destination: 'INBOX', uidMap: new Map([[5, 9]]) })
      .mockImplementationOnce(() => {
        throw new Error('connection reset');
      });

    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'INBOX',
      ...liveIntent,
    });

    expect(result.moveRestored).toEqual([5]);
    expect(result.labelsFailed).toEqual([
      { uid: 5, label: 'Work', reason: 'Mailbox operation failed.' },
    ]);
    expect(result.partialSuccess).toBe(true);
  });

  it('reconnect during flag repair (thrown, not a false return) is captured as flagsFailed, no crash', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        Trash: { fetchResults: [fakeMessage(5, '<a@example.com>')] },
        INBOX: { fetchResults: [fakeMessage(9, '<a@example.com>', ['\\Seen'])] },
        'Labels/Work': { searchResult: [] },
        'Labels/Personal': { searchResult: [] },
      },
      moveResult: { path: 'Trash', destination: 'INBOX', uidMap: new Map([[5, 9]]) },
    });
    fake.messageFlagsRemove.mockImplementationOnce(() => {
      throw new Error('connection reset');
    });

    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'INBOX',
      ...liveIntent,
    });

    expect(result.moveRestored).toEqual([5]);
    expect(result.flagsFailed).toEqual([{ uid: 5, flag: '\\Seen', reason: 'Flag repair failed.' }]);
    expect(result.partialSuccess).toBe(true);
  });

  it('never issues a second messageMove of the restored message itself, under any failure combination (no automatic rollback)', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        Trash: { fetchResults: [fakeMessage(5, '<a@example.com>')] },
        INBOX: { fetchResults: [fakeMessage(9, '<a@example.com>', ['\\Seen'])] },
        'Labels/Work': { searchSequence: [[1], []] },
        'Labels/Personal': { searchResult: [] },
      },
      flagsOk: false,
    });
    fake.messageMove
      .mockReturnValueOnce({ path: 'Trash', destination: 'INBOX', uidMap: new Map([[5, 9]]) })
      .mockReturnValueOnce(false);

    await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'INBOX',
      ...liveIntent,
    });

    const movesOfTheMessageItself = fake.messageMove.mock.calls.filter(
      (call) => call[1] === 'INBOX' || call[1] === 'Trash',
    );
    expect(movesOfTheMessageItself).toHaveLength(1);
  });
});
