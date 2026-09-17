import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getReceiptSigningSecretOrUndefined } from '../bridge/config.js';
import { withBridgeConnection } from '../bridge/client.js';
import { MAX_MUTATION_UIDS } from '../mutations/batch.js';
import { restoreFromTrash } from '../mutations/restore.js';

export const inputSchema = z
  .object({
    uids: z
      .array(z.number().int().positive())
      .min(1)
      .max(MAX_MUTATION_UIDS)
      .describe(`Explicit message UIDs in Trash to restore (1-${MAX_MUTATION_UIDS}).`),
    destinationFolder: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Destination: a system folder path (e.g. "INBOX", "Archive") or a custom folder — bare ' +
          'logical name or the exact path from mail_list_folders — resolved the same way as ' +
          'mail_move. Must not be Trash, Spam, Sent, Drafts, All Mail, a namespace container, or a ' +
          'Labels/... reference (Spam has its own dedicated, separately-gated tool). Required unless ' +
          'restoreToOriginalSource is true, in which case it must be omitted.',
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
    restoreReceipts: z
      .array(
        z.object({
          uid: z.number().int().positive(),
          receipt: z
            .unknown()
            .describe(
              'Pass back exactly the restoreReceipt object mail_trash returned for this UID — never modified.',
            ),
        }),
      )
      .optional()
      .describe(
        'Signed receipts (0.4.2) from mail_trash\'s "restoreReceipts", one entry per UID you want ' +
          'restored with the strong preservation guarantee. Each is fully verified (structure, HMAC ' +
          'signature, and a keyed Message-ID identity match against the live Trash message) before ' +
          "being trusted; a UID with no matching entry falls back to measuring Trash's current state " +
          '(0.4.1 behavior — see preservationSource: "trashSnapshot" on the result); a UID whose ' +
          'receipt fails validation fails closed (preservationSource: "unavailable" — see ' +
          'receiptRejections) rather than silently degrading to the weaker fallback.',
      ),
    restoreToOriginalSource: z
      .boolean()
      .optional()
      .describe(
        'When true, destinationFolder must be omitted and the message is restored to the ' +
          'sourceFolder recorded in its own verified restoreReceipt instead. Only supported for a ' +
          'single UID per call (documented scope limitation).',
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
  })
  .refine(
    (value) => value.restoreToOriginalSource === true || value.destinationFolder !== undefined,
    {
      message: 'destinationFolder is required unless restoreToOriginalSource is true.',
      path: ['destinationFolder'],
    },
  );

export function registerRestoreFromTrashTool(server: McpServer): void {
  server.registerTool(
    'mail_restore_from_trash',
    {
      title: 'Restore mail from Trash',
      description:
        'Moves explicit message UIDs out of Trash into an explicit destination folder, ' +
        "automatically preserving the message's preservable flags (\\Seen, \\Flagged) and label " +
        'membership across the move — a Bridge mailbox transition may otherwise silently drop ' +
        'labels or flip \\Seen; this tool measures the pre-move state, re-measures it after, and ' +
        'repairs any divergence, but only for a destination identity confirmed without guessing. ' +
        'As of 0.4.2, pass back restoreReceipts (from mail_trash) for the strong version of this ' +
        'guarantee: Trash itself is not authoritative for "original state" — Proton Bridge can drop ' +
        "labels asynchronously, after mail_trash's own immediate check already reported them intact " +
        '— so a UID with no matching receipt falls back to measuring whatever Trash shows right now ' +
        '(preservationSource: "trashSnapshot", statePreserved never true), and a UID whose supplied ' +
        'receipt fails verification fails closed (preservationSource: "unavailable" — see ' +
        'receiptRejections) rather than silently using the weaker fallback. Defaults to dryRun=true; ' +
        'live execution requires confirm=true and acknowledgeRestoreFromTrash=true. labelsToRestore ' +
        'is for EXTRA labels only, in addition to — never instead of — automatic preservation; each ' +
        'extra is validated to exist and rejected before any move if not. The folder move and any ' +
        'repair are separate IMAP operations, never atomic: a repair failure never rolls back the ' +
        'move, and the result reports the outcome explicitly via moveRestored / preservationSource / ' +
        'statePreserved / labelsRestored / labelsFailed / flagsRestored / flagsFailed / ' +
        'requiresRefresh / partialSuccess. Only explicit UIDs you provide are affected.',
      inputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const signingSecret = await getReceiptSigningSecretOrUndefined();
      const result = await withBridgeConnection((client) =>
        restoreFromTrash(client, { ...args, signingSecret }),
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
