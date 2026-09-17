import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { withBridgeConnection } from '../bridge/client.js';
import {
  getBridgePassword,
  getSendIntentSigningSecretOrUndefined,
  loadSmtpConfig,
} from '../bridge/config.js';
import { fetchForwardSourceContent } from '../mail/source-message.js';
import { sendForward } from '../smtp/forward-send.js';

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
  forwardIntentReceipt: z
    .unknown()
    .optional()
    .describe(
      'Pass back exactly the forwardIntentReceipt mail_forward_preview returned for this EXACT ' +
        'source message and payload — never modified. Required for a live call (dryRun=false); any ' +
        'drift (including the source message changing since preview) is rejected.',
    ),
  dryRun: z
    .boolean()
    .default(true)
    .describe(
      'When true (default), validates the derived forward intent and reports what would happen ' +
        'without connecting to SMTP.',
    ),
  confirm: z.boolean().default(false).describe('Must be true when dryRun=false.'),
  acknowledgeExternalForward: z
    .boolean()
    .default(false)
    .describe(
      'Must be true when dryRun=false: this would submit a real outbound forward over SMTP. Not ' +
        'reversible by this tool.',
    ),
  acknowledgeAttachmentsWillBeOmitted: z
    .boolean()
    .default(false)
    .describe(
      'Must be true when dryRun=false AND the (verified) receipt reports the source has ' +
        'attachments — attachments are never forwarded in this version.',
    ),
});

export function registerForwardTool(server: McpServer): void {
  server.registerTool(
    'mail_forward',
    {
      title: 'Forward a message (live, controlled)',
      description:
        'Forwards a source message (by folder+UID) as plain text over SMTP to the local Proton ' +
        'Mail Bridge, to caller-supplied recipients only (never derived from the source). Subject ' +
        'is derived ("Fwd:", never doubled, never caller-chosen). The forwarded body is a ' +
        'deterministic plain-text representation of the source (attachments NEVER included). ' +
        'Defaults to dryRun=true (zero SMTP connections). Live execution (dryRun=false) requires ' +
        'confirm=true, acknowledgeExternalForward=true, a valid forwardIntentReceipt from a prior ' +
        'mail_forward_preview call, AND acknowledgeAttachmentsWillBeOmitted=true whenever that ' +
        '(verified) receipt reports the source has attachments — and immediately re-fetches and ' +
        're-validates the source message before submitting; any drift since preview (including its ' +
        'text or attachment presence) is rejected before any SMTP connection. LIVE FORWARD IS ' +
        'UNCONDITIONALLY DISABLED IN THIS VERSION (0.5.2): a fully-confirmed, fully-valid ' +
        'dryRun=false call is still refused before any credential is requested, and does NOT ' +
        'consume the receipt. mail_forward_preview and dryRun=true both work fully today. No Cc, ' +
        'no Bcc, no HTML forwarding, no attachments, no custom headers; From is restricted to the ' +
        'configured Bridge account identity.',
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
        fetchForwardSourceContent(client, args.sourceFolder, args.uid),
      );
      const result = await sendForward(source, args, smtpConfig, signingSecret, {
        getPassword: () => getBridgePassword(smtpConfig.username),
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
