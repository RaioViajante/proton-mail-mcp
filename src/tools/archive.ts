import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { withBridgeConnection } from '../bridge/client.js';
import { MAX_MUTATION_UIDS } from '../mutations/batch.js';
import { archiveMessages } from '../mutations/archive.js';

export const inputSchema = z.object({
  folder: z
    .string()
    .min(1)
    .describe('Source folder path, e.g. "INBOX". Must not already be Archive.'),
  uids: z
    .array(z.number().int().positive())
    .min(1)
    .max(MAX_MUTATION_UIDS)
    .describe(`Explicit message UIDs to archive (1-${MAX_MUTATION_UIDS}).`),
  dryRun: z
    .boolean()
    .default(true)
    .describe('When true (default), resolves and previews the move without archiving anything.'),
});

export function registerArchiveTool(server: McpServer): void {
  server.registerTool(
    'mail_archive',
    {
      title: 'Archive mail',
      description:
        "Moves explicit message UIDs from a folder to the account's Archive folder. Defaults to " +
        'dryRun=true. Refuses to run when the source folder is already Archive. Only explicit UIDs you ' +
        'provide are affected — never a search or "everything in this folder". UIDs are mailbox-local ' +
        'and may change after moves, archives, or label removal — check the result\'s "transitions" ' +
        'for the resultingUid (or requiresRefresh) in Archive; do not keep reusing the old UID.',
      inputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const result = await withBridgeConnection((client) => archiveMessages(client, args));
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
