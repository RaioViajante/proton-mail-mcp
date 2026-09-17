import { vi } from 'vitest';
import type { FetchMessageObject, ImapFlow, ListResponse, MailboxObject } from 'imapflow';

/**
 * A minimal fake of the slice of ImapFlow's API this project uses. Real
 * network/TLS behavior is intentionally out of scope for unit tests — see
 * README.md for how to exercise a live Bridge connection manually.
 */
export interface LockCall {
  path: string;
  readOnly: boolean | undefined;
}

export interface FakeImapClient {
  getMailboxLock: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
  fetchOne: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  messageFlagsAdd: ReturnType<typeof vi.fn>;
  messageFlagsRemove: ReturnType<typeof vi.fn>;
  messageMove: ReturnType<typeof vi.fn>;
  messageCopy: ReturnType<typeof vi.fn>;
  messageDelete: ReturnType<typeof vi.fn>;
  mailboxCreate: ReturnType<typeof vi.fn>;
  mailbox: MailboxObject | false;
  /** Active IMAP capabilities, mirroring ImapFlow's own `capabilities` map (e.g. `UIDPLUS`). */
  capabilities: Map<string, boolean | number>;
  lockReleased: boolean;
  /** Every getMailboxLock call, in order — the primary tool for proving what a dry-run did or didn't open. */
  lockCalls: LockCall[];
}

export interface MailboxFixture {
  searchResult?: number[] | false | undefined;
  fetchResults?: FetchMessageObject[] | undefined;
  /**
   * For race/stale-state tests: if set, successive fetch() calls while this
   * path is the currently open mailbox consume entries in order (the last
   * entry repeats once exhausted), instead of always returning
   * `fetchResults`. This is what lets a test simulate "the UID was there
   * during read-only validation but gone by the time the write lock was
   * acquired" — e.g. `fetchSequence: [[msg10], []]`.
   */
  fetchSequence?: FetchMessageObject[][] | undefined;
  /** Same idea as {@link fetchSequence}, but for successive search() calls while this path is open. */
  searchSequence?: (number[] | false)[] | undefined;
}

export interface FakeImapClientOptions {
  /** Legacy/default mailbox metadata, set once (used by V1 single-mailbox tests). */
  mailbox?: Partial<MailboxObject>;
  /** Legacy/default fetch()/fetchOne() results, used when no per-path override matches. */
  fetchResults?: FetchMessageObject[];
  /** Legacy/default search() result, used when no per-path override matches. */
  searchResult?: number[] | false;
  /** list() result — the folder listing mutation policy resolves special folders from. */
  folders?: ListResponse[];
  /** Per-mailbox-path fetch/search fixtures, for tests that open more than one mailbox (e.g. labels). */
  mailboxes?: Record<string, MailboxFixture>;
  /** messageFlagsAdd/messageFlagsRemove return value. Default true. */
  flagsOk?: boolean;
  /** messageMove return value. Default a truthy stub object; pass false to simulate server rejection. */
  moveResult?: unknown;
  /** messageCopy return value. Default a truthy stub object. */
  copyResult?: unknown;
  /** messageDelete return value. Default true. */
  deleteResult?: boolean;
  /** mailboxCreate return value. */
  mailboxCreateResult?: { path: string; created: boolean };
  /** capabilities map, e.g. `new Map([['UIDPLUS', true]])`. Default empty (no capabilities). */
  capabilities?: Map<string, boolean | number>;
}

export function createFakeImapClient(options: FakeImapClientOptions = {}): FakeImapClient {
  const mailbox: MailboxObject = {
    path: 'INBOX',
    delimiter: '/',
    flags: new Set(),
    uidValidity: 1n,
    uidNext: 1,
    exists: 0,
    ...options.mailbox,
  };

  let currentPath: string | undefined;
  const fetchCallCounts = new Map<string, number>();
  const searchCallCounts = new Map<string, number>();

  function fixtureFor(path: string | undefined): MailboxFixture {
    if (path && options.mailboxes?.[path]) {
      return options.mailboxes[path];
    }
    return { searchResult: options.searchResult, fetchResults: options.fetchResults };
  }

  function fetchResultsFor(path: string | undefined): FetchMessageObject[] {
    const fixture = fixtureFor(path);
    if (!fixture.fetchSequence) {
      return fixture.fetchResults ?? [];
    }
    const key = path ?? '';
    const callIndex = fetchCallCounts.get(key) ?? 0;
    fetchCallCounts.set(key, callIndex + 1);
    const clampedIndex = Math.min(callIndex, fixture.fetchSequence.length - 1);
    return fixture.fetchSequence[clampedIndex] ?? [];
  }

  function searchResultFor(path: string | undefined): number[] | false {
    const fixture = fixtureFor(path);
    if (!fixture.searchSequence) {
      return fixture.searchResult ?? [];
    }
    const key = path ?? '';
    const callIndex = searchCallCounts.get(key) ?? 0;
    searchCallCounts.set(key, callIndex + 1);
    const clampedIndex = Math.min(callIndex, fixture.searchSequence.length - 1);
    return fixture.searchSequence[clampedIndex] ?? [];
  }

  const fake: FakeImapClient = {
    lockReleased: false,
    lockCalls: [],
    mailbox,
    capabilities: options.capabilities ?? new Map<string, boolean | number>(),
    getMailboxLock: vi.fn((path: string, lockOptions?: { readOnly?: boolean }) => {
      currentPath = path;
      fake.lockCalls.push({ path, readOnly: lockOptions?.readOnly });
      return {
        path,
        release: () => {
          fake.lockReleased = true;
        },
      };
    }),
    search: vi.fn(() => searchResultFor(currentPath)),
    fetch: vi.fn(function* fetch() {
      for (const message of fetchResultsFor(currentPath)) {
        yield message;
      }
    }),
    fetchOne: vi.fn(
      (uid: number) => fetchResultsFor(currentPath).find((message) => message.uid === uid) ?? false,
    ),
    list: vi.fn(() => options.folders ?? []),
    messageFlagsAdd: vi.fn(() => options.flagsOk ?? true),
    messageFlagsRemove: vi.fn(() => options.flagsOk ?? true),
    messageMove: vi.fn(
      () => options.moveResult ?? { path: 'source', destination: 'destination', uidMap: new Map() },
    ),
    messageCopy: vi.fn(
      () => options.copyResult ?? { path: 'source', destination: 'destination', uidMap: new Map() },
    ),
    messageDelete: vi.fn(() => options.deleteResult ?? true),
    mailboxCreate: vi.fn(() => options.mailboxCreateResult ?? { path: 'New', created: true }),
  };

  return fake;
}

export function asImapFlow(fake: FakeImapClient): ImapFlow {
  return fake as unknown as ImapFlow;
}

export function fakeFolder(overrides: Partial<ListResponse> & { path: string }): ListResponse {
  return {
    path: overrides.path,
    pathAsListed: overrides.path,
    name: overrides.name ?? overrides.path.split('/').pop() ?? overrides.path,
    delimiter: overrides.delimiter ?? '/',
    parent: overrides.parent ?? [],
    parentPath: overrides.parentPath ?? '',
    flags: overrides.flags ?? new Set(),
    listed: overrides.listed ?? true,
    subscribed: overrides.subscribed ?? true,
    ...(overrides.specialUse ? { specialUse: overrides.specialUse } : {}),
  };
}
