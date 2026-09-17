import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { withBridgeConnection } from '../bridge/client.js';
import {
  getBridgePassword,
  getSendIntentSigningSecretOrUndefined,
  loadSmtpConfig,
} from '../bridge/config.js';
import { fetchReplySourceHeaders } from '../mail/source-message.js';
import { sendReply } from '../smtp/reply-send.js';

export const inputSchema = z.object({
  sourceFolder: z
    .string()
    .min(1)
    .describe('Folder path as returned by mail_list_folders, e.g. "INBOX".'),
  uid: z.number().int().positive().describe('UID of the message being replied to.'),
  text: z
    .string()
    .describe(
      'Plain-text reply body — the ONLY body format supported. The original message body is ' +
        'never automatically included.',
    ),
  replyIntentReceipt: z
    .unknown()
    .optional()
    .describe(
      'Pass back exactly the replyIntentReceipt mail_reply_preview returned for this EXACT ' +
        'source message and text — never modified. Required for a live call (dryRun=false); any ' +
        'drift (including the source message changing since preview) is rejected.',
    ),
  dryRun: z
    .boolean()
    .default(true)
    .describe(
      'When true (default), validates the derived reply intent and reports what would happen ' +
        'without connecting to SMTP.',
    ),
  confirm: z.boolean().default(false).describe('Must be true when dryRun=false.'),
  acknowledgeExternalReply: z
    .boolean()
    .default(false)
    .describe(
      'Must be true when dryRun=false: this would submit a real outbound reply over SMTP. Not ' +
        'reversible by this tool.',
    ),
});

export function registerReplyTool(server: McpServer): void {
  server.registerTool(
    'mail_reply',
    {
      title: 'Reply to a message (live, controlled)',
      description:
        'Replies to a source message (by folder+UID) with plain-text-only content over SMTP to ' +
        'the local Proton Mail Bridge. Recipient is derived (Reply-To then From — never multiple, ' +
        'never reply-all), subject is derived ("Re:", never doubled, never caller-chosen), and ' +
        'threading (In-Reply-To/References) is derived from the source when available — none of ' +
        'these can be overridden by the caller. The original message body is never automatically ' +
        'quoted. Defaults to dryRun=true (zero SMTP connections). Live execution (dryRun=false) ' +
        'requires confirm=true, acknowledgeExternalReply=true, and a valid replyIntentReceipt from ' +
        'a prior mail_reply_preview call, AND immediately re-fetches and re-validates the source ' +
        'message identity/Reply-To/threading before submitting — any drift since preview is ' +
        'rejected before any SMTP connection. Controlled live reply is enabled in 0.5.3; real ' +
        'Bridge validation is still pending after a full MCP process restart. mail_reply_preview ' +
        'and dryRun=true both work fully. No Cc, no ' +
        'reply-all, no HTML/attachments, no custom headers; From is restricted to the configured ' +
        'Bridge account identity.',
      inputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      const smtpConfig = loadSmtpConfig();
      const signingSecret = await getSendIntentSigningSecretOrUndefined();
      const source = await withBridgeConnection((client) =>
        fetchReplySourceHeaders(client, args.sourceFolder, args.uid),
      );
      const result = await sendReply(source, args, smtpConfig, signingSecret, {
        getPassword: () => getBridgePassword(smtpConfig.username),
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
