import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { withBridgeConnection } from '../bridge/client.js';
import { previewUnsubscribe } from '../unsubscribe/preview.js';

export const inputSchema = z.object({
  folder: z.string().min(1).describe('Folder path as returned by mail_list_folders, e.g. "INBOX".'),
  uid: z
    .number()
    .int()
    .positive()
    .describe('Message UID, as returned by mail_list_messages or mail_search.'),
});

export function registerUnsubscribePreviewTool(server: McpServer): void {
  server.registerTool(
    'mail_unsubscribe_preview',
    {
      title: 'Preview mail unsubscribe eligibility',
      description:
        "Read-only. Examines one message's List-Unsubscribe / List-Unsubscribe-Post / " +
        'Authentication-Results headers and reports whether a safe, RFC 8058 HTTPS one-click ' +
        'unsubscribe mechanism is available and eligible for automatic execution by ' +
        'mail_unsubscribe. Makes zero network requests. Never returns the full unsubscribe URL, ' +
        'query string, token, or recipient identifier — only a normalized hostname when a ' +
        'candidate HTTPS URI is present.',
      inputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const result = await withBridgeConnection((client) => previewUnsubscribe(client, args));
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
