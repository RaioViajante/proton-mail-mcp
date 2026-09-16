import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { withBridgeConnection } from '../bridge/client.js';
import { MAX_MUTATION_UIDS } from '../mutations/batch.js';
import { moveMessages } from '../mutations/move.js';

export const inputSchema = z.object({
  sourceFolder: z.string().min(1).describe('Source folder path, e.g. "INBOX".'),
  destinationFolder: z
    .string()
    .min(1)
    .describe(
      'Destination: a system folder path (e.g. "Archive") or a custom folder — either its bare logical ' +
        'name (e.g. "MCP Test") or the exact path from mail_list_folders (e.g. "Folders/MCP Test"); a ' +
        'custom folder name is always resolved under the Bridge Folders/ namespace automatically. Must ' +
        'exist, must differ from sourceFolder, and must not be Trash, Spam, Sent, Drafts, or All Mail ' +
        '(use mail_mark_spam for Spam).',
    ),
  uids: z
    .array(z.number().int().positive())
    .min(1)
    .max(MAX_MUTATION_UIDS)
    .describe(`Explicit message UIDs to move (1-${MAX_MUTATION_UIDS}).`),
  dryRun: z
    .boolean()
    .default(true)
    .describe('When true (default), resolves and previews the move without moving anything.'),
});

export function registerMoveTool(server: McpServer): void {
  server.registerTool(
    'mail_move',
    {
      title: 'Move mail',
      description:
        'Moves explicit message UIDs from one folder to another (not Archive/Spam — use mail_archive / ' +
        'mail_mark_spam for those). Defaults to dryRun=true. Refuses protected destinations: Trash, ' +
        'Spam, Sent, Drafts, All Mail. Only explicit UIDs you provide are affected — never a search or ' +
        '"everything in this folder". UIDs are mailbox-local and may change after moves, archives, or ' +
        'label removal — check the result\'s "transitions" for the resultingUid (or requiresRefresh) ' +
        'in the destination; do not keep reusing the old UID.',
      inputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const result = await withBridgeConnection((client) => moveMessages(client, args));
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
