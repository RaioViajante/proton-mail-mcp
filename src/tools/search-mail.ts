import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { withBridgeConnection } from '../bridge/client.js';
import { searchMail } from '../mail/search.js';

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

const dateString = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: 'must be a valid date string' })
  .describe('Date, e.g. "2026-01-31" or an ISO 8601 timestamp.');

export const inputSchema = z.object({
  folder: z.string().min(1).describe('Folder path as returned by mail_list_folders, e.g. "INBOX".'),
  from: z.string().min(1).optional().describe('Matches the From address field.'),
  to: z.string().min(1).optional().describe('Matches the To address field.'),
  subject: z.string().min(1).optional().describe('Matches the Subject field.'),
  text: z
    .string()
    .min(1)
    .optional()
    .describe('Matches any text in headers and body, if the server supports it.'),
  since: dateString.optional().describe('Only messages received on or after this date.'),
  before: dateString.optional().describe('Only messages received before this date.'),
  unreadOnly: z.boolean().default(false).describe('If true, only match unread messages.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .default(DEFAULT_LIMIT)
    .describe(`Maximum number of results to return (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`),
});

export function registerSearchMailTool(server: McpServer): void {
  server.registerTool(
    'mail_search',
    {
      title: 'Search mail',
      description:
        'Searches one folder with structured criteria and returns summarized results, not full bodies. ' +
        'Read-only; never marks messages as read.',
      inputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const messages = await withBridgeConnection((client) => searchMail(client, args));
      return { content: [{ type: 'text', text: JSON.stringify({ messages }, null, 2) }] };
    },
  );
}
