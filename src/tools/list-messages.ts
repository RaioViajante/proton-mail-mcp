import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { withBridgeConnection } from '../bridge/client.js';
import { listMessages } from '../mail/messages.js';

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

export const inputSchema = z.object({
  folder: z.string().min(1).describe('Folder path as returned by mail_list_folders, e.g. "INBOX".'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .default(DEFAULT_LIMIT)
    .describe(`Maximum number of messages to return (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`),
  unreadOnly: z.boolean().default(false).describe('If true, only return unread messages.'),
});

export function registerListMessagesTool(server: McpServer): void {
  server.registerTool(
    'mail_list_messages',
    {
      title: 'List mail messages',
      description:
        'Lists message metadata (no bodies) for a folder, most recent first. Read-only; never marks ' +
        'messages as read and never fetches the whole mailbox.',
      inputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const messages = await withBridgeConnection((client) =>
        listMessages(client, {
          folder: args.folder,
          limit: args.limit,
          unreadOnly: args.unreadOnly,
        }),
      );
      return { content: [{ type: 'text', text: JSON.stringify({ messages }, null, 2) }] };
    },
  );
}
