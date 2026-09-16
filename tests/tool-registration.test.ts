import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { registerGetMessageTool } from '../src/tools/get-message.js';
import { registerListFoldersTool } from '../src/tools/list-folders.js';
import { registerListMessagesTool } from '../src/tools/list-messages.js';
import { registerSearchMailTool } from '../src/tools/search-mail.js';

interface CapturedRegistration {
  name: string;
  config: { annotations?: Record<string, unknown> };
}

function captureRegistrations(register: (server: McpServer) => void): CapturedRegistration[] {
  const calls: CapturedRegistration[] = [];
  const fakeServer = {
    registerTool: vi.fn((name: string, config: Record<string, unknown>) => {
      calls.push({ name, config });
    }),
  };
  register(fakeServer as unknown as McpServer);
  return calls;
}

// This is the full V1 tool surface. If you are adding a fifth tool, also
// update README.md's "V1 read-only limitations" section and confirm it is
// not a mutating operation (see the test below).
const registrars = [
  registerListFoldersTool,
  registerListMessagesTool,
  registerSearchMailTool,
  registerGetMessageTool,
];

describe('V1 tool registration', () => {
  it('registers exactly one tool per registrar, matching the documented V1 tool names', () => {
    const names = registrars.flatMap((register) =>
      captureRegistrations(register).map((call) => call.name),
    );
    expect(names.sort()).toEqual([
      'mail_get_message',
      'mail_list_folders',
      'mail_list_messages',
      'mail_search',
    ]);
  });

  it('marks every registered tool as read-only and non-destructive', () => {
    for (const register of registrars) {
      const [registration] = captureRegistrations(register);
      expect(registration?.config.annotations?.readOnlyHint).toBe(true);
      expect(registration?.config.annotations?.destructiveHint).toBe(false);
    }
  });

  it('registers no tool whose name suggests a mutating operation', () => {
    const mutatingNamePattern = /(mark|delete|move|archive|create|rename|send|reply|smtp)/i;
    for (const register of registrars) {
      const [registration] = captureRegistrations(register);
      expect(registration?.name).not.toMatch(mutatingNamePattern);
    }
  });
});
