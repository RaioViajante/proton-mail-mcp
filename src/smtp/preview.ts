import {
  receiptFieldsFromIntent,
  signSendIntentReceipt,
  type SendIntentReceiptEnvelope,
} from '../security/send-intent-receipt.js';
import type { ResolvedSmtpConfig } from './config.js';
import { validateSendIntent, type RawSendParams } from './intent.js';

export interface SendPreviewResult {
  operation: 'mail_send_preview';
  from: string | null;
  to: string[];
  cc: string[];
  subject: string;
  bodyLength: number;
  /** Hex SHA-256 of the body — never the body itself. `null` only when the intent failed to validate at all. */
  bodyDigest: string | null;
  totalRecipients: number;
  /** Always loopback (see src/smtp/host-safety.ts) — safe to echo back; never anything else could be configured. */
  smtpHost: string;
  smtpPort: number;
  securityMode: string;
  eligible: boolean;
  reasons: string[];
  /** Present only when eligible AND a send-signing secret is provisioned. Opaque to the caller — pass it back to `mail_send` unmodified. */
  sendIntentReceipt?: SendIntentReceiptEnvelope;
}

/**
 * Read-only. Validates and normalizes exactly what `mail_send` would submit
 * — sender, recipients, subject, body — and, if eligible and a send-signing
 * secret is provisioned, issues a signed `sendIntentReceipt` binding this
 * exact intent for `mail_send` to verify later. Makes **zero SMTP
 * connections**: eligibility here is "this intent is well-formed and
 * authorized", never "the Bridge SMTP server is currently reachable" — see
 * SECURITY.md ("mail_send_preview never touches the network"). Never
 * returns the Bridge password or the signing secret.
 */
export function previewSend(
  params: RawSendParams,
  smtpConfig: ResolvedSmtpConfig,
  signingSecret: Buffer | undefined,
): SendPreviewResult {
  const validation = validateSendIntent(params, smtpConfig.username);

  const base = {
    operation: 'mail_send_preview' as const,
    from: validation.intent?.from ?? null,
    to: validation.intent?.to ?? [],
    cc: validation.intent?.cc ?? [],
    subject: params.subject,
    bodyLength: params.text.length,
    bodyDigest: validation.intent?.bodyHash ?? null,
    totalRecipients: (validation.intent?.to.length ?? 0) + (validation.intent?.cc.length ?? 0),
    smtpHost: smtpConfig.host,
    smtpPort: smtpConfig.port,
    securityMode: smtpConfig.security,
  };

  if (!validation.valid || !validation.intent) {
    return { ...base, eligible: false, reasons: validation.reasons };
  }

  if (!signingSecret) {
    return {
      ...base,
      eligible: true,
      reasons: [
        ...validation.reasons,
        'No send-signing secret is provisioned (run scripts/configure-send-signing.sh); no ' +
          'sendIntentReceipt was issued. Live mail_send fails closed without one.',
      ],
    };
  }

  const issuedAt = new Date().toISOString();
  const receipt = signSendIntentReceipt(
    signingSecret,
    receiptFieldsFromIntent(validation.intent, issuedAt),
  );

  return {
    ...base,
    eligible: true,
    reasons: validation.reasons,
    sendIntentReceipt: receipt,
  };
}
