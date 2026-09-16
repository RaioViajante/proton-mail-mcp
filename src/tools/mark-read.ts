import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { withBridgeConnection } from '../bridge/client.js';
import { MAX_MUTATION_UIDS } from '../mutations/batch.js';
import { markRead } from '../mutations/read-state.js';

export const inputSchema = z.object({
  folder: z.string().min(1).describe('Folder path as returned by mail_list_folders, e.g. "INBOX".'),
  uids: z
    .array(z.number().int().positive())
    .min(1)
    .max(MAX_MUTATION_UIDS)
    .describe(`Explicit message UIDs to mark as read (1-${MAX_MUTATION_UIDS}).`),
  dryRun: z
    .boolean()
    .default(true)
    .describe(
      'When true (default), resolves and previews the change without marking anything as read.',
    ),
});

export function registerMarkReadTool(server: McpServer): void {
  server.registerTool(
    'mail_mark_read',
    {
      title: 'Mark mail as read',
      description:
        'Marks explicit message UIDs in a folder as read (\\Seen). Defaults to dryRun=true, which ' +
        'resolves everything and previews the change without marking anything. Only explicit UIDs you ' +
        'provide are affected — never a search or "everything in this folder".',
      inputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const result = await withBridgeConnection((client) => markRead(client, args));
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
