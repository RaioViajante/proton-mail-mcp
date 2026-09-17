import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { withBridgeConnection } from '../bridge/client.js';
import { MAX_MUTATION_UIDS } from '../mutations/batch.js';
import { restoreFromTrash } from '../mutations/restore.js';

export const inputSchema = z.object({
  uids: z
    .array(z.number().int().positive())
    .min(1)
    .max(MAX_MUTATION_UIDS)
    .describe(`Explicit message UIDs in Trash to restore (1-${MAX_MUTATION_UIDS}).`),
  destinationFolder: z
    .string()
    .min(1)
    .describe(
      'Destination: a system folder path (e.g. "INBOX", "Archive") or a custom folder — bare ' +
        'logical name or the exact path from mail_list_folders — resolved the same way as ' +
        'mail_move. Must not be Trash, Spam, Sent, Drafts, All Mail, a namespace container, or a ' +
        'Labels/... reference (Spam has its own dedicated, separately-gated tool).',
    ),
  labelsToRestore: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Optional label names to reapply after restoring — Trash may have removed them. Labels are ' +
        'validated to exist and are never created automatically; a missing label or a label that ' +
        'fails to reapply is reported in labelsFailed without undoing the restore.',
    ),
  dryRun: z
    .boolean()
    .default(true)
    .describe('When true (default), resolves and previews the restore without moving anything.'),
  confirm: z.boolean().default(false).describe('Must be true when dryRun=false.'),
  acknowledgeRestoreFromTrash: z
    .boolean()
    .default(false)
    .describe('Must be true when dryRun=false.'),
});

export function registerRestoreFromTrashTool(server: McpServer): void {
  server.registerTool(
    'mail_restore_from_trash',
    {
      title: 'Restore mail from Trash',
      description:
        'Moves explicit message UIDs out of Trash into an explicit destination folder. Defaults ' +
        'to dryRun=true; live execution requires confirm=true and ' +
        'acknowledgeRestoreFromTrash=true. Optionally reapplies explicit, pre-existing labels via ' +
        'labelsToRestore — this is a separate IMAP operation from the folder move and is never ' +
        'treated as atomic with it: if the move succeeds but a label reapply fails, the move is ' +
        'never rolled back, and the result reports the partial outcome explicitly via ' +
        'moveRestored / labelsRestored / labelsFailed / requiresRefresh. Only explicit UIDs you ' +
        'provide are affected.',
      inputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const result = await withBridgeConnection((client) => restoreFromTrash(client, args));
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
