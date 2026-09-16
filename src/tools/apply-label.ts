import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { withBridgeConnection } from '../bridge/client.js';
import { MAX_MUTATION_UIDS } from '../mutations/batch.js';
import { applyLabel } from '../mutations/labels.js';

export const inputSchema = z.object({
  folder: z.string().min(1).describe('Folder path where the messages currently are, e.g. "INBOX".'),
  label: z
    .string()
    .min(1)
    .describe(
      'Label name (must already exist in Proton Mail, exposed by Bridge as "Labels/<label>").',
    ),
  uids: z
    .array(z.number().int().positive())
    .min(1)
    .max(MAX_MUTATION_UIDS)
    .describe(`Explicit message UIDs to label (1-${MAX_MUTATION_UIDS}).`),
  dryRun: z
    .boolean()
    .default(true)
    .describe('When true (default), resolves and previews the change without applying anything.'),
});

export function registerApplyLabelTool(server: McpServer): void {
  server.registerTool(
    'mail_apply_label',
    {
      title: 'Apply a mail label',
      description:
        'Applies an existing Proton label to explicit message UIDs. The label must already exist in ' +
        'Proton Mail. Defaults to dryRun=true. Messages already carrying the label are reported as ' +
        'skipped, not re-applied. Only explicit UIDs you provide are affected. Confirmed live: unlike ' +
        'other mutation tools, the UID you passed in stays valid in "folder" afterward — the result\'s ' +
        'optional "transitions" only reports the message\'s separate, informational UID inside the ' +
        'label mailbox, which you do not need unless you plan to call mail_remove_label next.',
      inputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const result = await withBridgeConnection((client) => applyLabel(client, args));
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
