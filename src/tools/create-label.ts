import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { withBridgeConnection } from '../bridge/client.js';
import { createLabel } from '../mutations/create-label.js';

export const inputSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .describe('Flat logical label name; do not supply Labels/ or another mailbox path.'),
  dryRun: z.boolean().default(true).describe('Preview only by default; never creates a label.'),
});

export function registerCreateLabelTool(server: McpServer): void {
  server.registerTool(
    'mail_create_label',
    {
      title: 'Create a mail label',
      description:
        'Creates one flat custom label under the Proton Bridge Labels/ namespace. The input is a logical ' +
        'name, not a path. Checks for same-named folders and labels before CREATE. Defaults to dryRun=true. ' +
        'Creating a label does not apply it to any message.',
      inputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const result = await withBridgeConnection((client) => createLabel(client, args));
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
