import type { FetchMessageObject } from 'imapflow';
import { describe, expect, it } from 'vitest';
import { restoreFromTrash } from '../src/mutations/restore.js';
import {
  deriveIdentityFingerprint,
  RESTORE_RECEIPT_VERSION,
  signRestoreReceipt,
  type RestoreReceiptEnvelope,
} from '../src/security/restore-receipt.js';
import { asImapFlow, createFakeImapClient, fakeFolder } from './fakes/imap-client.js';

const SECRET = Buffer.from('d'.repeat(64), 'hex');
const OTHER_SECRET = Buffer.from('e'.repeat(64), 'hex');

const folders = [
  fakeFolder({ path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' }),
  fakeFolder({ path: 'Archive', name: 'Archive', specialUse: '\\Archive' }),
  fakeFolder({ path: 'Trash', name: 'Trash', specialUse: '\\Trash' }),
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

function makeReceipt(
  messageId: string,
  overrides: Partial<Omit<RestoreReceiptEnvelope, 'signature'>> = {},
  secret: Buffer = SECRET,
): RestoreReceiptEnvelope {
  return signRestoreReceipt(secret, {
    v: RESTORE_RECEIPT_VERSION,
    sourceFolder: 'Archive',
    originalLabels: ['Personal', 'Work'],
    originalFlags: ['\\Seen'],
    identity: deriveIdentityFingerprint(secret, messageId),
    issuedAt: '2026-09-17T00:00:00.000Z',
    ...overrides,
  });
}

const liveIntent = { dryRun: false, confirm: true, acknowledgeRestoreFromTrash: true } as const;

describe('mail_restore_from_trash — async label loss regression (0.4.2 primary test)', () => {
  it('reproduces the exact finding and repairs from the receipt, even though Trash itself shows zero labels', async () => {
    // 1. Archive starts with labels Personal+Work, \Seen.
    // 2. mail_trash captured that snapshot into a receipt (built here directly).
    const receipt = makeReceipt('<a@example.com>');

    // 3/4. By restore time, Trash itself shows ZERO labels for this message —
    // the async decay the receipt exists to survive.
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        Trash: { fetchResults: [fakeMessage(5, '<a@example.com>', ['\\Seen'])] },
        Archive: { fetchResults: [fakeMessage(9, '<a@example.com>', ['\\Seen'])] },
        'Labels/Work': { searchResult: [] },
        'Labels/Personal': { searchResult: [] },
      },
      moveResult: { path: 'Trash', destination: 'Archive', uidMap: new Map([[5, 9]]) },
    });

    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'Archive',
      restoreReceipts: [{ uid: 5, receipt }],
      signingSecret: SECRET,
      ...liveIntent,
    });

    // preservationSource: restoreReceipt, not trashSnapshot — the whole point.
    expect(result.preservationSource).toEqual([{ uid: 5, source: 'restoreReceipt' }]);
    // The baseline used for repair is the receipt's pre-Trash state, not Trash's current (empty) state.
    expect(result.originalLabels).toEqual([{ uid: 5, labels: ['Personal', 'Work'] }]);
    expect(result.labelsAfterMove).toEqual([{ uid: 5, labels: [] }]);
    // 8/9. Both labels are reapplied from the receipt; final state = original.
    expect(result.labelsRestored?.map((entry) => entry.label).sort()).toEqual(['Personal', 'Work']);
    expect(result.labelsFailed).toEqual([]);
    expect(result.flagsFailed).toEqual([]);
    expect(result.partialSuccess).toBe(false);
    expect(result.statePreserved).toEqual([{ uid: 5, preserved: true }]);
    expect(fake.messageMove).toHaveBeenCalledWith([9], 'Labels/Work', { uid: true });
    expect(fake.messageMove).toHaveBeenCalledWith([9], 'Labels/Personal', { uid: true });
  });
});

