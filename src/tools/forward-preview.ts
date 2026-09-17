import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { withBridgeConnection } from '../bridge/client.js';
import { getSendIntentSigningSecretOrUndefined, loadSmtpConfig } from '../bridge/config.js';
import { fetchForwardSourceContent } from '../mail/source-message.js';
import { previewForward } from '../smtp/forward-preview.js';

export const inputSchema = z.object({
  sourceFolder: z
    .string()
    .min(1)
    .describe('Folder path as returned by mail_list_folders, e.g. "INBOX".'),
  uid: z.number().int().positive().describe('UID of the message being forwarded.'),
  to: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      'Explicit recipient addresses, supplied by the caller — NEVER derived from the source ' +
        'message. No Cc, no Bcc in this version.',
    ),
  text: z
    .string()
    .optional()
    .describe(
      'Optional plain-text intro comment, shown before the forwarded message representation.',
    ),
});

export function registerForwardPreviewTool(server: McpServer): void {
  server.registerTool(
    'mail_forward_preview',
    {
      title: 'Preview forwarding a message',
      description:
        'Read-only. Derives exactly what mail_forward would submit from a source message (by ' +
        'folder+UID): your explicit recipients (never derived from the source), a derived "Fwd:" ' +
        'subject (never doubled, never caller-chosen), and a deterministic plain-text forwarded ' +
        'representation of the source (From/Date/Subject/To normalized to single safe lines, ' +
        'plain-text body only — HTML-only sources are converted, never forwarded as HTML). ' +
        'Attachments are NEVER included — sourceHasAttachments/attachmentsWillBeOmitted report ' +
        'whether the source has any. A source message whose content could not be fetched/proven ' +
        "complete within this version's conservative size bound, or that has no usable text at " +
        'all, or whose text exceeds the outbound bound, is reported ineligible rather than ' +
        'partially or silently-shortened forwarded (see sourceContentComplete). Makes ZERO SMTP ' +
        'connections. Issues a signed, opaque forwardIntentReceipt when eligible and a ' +
        'send-signing secret is provisioned. Controlled live forward is enabled in 0.5.4; ' +
        'real Bridge validation remains pending after a full MCP restart; see mail_forward.',
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
          fetchForwardSourceContent(client, args.sourceFolder, args.uid),
        ),
        getSendIntentSigningSecretOrUndefined(),
      ]);

      if (!source) {
        const result = {
          operation: 'mail_forward_preview' as const,
          sourceFolder: args.sourceFolder,
          uid: args.uid,
          to: [],
          derivedSubject: '',
          sourceFrom: null,
          sourceDate: null,
          sourceHasAttachments: false,
          attachmentsWillBeOmitted: false,
          introLength: (args.text ?? '').length,
          forwardedTextLength: 0,
          sourceContentComplete: false,
          eligible: false,
          reasons: ['Message not found in the specified folder.'],
        };
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      const result = previewForward(
        source,
        { to: args.to, text: args.text },
        smtpConfig.username,
        signingSecret,
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
