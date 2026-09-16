import type { FetchMessageObject } from 'imapflow';
import { describe, expect, it } from 'vitest';
import { archiveMessages } from '../src/mutations/archive.js';
import { applyLabel, removeLabel } from '../src/mutations/labels.js';
import { markRead } from '../src/mutations/read-state.js';
import { asImapFlow, createFakeImapClient, fakeFolder } from './fakes/imap-client.js';

/**
 * Every mutation resolves candidates under a read-only lock, then — if
 * dryRun is false — re-opens the same mailbox in write mode. Between those
 * two locks, another client (Proton's own web app, another IMAP session,
 * etc.) could move, delete, or otherwise remove a message. These tests
 * prove that gap is closed: a UID confirmed to exist during the read-only
 * pass is re-checked immediately after the write lock is acquired, and is
 * never mutated if it's gone by then — the selection can only shrink,
 * never grow, and the rest of the batch still proceeds normally.
 */

const inboxOnly = [fakeFolder({ path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' })];

const moveFolders = [
  fakeFolder({ path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' }),
  fakeFolder({ path: 'Archive', name: 'Archive', specialUse: '\\Archive' }),
];

const labelFolders = [
  fakeFolder({ path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' }),
  fakeFolder({ path: 'Labels/Work', name: 'Work' }),
];

function readMessage(uid: number, seen: boolean): FetchMessageObject {
  return { seq: uid, uid, flags: seen ? new Set(['\\Seen']) : new Set() };
}

function envelopeMessage(uid: number, messageId: string): FetchMessageObject {
  return { seq: uid, uid, envelope: { messageId } };
}

describe('write-lock revalidation: mail_mark_read', () => {
  it('a UID present during read-only validation but gone by write-lock time is not mutated and is reported missing', async () => {
    const fake = createFakeImapClient({
      folders: inboxOnly,
      mailboxes: {
        INBOX: {
          fetchSequence: [
            [readMessage(10, false), readMessage(11, false)], // read-only resolution: both present
            [readMessage(11, false)], // write-lock revalidation: 10 vanished
          ],
        },
      },
    });

    const result = await markRead(asImapFlow(fake), {
      folder: 'INBOX',
      uids: [10, 11],
      dryRun: false,
    });

    expect(result.missingUids).toContain(10);
    expect(result.matchedUids).not.toContain(10);
    expect(result.changedUids).not.toContain(10);
  });

  it('the remaining, still-present UID is mutated normally', async () => {
    const fake = createFakeImapClient({
      folders: inboxOnly,
      mailboxes: {
        INBOX: {
          fetchSequence: [
            [readMessage(10, false), readMessage(11, false)],
            [readMessage(11, false)],
          ],
        },
      },
    });

    const result = await markRead(asImapFlow(fake), {
      folder: 'INBOX',
      uids: [10, 11],
      dryRun: false,
    });

    expect(result.changedUids).toEqual([11]);
    expect(fake.messageFlagsAdd).toHaveBeenCalledWith([11], ['\\Seen'], { uid: true });
    expect(fake.messageFlagsAdd).not.toHaveBeenCalledWith(
      expect.arrayContaining([10]),
      expect.anything(),
      expect.anything(),
    );
  });

  it('never calls messageFlagsAdd at all when every matched UID turns out stale', async () => {
    const fake = createFakeImapClient({
      folders: inboxOnly,
      mailboxes: {
        INBOX: {
          fetchSequence: [[readMessage(10, false)], []],
        },
      },
    });

    const result = await markRead(asImapFlow(fake), { folder: 'INBOX', uids: [10], dryRun: false });

    expect(result.changedUids).toEqual([]);
    expect(result.missingUids).toEqual([10]);
    expect(fake.messageFlagsAdd).not.toHaveBeenCalled();
  });

  it('does not revalidate at all during dry-run (only one fetch, the read-only resolution)', async () => {
    const fake = createFakeImapClient({
      folders: inboxOnly,
      mailboxes: { INBOX: { fetchResults: [readMessage(10, false)] } },
    });

    await markRead(asImapFlow(fake), { folder: 'INBOX', uids: [10], dryRun: true });

    expect(fake.fetch).toHaveBeenCalledTimes(1);
    expect(fake.lockCalls.every((call) => call.readOnly === true)).toBe(true);
  });
});

describe('write-lock revalidation: mail_archive (shared by mail_move / mail_mark_spam)', () => {
  it('a UID that disappears before the write lock is not archived and is reported missing', async () => {
    const fake = createFakeImapClient({
      folders: moveFolders,
      mailboxes: {
        INBOX: {
          fetchSequence: [
            [
              { seq: 5, uid: 5 },
              { seq: 6, uid: 6 },
            ],
            [{ seq: 6, uid: 6 }], // 5 vanished by write-lock time
          ],
        },
      },
    });

    const result = await archiveMessages(asImapFlow(fake), {
      folder: 'INBOX',
      uids: [5, 6],
      dryRun: false,
    });

    expect(result.changedUids).toEqual([6]);
    expect(result.missingUids).toContain(5);
    expect(result.matchedUids).not.toContain(5);
    expect(fake.messageMove).toHaveBeenCalledWith([6], 'Archive', { uid: true });
  });

  it('never calls messageMove when every matched UID turns out stale', async () => {
    const fake = createFakeImapClient({
      folders: moveFolders,
      mailboxes: { INBOX: { fetchSequence: [[{ seq: 5, uid: 5 }], []] } },
    });

    const result = await archiveMessages(asImapFlow(fake), {
      folder: 'INBOX',
      uids: [5],
      dryRun: false,
    });

    expect(result.changedUids).toEqual([]);
    expect(result.missingUids).toEqual([5]);
    expect(fake.messageMove).not.toHaveBeenCalled();
  });
});

describe('write-lock revalidation: mail_apply_label', () => {
  it('a UID that disappears from the source folder before the write lock is not labeled', async () => {
    const fake = createFakeImapClient({
      folders: labelFolders,
      mailboxes: {
        INBOX: {
          fetchSequence: [
            [envelopeMessage(10, '<a@example.com>'), envelopeMessage(11, '<b@example.com>')],
            [envelopeMessage(11, '<b@example.com>')], // 10 vanished by write-lock time
          ],
        },
        'Labels/Work': { searchResult: [] },
      },
    });

    const result = await applyLabel(asImapFlow(fake), {
      folder: 'INBOX',
      label: 'Work',
      uids: [10, 11],
      dryRun: false,
    });

    expect(result.changedUids).toEqual([11]);
    expect(result.missingUids).toContain(10);
    expect(result.matchedUids).not.toContain(10);
    expect(fake.messageMove).toHaveBeenCalledWith([11], 'Labels/Work', { uid: true });
  });

  it('a message labeled by something else between resolution and the write lock is skipped, not re-applied', async () => {
    const fake = createFakeImapClient({
      folders: labelFolders,
      mailboxes: {
        INBOX: { fetchResults: [envelopeMessage(10, '<a@example.com>')] },
        // Not present on the first correlation check (during resolution),
        // present on the second (the pre-write-lock re-check) — simulating
        // a concurrent apply of the same label by something else.
        'Labels/Work': { searchSequence: [[], [77]] },
      },
    });

    const result = await applyLabel(asImapFlow(fake), {
      folder: 'INBOX',
      label: 'Work',
      uids: [10],
      dryRun: false,
    });

    expect(result.skippedUids).toEqual([10]);
    expect(result.changedUids).toEqual([]);
    expect(fake.messageMove).not.toHaveBeenCalled();
  });
});

describe('write-lock revalidation: mail_remove_label', () => {
  it('a labelUid that disappears from Labels/<label> before the write lock is not removed and is reported missing', async () => {
    const fake = createFakeImapClient({
      folders: labelFolders,
      mailboxes: {
        INBOX: { fetchResults: [envelopeMessage(10, '<a@example.com>')] },
        'Labels/Work': {
          searchResult: [55], // correlation finds it...
          fetchResults: [], // ...but it's gone by the write-lock revalidation
        },
      },
    });

    const result = await removeLabel(asImapFlow(fake), {
      folder: 'INBOX',
      label: 'Work',
      uids: [10],
      dryRun: false,
    });

    expect(result.changedUids).toEqual([]);
    expect(result.missingUids).toContain(10);
    expect(result.matchedUids).not.toContain(10);
    expect(fake.messageMove).not.toHaveBeenCalled();
  });

  it('still removes the label when the labelUid is confirmed present at write-lock time', async () => {
    const fake = createFakeImapClient({
      folders: labelFolders,
      mailboxes: {
        INBOX: { fetchResults: [envelopeMessage(10, '<a@example.com>')] },
        'Labels/Work': { searchResult: [55], fetchResults: [{ seq: 55, uid: 55 }] },
      },
    });

    const result = await removeLabel(asImapFlow(fake), {
      folder: 'INBOX',
      label: 'Work',
      uids: [10],
      dryRun: false,
    });

    expect(result.changedUids).toEqual([10]);
    expect(fake.messageMove).toHaveBeenCalledWith([55], 'INBOX', { uid: true });
  });
});