describe('mail_restore_from_trash — no receipt supplied (trashSnapshot fallback, 0.4.1 behavior)', () => {
  it('falls back to measuring Trash directly, and never claims statePreserved', async () => {
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

    expect(result.preservationSource).toEqual([{ uid: 5, source: 'trashSnapshot' }]);
    expect(result.labelsRestored).toEqual([{ uid: 5, label: 'Work' }]);
    expect(result.labelsFailed).toEqual([]);
    // Even with a fully clean repair, trashSnapshot never claims the strong guarantee.
    expect(result.statePreserved).toEqual([{ uid: 5, preserved: false }]);
    expect(result.receiptRejections).toBeUndefined();
  });
});

describe('mail_restore_from_trash — receipt fail-closed rejection', () => {
  const baseFakeOptions = {
    folders,
    mailboxes: {
      Trash: { fetchResults: [fakeMessage(5, '<a@example.com>', ['\\Seen'])] },
      Archive: { fetchResults: [fakeMessage(9, '<a@example.com>', ['\\Seen'])] },
      'Labels/Work': { searchResult: [] },
      'Labels/Personal': { searchResult: [] },
    },
    moveResult: { path: 'Trash', destination: 'Archive', uidMap: new Map([[5, 9]]) },
  };

  it('malformed receipt: rejected, move still proceeds, zero repair applied from it', async () => {
    const fake = createFakeImapClient(baseFakeOptions);
    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'Archive',
      restoreReceipts: [{ uid: 5, receipt: { garbage: true } }],
      signingSecret: SECRET,
      ...liveIntent,
    });

    expect(result.receiptRejections).toEqual([{ uid: 5, reason: 'malformedReceipt' }]);
    expect(result.preservationSource).toEqual([{ uid: 5, source: 'unavailable' }]);
    expect(result.moveRestored).toEqual([5]);
    expect(result.originalLabels).toEqual([]);
    expect(result.labelsRestored).toEqual([]);
    expect(result.labelsFailed).toEqual([]);
    expect(result.statePreserved).toEqual([{ uid: 5, preserved: false }]);
    expect(fake.messageMove).toHaveBeenCalledTimes(1); // only the restore move itself
  });

  it('missing fields: rejected as malformed', async () => {
    const fake = createFakeImapClient(baseFakeOptions);
    const receipt = makeReceipt('<a@example.com>') as unknown as Record<string, unknown>;
    delete receipt.signature;
    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'Archive',
      restoreReceipts: [{ uid: 5, receipt }],
      signingSecret: SECRET,
      ...liveIntent,
    });
    expect(result.receiptRejections).toEqual([{ uid: 5, reason: 'malformedReceipt' }]);
  });

  it('unsupported receipt version: rejected as malformed', async () => {
    const fake = createFakeImapClient(baseFakeOptions);
    const receipt = { ...makeReceipt('<a@example.com>'), v: 99 };
    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'Archive',
      restoreReceipts: [{ uid: 5, receipt }],
      signingSecret: SECRET,
      ...liveIntent,
    });
    expect(result.receiptRejections).toEqual([{ uid: 5, reason: 'malformedReceipt' }]);
  });

  it('modified originalLabels (post-signing tamper): signature invalid, rejected', async () => {
    const fake = createFakeImapClient(baseFakeOptions);
    const receipt = { ...makeReceipt('<a@example.com>'), originalLabels: ['Injected'] };
    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'Archive',
      restoreReceipts: [{ uid: 5, receipt }],
      signingSecret: SECRET,
      ...liveIntent,
    });
    expect(result.receiptRejections).toEqual([{ uid: 5, reason: 'signatureInvalid' }]);
    expect(result.labelsRestored).toEqual([]);
  });

  it('modified flags (post-signing tamper): signature invalid, rejected', async () => {
    const fake = createFakeImapClient(baseFakeOptions);
    const receipt = { ...makeReceipt('<a@example.com>'), originalFlags: [] };
    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'Archive',
      restoreReceipts: [{ uid: 5, receipt }],
      signingSecret: SECRET,
      ...liveIntent,
    });
    expect(result.receiptRejections).toEqual([{ uid: 5, reason: 'signatureInvalid' }]);
  });

  it('modified sourceFolder (post-signing tamper): signature invalid, rejected', async () => {
    const fake = createFakeImapClient(baseFakeOptions);
    const receipt = { ...makeReceipt('<a@example.com>'), sourceFolder: 'INBOX' };
    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'Archive',
      restoreReceipts: [{ uid: 5, receipt }],
      signingSecret: SECRET,
      ...liveIntent,
    });
    expect(result.receiptRejections).toEqual([{ uid: 5, reason: 'signatureInvalid' }]);
  });

  it('modified identity fingerprint (post-signing tamper): signature invalid, rejected', async () => {
    const fake = createFakeImapClient(baseFakeOptions);
    const receipt = { ...makeReceipt('<a@example.com>'), identity: 'f'.repeat(64) };
    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'Archive',
      restoreReceipts: [{ uid: 5, receipt }],
      signingSecret: SECRET,
      ...liveIntent,
    });
    expect(result.receiptRejections).toEqual([{ uid: 5, reason: 'signatureInvalid' }]);
  });

  it('receipt for message A used on message B: identity mismatch, rejected', async () => {
    // Trash message at uid 5 actually has Message-ID B, but the receipt is for A.
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        Trash: { fetchResults: [fakeMessage(5, '<b@example.com>', ['\\Seen'])] },
        Archive: { fetchResults: [fakeMessage(9, '<b@example.com>', ['\\Seen'])] },
        'Labels/Work': { searchResult: [] },
        'Labels/Personal': { searchResult: [] },
      },
      moveResult: { path: 'Trash', destination: 'Archive', uidMap: new Map([[5, 9]]) },
    });
    const receiptForA = makeReceipt('<a@example.com>');
    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'Archive',
      restoreReceipts: [{ uid: 5, receipt: receiptForA }],
      signingSecret: SECRET,
      ...liveIntent,
    });
    expect(result.receiptRejections).toEqual([{ uid: 5, reason: 'identityMismatch' }]);
    expect(result.moveRestored).toEqual([5]); // the move itself still succeeds
    expect(result.labelsRestored).toEqual([]);
  });

  it('no Message-ID on the live Trash message: rejected, cannot verify identity', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        Trash: { fetchResults: [{ seq: 5, uid: 5, flags: new Set(['\\Seen']) }] },
        Archive: { fetchResults: [] },
      },
    });
    const receipt = makeReceipt('<a@example.com>');
    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'Archive',
      restoreReceipts: [{ uid: 5, receipt }],
      signingSecret: SECRET,
      ...liveIntent,
    });
    expect(result.receiptRejections).toEqual([{ uid: 5, reason: 'noMessageIdToVerify' }]);
  });

  it('malformed Message-ID (empty string) on the live message: no identity to verify, rejected', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        Trash: {
          fetchResults: [{ seq: 5, uid: 5, envelope: { messageId: '' }, flags: new Set() }],
        },
        Archive: { fetchResults: [] },
      },
    });
    const receipt = makeReceipt('<a@example.com>');
    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'Archive',
      restoreReceipts: [{ uid: 5, receipt }],
      signingSecret: SECRET,
      ...liveIntent,
    });
    expect(result.receiptRejections).toEqual([{ uid: 5, reason: 'noMessageIdToVerify' }]);
  });

  it('signing secret unavailable at restore time: every supplied receipt fails closed', async () => {
    const fake = createFakeImapClient(baseFakeOptions);
    const receipt = makeReceipt('<a@example.com>');
    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'Archive',
      restoreReceipts: [{ uid: 5, receipt }],
      signingSecret: undefined,
      ...liveIntent,
    });
    expect(result.receiptRejections).toEqual([{ uid: 5, reason: 'signingSecretUnavailable' }]);
  });

  it('a receipt signed under a different secret than the one available now: signature invalid', async () => {
    const fake = createFakeImapClient(baseFakeOptions);
    const receipt = makeReceipt('<a@example.com>', {}, OTHER_SECRET);
    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'Archive',
      restoreReceipts: [{ uid: 5, receipt }],
      signingSecret: SECRET,
      ...liveIntent,
    });
    expect(result.receiptRejections).toEqual([{ uid: 5, reason: 'signatureInvalid' }]);
  });
});

