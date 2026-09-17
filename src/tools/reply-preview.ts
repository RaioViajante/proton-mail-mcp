import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { withBridgeConnection } from '../bridge/client.js';
import { getSendIntentSigningSecretOrUndefined, loadSmtpConfig } from '../bridge/config.js';
import { fetchReplySourceHeaders } from '../mail/source-message.js';
import { previewReply } from '../smtp/reply-preview.js';

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
        'never automatically included; this is exactly what will be sent.',
    ),
});

export function registerReplyPreviewTool(server: McpServer): void {
  server.registerTool(
    'mail_reply_preview',
    {
      title: 'Preview a reply to a message',
      description:
        'Read-only. Derives exactly what mail_reply would submit from a source message (by ' +
        'folder+UID) and your reply text: the recipient (Reply-To when present and unambiguous, ' +
        'otherwise From — never multiple recipients; no reply-all in this version), a derived ' +
        '"Re:" subject (never doubled, never caller-chosen), and threading (In-Reply-To/' +
        'References) when the source has a usable Message-ID. Fetches ONLY the headers needed to ' +
        'derive a recipient/subject/threading plan — never the source message body or ' +
        'attachments. Makes ZERO SMTP connections. Issues a signed, opaque replyIntentReceipt when ' +
        'eligible and a send-signing secret is provisioned — pass it back to mail_reply unmodified. ' +
        'Live reply is unconditionally disabled in this version pending separate validation; see ' +
        'mail_reply.',
      inputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      const smtpConfig = loadSmtpConfig();
      const [source, signingSecret] = await Promise.all([
        withBridgeConnection((client) =>
          fetchReplySourceHeaders(client, args.sourceFolder, args.uid),
        ),
        getSendIntentSigningSecretOrUndefined(),
      ]);

      if (!source) {
        const result = {
          operation: 'mail_reply_preview' as const,
          sourceFolder: args.sourceFolder,
          uid: args.uid,
          targetRecipient: null,
          derivedSubject: '',
          textLength: args.text.length,
          threadingAvailable: false,
          eligible: false,
          reasons: ['Message not found in the specified folder.'],
        };
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      const result = previewReply(source, { text: args.text }, smtpConfig.username, signingSecret);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
