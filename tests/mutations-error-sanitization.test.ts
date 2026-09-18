import { describe, expect, it } from 'vitest';
import { createLabel } from '../src/mutations/create-label.js';
import { createFolder } from '../src/mutations/folders.js';
import { applyLabel } from '../src/mutations/labels.js';
import { moveMessages } from '../src/mutations/move.js';
import { markRead } from '../src/mutations/read-state.js';
import type { MutationResult } from '../src/mutations/result.js';
import { asImapFlow, createFakeImapClient, fakeFolder } from './fakes/imap-client.js';

const hostileError =
  'A12 NO fake@example.test <fake-id@example.test> /tmp/private-fixture ' + 'fake-credential-token';
const forbiddenParts = [
  'fake@example.test',
  '<fake-id@example.test>',
  '/tmp/private-fixture',
  'fake-credential-token',
  'A12 NO',
];

function expectSanitized(result: MutationResult): void {
  expect(result.errors).toEqual([{ uid: 10, message: 'Mailbox operation failed.' }]);
  const output = JSON.stringify(result);
  for (const part of forbiddenParts) expect(output).not.toContain(part);
}

const folders = [
  fakeFolder({ path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' }),
  fakeFolder({ path: 'Folders', name: 'Folders', flags: new Set(['\\Noselect']) }),
  fakeFolder({ path: 'Folders/Projects', name: 'Projects', parentPath: 'Folders' }),
  fakeFolder({ path: 'Labels', name: 'Labels', flags: new Set(['\\Noselect']) }),
  fakeFolder({ path: 'Labels/Work', name: 'Work' }),
];

describe('MCP-facing mutation errors', () => {
  it('does not return a raw IMAP exception from move', async () => {
    const fake = createFakeImapClient({
      folders,
      fetchResults: [{ seq: 10, uid: 10 }],
    });
    fake.messageMove.mockRejectedValueOnce(new Error(hostileError));
    const result = await moveMessages(asImapFlow(fake), {
      sourceFolder: 'INBOX',
      destinationFolder: 'Projects',
      uids: [10],
      dryRun: false,
    });
    expectSanitized(result);
  });

  it('does not return a raw IMAP exception from flag changes', async () => {
    const fake = createFakeImapClient({
      folders,
      fetchResults: [{ seq: 10, uid: 10, flags: new Set() }],
    });
    fake.messageFlagsAdd.mockRejectedValueOnce(new Error(hostileError));
    const result = await markRead(asImapFlow(fake), { folder: 'INBOX', uids: [10], dryRun: false });
    expectSanitized(result);
  });

  it('does not return a raw IMAP exception from label changes', async () => {
    const fake = createFakeImapClient({
      folders,
      mailboxes: {
        INBOX: {
          fetchResults: [{ seq: 10, uid: 10, envelope: { messageId: '<a@example.test>' } }],
        },
        'Labels/Work': { searchResult: [] },
      },
    });
    fake.messageMove.mockRejectedValueOnce(new Error(hostileError));
    const result = await applyLabel(asImapFlow(fake), {
      folder: 'INBOX',
      label: 'Work',
      uids: [10],
      dryRun: false,
    });
    expectSanitized(result);
  });

  it('does not throw raw IMAP exceptions from folder or label creation', async () => {
    const folderClient = createFakeImapClient({ folders });
    folderClient.mailboxCreate.mockRejectedValueOnce(new Error(hostileError));
    await expect(
      createFolder(asImapFlow(folderClient), { name: 'New Folder', dryRun: false }),
    ).rejects.toThrow('Mailbox operation failed.');

    const labelClient = createFakeImapClient({ folders });
    labelClient.mailboxCreate.mockRejectedValueOnce(new Error(hostileError));
    await expect(
      createLabel(asImapFlow(labelClient), { name: 'New Label', dryRun: false }),
    ).rejects.toThrow('Mailbox operation failed.');
  });
});
