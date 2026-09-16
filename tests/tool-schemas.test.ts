import { describe, expect, it } from 'vitest';
import { inputSchema as getMessageSchema } from '../src/tools/get-message.js';
import { inputSchema as listMessagesSchema } from '../src/tools/list-messages.js';
import { inputSchema as searchMailSchema } from '../src/tools/search-mail.js';

describe('mail_list_messages input schema', () => {
  it('requires a folder', () => {
    expect(listMessagesSchema.safeParse({}).success).toBe(false);
  });

  it('applies default limit and unreadOnly', () => {
    const result = listMessagesSchema.parse({ folder: 'INBOX' });
    expect(result.limit).toBe(20);
    expect(result.unreadOnly).toBe(false);
  });

  it('rejects a limit above the maximum of 50', () => {
    expect(listMessagesSchema.safeParse({ folder: 'INBOX', limit: 51 }).success).toBe(false);
  });

  it('accepts a limit at the maximum of 50', () => {
    expect(listMessagesSchema.safeParse({ folder: 'INBOX', limit: 50 }).success).toBe(true);
  });

  it('rejects a limit below 1', () => {
    expect(listMessagesSchema.safeParse({ folder: 'INBOX', limit: 0 }).success).toBe(false);
  });

  it('rejects a non-integer limit', () => {
    expect(listMessagesSchema.safeParse({ folder: 'INBOX', limit: 10.5 }).success).toBe(false);
  });

  it('rejects an empty folder', () => {
    expect(listMessagesSchema.safeParse({ folder: '' }).success).toBe(false);
  });
});

describe('mail_search input schema', () => {
  it('requires a folder', () => {
    expect(searchMailSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a limit above the maximum of 50', () => {
    expect(searchMailSchema.safeParse({ folder: 'INBOX', limit: 51 }).success).toBe(false);
  });

  it('accepts a limit at the maximum of 50', () => {
    expect(searchMailSchema.safeParse({ folder: 'INBOX', limit: 50 }).success).toBe(true);
  });

  it('rejects an invalid since date', () => {
    expect(searchMailSchema.safeParse({ folder: 'INBOX', since: 'not-a-date' }).success).toBe(
      false,
    );
  });

  it('accepts a valid ISO date', () => {
    expect(searchMailSchema.safeParse({ folder: 'INBOX', since: '2026-01-01' }).success).toBe(true);
  });

  it('accepts structured filters together', () => {
    const result = searchMailSchema.safeParse({
      folder: 'INBOX',
      from: 'alice@example.com',
      subject: 'invoice',
      unreadOnly: true,
      limit: 10,
    });
    expect(result.success).toBe(true);
  });
});

describe('mail_get_message input schema', () => {
  it('requires folder and uid', () => {
    expect(getMessageSchema.safeParse({}).success).toBe(false);
    expect(getMessageSchema.safeParse({ folder: 'INBOX' }).success).toBe(false);
  });

  it('rejects a non-positive uid', () => {
    expect(getMessageSchema.safeParse({ folder: 'INBOX', uid: 0 }).success).toBe(false);
    expect(getMessageSchema.safeParse({ folder: 'INBOX', uid: -1 }).success).toBe(false);
  });

  it('rejects a non-integer uid', () => {
    expect(getMessageSchema.safeParse({ folder: 'INBOX', uid: 1.5 }).success).toBe(false);
  });

  it('accepts a valid uid', () => {
    expect(getMessageSchema.safeParse({ folder: 'INBOX', uid: 42 }).success).toBe(true);
  });
});