describe('mail_restore_from_trash — stale UID / receipt replay', () => {
  it('stale Trash UID: the message is no longer in Trash, reported missing, receipt simply unused', async () => {
    const fake = createFakeImapClient({ folders, fetchResults: [] });
    const receipt = makeReceipt('<a@example.com>');
    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'Archive',
      restoreReceipts: [{ uid: 5, receipt }],
      signingSecret: SECRET,
      ...liveIntent,
    });
    expect(result.missingUids).toEqual([5]);
    expect(result.changedUids).toEqual([]);
    expect(fake.messageMove).not.toHaveBeenCalled();
  });

  it('receipt replay after the message was already restored: second call finds nothing in Trash, no-op', async () => {
    const fake = createFakeImapClient({ folders, fetchResults: [] });
    const receipt = makeReceipt('<a@example.com>');
    // Simulates re-using the same receipt a second time, after uid 5 is gone from Trash.
    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'Archive',
      restoreReceipts: [{ uid: 5, receipt }],
      signingSecret: SECRET,
      ...liveIntent,
    });
    expect(result.missingUids).toEqual([5]);
    expect(result.labelsRestored).toBeUndefined();
  });
});

describe('mail_restore_from_trash — duplicate/nonexistent original labels in a receipt', () => {
  it('duplicate labels in originalLabels are deduplicated, applied once each', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        Trash: { fetchResults: [fakeMessage(5, '<a@example.com>', ['\\Seen'])] },
        Archive: { fetchResults: [fakeMessage(9, '<a@example.com>', ['\\Seen'])] },
        'Labels/Work': { searchResult: [] },
        'Labels/Personal': { searchResult: [] },
      },
      moveResult: { path: 'Trash', destination: 'Archive', uidMap: new Map([[5, 9]]) },
    });
    const receipt = makeReceipt('<a@example.com>', {
      originalLabels: ['Work', 'Work', 'Personal'],
    });
    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'Archive',
      restoreReceipts: [{ uid: 5, receipt }],
      signingSecret: SECRET,
      ...liveIntent,
    });
    expect(result.labelsRestored?.map((entry) => entry.label).sort()).toEqual(['Personal', 'Work']);
    expect(fake.messageMove.mock.calls.filter((call) => call[1] === 'Labels/Work')).toHaveLength(1);
  });

  it('a receipt-original label that no longer exists as a mailbox fails gracefully, never thrown, never auto-created', async () => {
    const fake = createFakeImapClient({
      folders, // "Ghost" label deliberately absent from the folder listing
      mailboxes: {
        Trash: { fetchResults: [fakeMessage(5, '<a@example.com>', ['\\Seen'])] },
        Archive: { fetchResults: [fakeMessage(9, '<a@example.com>', ['\\Seen'])] },
        'Labels/Work': { searchResult: [] },
      },
      moveResult: { path: 'Trash', destination: 'Archive', uidMap: new Map([[5, 9]]) },
    });
    const receipt = makeReceipt('<a@example.com>', { originalLabels: ['Work', 'Ghost'] });
    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'Archive',
      restoreReceipts: [{ uid: 5, receipt }],
      signingSecret: SECRET,
      ...liveIntent,
    });
    expect(result.labelsRestored).toEqual([{ uid: 5, label: 'Work' }]);
    expect(result.labelsFailed).toEqual([
      {
        uid: 5,
        label: 'Ghost',
        reason: 'Label mailbox no longer exists; not reapplied automatically.',
      },
    ]);
    expect(result.partialSuccess).toBe(true);
  });
});

