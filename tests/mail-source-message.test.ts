import type { FetchMessageObject } from 'imapflow';
import { describe, expect, it } from 'vitest';
import {
  fetchForwardSourceContent,
  fetchReplySourceHeaders,
  FORWARD_SOURCE_BYTES_CAP,
} from '../src/mail/source-message.js';
import { asImapFlow, createFakeImapClient } from './fakes/imap-client.js';

function fakeReplyMessage(overrides: Partial<FetchMessageObject> = {}): FetchMessageObject {
  return {
    seq: 1,
    uid: 42,
    flags: new Set(),
    envelope: {
      subject: 'Hello',
      date: '2026-01-01T00:00:00.000Z',
      from: [{ name: 'Alice', address: 'alice@example.com' }],
      messageId: '<abc@example.com>',
    },
    ...overrides,
  };
}

describe('fetchReplySourceHeaders', () => {
  it('opens the mailbox read-only — never marks the message as read', async () => {
    const fake = createFakeImapClient({
      mailbox: { exists: 1 },
      fetchResults: [fakeReplyMessage()],
    });
    await fetchReplySourceHeaders(asImapFlow(fake), 'INBOX', 42);
    expect(fake.getMailboxLock).toHaveBeenCalledWith('INBOX', { readOnly: true });
    expect(fake.lockReleased).toBe(true);
  });

  it('requests only envelope + references/reply-to headers — never a source fetch', async () => {
    const fake = createFakeImapClient({
      mailbox: { exists: 1 },
      fetchResults: [fakeReplyMessage()],
    });
    await fetchReplySourceHeaders(asImapFlow(fake), 'INBOX', 42);
    const [, query] = fake.fetchOne.mock.calls[0] as [number, Record<string, unknown>];
    expect(query.source).toBeUndefined();
    expect(query.bodyStructure).toBeUndefined();
    expect(query.envelope).toBe(true);
    expect(query.headers).toEqual(['references', 'reply-to']);
  });

  it('returns null when the message is not found', async () => {
    const fake = createFakeImapClient({ mailbox: { exists: 0 }, fetchResults: [] });
    const result = await fetchReplySourceHeaders(asImapFlow(fake), 'INBOX', 999);
    expect(result).toBeNull();
  });

  it('extracts from/messageId/subject/date from the envelope', async () => {
    const fake = createFakeImapClient({
      mailbox: { exists: 1 },
      fetchResults: [fakeReplyMessage()],
    });
    const result = await fetchReplySourceHeaders(asImapFlow(fake), 'INBOX', 42);
    expect(result?.from).toBe('alice@example.com');
    expect(result?.messageId).toBe('<abc@example.com>');
    expect(result?.subject).toBe('Hello');
    expect(result?.date).toBe(new Date('2026-01-01T00:00:00.000Z').toISOString());
  });

  describe('Reply-To presence vs. usability (0.5.2 corrected semantics)', () => {
    it('no Reply-To header at all: headerPresent=false, valid From is still usable by the caller', async () => {
      const fake = createFakeImapClient({
        mailbox: { exists: 1 },
        fetchResults: [
          fakeReplyMessage({ headers: Buffer.from('References: <r1@example.com>\r\n') }),
        ],
      });
      const result = await fetchReplySourceHeaders(asImapFlow(fake), 'INBOX', 42);
      expect(result?.replyTo.headerPresent).toBe(false);
      expect(result?.replyTo.malformed).toBe(false);
      expect(result?.replyTo.addresses).toEqual([]);
      expect(result?.from).toBe('alice@example.com');
    });

    it('a Reply-To header that IMAP-envelope-parses to zero addresses is still reported present — never silently absent', async () => {
      const fake = createFakeImapClient({
        mailbox: { exists: 1 },
        fetchResults: [
          fakeReplyMessage({
            envelope: {
              subject: 'Hello',
              from: [{ address: 'alice@example.com' }],
              replyTo: [], // server parsed nothing usable
            },
            headers: Buffer.from('Reply-To: this is not a usable address\r\n'),
          }),
        ],
      });
      const result = await fetchReplySourceHeaders(asImapFlow(fake), 'INBOX', 42);
      expect(result?.replyTo.headerPresent).toBe(true);
      expect(result?.replyTo.malformed).toBe(false);
      expect(result?.replyTo.addresses).toEqual([]);
    });

    it('multiple Reply-To addresses are reported, flagged for reply-intent.ts to reject (never reply-all)', async () => {
      const fake = createFakeImapClient({
        mailbox: { exists: 1 },
        fetchResults: [
          fakeReplyMessage({
            envelope: {
              subject: 'Hello',
              from: [{ address: 'alice@example.com' }],
              replyTo: [{ address: 'a@example.com' }, { address: 'b@example.com' }],
            },
            headers: Buffer.from('Reply-To: a@example.com, b@example.com\r\n'),
          }),
        ],
      });
      const result = await fetchReplySourceHeaders(asImapFlow(fake), 'INBOX', 42);
      expect(result?.replyTo.headerPresent).toBe(true);
      expect(result?.replyTo.addresses).toEqual(['a@example.com', 'b@example.com']);
    });

    it('oversized raw Reply-To header: flagged malformed, addresses discarded (never truncated-and-used)', async () => {
      const hugeValue = 'a@example.com' + 'x'.repeat(5000);
      const fake = createFakeImapClient({
        mailbox: { exists: 1 },
        fetchResults: [
          fakeReplyMessage({
            envelope: {
              subject: 'Hello',
              from: [{ address: 'alice@example.com' }],
              replyTo: [{ address: 'a@example.com' }],
            },
            headers: Buffer.from(`Reply-To: ${hugeValue}\r\n`),
          }),
        ],
      });
      const result = await fetchReplySourceHeaders(asImapFlow(fake), 'INBOX', 42);
      expect(result?.replyTo.headerPresent).toBe(true);
      expect(result?.replyTo.malformed).toBe(true);
      expect(result?.replyTo.addresses).toEqual([]);
    });

    it('a Reply-To header containing a raw control character: flagged malformed', async () => {
      const fake = createFakeImapClient({
        mailbox: { exists: 1 },
        fetchResults: [
          fakeReplyMessage({
            envelope: {
              subject: 'Hello',
              from: [{ address: 'alice@example.com' }],
              replyTo: [{ address: 'a@example.com' }],
            },
            headers: Buffer.from('Reply-To: a@example.com\x07evil\r\n'),
          }),
        ],
      });
      const result = await fetchReplySourceHeaders(asImapFlow(fake), 'INBOX', 42);
      expect(result?.replyTo.malformed).toBe(true);
      expect(result?.replyTo.addresses).toEqual([]);
    });
  });

  describe('References presence/oversize flagging', () => {
    it('References header present and small: reported present, not malformed', async () => {
      const fake = createFakeImapClient({
        mailbox: { exists: 1 },
        fetchResults: [
          fakeReplyMessage({
            headers: Buffer.from('References: <r1@example.com> <r2@example.com>\r\n'),
          }),
        ],
      });
      const result = await fetchReplySourceHeaders(asImapFlow(fake), 'INBOX', 42);
      expect(result?.references.headerPresent).toBe(true);
      expect(result?.references.malformed).toBe(false);
      expect(result?.references.raw).toBe('<r1@example.com> <r2@example.com>');
    });

    it('References header absent: headerPresent=false, raw=null', async () => {
      const fake = createFakeImapClient({
        mailbox: { exists: 1 },
        fetchResults: [fakeReplyMessage({ headers: Buffer.from('') })],
      });
      const result = await fetchReplySourceHeaders(asImapFlow(fake), 'INBOX', 42);
      expect(result?.references.headerPresent).toBe(false);
      expect(result?.references.raw).toBeNull();
    });

    it('oversized References header (exceeds byte bound before parsing): flagged malformed, raw discarded', async () => {
      const huge = Array.from({ length: 2000 }, (_, i) => `<r${i}@example.com>`).join(' ');
      const fake = createFakeImapClient({
        mailbox: { exists: 1 },
        fetchResults: [fakeReplyMessage({ headers: Buffer.from(`References: ${huge}\r\n`) })],
      });
      const result = await fetchReplySourceHeaders(asImapFlow(fake), 'INBOX', 42);
      expect(result?.references.malformed).toBe(true);
      expect(result?.references.raw).toBeNull();
    });
  });
});

