import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { withBridgeConnection } from '../bridge/client.js';
import { MAX_MUTATION_UIDS } from '../mutations/batch.js';
import { markAsSpam } from '../mutations/spam.js';

export const inputSchema = z.object({
  folder: z.string().min(1).describe('Source folder path, e.g. "INBOX". Must not already be Spam.'),
  uids: z
    .array(z.number().int().positive())
    .min(1)
    .max(MAX_MUTATION_UIDS)
    .describe(`Explicit message UIDs to move to Spam (1-${MAX_MUTATION_UIDS}).`),
  dryRun: z
    .boolean()
    .default(true)
    .describe('When true (default), resolves and previews the move without moving anything.'),
  confirm: z.boolean().default(false).describe('Must be true when dryRun=false.'),
  acknowledgeFutureFiltering: z
    .boolean()
    .default(false)
    .describe(
      'Must be true when dryRun=false: Proton may filter future messages from this sender to Spam.',
    ),
});

export function registerMarkSpamTool(server: McpServer): void {
  server.registerTool(
    'mail_mark_spam',
    {
      title: 'Mark mail as spam',
      description:
        'Moves explicit message UIDs from a folder to Spam. Defaults to dryRun=true; live execution ' +
        'requires confirm=true and acknowledgeFutureFiltering=true. Live testing confirmed that Proton ' +
        'also added the sender to its account-level Spam List after a Bridge MOVE, which may filter future ' +
        'messages. This tool only issues the message MOVE; it does not manage that list or implement ' +
        'Proton Block. Only explicit UIDs you provide are affected by the IMAP mutation.',
      inputSchema,
      annotations: {
        readOnlyHint: false,
        // Live testing confirmed a persistent Proton Spam List effect after
        // the Bridge MOVE. This hint is not a security control; the two
        // confirmation gates and dry-run default enforce the policy.
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const result = await withBridgeConnection((client) => markAsSpam(client, args));
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