describe('mail_restore_from_trash — restoreToOriginalSource', () => {
  it('restores to the sourceFolder recorded in the verified receipt', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        Trash: { fetchResults: [fakeMessage(5, '<a@example.com>', ['\\Seen'])] },
        Archive: { fetchResults: [fakeMessage(9, '<a@example.com>', ['\\Seen'])] },
        'Labels/Work': { searchResult: [1] },
        'Labels/Personal': { searchResult: [1] },
      },
      moveResult: { path: 'Trash', destination: 'Archive', uidMap: new Map([[5, 9]]) },
    });
    const receipt = makeReceipt('<a@example.com>', { sourceFolder: 'Archive' });
    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      restoreToOriginalSource: true,
      restoreReceipts: [{ uid: 5, receipt }],
      signingSecret: SECRET,
      ...liveIntent,
    });
    expect(fake.messageMove).toHaveBeenCalledWith([5], 'Archive', { uid: true });
    expect(result.moveRestored).toEqual([5]);
  });

  it('rejects destinationFolder being supplied together with restoreToOriginalSource', async () => {
    const fake = createFakeImapClient({ folders });
    await expect(
      restoreFromTrash(asImapFlow(fake), {
        uids: [5],
        destinationFolder: 'Archive',
        restoreToOriginalSource: true,
        signingSecret: SECRET,
        ...liveIntent,
      }),
    ).rejects.toThrow(/must be omitted/i);
    expect(fake.list).not.toHaveBeenCalled();
  });

  it('rejects restoreToOriginalSource for more than one uid', async () => {
    const fake = createFakeImapClient({ folders });
    await expect(
      restoreFromTrash(asImapFlow(fake), {
        uids: [5, 6],
        restoreToOriginalSource: true,
        signingSecret: SECRET,
        ...liveIntent,
      }),
    ).rejects.toThrow(/single uid/i);
  });

  it('rejects restoreToOriginalSource when no valid receipt is available for the uid', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        Trash: { fetchResults: [fakeMessage(5, '<a@example.com>', ['\\Seen'])] },
      },
    });
    await expect(
      restoreFromTrash(asImapFlow(fake), {
        uids: [5],
        restoreToOriginalSource: true,
        signingSecret: SECRET,
        ...liveIntent,
      }),
    ).rejects.toThrow(/requires a fully verified restoreReceipt/i);
    expect(fake.messageMove).not.toHaveBeenCalled();
  });

  it('requires destinationFolder when restoreToOriginalSource is not set', async () => {
    const fake = createFakeImapClient({ folders });
    await expect(
      restoreFromTrash(asImapFlow(fake), {
        uids: [5],
        signingSecret: SECRET,
        ...liveIntent,
      }),
    ).rejects.toThrow(/destinationFolder is required/i);
  });
});

describe('mail_restore_from_trash — dry-run never side-effects with a receipt supplied', () => {
  it('dry-run with a valid receipt reports the preview but calls no mutating IMAP method', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        Trash: { fetchResults: [fakeMessage(5, '<a@example.com>', ['\\Seen'])] },
      },
    });
    const receipt = makeReceipt('<a@example.com>');
    const result = await restoreFromTrash(asImapFlow(fake), {
      uids: [5],
      destinationFolder: 'Archive',
      restoreReceipts: [{ uid: 5, receipt }],
      signingSecret: SECRET,
      dryRun: true,
      confirm: false,
      acknowledgeRestoreFromTrash: false,
    });
    expect(result.preservationSource).toEqual([{ uid: 5, source: 'restoreReceipt' }]);
    expect(result.originalLabels).toEqual([{ uid: 5, labels: ['Personal', 'Work'] }]);
    expect(fake.messageMove).not.toHaveBeenCalled();
    expect(fake.messageFlagsAdd).not.toHaveBeenCalled();
    expect(fake.messageFlagsRemove).not.toHaveBeenCalled();
  });
});
