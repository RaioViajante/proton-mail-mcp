import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { withBridgeConnection } from '../bridge/client.js';
import { unsubscribe } from '../unsubscribe/execute.js';

export const inputSchema = z.object({
  folder: z.string().min(1).describe('Folder path where the message currently is, e.g. "INBOX".'),
  uid: z
    .number()
    .int()
    .positive()
    .describe('Explicit message UID — exactly one per call, by design.'),
  dryRun: z
    .boolean()
    .default(true)
    .describe(
      'When true (default), resolves eligibility and previews the outcome without sending any ' +
        'network request.',
    ),
  confirm: z.boolean().default(false).describe('Must be true when dryRun=false.'),
  acknowledgeExternalUnsubscribe: z
    .boolean()
    .default(false)
    .describe(
      'Must be true when dryRun=false: this sends a real HTTPS request to a host named in the ' +
        "message's own headers (attacker-influenced input) and changes a real subscription " +
        'outside of Proton. It is not reversible by this tool.',
    ),
});

export function registerUnsubscribeTool(server: McpServer): void {
  server.registerTool(
    'mail_unsubscribe',
    {
      title: 'Unsubscribe via RFC 8058 one-click',
      description:
        'Executes ONLY the RFC 8058 HTTPS one-click unsubscribe mechanism (List-Unsubscribe + ' +
        'List-Unsubscribe-Post: List-Unsubscribe=One-Click) for one explicit message UID. Defaults ' +
        'to dryRun=true; live execution requires confirm=true AND acknowledgeExternalUnsubscribe=true. ' +
        'Requires the message\'s own authentication to resolve to "verified" (see ' +
        'mail_unsubscribe_preview); anything less fails closed. mailto: URIs and plain-HTTP or ' +
        'non-one-click HTTPS links are detected but never executed in this version. Re-validates the ' +
        "message's identity and every relevant header immediately before sending the request, and " +
        'aborts with zero network calls if anything changed since the eligibility decision. Never ' +
        'follows redirects, never sends cookies/Authorization/Referer, and never returns the response ' +
        'body, the unsubscribe URL, or any token.',
      inputSchema,
      annotations: {
        readOnlyHint: false,
        // Hint only, not a security control (see mail_mark_spam for the same
        // pattern): a live unsubscribe changes an external subscription that
        // this tool cannot reverse.
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const result = await withBridgeConnection((client) => unsubscribe(client, args));
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
