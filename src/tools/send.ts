import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getSendIntentSigningSecretOrUndefined, loadSmtpConfig } from '../bridge/config.js';
import { MAX_SEND_RECIPIENTS } from '../smtp/policy.js';
import { LIVE_SEND_DISABLED_REASON, sendMail } from '../smtp/send.js';

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
  sendIntentReceipt: z
    .unknown()
    .optional()
    .describe(
      'Pass back exactly the sendIntentReceipt mail_send_preview returned for this EXACT intent — ' +
        'never modified. Required for a live call (dryRun=false); any drift from what was previewed ' +
        '(sender, recipients, subject, or body) is rejected.',
    ),
  dryRun: z
    .boolean()
    .default(true)
    .describe(
      'When true (default), validates the intent and reports what would happen without connecting ' +
        'to SMTP.',
    ),
  confirm: z.boolean().default(false).describe('Must be true when dryRun=false.'),
  acknowledgeExternalSend: z
    .boolean()
    .default(false)
    .describe(
      'Must be true when dryRun=false: this submits a real outbound email over SMTP. It is not ' +
        'reversible by this tool.',
    ),
});

export function registerSendTool(server: McpServer): void {
  server.registerTool(
    'mail_send',
    {
      title: 'Send mail (live submission disabled)',
      description:
        'Submits a plain-text email over SMTP to the local Proton Mail Bridge — external side ' +
        'effect: sends a real outbound message once live execution is enabled in a future version. ' +
        'Defaults to dryRun=true, which validates the intent (sender/recipients/subject/body) and ' +
        'previews the outcome without any SMTP connection. Live execution (dryRun=false) requires ' +
        'confirm=true, acknowledgeExternalSend=true, AND a valid sendIntentReceipt from ' +
        'mail_send_preview matching this exact payload — but even with everything correct, live ' +
        `submission is UNCONDITIONALLY DISABLED by a hard feature gate: the call returns ` +
        `blocked: true, blockReason: "${LIVE_SEND_DISABLED_REASON}", before any SMTP connection is ` +
        'attempted. This is a deliberate, documented limitation, not a bug — live send ships in a ' +
        'separate, explicitly authorized version after dedicated live validation. See SECURITY.md. ' +
        'No reply/forward, HTML, attachments, or Bcc in this version; From is restricted to the ' +
        'configured Bridge account identity.',
      inputSchema,
      annotations: {
        readOnlyHint: false,
        // Not destructiveHint: sending mail doesn't destroy/mutate existing
        // mailbox state — it's an external side effect, not data loss. The
        // description above is the actual warning; this mirrors the MCP
        // semantics mail_unsubscribe/mail_trash already use consistently.
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      const smtpConfig = loadSmtpConfig();
      const signingSecret = await getSendIntentSigningSecretOrUndefined();
      const result = sendMail(args, smtpConfig, signingSecret);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
