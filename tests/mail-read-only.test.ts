import type { FetchMessageObject } from 'imapflow';
import { describe, expect, it } from 'vitest';
import { getMessage, listMessages } from '../src/mail/messages.js';
import { searchMail } from '../src/mail/search.js';
import { asImapFlow, createFakeImapClient } from './fakes/imap-client.js';

function fakeMessage(overrides: Partial<FetchMessageObject> = {}): FetchMessageObject {
  return {
    seq: 1,
    uid: 42,
    flags: new Set(['\\Seen']),
    envelope: {
      subject: 'Hello',
      date: '2026-01-01T00:00:00.000Z',
      from: [{ name: 'Alice', address: 'alice@example.com' }],
      to: [{ name: 'Bob', address: 'bob@example.com' }],
    },
    ...overrides,
  };
}

describe('listMessages', () => {
  it('opens the mailbox in read-only mode', async () => {
    const fake = createFakeImapClient({
      mailbox: { exists: 1 },
      fetchResults: [fakeMessage()],
    });

    await listMessages(asImapFlow(fake), { folder: 'INBOX', limit: 20, unreadOnly: false });

    expect(fake.getMailboxLock).toHaveBeenCalledWith('INBOX', { readOnly: true });
  });

  it('always releases the mailbox lock, even when nothing matches', async () => {
    const fake = createFakeImapClient({ mailbox: { exists: 0 } });

    await listMessages(asImapFlow(fake), { folder: 'INBOX', limit: 20, unreadOnly: false });

    expect(fake.lockReleased).toBe(true);
  });

  it('never requests message content, only metadata fields', async () => {
    const fake = createFakeImapClient({ mailbox: { exists: 1 }, fetchResults: [fakeMessage()] });

    await listMessages(asImapFlow(fake), { folder: 'INBOX', limit: 20, unreadOnly: false });

    const [, query] = fake.fetch.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(query.source).toBeUndefined();
    expect(query.envelope).toBe(true);
  });

  it('does not fetch the whole mailbox: the range is bounded by the requested limit', async () => {
    const fake = createFakeImapClient({
      mailbox: { exists: 10_000 },
      fetchResults: [fakeMessage()],
    });

    await listMessages(asImapFlow(fake), { folder: 'INBOX', limit: 20, unreadOnly: false });

    const [range] = fake.fetch.mock.calls[0] as [string, unknown];
    expect(range).not.toBe('1:*');
    expect(range).toBe('9981:*');
  });
});

describe('searchMail', () => {
  it('opens the mailbox in read-only mode', async () => {
    const fake = createFakeImapClient({
      mailbox: { exists: 1 },
      searchResult: [42],
      fetchResults: [fakeMessage()],
    });

    await searchMail(asImapFlow(fake), {
      folder: 'INBOX',
      subject: 'invoice',
      unreadOnly: false,
      limit: 20,
    });

    expect(fake.getMailboxLock).toHaveBeenCalledWith('INBOX', { readOnly: true });
  });

  it('always releases the mailbox lock', async () => {
    const fake = createFakeImapClient({ mailbox: { exists: 1 }, searchResult: [] });

    await searchMail(asImapFlow(fake), { folder: 'INBOX', unreadOnly: false, limit: 20 });

    expect(fake.lockReleased).toBe(true);
  });
});

describe('getMessage', () => {
  const rawMessage = [
    'From: Alice <alice@example.com>',
    'To: Bob <bob@example.com>',
    'Subject: Hello',
    'Date: Thu, 01 Jan 2026 00:00:00 +0000',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Plain body content.',
    '',
  ].join('\r\n');

  it('opens the mailbox in read-only mode', async () => {
    const fake = createFakeImapClient({
      fetchResults: [{ seq: 1, uid: 42, source: Buffer.from(rawMessage, 'utf8') }],
    });

    await getMessage(asImapFlow(fake), 'INBOX', 42);

    expect(fake.getMailboxLock).toHaveBeenCalledWith('INBOX', { readOnly: true });
  });

  it('always releases the mailbox lock, even when the message is missing', async () => {
    const fake = createFakeImapClient({ fetchResults: [] });

    await expect(getMessage(asImapFlow(fake), 'INBOX', 999)).rejects.toThrow(/not found/);
    expect(fake.lockReleased).toBe(true);
  });

  it('fetches by UID, not by sequence number', async () => {
    const fake = createFakeImapClient({
      fetchResults: [{ seq: 1, uid: 42, source: Buffer.from(rawMessage, 'utf8') }],
    });

    await getMessage(asImapFlow(fake), 'INBOX', 42);

    const [range, , options] = fake.fetchOne.mock.calls[0] as [
      unknown,
      unknown,
      Record<string, unknown>,
    ];
    expect(range).toBe(42);
    expect(options.uid).toBe(true);
  });
});
