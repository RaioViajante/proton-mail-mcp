import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { withBridgeConnection } from '../bridge/client.js';
import { MAX_PERMANENT_DELETE_UIDS } from '../mutations/batch.js';
import {
  deletePermanently,
  PERMANENT_DELETE_CONFIRMATION_PHRASE,
} from '../mutations/permanent-delete.js';

export const inputSchema = z.object({
  sourceFolder: z
    .string()
    .min(1)
    .describe("Must be exactly the account's Trash folder — no other source is accepted."),
  uids: z
    .array(z.number().int().positive())
    .min(1)
    .max(MAX_PERMANENT_DELETE_UIDS)
    .describe(
      `Explicit message UIDs in Trash to permanently delete (1-${MAX_PERMANENT_DELETE_UIDS}). ` +
        'Irreversible once live execution is enabled in a future version.',
    ),
  dryRun: z
    .boolean()
    .default(true)
    .describe(
      'When true (default), resolves and previews which UIDs exist in Trash without deleting ' +
        'anything. Live execution (dryRun=false) is unconditionally disabled (introduced 0.4.0, ' +
        'unchanged as of 0.4.2) — see the tool description.',
    ),
  confirm: z.boolean().default(false).describe('Must be true when dryRun=false.'),
  acknowledgePermanentDeletion: z
    .boolean()
    .default(false)
    .describe('Must be true when dryRun=false: permanent deletion is irreversible.'),
  confirmationPhrase: z
    .string()
    .default('')
    .describe(`Must be exactly "${PERMANENT_DELETE_CONFIRMATION_PHRASE}" when dryRun=false.`),
});

export function registerDeletePermanentlyTool(server: McpServer): void {
  server.registerTool(
    'mail_delete_permanently',
    {
      title: 'Permanently delete mail (live-disabled)',
      description:
        'Permanently deletes explicit message UIDs from Trash — irreversible, and the most ' +
        'dangerous operation in this project. Defaults to dryRun=true, which only resolves and ' +
        'previews which UIDs currently exist in Trash; zero IMAP mutating commands run in a ' +
        "dry-run. sourceFolder must be exactly the account's Trash folder. Live execution " +
        '(dryRun=false) requires confirm=true, acknowledgePermanentDeletion=true, AND ' +
        `confirmationPhrase exactly "${PERMANENT_DELETE_CONFIRMATION_PHRASE}" — but even with every ` +
        'confirmation correct, live execution is UNCONDITIONALLY DISABLED by a hard feature gate ' +
        '(introduced 0.4.0, unchanged as of 0.4.2): the call returns blocked: true, blockReason: ' +
        '"livePermanentDeleteDisabled", ' +
        'before any IMAP mutating command is issued. This is a deliberate, documented limitation, ' +
        'not a bug — live permanent deletion ships in a separate, explicitly authorized version ' +
        'after dedicated destructive-action validation. See SECURITY.md.',
      inputSchema,
      annotations: {
        readOnlyHint: false,
        // Irreversible once live execution is enabled — hint only, not a
        // security control; the actual protection is the feature gate plus
        // the confirm/acknowledge/phrase gate above it.
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const result = await withBridgeConnection((client) => deletePermanently(client, args));
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
