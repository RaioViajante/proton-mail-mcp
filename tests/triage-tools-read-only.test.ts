import type { ImapFlow } from 'imapflow';
import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { registerTriageIntelligenceTools } from '../src/tools/triage-intelligence.js';
import { asImapFlow, createFakeImapClient } from './fakes/imap-client.js';

const bridge = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('../src/bridge/client.js', () => ({ withBridgeConnection: bridge.connect }));

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;

describe('V2.5 tool callbacks', () => {
  it('all five execute only bounded read-only IMAP operations', async () => {
    const fake = createFakeImapClient({
      mailbox: { exists: 1 },
      fetchResults: [
        {
          seq: 1,
          uid: 1,
          envelope: { from: [{ address: 'test@example.com' }], subject: 'Test' },
          flags: new Set(),
        },
      ],
    });
    bridge.connect.mockImplementation(async (run: (client: ImapFlow) => Promise<unknown>) =>
      run(asImapFlow(fake)),
    );
    const handlers = new Map<string, Handler>();
    registerTriageIntelligenceTools({
      registerTool: vi.fn((name: string, _config: unknown, handler: Handler) =>
        handlers.set(name, handler),
      ),
    } as unknown as McpServer);

    expect(handlers.size).toBe(5);
    for (const handler of handlers.values()) {
      const result = await handler({
        folder: 'INBOX',
        maxMessages: 1,
        includeDomains: true,
        minMessages: 2,
      });
      expect(result.content[0]?.text).toContain('untrustedDataWarning');
    }
    expect(fake.lockCalls).toHaveLength(5);
    expect(fake.lockCalls.every((call) => call.readOnly === true)).toBe(true);
    for (const method of [
      fake.messageFlagsAdd,
      fake.messageFlagsRemove,
      fake.messageMove,
      fake.messageCopy,
      fake.mailboxCreate,
    ]) {
      expect(method).not.toHaveBeenCalled();
    }
    expect(fake.fetchOne).not.toHaveBeenCalled();
  });
});
