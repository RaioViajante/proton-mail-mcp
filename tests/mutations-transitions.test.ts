import type { FetchMessageObject } from 'imapflow';
import { describe, expect, it } from 'vitest';
import { archiveMessages } from '../src/mutations/archive.js';
import { applyLabel, removeLabel } from '../src/mutations/labels.js';
import { moveMessages } from '../src/mutations/move.js';
import { reconcileResultingUid } from '../src/mutations/transitions.js';
import { asImapFlow, createFakeImapClient, fakeFolder } from './fakes/imap-client.js';

/**
 * IMAP UIDs are mailbox-local. A live test confirmed this matters in
 * practice, not just in theory: mail_archive and mail_move both landed
 * messages under a different UID in the destination, and mail_remove_label
 * moved a message from INBOX UID 705 back to INBOX UID 706 — same message,
 * no duplication, no data loss, just a new UID in the very folder it
 * started in. These tests exercise the resulting `transitions` model:
 * server-provided UIDPLUS mapping first, Message-ID correlation second,
 * never a guess.
 */

const moveFolders = [
  fakeFolder({ path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' }),
  fakeFolder({ path: 'Archive', name: 'Archive', specialUse: '\\Archive' }),
  fakeFolder({ path: 'Folders/Projects', name: 'Projects', parentPath: 'Folders' }),
];

const labelFolders = [
  fakeFolder({ path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' }),
  fakeFolder({ path: 'Labels/Work', name: 'Work' }),
];

function withMessageId(uid: number, messageId: string | undefined): FetchMessageObject {
  return { seq: uid, uid, envelope: messageId ? { messageId } : {} };
}

describe('UIDPLUS candidate verification', () => {
  it('accepts a uidMap candidate only when its destination Message-ID matches', async () => {
    const fake = createFakeImapClient({
      mailboxes: { DEST: { fetchResults: [withMessageId(1, '<same@example.com>')] } },
    });
    await expect(
      reconcileResultingUid(
        asImapFlow(fake),
        'DEST',
        100,
        new Map([[100, 1]]),
        '<same@example.com>',
      ),
    ).resolves.toBe(1);
  });

  it('rejects an incorrect uidMap candidate and falls back by Message-ID', async () => {
    const fake = createFakeImapClient({
      mailboxes: {
        DEST: {
          fetchResults: [
            withMessageId(25, '<other@example.com>'),
            withMessageId(1, '<same@example.com>'),
          ],
          searchResult: [1],
        },
      },
    });
    await expect(
      reconcileResultingUid(
        asImapFlow(fake),
        'DEST',
        100,
        new Map([[100, 25]]),
        '<same@example.com>',
      ),
    ).resolves.toBe(1);
  });

  it('reconciles mixed valid and invalid mappings independently, never by array order', async () => {
    const fake = createFakeImapClient({
      mailboxes: {
        DEST: {
          fetchResults: [
            withMessageId(10, '<id-a@example.com>'),
            withMessageId(20, '<wrong@example.com>'),
            withMessageId(30, '<id-b@example.com>'),
          ],
          searchSequence: [[30]],
        },
      },
    });
    const map = new Map([
      [100, 10],
      [101, 20],
    ]);
    await expect(
      reconcileResultingUid(asImapFlow(fake), 'DEST', 100, map, '<id-a@example.com>'),
    ).resolves.toBe(10);
    await expect(
      reconcileResultingUid(asImapFlow(fake), 'DEST', 101, map, '<id-b@example.com>'),
    ).resolves.toBe(30);
  });

  it('handles a reversed multi-message uidMap by identity, never by position', async () => {
    const fake = createFakeImapClient({
      mailboxes: {
        DEST: {
          fetchResults: [
            withMessageId(1, '<source-b@example.com>'),
            withMessageId(2, '<source-a@example.com>'),
          ],
          searchSequence: [[2], [1]],
        },
      },
    });
    const map = new Map([
      [100, 1], // wrong candidate for source A
      [101, 2], // wrong candidate for source B
    ]);
    const a = await reconcileResultingUid(
      asImapFlow(fake),
      'DEST',
      100,
      map,
      '<source-a@example.com>',
    );
    const b = await reconcileResultingUid(
      asImapFlow(fake),
      'DEST',
      101,
      map,
      '<source-b@example.com>',
    );
    expect(a).toBe(2);
    expect(b).toBe(1);
  });

  it('returns undefined for missing IDs, zero matches, or ambiguous matches', async () => {
    const fake = createFakeImapClient({
      mailboxes: { DEST: { searchSequence: [[], [7, 8]] } },
    });
    await expect(
      reconcileResultingUid(asImapFlow(fake), 'DEST', 1, new Map([[1, 9]]), undefined),
    ).resolves.toBeUndefined();
    await expect(
      reconcileResultingUid(asImapFlow(fake), 'DEST', 1, undefined, '<none@example.com>'),
    ).resolves.toBeUndefined();
    await expect(
      reconcileResultingUid(asImapFlow(fake), 'DEST', 1, undefined, '<ambiguous@example.com>'),
    ).resolves.toBeUndefined();
  });
});

describe('mail_move transitions', () => {
  it('resolves source UID + destination UID via the server UIDPLUS mapping when available', async () => {
    const fake = createFakeImapClient({
      folders: moveFolders,
      mailboxes: {
        INBOX: { fetchResults: [withMessageId(10, '<a@example.com>')] },
        'Folders/Projects': { fetchResults: [withMessageId(99, '<a@example.com>')] },
      },
      moveResult: { path: 'INBOX', destination: 'Folders/Projects', uidMap: new Map([[10, 99]]) },
    });

    const result = await moveMessages(asImapFlow(fake), {
      sourceFolder: 'INBOX',
      destinationFolder: 'Projects',
      uids: [10],
      dryRun: false,
    });

    expect(result.transitions).toEqual([
      {
        requestedUid: 10,
        sourceFolder: 'INBOX',
        destinationFolder: 'Folders/Projects',
        originalUidStillValid: false,
        resultingUid: 99,
      },
    ]);
  });

  it('falls back to Message-ID correlation when the server provides no UIDPLUS mapping', async () => {
    const fake = createFakeImapClient({
      folders: moveFolders,
      mailboxes: {
        INBOX: { fetchResults: [withMessageId(10, '<a@example.com>')] },
        'Folders/Projects': { searchResult: [55] },
      },
      moveResult: { path: 'INBOX', destination: 'Folders/Projects', uidMap: new Map() },
    });

    const result = await moveMessages(asImapFlow(fake), {
      sourceFolder: 'INBOX',
      destinationFolder: 'Projects',
      uids: [10],
      dryRun: false,
    });

    expect(result.transitions?.[0]?.resultingUid).toBe(55);
    expect(result.transitions?.[0]?.requiresRefresh).toBeUndefined();
  });

  it('a missing Message-ID never causes a guess — reports requiresRefresh instead', async () => {
    const fake = createFakeImapClient({
      folders: moveFolders,
      mailboxes: {
        INBOX: { fetchResults: [withMessageId(10, undefined)] },
        'Folders/Projects': { searchResult: [55] }, // present but must never be consulted
      },
      moveResult: { path: 'INBOX', destination: 'Folders/Projects', uidMap: new Map() },
    });

    const result = await moveMessages(asImapFlow(fake), {
      sourceFolder: 'INBOX',
      destinationFolder: 'Projects',
      uids: [10],
      dryRun: false,
    });

    expect(result.transitions).toEqual([
      {
        requestedUid: 10,
        sourceFolder: 'INBOX',
        destinationFolder: 'Folders/Projects',
        originalUidStillValid: false,
        requiresRefresh: true,
      },
    ]);
  });

  it('an ambiguous Message-ID correlation (more than one match) never causes a guess', async () => {
    const fake = createFakeImapClient({
      folders: moveFolders,
      mailboxes: {
        INBOX: { fetchResults: [withMessageId(10, '<a@example.com>')] },
        'Folders/Projects': { searchResult: [55, 56] }, // ambiguous
      },
      moveResult: { path: 'INBOX', destination: 'Folders/Projects', uidMap: new Map() },
    });

    const result = await moveMessages(asImapFlow(fake), {
      sourceFolder: 'INBOX',
      destinationFolder: 'Projects',
      uids: [10],
      dryRun: false,
    });

    expect(result.transitions?.[0]?.resultingUid).toBeUndefined();
    expect(result.transitions?.[0]?.requiresRefresh).toBe(true);
  });

  it('old requestedUid is not implied valid: originalUidStillValid is false', async () => {
    const fake = createFakeImapClient({
      folders: moveFolders,
      mailboxes: {
        INBOX: { fetchResults: [withMessageId(10, '<a@example.com>')] },
        'Folders/Projects': { fetchResults: [withMessageId(99, '<a@example.com>')] },
      },
      moveResult: { path: 'INBOX', destination: 'Folders/Projects', uidMap: new Map([[10, 99]]) },
    });

    const result = await moveMessages(asImapFlow(fake), {
      sourceFolder: 'INBOX',
      destinationFolder: 'Projects',
      uids: [10],
      dryRun: false,
    });

    expect(result.transitions?.[0]?.originalUidStillValid).toBe(false);
  });

  it('unrelated (missing) UIDs never appear in transitions', async () => {
    const fake = createFakeImapClient({
      folders: moveFolders,
      mailboxes: {
        INBOX: { fetchResults: [withMessageId(10, '<a@example.com>')] }, // 11 does not exist
        'Folders/Projects': { fetchResults: [withMessageId(99, '<a@example.com>')] },
      },
      moveResult: { path: 'INBOX', destination: 'Folders/Projects', uidMap: new Map([[10, 99]]) },
    });

    const result = await moveMessages(asImapFlow(fake), {
      sourceFolder: 'INBOX',
      destinationFolder: 'Projects',
      uids: [10, 11],
      dryRun: false,
    });

    expect(result.missingUids).toEqual([11]);
    expect(result.transitions).toHaveLength(1);
    expect(result.transitions?.[0]?.requestedUid).toBe(10);
  });

  it('dry-run never produces a transition for a mutation that did not happen', async () => {
    const fake = createFakeImapClient({
      folders: moveFolders,
      fetchResults: [withMessageId(10, '<a@example.com>')],
    });

    const result = await moveMessages(asImapFlow(fake), {
      sourceFolder: 'INBOX',
      destinationFolder: 'Projects',
      uids: [10],
      dryRun: true,
    });

    expect(result.transitions).toBeUndefined();
  });
});

describe('mail_archive transitions', () => {
  it('resolves source UID + Archive UID via the server UIDPLUS mapping (mirrors the live INBOX 703 -> Archive 1 result)', async () => {
    const fake = createFakeImapClient({
      folders: moveFolders,
      mailboxes: {
        INBOX: { fetchResults: [withMessageId(703, '<archive-test@example.com>')] },
        Archive: { fetchResults: [withMessageId(1, '<archive-test@example.com>')] },
      },
      moveResult: { path: 'INBOX', destination: 'Archive', uidMap: new Map([[703, 1]]) },
    });

    const result = await archiveMessages(asImapFlow(fake), {
      folder: 'INBOX',
      uids: [703],
      dryRun: false,
    });

    expect(result.transitions).toEqual([
      {
        requestedUid: 703,
        sourceFolder: 'INBOX',
        destinationFolder: 'Archive',
        originalUidStillValid: false,
        resultingUid: 1,
      },
    ]);
  });

  it('dry-run never produces a transition', async () => {
    const fake = createFakeImapClient({
      folders: moveFolders,
      fetchResults: [withMessageId(703, '<archive-test@example.com>')],
    });

    const result = await archiveMessages(asImapFlow(fake), {
      folder: 'INBOX',
      uids: [703],
      dryRun: true,
    });

    expect(result.transitions).toBeUndefined();
  });
});

describe('mail_apply_label transitions', () => {
  it('reports the label-mailbox UID as an additional identity, with originalUidStillValid: true', async () => {
    const fake = createFakeImapClient({
      folders: labelFolders,
      mailboxes: {
        INBOX: {
          fetchResults: [withMessageId(705, '<label-test@example.com>')],
        },
        'Labels/Work': {
          searchResult: [],
          fetchResults: [withMessageId(42, '<label-test@example.com>')],
        }, // not yet labeled, during resolution
      },
      moveResult: { path: 'INBOX', destination: 'Labels/Work', uidMap: new Map([[705, 42]]) },
    });

    const result = await applyLabel(asImapFlow(fake), {
      folder: 'INBOX',
      label: 'Work',
      uids: [705],
      dryRun: false,
    });

    expect(result.transitions).toEqual([
      {
        requestedUid: 705,
        sourceFolder: 'INBOX',
        destinationFolder: 'Labels/Work',
        originalUidStillValid: true,
        resultingUid: 42,
      },
    ]);
  });

  it('dry-run never produces a transition', async () => {
    const fake = createFakeImapClient({
      folders: labelFolders,
      mailboxes: {
        INBOX: { fetchResults: [withMessageId(705, '<label-test@example.com>')] },
        'Labels/Work': { searchResult: [] },
      },
    });

    const result = await applyLabel(asImapFlow(fake), {
      folder: 'INBOX',
      label: 'Work',
      uids: [705],
      dryRun: true,
    });

    expect(result.transitions).toBeUndefined();
  });
});

describe('mail_remove_label transitions', () => {
  it('reproduces the live-observed INBOX 705 -> INBOX 706 result: original UID invalid, new UID reported', async () => {
    const fake = createFakeImapClient({
      folders: labelFolders,
      mailboxes: {
        INBOX: {
          fetchResults: [
            withMessageId(705, '<label-test@example.com>'),
            withMessageId(706, '<label-test@example.com>'),
          ],
        },
        'Labels/Work': { searchResult: [42], fetchResults: [{ seq: 42, uid: 42 }] },
      },
      // uidMap is keyed by the labelUid (42, the source side of THIS move
      // call), mapping to the new UID the message gets back in INBOX.
      moveResult: { path: 'Labels/Work', destination: 'INBOX', uidMap: new Map([[42, 706]]) },
    });

    const result = await removeLabel(asImapFlow(fake), {
      folder: 'INBOX',
      label: 'Work',
      uids: [705],
      dryRun: false,
    });

    expect(result.changedUids).toEqual([705]);
    expect(result.transitions).toEqual([
      {
        requestedUid: 705,
        sourceFolder: 'Labels/Work',
        destinationFolder: 'INBOX',
        originalUidStillValid: false,
        resultingUid: 706,
      },
    ]);
  });

  it('the old requestedUid (705) is never implied valid going forward', async () => {
    const fake = createFakeImapClient({
      folders: labelFolders,
      mailboxes: {
        INBOX: { fetchResults: [withMessageId(705, '<label-test@example.com>')] },
        'Labels/Work': { searchResult: [42], fetchResults: [{ seq: 42, uid: 42 }] },
      },
      moveResult: { path: 'Labels/Work', destination: 'INBOX', uidMap: new Map([[42, 706]]) },
    });

    const result = await removeLabel(asImapFlow(fake), {
      folder: 'INBOX',
      label: 'Work',
      uids: [705],
      dryRun: false,
    });

    const transition = result.transitions?.[0];
    expect(transition?.originalUidStillValid).toBe(false);
    expect(transition?.resultingUid).not.toBe(705);
  });

  it('falls back to Message-ID correlation in the destination folder when no UIDPLUS mapping is available', async () => {
    const fake = createFakeImapClient({
      folders: labelFolders,
      mailboxes: {
        INBOX: {
          fetchResults: [withMessageId(705, '<label-test@example.com>')],
          searchResult: [706], // used by the Message-ID fallback search in INBOX
        },
        'Labels/Work': { searchResult: [42], fetchResults: [{ seq: 42, uid: 42 }] },
      },
      moveResult: { path: 'Labels/Work', destination: 'INBOX', uidMap: new Map() },
    });

    const result = await removeLabel(asImapFlow(fake), {
      folder: 'INBOX',
      label: 'Work',
      uids: [705],
      dryRun: false,
    });

    expect(result.transitions?.[0]?.resultingUid).toBe(706);
  });

  it('produces requiresRefresh, never a guess, when the resulting UID cannot be determined', async () => {
    const fake = createFakeImapClient({
      folders: labelFolders,
      mailboxes: {
        INBOX: {
          fetchResults: [withMessageId(705, '<label-test@example.com>')],
          searchResult: [], // Message-ID fallback finds nothing (yet)
        },
        'Labels/Work': { searchResult: [42], fetchResults: [{ seq: 42, uid: 42 }] },
      },
      moveResult: { path: 'Labels/Work', destination: 'INBOX', uidMap: new Map() },
    });

    const result = await removeLabel(asImapFlow(fake), {
      folder: 'INBOX',
      label: 'Work',
      uids: [705],
      dryRun: false,
    });

    expect(result.transitions).toEqual([
      {
        requestedUid: 705,
        sourceFolder: 'Labels/Work',
        destinationFolder: 'INBOX',
        originalUidStillValid: false,
        requiresRefresh: true,
      },
    ]);
  });

  it('dry-run never produces a transition', async () => {
    const fake = createFakeImapClient({
      folders: labelFolders,
      mailboxes: {
        INBOX: { fetchResults: [withMessageId(705, '<label-test@example.com>')] },
        'Labels/Work': { searchResult: [42] },
      },
    });

    const result = await removeLabel(asImapFlow(fake), {
      folder: 'INBOX',
      label: 'Work',
      uids: [705],
      dryRun: true,
    });

    expect(result.transitions).toBeUndefined();
  });
});
