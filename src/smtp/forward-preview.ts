import type { ForwardSourceContent } from '../mail/source-message.js';
import {
  computeForwardSourceFingerprint,
  receiptFieldsFromForwardIntent,
  signForwardIntentReceipt,
  type ForwardIntentReceiptEnvelope,
} from '../security/forward-intent-receipt.js';
import { deriveForwardIntent } from './forward-intent.js';

export interface ForwardPreviewResult {
  operation: 'mail_forward_preview';
  sourceFolder: string;
  uid: number;
  to: string[];
  derivedSubject: string;
  sourceFrom: string | null;
  sourceDate: string | null;
  sourceHasAttachments: boolean;
  /** Always equal to `sourceHasAttachments` — surfaced separately so a caller's `acknowledgeAttachmentsWillBeOmitted` decision is explicit rather than inferred. */
  attachmentsWillBeOmitted: boolean;
  introLength: number;
  forwardedTextLength: number;
  /** False when the bounded source fetch could not be proven complete — see `src/mail/source-message.ts`. Never exposes raw MIME/body content to explain why. */
  sourceContentComplete: boolean;
  eligible: boolean;
  reasons: string[];
  /** Present only when eligible AND a send-signing secret is provisioned. */
  forwardIntentReceipt?: ForwardIntentReceiptEnvelope;
}

/**
 * Read-only. Derives exactly what `mail_forward` would submit — caller
 * recipients (never derived from the source), subject (`Fwd:` prefix, never
 * doubled), and a deterministic plain-text forwarded representation — from
 * `source` (already fetched, read-only, via `fetchForwardSourceContent`)
 * and reports eligibility. Zero SMTP connections. Issues a signed
 * `forwardIntentReceipt` when eligible and a send-signing secret is
 * provisioned.
 */
export function previewForward(
  source: ForwardSourceContent,
  params: { to: string[]; text?: string | undefined },
  authorizedUsername: string,
  signingSecret: Buffer | undefined,
): ForwardPreviewResult {
  const validation = deriveForwardIntent(source, params, authorizedUsername);

  const base = {
    operation: 'mail_forward_preview' as const,
    sourceFolder: source.folder,
    uid: source.uid,
    to: validation.intent?.to ?? [],
    derivedSubject: validation.intent?.subject ?? '',
    sourceFrom: source.from,
    sourceDate: source.date,
    sourceHasAttachments: source.hasAttachments,
    attachmentsWillBeOmitted: source.hasAttachments,
    introLength: (params.text ?? '').length,
    forwardedTextLength: validation.intent?.forwardedBlock.length ?? 0,
    sourceContentComplete: source.sourceContentComplete,
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
          'forwardIntentReceipt was issued. Live mail_forward fails closed without one.',
      ],
    };
  }

  const sourceFingerprint = computeForwardSourceFingerprint(signingSecret, {
    folder: source.folder,
    uidValidity: source.uidValidity,
    uid: source.uid,
    from: source.from,
    subject: source.subject,
    date: source.date,
    messageId: source.messageId,
  });
  const issuedAt = new Date().toISOString();
  const receipt = signForwardIntentReceipt(
    signingSecret,
    receiptFieldsFromForwardIntent(validation.intent, sourceFingerprint, issuedAt),
  );

  return {
    ...base,
    eligible: true,
    reasons: validation.reasons,
    forwardIntentReceipt: receipt,
  };
}
