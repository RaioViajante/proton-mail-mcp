import type { FetchMessageObject } from 'imapflow';
import { describe, expect, it } from 'vitest';
import {
  deletePermanently,
  expungeExactUids,
  LIVE_PERMANENT_DELETE_DISABLED_REASON,
  PERMANENT_DELETE_CONFIRMATION_PHRASE,
} from '../src/mutations/permanent-delete.js';
import { asImapFlow, createFakeImapClient, fakeFolder } from './fakes/imap-client.js';

const folders = [
  fakeFolder({ path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' }),
  fakeFolder({ path: 'Trash', name: 'Trash', specialUse: '\\Trash' }),
];

function fakeMessage(uid: number): FetchMessageObject {
  return { seq: uid, uid };
}

const fullLiveIntent = {
  dryRun: false,
  confirm: true,
  acknowledgePermanentDeletion: true,
  confirmationPhrase: PERMANENT_DELETE_CONFIRMATION_PHRASE,
} as const;

describe('mail_delete_permanently (deletePermanently) — dry-run', () => {
  it('a valid dry-run resolves matched/missing uids in Trash and mutates nothing', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: { Trash: { fetchResults: [fakeMessage(1), fakeMessage(2)] } },
    });

    const result = await deletePermanently(asImapFlow(fake), {
      sourceFolder: 'Trash',
      uids: [1, 2, 3],
      dryRun: true,
      confirm: false,
      acknowledgePermanentDeletion: false,
      confirmationPhrase: '',
    });

    expect(result.matchedUids.sort()).toEqual([1, 2]);
    expect(result.missingUids).toEqual([3]);
    expect(result.changedUids).toEqual([]);
    expect(result.blocked).toBeUndefined();
  });

  it('ZERO STORE and ZERO EXPUNGE in dry-run', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: { Trash: { fetchResults: [fakeMessage(1)] } },
    });

    await deletePermanently(asImapFlow(fake), {
      sourceFolder: 'Trash',
      uids: [1],
      dryRun: true,
      confirm: false,
      acknowledgePermanentDeletion: false,
      confirmationPhrase: '',
    });

    expect(fake.messageFlagsAdd).not.toHaveBeenCalled();
    expect(fake.messageDelete).not.toHaveBeenCalled();
    expect(fake.messageMove).not.toHaveBeenCalled();
    expect(fake.lockCalls.every((call) => call.readOnly === true)).toBe(true);
  });

  it('a stale uid (present at listing time, gone at read time) is reported missing, not deleted', async () => {
    // The fake only supports one fetch snapshot per path per call; this
    // proves the resolver filters the fetch response down to exactly the
    // requested set rather than trusting a broader result verbatim.
    const fake = createFakeImapClient({
      folders,
      mailboxes: { Trash: { fetchResults: [fakeMessage(2)] } }, // uid 1 never resolves
    });

    const result = await deletePermanently(asImapFlow(fake), {
      sourceFolder: 'Trash',
      uids: [1, 2],
      dryRun: true,
      confirm: false,
      acknowledgePermanentDeletion: false,
      confirmationPhrase: '',
    });

    expect(result.matchedUids).toEqual([2]);
    expect(result.missingUids).toEqual([1]);
  });

  it('never targets a uid beyond the explicit requested set, even if the transport returns extras', async () => {
    const fake = createFakeImapClient({
      folders,
      // Simulates a transport/server returning more than was asked for.
      mailboxes: { Trash: { fetchResults: [fakeMessage(1), fakeMessage(2), fakeMessage(99)] } },
    });

    const result = await deletePermanently(asImapFlow(fake), {
      sourceFolder: 'Trash',
      uids: [1, 2],
      dryRun: true,
      confirm: false,
      acknowledgePermanentDeletion: false,
      confirmationPhrase: '',
    });

    expect(result.matchedUids.sort()).toEqual([1, 2]);
    expect(result.matchedUids).not.toContain(99);
  });
});

