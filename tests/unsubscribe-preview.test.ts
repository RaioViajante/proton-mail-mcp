import type { FetchMessageObject } from 'imapflow';
import { describe, expect, it } from 'vitest';
import { previewUnsubscribe } from '../src/unsubscribe/preview.js';
import { asImapFlow, createFakeImapClient, fakeFolder } from './fakes/imap-client.js';

const folders = [fakeFolder({ path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' })];

function headerMessage(uid: number, rawHeaders: string): FetchMessageObject {
  return {
    seq: uid,
    uid,
    envelope: {
      messageId: '<a@list.example.com>',
      from: [{ address: 'sender@list.example.com', name: '' }],
    },
    headers: Buffer.from(`${rawHeaders}\r\n`, 'utf8'),
  };
}

describe('mail_unsubscribe_preview', () => {
  it('is read-only: opens the mailbox read-only and issues no write call', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        INBOX: {
          fetchResults: [
            headerMessage(
              1,
              'List-Unsubscribe: <https://list.example.com/u?id=1>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click',
            ),
          ],
        },
      },
    });

    await previewUnsubscribe(asImapFlow(fake), { folder: 'INBOX', uid: 1 });

    expect(fake.lockCalls.every((call) => call.readOnly === true)).toBe(true);
    expect(fake.messageMove).not.toHaveBeenCalled();
    expect(fake.messageFlagsAdd).not.toHaveBeenCalled();
  });

  it('reports a message that no longer exists without throwing', async () => {
    const fake = createFakeImapClient({ folders, mailboxes: { INBOX: { fetchResults: [] } } });

    const result = await previewUnsubscribe(asImapFlow(fake), { folder: 'INBOX', uid: 42 });

    expect(result.executionEligibility).toBe('ineligible');
    expect(result.supported).toBe(false);
    expect(result.reasons).toContain('Message not found in the specified folder.');
  });

  it('never includes the full URL, query string, or a mailto address in its output', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        INBOX: {
          fetchResults: [
            headerMessage(
              1,
              [
                'List-Unsubscribe: <https://list.example.com/u?id=SUPER-SECRET-TOKEN>, <mailto:secret-recipient@list.example.com>',
                'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
                'Authentication-Results: mx.proton.me; dmarc=pass',
              ].join('\r\n'),
            ),
          ],
        },
      },
    });

    const result = await previewUnsubscribe(asImapFlow(fake), { folder: 'INBOX', uid: 1 });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain('SUPER-SECRET-TOKEN');
    expect(serialized).not.toContain('secret-recipient');
    expect(serialized).not.toContain('mailto:');
    expect(result.targetHost).toBe('list.example.com');
  });
});
