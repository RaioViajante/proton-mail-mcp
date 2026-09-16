import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { withBridgeConnection } from '../bridge/client.js';
import { createFolder } from '../mutations/folders.js';

export const inputSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe('New folder\'s logical name (no "/"; not a reserved name like Inbox or Spam).'),
  parent: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Optional logical name of an existing custom folder to nest under (e.g. "Projects" — not a raw ' +
        'path). Every custom folder is created under the Bridge Folders/ namespace automatically; ' +
        '"MCP Test" becomes "Folders/MCP Test", and parent "Projects" + name "GitHub" becomes ' +
        '"Folders/Projects/GitHub".',
    ),
  dryRun: z
    .boolean()
    .default(true)
    .describe(
      'When true (default), resolves and previews the folder path without creating anything.',
    ),
});

export function registerCreateFolderTool(server: McpServer): void {
  server.registerTool(
    'mail_create_folder',
    {
      title: 'Create a mail folder',
      description:
        'Creates a new custom folder, optionally nested under an existing custom folder. Every custom ' +
        'folder is created under the Bridge Folders/ namespace automatically (confirmed live: Proton ' +
        'Mail Bridge rejects folder creation at the true IMAP root) — you never need to know or supply ' +
        'that prefix yourself. Also checks locally, before ever contacting Bridge, whether the name is ' +
        'already used by a label — Proton folders and labels share one name per account (confirmed ' +
        'live: a same-named label makes folder creation fail with HTTP 409); a collision is reported as ' +
        '{ alreadyExists: true, conflictType, conflictingPath } and nothing is sent to Bridge. Defaults ' +
        'to dryRun=true. Rejects empty or reserved names, and refuses to create inside ' +
        'Spam/Trash/Archive/Sent/Drafts/All Mail or under Labels. Renaming and deleting folders are not ' +
        'implemented in V2.',
      inputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const result = await withBridgeConnection((client) => createFolder(client, args));
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
