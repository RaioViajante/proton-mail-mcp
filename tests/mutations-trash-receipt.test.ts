import type { FetchMessageObject } from 'imapflow';
import { describe, expect, it } from 'vitest';
import { trashMessages } from '../src/mutations/trash.js';
import {
  RESTORE_RECEIPT_VERSION,
  verifyRestoreReceiptSignature,
} from '../src/security/restore-receipt.js';
import { asImapFlow, createFakeImapClient, fakeFolder } from './fakes/imap-client.js';

const SECRET = Buffer.from('c'.repeat(64), 'hex');

const folders = [
  fakeFolder({ path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' }),
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

const liveIntent = { dryRun: false, confirm: true, acknowledgeTrashMove: true } as const;

describe('mail_trash — restore receipts (0.4.2)', () => {
  it('issues no restoreReceipts field at all when no signingSecret is supplied (0.4.1 behavior unchanged)', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        INBOX: { fetchResults: [fakeMessage(10, '<a@example.com>', ['\\Seen'])] },
        Trash: { fetchResults: [fakeMessage(3, '<a@example.com>')] },
        'Labels/Work': { searchResult: [] },
        'Labels/Personal': { searchResult: [] },
      },
    });

    const result = await trashMessages(asImapFlow(fake), {
      sourceFolder: 'INBOX',
      uids: [10],
      ...liveIntent,
    });
    expect(result.restoreReceipts).toBeUndefined();
  });

  it('never issues a restoreReceipt for a dry-run, even with a signingSecret supplied', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        INBOX: { fetchResults: [fakeMessage(10, '<a@example.com>', ['\\Seen'])] },
        'Labels/Work': { searchResult: [1] },
        'Labels/Personal': { searchResult: [] },
      },
    });

    const result = await trashMessages(asImapFlow(fake), {
      sourceFolder: 'INBOX',
      uids: [10],
      dryRun: true,
      confirm: false,
      acknowledgeTrashMove: false,
      signingSecret: SECRET,
    });

    expect(result.restoreReceipts).toBeUndefined();
  });

  it('issues a signed restoreReceipt for a live, identity-confirmed move', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        INBOX: { fetchResults: [fakeMessage(10, '<a@example.com>', ['\\Seen'])] },
        Trash: { fetchResults: [fakeMessage(3, '<a@example.com>')] },
        'Labels/Work': { searchResult: [1] },
        'Labels/Personal': { searchResult: [] },
      },
      moveResult: { path: 'INBOX', destination: 'Trash', uidMap: new Map([[10, 3]]) },
    });

    const result = await trashMessages(asImapFlow(fake), {
      sourceFolder: 'INBOX',
      uids: [10],
      ...liveIntent,
      signingSecret: SECRET,
    });

    expect(result.restoreReceipts).toHaveLength(1);
    const outcome = result.restoreReceipts?.[0];
    expect(outcome?.uid).toBe(10);
    expect(outcome?.receiptUnavailable).toBeUndefined();
    const receipt = outcome?.restoreReceipt;
    expect(receipt).toBeDefined();
    if (!receipt) return;
    expect(receipt.v).toBe(RESTORE_RECEIPT_VERSION);
    expect(receipt.sourceFolder).toBe('INBOX');
    expect(receipt.originalLabels).toEqual(['Work']);
    expect(receipt.originalFlags).toEqual(['\\Seen']);
    expect(verifyRestoreReceiptSignature(SECRET, receipt)).toBe(true);
  });

  it('the receipt captures the PRE-TRASH snapshot, not labelsAfterTrash — even when the move itself drops a label', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        INBOX: { fetchResults: [fakeMessage(10, '<a@example.com>', ['\\Seen'])] },
        Trash: { fetchResults: [fakeMessage(3, '<a@example.com>')] },
        // Present before the move, gone after — the label impact the receipt must NOT reflect.
        'Labels/Work': { searchSequence: [[1], []] },
        'Labels/Personal': { searchResult: [] },
      },
      moveResult: { path: 'INBOX', destination: 'Trash', uidMap: new Map([[10, 3]]) },
    });

    const result = await trashMessages(asImapFlow(fake), {
      sourceFolder: 'INBOX',
      uids: [10],
      ...liveIntent,
      signingSecret: SECRET,
    });

    expect(result.labelImpacts[0]).toEqual({
      uid: 10,
      originalLabels: ['Work'],
      labelsAfterTrash: [],
      labelsRemovedByTrash: ['Work'],
    });
    // The receipt still asserts the label was originally there, regardless
    // of what labelsAfterTrash shows — that's the entire point.
    expect(result.restoreReceipts?.[0]?.restoreReceipt?.originalLabels).toEqual(['Work']);
  });

  it('receiptUnavailable: noMessageId when the source message has no Message-ID', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        INBOX: { fetchResults: [{ seq: 10, uid: 10, flags: new Set(['\\Seen']) }] },
        'Labels/Work': { searchResult: [] },
        'Labels/Personal': { searchResult: [] },
      },
    });

    const result = await trashMessages(asImapFlow(fake), {
      sourceFolder: 'INBOX',
      uids: [10],
      ...liveIntent,
      signingSecret: SECRET,
    });

    expect(result.restoreReceipts).toEqual([{ uid: 10, receiptUnavailable: 'noMessageId' }]);
  });

  it('receiptUnavailable: identityNotConfirmed when the destination identity in Trash cannot be reconciled', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        INBOX: { fetchResults: [fakeMessage(10, '<a@example.com>')] },
        // No Message-ID match in Trash and no uidMap entry: resultingUid cannot be determined.
        Trash: { fetchResults: [] },
        'Labels/Work': { searchResult: [] },
        'Labels/Personal': { searchResult: [] },
      },
    });

    const result = await trashMessages(asImapFlow(fake), {
      sourceFolder: 'INBOX',
      uids: [10],
      ...liveIntent,
      signingSecret: SECRET,
    });

    expect(result.restoreReceipts).toEqual([
      { uid: 10, receiptUnavailable: 'identityNotConfirmed' },
    ]);
  });

  it('never logs or returns the raw signingSecret anywhere in the result', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        INBOX: { fetchResults: [fakeMessage(10, '<a@example.com>', ['\\Seen'])] },
        Trash: { fetchResults: [fakeMessage(3, '<a@example.com>')] },
        'Labels/Work': { searchResult: [] },
        'Labels/Personal': { searchResult: [] },
      },
      moveResult: { path: 'INBOX', destination: 'Trash', uidMap: new Map([[10, 3]]) },
    });

    const result = await trashMessages(asImapFlow(fake), {
      sourceFolder: 'INBOX',
      uids: [10],
      ...liveIntent,
      signingSecret: SECRET,
    });

    expect(JSON.stringify(result)).not.toContain(SECRET.toString('hex'));
    expect(JSON.stringify(result)).not.toContain('a@example.com');
  });
});
