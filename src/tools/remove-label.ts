import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { withBridgeConnection } from '../bridge/client.js';
import { MAX_MUTATION_UIDS } from '../mutations/batch.js';
import { removeLabel } from '../mutations/labels.js';

export const inputSchema = z.object({
  folder: z.string().min(1).describe('Folder path where the messages currently are, e.g. "INBOX".'),
  label: z.string().min(1).describe('Label name (as exposed by Bridge under "Labels/<label>").'),
  uids: z
    .array(z.number().int().positive())
    .min(1)
    .max(MAX_MUTATION_UIDS)
    .describe(`Explicit message UIDs to unlabel (1-${MAX_MUTATION_UIDS}).`),
  dryRun: z
    .boolean()
    .default(true)
    .describe('When true (default), resolves and previews the change without removing anything.'),
});

export function registerRemoveLabelTool(server: McpServer): void {
  server.registerTool(
    'mail_remove_label',
    {
      title: 'Remove a mail label',
      description:
        'Removes an existing Proton label from explicit message UIDs. Defaults to dryRun=true. ' +
        'Messages that do not currently carry the label are reported as skipped. Only explicit UIDs ' +
        'you provide are affected. IMPORTANT — confirmed live: the UID you passed in is NOT guaranteed ' +
        'to remain valid in "folder" afterward (observed: INBOX UID 705 became UID 706 after removing ' +
        'its label — same message, no data loss, just a new mailbox-local UID). Always use the ' +
        'result\'s "transitions" (resultingUid, or requiresRefresh if it could not be determined) — ' +
        'never keep using the old requested UID for a follow-up mutation.',
      inputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const result = await withBridgeConnection((client) => removeLabel(client, args));
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
