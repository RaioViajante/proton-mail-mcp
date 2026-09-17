import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getReceiptSigningSecretOrUndefined } from '../bridge/config.js';
import { withBridgeConnection } from '../bridge/client.js';
import { MAX_MUTATION_UIDS } from '../mutations/batch.js';
import { trashMessages } from '../mutations/trash.js';

export const inputSchema = z.object({
  sourceFolder: z
    .string()
    .min(1)
    .describe(
      'Source folder path, e.g. "INBOX". Must not already be Trash, and must not be a ' +
        'Labels/... reference (a label is a view of a message, not its physical location).',
    ),
  uids: z
    .array(z.number().int().positive())
    .min(1)
    .max(MAX_MUTATION_UIDS)
    .describe(`Explicit message UIDs to move to Trash (1-${MAX_MUTATION_UIDS}).`),
  dryRun: z
    .boolean()
    .default(true)
    .describe('When true (default), resolves and previews the move without moving anything.'),
  confirm: z.boolean().default(false).describe('Must be true when dryRun=false.'),
  acknowledgeTrashMove: z
    .boolean()
    .default(false)
    .describe(
      "Must be true when dryRun=false: Proton may remove some or all of a moved message's labels " +
        "as a consequence of entering Trash — see the result's labelImpacts.",
    ),
});

export function registerTrashTool(server: McpServer): void {
  server.registerTool(
    'mail_trash',
    {
      title: 'Move mail to Trash',
      description:
        'Moves explicit message UIDs from a folder to Trash. sourceFolder must not already be ' +
        'Trash and must not be a Labels/... reference (rejected — a label is a view of a message, ' +
        'not its physical location). Defaults to dryRun=true; live execution requires ' +
        'confirm=true and acknowledgeTrashMove=true. Recoverable via mail_restore_from_trash. ' +
        "Proton may remove some or all of a message's labels, or change its flags (\\Seen, " +
        '\\Flagged), when it enters Trash — this tool measures that rather than assuming it, and ' +
        "never reapplies/repairs anything itself; see the result's labelImpacts (originalLabels, " +
        'labelsAfterTrash, labelsRemovedByTrash) and flagImpacts (originalFlags, flagsAfterTrash, ' +
        'flagsRemovedByTrash, flagsAddedByTrash) per UID. Only explicit UIDs you provide are ' +
        'affected — never a search or "everything in this folder". UIDs are mailbox-local and may ' +
        'change after this move; check the result\'s "transitions" for the resultingUid (or ' +
        'requiresRefresh) in Trash — a connection drop after the move command is sent is never ' +
        'assumed to be a clean failure or success, only confirmed read-only. When a restore-receipt ' +
        'signing secret is provisioned (scripts/configure-receipt-signing.sh, 0.4.2), a live, ' +
        'identity-confirmed move also returns "restoreReceipts": a signed, pre-Trash snapshot per ' +
        'UID to hand back to mail_restore_from_trash later, for a stronger preservation guarantee ' +
        "than Trash's own (possibly already-decayed) state can offer by then.",
      inputSchema,
      annotations: {
        readOnlyHint: false,
        // Recoverable via mail_restore_from_trash, but still a real mailbox
        // state change with an observed label-loss side effect — hint only,
        // not a security control (see mail_mark_spam for the same pattern).
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const signingSecret = await getReceiptSigningSecretOrUndefined();
      const result = await withBridgeConnection((client) =>
        trashMessages(client, { ...args, signingSecret }),
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
