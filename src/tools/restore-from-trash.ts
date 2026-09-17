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
      'Optional EXTRA label names to guarantee on the restored message, in addition to — never ' +
        'instead of — the labels it already carried in Trash, which are now preserved ' +
        'automatically (0.4.1). Each extra is validated to exist and rejected before any move if ' +
        'not (never created automatically); once applied, appears in labelsRestored alongside any ' +
        'auto-preserved labels.',
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
        'Moves explicit message UIDs out of Trash into an explicit destination folder, ' +
        "automatically preserving the message's preservable flags (\\Seen, \\Flagged) and label " +
        'membership across the move (0.4.1) — a Bridge mailbox transition may otherwise silently ' +
        'drop labels or flip \\Seen; this tool measures the pre-move state, re-measures it after, ' +
        'and repairs any divergence, but only for a destination identity confirmed without ' +
        'guessing. Defaults to dryRun=true; live execution requires confirm=true and ' +
        'acknowledgeRestoreFromTrash=true. labelsToRestore is for EXTRA labels only, in addition ' +
        'to — never instead of — automatic preservation; each extra is validated to exist and ' +
        'rejected before any move if not. The folder move and any repair are separate IMAP ' +
        'operations, never atomic: a repair failure never rolls back the move, and the result ' +
        'reports the outcome explicitly via moveRestored / labelsRestored / labelsFailed / ' +
        'flagsRestored / flagsFailed / requiresRefresh / partialSuccess. Only explicit UIDs you ' +
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
