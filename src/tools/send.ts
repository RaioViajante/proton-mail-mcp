import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  getBridgePassword,
  getSendIntentSigningSecretOrUndefined,
  loadSmtpConfig,
} from '../bridge/config.js';
import { MAX_SEND_RECIPIENTS } from '../smtp/policy.js';
import { sendMail } from '../smtp/send.js';

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
      title: 'Send mail (live, controlled)',
      description:
        'Submits a plain-text email over SMTP to the local Proton Mail Bridge — SENDS A REAL ' +
        'EXTERNAL EMAIL when dryRun=false and every requirement below is met; this is an external ' +
        'side effect with no undo from this tool. Defaults to dryRun=true, which validates the ' +
        'intent (sender/recipients/subject/body) and, if a sendIntentReceipt was supplied, checks it ' +
        'too — all with ZERO SMTP connection. Live execution (dryRun=false) requires ALL of: ' +
        'confirm=true, acknowledgeExternalSend=true, and a valid sendIntentReceipt from a prior ' +
        'mail_send_preview call matching this exact from/to/cc/subject/body — call mail_send_preview ' +
        'first. The receipt is single-use: once a live call consumes it (whether or not the SMTP ' +
        'attempt itself succeeds), presenting the same receipt again is refused — call ' +
        'mail_send_preview again for a fresh one. There is NO automatic retry of any kind: a live ' +
        'call makes at most one SMTP submission attempt; an ambiguous failure is reported as ' +
        'outcome="uncertain" rather than retried or guessed at. "accepted" means only that the ' +
        'Bridge SMTP server accepted the submission — never that the message was delivered, ' +
        'received, or read. Only ever connects to the local, loopback-only Proton Mail Bridge over ' +
        'STARTTLS/TLS with certificate validation; never any external SMTP host. See SECURITY.md. ' +
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
      const result = await sendMail(args, smtpConfig, signingSecret, {
        getPassword: () => getBridgePassword(smtpConfig.username),
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