function fakeForwardMessage(overrides: Partial<FetchMessageObject> = {}): FetchMessageObject {
  const source = Buffer.from(
    ['From: Alice <alice@example.com>', 'Subject: Hello', '', 'Body text here.'].join('\r\n'),
    'utf8',
  );
  return {
    seq: 1,
    uid: 42,
    flags: new Set(),
    envelope: {
      subject: 'Hello',
      date: '2026-01-01T00:00:00.000Z',
      from: [{ address: 'alice@example.com' }],
      to: [{ address: 'bob@example.com' }],
    },
    bodyStructure: { part: '1', type: 'text/plain', parameters: {}, disposition: undefined },
    size: source.byteLength,
    source,
    ...overrides,
  };
}

describe('fetchForwardSourceContent', () => {
  it('opens the mailbox read-only — never marks the message as read', async () => {
    const fake = createFakeImapClient({
      mailbox: { exists: 1 },
      fetchResults: [fakeForwardMessage()],
    });
    await fetchForwardSourceContent(asImapFlow(fake), 'INBOX', 42);
    expect(fake.getMailboxLock).toHaveBeenCalledWith('INBOX', { readOnly: true });
    expect(fake.lockReleased).toBe(true);
  });

  it('requests envelope + bodyStructure + size + a bounded source', async () => {
    const fake = createFakeImapClient({
      mailbox: { exists: 1 },
      fetchResults: [fakeForwardMessage()],
    });
    await fetchForwardSourceContent(asImapFlow(fake), 'INBOX', 42);
    const [, query] = fake.fetchOne.mock.calls[0] as [number, Record<string, unknown>];
    expect(query.envelope).toBe(true);
    expect(query.bodyStructure).toBe(true);
    expect(query.size).toBe(true);
    expect((query.source as { maxLength: number }).maxLength).toBe(FORWARD_SOURCE_BYTES_CAP);
  });

  it('returns null when the message is not found', async () => {
    const fake = createFakeImapClient({ mailbox: { exists: 0 }, fetchResults: [] });
    const result = await fetchForwardSourceContent(asImapFlow(fake), 'INBOX', 999);
    expect(result).toBeNull();
  });

  it('a complete source (returned bytes >= reported size) parses plain text and reports sourceContentComplete=true', async () => {
    const fake = createFakeImapClient({
      mailbox: { exists: 1 },
      fetchResults: [fakeForwardMessage()],
    });
    const result = await fetchForwardSourceContent(asImapFlow(fake), 'INBOX', 42);
    expect(result?.sourceContentComplete).toBe(true);
    expect(result?.plainText).toContain('Body text here.');
  });

  it('a source truncated by the byte cap (size > returned bytes) is ineligible — never parsed', async () => {
    const fake = createFakeImapClient({
      mailbox: { exists: 1 },
      fetchResults: [fakeForwardMessage({ size: 10_000_000 })], // real message is far larger than what was returned
    });
    const result = await fetchForwardSourceContent(asImapFlow(fake), 'INBOX', 42);
    expect(result?.sourceContentComplete).toBe(false);
    expect(result?.plainText).toBe('');
  });

  it('server not reporting a size at all: treated as incomplete (cannot prove completeness) — never parsed', async () => {
    const fake = createFakeImapClient({
      mailbox: { exists: 1 },
      fetchResults: [fakeForwardMessage({ size: undefined })],
    });
    const result = await fetchForwardSourceContent(asImapFlow(fake), 'INBOX', 42);
    expect(result?.sourceContentComplete).toBe(false);
    expect(result?.plainText).toBe('');
  });

  it('HTML-only source falls back to converted plain text', async () => {
    const htmlSource = Buffer.from(
      [
        'From: Alice <alice@example.com>',
        'Subject: Hello',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<p>Hello <b>world</b></p>',
      ].join('\r\n'),
      'utf8',
    );
    const fake = createFakeImapClient({
      mailbox: { exists: 1 },
      fetchResults: [fakeForwardMessage({ source: htmlSource, size: htmlSource.byteLength })],
    });
    const result = await fetchForwardSourceContent(asImapFlow(fake), 'INBOX', 42);
    expect(result?.sourceContentComplete).toBe(true);
    expect(result?.plainText).toContain('Hello');
    expect(result?.plainText).not.toContain('<b>');
  });

  it('no plain-text and no HTML at all: plainText is empty, still marked complete', async () => {
    const emptySource = Buffer.from(
      ['From: Alice <alice@example.com>', 'Subject: Hello', '', ''].join('\r\n'),
      'utf8',
    );
    const fake = createFakeImapClient({
      mailbox: { exists: 1 },
      fetchResults: [fakeForwardMessage({ source: emptySource, size: emptySource.byteLength })],
    });
    const result = await fetchForwardSourceContent(asImapFlow(fake), 'INBOX', 42);
    expect(result?.sourceContentComplete).toBe(true);
    expect(result?.plainText).toBe('');
  });

  it('hasAttachments is derived from bodyStructure alone, without ever reading attachment content', async () => {
    const fake = createFakeImapClient({
      mailbox: { exists: 1 },
      fetchResults: [
        fakeForwardMessage({
          bodyStructure: {
            part: '1',
            type: 'multipart/mixed',
            childNodes: [
              { part: '1.1', type: 'text/plain', parameters: {}, disposition: undefined },
              {
                part: '1.2',
                type: 'application/pdf',
                parameters: { name: 'invoice.pdf' },
                disposition: 'attachment',
                dispositionParameters: { filename: 'invoice.pdf' },
              },
            ],
          },
        }),
      ],
    });
    const result = await fetchForwardSourceContent(asImapFlow(fake), 'INBOX', 42);
    expect(result?.hasAttachments).toBe(true);
  });
});
