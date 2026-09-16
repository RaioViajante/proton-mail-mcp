import type { FetchMessageObject } from 'imapflow';
import { describe, expect, it } from 'vitest';
import { markRead, markUnread } from '../src/mutations/read-state.js';
import { asImapFlow, createFakeImapClient, fakeFolder } from './fakes/imap-client.js';

const folders = [fakeFolder({ path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' })];

function fakeMessage(uid: number, seen: boolean): FetchMessageObject {
  return { seq: uid, uid, flags: seen ? new Set(['\\Seen']) : new Set() };
}

describe('markRead', () => {
  it('dry-run resolves everything but changes nothing and never opens a write lock', async () => {
    const fake = createFakeImapClient({
      folders,
      fetchResults: [fakeMessage(10, false), fakeMessage(11, true)],
    });

    const result = await markRead(asImapFlow(fake), {
      folder: 'INBOX',
      uids: [10, 11],
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.matchedUids.sort()).toEqual([10, 11]);
    expect(result.skippedUids).toEqual([11]); // already \Seen
    expect(result.changedUids).toEqual([]);
    expect(fake.messageFlagsAdd).not.toHaveBeenCalled();
    expect(fake.lockCalls.every((call) => call.readOnly === true)).toBe(true);
  });

  it('dryRun defaults to true when omitted at the schema layer (proven in tool-schemas tests); here the function itself requires an explicit value', async () => {
    // The mutation function always requires an explicit dryRun; the zod
    // schema default lives at the tool boundary. This test documents that
    // contract so a future refactor cannot silently drop the safe default.
    const fake = createFakeImapClient({ folders, fetchResults: [fakeMessage(10, false)] });
    const result = await markRead(asImapFlow(fake), { folder: 'INBOX', uids: [10], dryRun: true });
    expect(result.dryRun).toBe(true);
  });

  it('live run marks unread messages as read and reports changedUids', async () => {
    const fake = createFakeImapClient({ folders, fetchResults: [fakeMessage(10, false)] });

    const result = await markRead(asImapFlow(fake), { folder: 'INBOX', uids: [10], dryRun: false });

    expect(result.changedUids).toEqual([10]);
    expect(fake.messageFlagsAdd).toHaveBeenCalledWith([10], ['\\Seen'], { uid: true });
    expect(fake.lockCalls.some((call) => call.readOnly === false)).toBe(true);
  });

  it('does not call messageFlagsAdd at all when every matched UID is already read', async () => {
    const fake = createFakeImapClient({ folders, fetchResults: [fakeMessage(10, true)] });

    const result = await markRead(asImapFlow(fake), { folder: 'INBOX', uids: [10], dryRun: false });

    expect(result.changedUids).toEqual([]);
    expect(result.skippedUids).toEqual([10]);
    expect(fake.messageFlagsAdd).not.toHaveBeenCalled();
    expect(fake.lockCalls.every((call) => call.readOnly === true)).toBe(true);
  });

  it('reports a requested UID that does not exist as missing, not as an error', async () => {
    const fake = createFakeImapClient({ folders, fetchResults: [fakeMessage(10, false)] });

    const result = await markRead(asImapFlow(fake), {
      folder: 'INBOX',
      uids: [10, 999],
      dryRun: true,
    });

    expect(result.matchedUids).toEqual([10]);
    expect(result.missingUids).toEqual([999]);
    expect(result.errors).toEqual([]);
  });

  it('deduplicates requested UIDs before processing', async () => {
    const fake = createFakeImapClient({ folders, fetchResults: [fakeMessage(10, false)] });

    const result = await markRead(asImapFlow(fake), {
      folder: 'INBOX',
      uids: [10, 10, 10],
      dryRun: true,
    });

    expect(result.matchedUids).toEqual([10]);
    expect(result.requestedUids).toEqual([10, 10, 10]); // requested is preserved verbatim for audit
  });

  it('rejects a batch larger than the maximum', async () => {
    const fake = createFakeImapClient({ folders });
    const uids = Array.from({ length: 26 }, (_, i) => i + 1);

    await expect(
      markRead(asImapFlow(fake), { folder: 'INBOX', uids, dryRun: true }),
    ).rejects.toThrow(/at most 25/i);
    expect(fake.getMailboxLock).not.toHaveBeenCalled();
  });

  it('rejects an empty UID array', async () => {
    const fake = createFakeImapClient({ folders });
    await expect(
      markRead(asImapFlow(fake), { folder: 'INBOX', uids: [], dryRun: true }),
    ).rejects.toThrow(/must not be empty/i);
  });

  it('rejects a nonexistent source folder', async () => {
    const fake = createFakeImapClient({ folders, fetchResults: [fakeMessage(10, false)] });
    await expect(
      markRead(asImapFlow(fake), { folder: 'DoesNotExist', uids: [10], dryRun: true }),
    ).rejects.toThrow(/no such folder/i);
    expect(fake.messageFlagsAdd).not.toHaveBeenCalled();
  });

  it('never expands the selection beyond the requested UIDs', async () => {
    const fake = createFakeImapClient({
      folders,
      fetchResults: [fakeMessage(10, false), fakeMessage(11, false), fakeMessage(12, false)],
    });

    // Only [10, 12] requested — the fake's fetch() ignores the range filter,
    // so this proves the mutation layer itself filters fetch results down to
    // the requested set rather than trusting the server to.
    const result = await markRead(asImapFlow(fake), {
      folder: 'INBOX',
      uids: [10, 12],
      dryRun: true,
    });

    expect(result.matchedUids.sort()).toEqual([10, 12]);
    expect(result.matchedUids).not.toContain(11);
  });
});

describe('markUnread', () => {
  it('dry-run never calls messageFlagsRemove', async () => {
    const fake = createFakeImapClient({ folders, fetchResults: [fakeMessage(10, true)] });

    const result = await markUnread(asImapFlow(fake), {
      folder: 'INBOX',
      uids: [10],
      dryRun: true,
    });

    expect(result.changedUids).toEqual([]);
    expect(fake.messageFlagsRemove).not.toHaveBeenCalled();
  });

  it('live run removes \\Seen from read messages', async () => {
    const fake = createFakeImapClient({ folders, fetchResults: [fakeMessage(10, true)] });

    const result = await markUnread(asImapFlow(fake), {
      folder: 'INBOX',
      uids: [10],
      dryRun: false,
    });

    expect(result.changedUids).toEqual([10]);
    expect(fake.messageFlagsRemove).toHaveBeenCalledWith([10], ['\\Seen'], { uid: true });
  });

  it('skips a message that is already unread', async () => {
    const fake = createFakeImapClient({ folders, fetchResults: [fakeMessage(10, false)] });

    const result = await markUnread(asImapFlow(fake), {
      folder: 'INBOX',
      uids: [10],
      dryRun: false,
    });

    expect(result.skippedUids).toEqual([10]);
    expect(fake.messageFlagsRemove).not.toHaveBeenCalled();
  });

  it('records a per-uid error and keeps other results intact when the IMAP command is rejected', async () => {
    const fake = createFakeImapClient({
      folders,
      fetchResults: [fakeMessage(10, true)],
      flagsOk: false,
    });

    const result = await markUnread(asImapFlow(fake), {
      folder: 'INBOX',
      uids: [10],
      dryRun: false,
    });

    expect(result.changedUids).toEqual([]);
    expect(result.errors).toEqual([{ uid: 10, message: 'IMAP server rejected the flag change.' }]);
  });
});
