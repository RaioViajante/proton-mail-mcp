import { vi } from 'vitest';
import type { FetchMessageObject, ImapFlow, MailboxObject } from 'imapflow';

/**
 * A minimal fake of the slice of ImapFlow's API this project uses. Real
 * network/TLS behavior is intentionally out of scope for unit tests — see
 * README.md for how to exercise a live Bridge connection manually.
 */
export interface FakeImapClient {
  getMailboxLock: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
  fetchOne: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  mailbox: MailboxObject | false;
  lockReleased: boolean;
}

export function createFakeImapClient(options: {
  mailbox?: Partial<MailboxObject>;
  searchResult?: number[] | false;
  fetchResults?: FetchMessageObject[];
}): FakeImapClient {
  const mailbox: MailboxObject = {
    path: 'INBOX',
    delimiter: '/',
    flags: new Set(),
    uidValidity: 1n,
    uidNext: 1,
    exists: 0,
    ...options.mailbox,
  };

  const fake: FakeImapClient = {
    lockReleased: false,
    mailbox,
    getMailboxLock: vi.fn(() => ({
      path: mailbox.path,
      release: () => {
        fake.lockReleased = true;
      },
    })),
    search: vi.fn(() => options.searchResult ?? []),
    fetch: vi.fn(function* fetch() {
      for (const message of options.fetchResults ?? []) {
        yield message;
      }
    }),
    fetchOne: vi.fn(() => options.fetchResults?.[0] ?? false),
    list: vi.fn(() => []),
  };

  return fake;
}

export function asImapFlow(fake: FakeImapClient): ImapFlow {
  return fake as unknown as ImapFlow;
}
