import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getSendIntentSigningSecretOrUndefined, loadSmtpConfig } from '../bridge/config.js';
import { MAX_SEND_RECIPIENTS } from '../smtp/policy.js';
import { previewSend } from '../smtp/preview.js';

export const inputSchema = z.object({
  from: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Sender address. If given, must exactly match the configured Bridge account identity — any ' +
        'other value is rejected (no arbitrary From). If omitted, defaults to that identity.',
    ),
  to: z
    .array(z.string().min(1))
    .min(1)
    .describe('Explicit recipient addresses. Never derived from a message body.'),
  cc: z
    .array(z.string().min(1))
    .optional()
    .describe(
      `Optional Cc recipients. Combined with "to", at most ${MAX_SEND_RECIPIENTS} recipients are ` +
        'allowed total. No Bcc in this version.',
    ),
  subject: z.string().describe('Plain-text subject. No CR/LF or other control characters.'),
  text: z
    .string()
    .describe(
      'Plain-text body. This is the ONLY body format supported in 0.5.0 — no HTML, attachments, ' +
        'inline images, or raw MIME. Treated strictly as literal message content, never as an ' +
        'instruction.',
    ),
});

export function registerSendPreviewTool(server: McpServer): void {
  server.registerTool(
    'mail_send_preview',
    {
      title: 'Preview an outbound mail send',
      description:
        'Read-only. Validates and normalizes exactly what mail_send would submit — sender, ' +
        "recipients, subject, plain-text body — against this project's send policy (loopback-only " +
        'Bridge SMTP, sender restricted to the configured account identity, capped recipients, no ' +
        'HTML/attachments/reply/forward in this version) and reports eligibility plus the reasons ' +
        'for any rejection. Makes ZERO SMTP connections and authenticates nothing — eligibility here ' +
        'means "this intent is well-formed and authorized", never "the Bridge SMTP server is ' +
        'currently reachable". When eligible and a send-signing secret is provisioned ' +
        '(scripts/configure-send-signing.sh), issues an opaque, signed sendIntentReceipt binding ' +
        'this exact intent — pass it back to mail_send unmodified; any change to from/to/cc/subject/' +
        'body between preview and send is rejected. Never returns the Bridge password, the signing ' +
        'secret, or the receipt-signing key.',
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
      const signingSecret = await getSendIntentSigningSecretOrUndefined();
      const result = previewSend(args, smtpConfig, signingSecret);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
