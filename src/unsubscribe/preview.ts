import type { ImapFlow } from 'imapflow';
import {
  computeUnsubscribeDecision,
  toPublicPreview,
  type PublicUnsubscribePreview,
} from './decision.js';
import { fetchUnsubscribeHeaders } from './headers.js';

export interface UnsubscribePreviewParams {
  folder: string;
  uid: number;
}

/**
 * Read-only. Makes no network request of any kind — it only fetches the
 * message's own headers over the already-open IMAP connection and evaluates
 * them locally. See `decision.ts` for the eligibility rules and
 * `toPublicPreview` for the sanitization guarantee (full URL, query, and
 * raw header values never leave that module).
 */
export async function previewUnsubscribe(
  client: ImapFlow,
  { folder, uid }: UnsubscribePreviewParams,
): Promise<PublicUnsubscribePreview> {
  const resolved = await fetchUnsubscribeHeaders(client, folder, uid);
  if (!resolved) {
    return {
      operation: 'mail_unsubscribe_preview',
      folder,
      uid,
      supported: false,
      oneClick: false,
      mechanism: 'none',
      listIdPresent: false,
      authenticationStatus: 'unavailable',
      executionEligibility: 'ineligible',
      reasons: ['Message not found in the specified folder.'],
      targetHost: null,
    };
  }
  return toPublicPreview(folder, computeUnsubscribeDecision(resolved));
}