describe('mail_delete_permanently (deletePermanently) — input validation', () => {
  it('rejects a sourceFolder that is not exactly the account Trash folder', async () => {
    const fake = createFakeImapClient({ folders });
    await expect(
      deletePermanently(asImapFlow(fake), {
        sourceFolder: 'INBOX',
        uids: [1],
        dryRun: true,
        confirm: false,
        acknowledgePermanentDeletion: false,
        confirmationPhrase: '',
      }),
    ).rejects.toThrow(/only operates on the account's Trash folder/i);
  });

  it('rejects more than 5 uids', async () => {
    const fake = createFakeImapClient({ folders });
    const uids = [1, 2, 3, 4, 5, 6];
    await expect(
      deletePermanently(asImapFlow(fake), {
        sourceFolder: 'Trash',
        uids,
        dryRun: true,
        confirm: false,
        acknowledgePermanentDeletion: false,
        confirmationPhrase: '',
      }),
    ).rejects.toThrow(/At most 5/);
  });

  it('accepts exactly 5 uids at the dry-run resolution stage', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: { Trash: { fetchResults: [1, 2, 3, 4, 5].map(fakeMessage) } },
    });
    const result = await deletePermanently(asImapFlow(fake), {
      sourceFolder: 'Trash',
      uids: [1, 2, 3, 4, 5],
      dryRun: true,
      confirm: false,
      acknowledgePermanentDeletion: false,
      confirmationPhrase: '',
    });
    expect(result.matchedUids.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('rejects live execution missing confirm, before any IMAP access', async () => {
    const fake = createFakeImapClient({ folders });
    await expect(
      deletePermanently(asImapFlow(fake), {
        sourceFolder: 'Trash',
        uids: [1],
        dryRun: false,
        confirm: false,
        acknowledgePermanentDeletion: true,
        confirmationPhrase: PERMANENT_DELETE_CONFIRMATION_PHRASE,
      }),
    ).rejects.toThrow(/confirm=true and acknowledgePermanentDeletion=true/);
    expect(fake.list).not.toHaveBeenCalled();
  });

  it('rejects live execution missing acknowledgePermanentDeletion, before any IMAP access', async () => {
    const fake = createFakeImapClient({ folders });
    await expect(
      deletePermanently(asImapFlow(fake), {
        sourceFolder: 'Trash',
        uids: [1],
        dryRun: false,
        confirm: true,
        acknowledgePermanentDeletion: false,
        confirmationPhrase: PERMANENT_DELETE_CONFIRMATION_PHRASE,
      }),
    ).rejects.toThrow(/confirm=true and acknowledgePermanentDeletion=true/);
    expect(fake.list).not.toHaveBeenCalled();
  });

  it('rejects a wrong confirmationPhrase, before any IMAP access', async () => {
    const fake = createFakeImapClient({ folders });
    await expect(
      deletePermanently(asImapFlow(fake), {
        sourceFolder: 'Trash',
        uids: [1],
        dryRun: false,
        confirm: true,
        acknowledgePermanentDeletion: true,
        confirmationPhrase: 'delete permanently',
      }),
    ).rejects.toThrow(/confirmationPhrase must be exactly/i);
    expect(fake.list).not.toHaveBeenCalled();
  });
});

describe('mail_delete_permanently (deletePermanently) — 0.4.0 feature gate', () => {
  it('blocks a fully-confirmed live call with a predictable reason code, before any mutating IMAP command', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: { Trash: { fetchResults: [fakeMessage(1)] } },
    });

    const result = await deletePermanently(asImapFlow(fake), {
      sourceFolder: 'Trash',
      uids: [1],
      ...fullLiveIntent,
    });

    expect(result.blocked).toBe(true);
    expect(result.blockReason).toBe(LIVE_PERMANENT_DELETE_DISABLED_REASON);
    expect(result.blockReason).toBe('livePermanentDeleteDisabled');
    expect(result.changedUids).toEqual([]);
    expect(fake.messageFlagsAdd).not.toHaveBeenCalled();
    expect(fake.messageDelete).not.toHaveBeenCalled();
  });

  it('does not hide the limitation — the block reason is always present on a blocked result', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: { Trash: { fetchResults: [fakeMessage(1)] } },
    });
    const result = await deletePermanently(asImapFlow(fake), {
      sourceFolder: 'Trash',
      uids: [1],
      ...fullLiveIntent,
    });
    expect(result).toHaveProperty('blocked', true);
    expect(result).toHaveProperty('blockReason');
  });
});

describe('expungeExactUids — UID-scoped deletion abstraction (not wired into any live tool path in 0.4.0)', () => {
  it('refuses outright when UIDPLUS is unavailable — never calls messageFlagsAdd/messageDelete, never a mailbox-wide EXPUNGE fallback', async () => {
    const fake = createFakeImapClient({ folders }); // capabilities defaults to empty (no UIDPLUS)

    await expect(expungeExactUids(asImapFlow(fake), 'Trash', [1, 2])).rejects.toThrow(
      /UID-scoped EXPUNGE \(UIDPLUS\) is not available/i,
    );

    expect(fake.messageFlagsAdd).not.toHaveBeenCalled();
    expect(fake.messageDelete).not.toHaveBeenCalled();
    expect(fake.getMailboxLock).not.toHaveBeenCalled();
  });

  it('with UIDPLUS available, flags then deletes exactly the given uids, uid-scoped, never a bare/wildcard range', async () => {
    const fake = createFakeImapClient({
      folders,
      capabilities: new Map([['UIDPLUS', true]]),
    });

    const outcome = await expungeExactUids(asImapFlow(fake), 'Trash', [1, 2]);

    expect(outcome).toBe(true);
    expect(fake.messageFlagsAdd).toHaveBeenCalledWith([1, 2], ['\\Deleted'], { uid: true });
    expect(fake.messageDelete).toHaveBeenCalledWith([1, 2], { uid: true });
    // Uid-scoped only: never called with a sequence wildcard like '1:*' or '*'.
    expect(fake.messageFlagsAdd).not.toHaveBeenCalledWith(
      '1:*',
      expect.anything(),
      expect.anything(),
    );
    expect(fake.messageDelete).not.toHaveBeenCalledWith('*', expect.anything());
  });

  it('an unrelated message elsewhere already flagged \\Deleted is never targeted — only the explicit uid list is ever passed', async () => {
    const fake = createFakeImapClient({
      folders,
      capabilities: new Map([['UIDPLUS', true]]),
    });

    // uid 7 represents some other, unrelated message that a different
    // client already flagged \Deleted — it is never part of this call's
    // authorized set and must never appear in any argument this function
    // passes to the IMAP layer.
    await expungeExactUids(asImapFlow(fake), 'Trash', [3]);

    for (const call of fake.messageFlagsAdd.mock.calls) {
      expect(call[0]).toEqual([3]);
    }
    for (const call of fake.messageDelete.mock.calls) {
      expect(call[0]).toEqual([3]);
    }
  });

  it('is a no-op for an empty uid list — never calls any IMAP command', async () => {
    const fake = createFakeImapClient({
      folders,
      capabilities: new Map([['UIDPLUS', true]]),
    });

    const outcome = await expungeExactUids(asImapFlow(fake), 'Trash', []);

    expect(outcome).toBe(true);
    expect(fake.messageFlagsAdd).not.toHaveBeenCalled();
    expect(fake.messageDelete).not.toHaveBeenCalled();
    expect(fake.getMailboxLock).not.toHaveBeenCalled();
  });
});
