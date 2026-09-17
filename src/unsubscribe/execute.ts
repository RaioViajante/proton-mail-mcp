import type { ImapFlow } from 'imapflow';
import { computeUnsubscribeDecision } from './decision.js';
import type {
  AuthenticationStatus,
  ExecutionEligibility,
  UnsubscribeMechanism,
} from './decision.js';
import { fetchUnsubscribeHeaders, headersIdentical } from './headers.js';
import { postOneClickUnsubscribe, type OneClickOutcome } from './http-client.js';
import { checkUrlStructurallySafe, resolveAndValidateHost } from './url-safety.js';

export interface UnsubscribeParams {
  folder: string;
  uid: number;
  dryRun: boolean;
  confirm: boolean;
  acknowledgeExternalUnsubscribe: boolean;
}

export interface UnsubscribeExecutionResult {
  operation: 'mail_unsubscribe';
  folder: string;
  uid: number;
  dryRun: boolean;
  requested: true;
  requestSent: boolean;
  httpStatus: number | null;
  outcome: OneClickOutcome | null;
  executionEligibility: ExecutionEligibility;
  mechanism: UnsubscribeMechanism;
  authenticationStatus: AuthenticationStatus;
  reasons: string[];
  targetHost: string | null;
}

/** Sends the live RFC 8058 POST. Overridable in tests so consent/revalidation tests never touch a real socket. */
export type OneClickSender = (target: { url: URL }) => ReturnType<typeof defaultSendOneClick>;

async function defaultSendOneClick(target: { url: URL }) {
  const structural = checkUrlStructurallySafe(target.url);
  if (!structural.safe) {
    return {
      requestSent: false,
      httpStatus: null,
      outcome: null as OneClickOutcome | null,
      reason: structural.reason,
    };
  }
  try {
    const resolved = await resolveAndValidateHost(target.url.hostname);
    const posted = await postOneClickUnsubscribe(target.url, resolved);
    return {
      requestSent: posted.requestSent,
      httpStatus: posted.httpStatus,
      outcome: posted.outcome as OneClickOutcome | null,
      reason: posted.failureReason,
    };
  } catch (error) {
    return {
      requestSent: false,
      httpStatus: null,
      outcome: null as OneClickOutcome | null,
      reason: error instanceof Error ? error.message : 'DNS resolution failed.',
    };
  }
}

function buildResult(
  base: Pick<UnsubscribeExecutionResult, 'folder' | 'uid' | 'dryRun'>,
  fields: Omit<UnsubscribeExecutionResult, 'operation' | 'folder' | 'uid' | 'dryRun' | 'requested'>,
): UnsubscribeExecutionResult {
  return { operation: 'mail_unsubscribe', requested: true, ...base, ...fields };
}

/**
 * Core `mail_unsubscribe` mutation. Never accepts a pre-computed eligibility
 * decision from the caller — every call (preview or live) re-derives
 * eligibility from a fresh IMAP fetch, so a stale or forged "trust me, it's
 * eligible" input is structurally impossible.
 *
 * Live execution re-validates twice, mirroring the write-lock revalidation
 * idiom every IMAP mutation in this project already follows (see
 * `mutations/*.ts`), adapted here for an external HTTP side effect instead
 * of an IMAP write: the decision is computed once, then immediately before
 * the network call the message is re-fetched and every header the decision
 * depends on must still be byte-identical. Any drift — the message
 * disappearing, its identity changing, or its headers changing — aborts
 * with zero network requests.
 */
export async function unsubscribe(
  client: ImapFlow,
  { folder, uid, dryRun, confirm, acknowledgeExternalUnsubscribe }: UnsubscribeParams,
  sendOneClick: OneClickSender = defaultSendOneClick,
): Promise<UnsubscribeExecutionResult> {
  if (!dryRun && (!confirm || !acknowledgeExternalUnsubscribe)) {
    throw new Error(
      'confirm=true and acknowledgeExternalUnsubscribe=true are both required together with ' +
        'dryRun=false for mail_unsubscribe.',
    );
  }

  const base = { folder, uid, dryRun };
  const notAttempted = { requestSent: false, httpStatus: null, outcome: null } as const;

  const first = await fetchUnsubscribeHeaders(client, folder, uid);
  if (!first) {
    return buildResult(base, {
      ...notAttempted,
      executionEligibility: 'ineligible',
      mechanism: 'none',
      authenticationStatus: 'unavailable',
      reasons: ['Message not found in the specified folder.'],
      targetHost: null,
    });
  }

  const decision = computeUnsubscribeDecision(first);

  if (dryRun) {
    return buildResult(base, {
      ...notAttempted,
      executionEligibility: decision.executionEligibility,
      mechanism: decision.mechanism,
      authenticationStatus: decision.authenticationStatus,
      reasons: decision.reasons,
      targetHost: decision.targetHost,
    });
  }

  if (decision.executionEligibility !== 'eligible' || !decision.targetUrl) {
    return buildResult(base, {
      ...notAttempted,
      executionEligibility: decision.executionEligibility,
      mechanism: decision.mechanism,
      authenticationStatus: decision.authenticationStatus,
      reasons: decision.reasons,
      targetHost: decision.targetHost,
    });
  }

  // Revalidate immediately before the side effect: re-fetch and require the
  // exact same message identity and the exact same header values used to
  // reach `decision` above.
  const second = await fetchUnsubscribeHeaders(client, folder, uid);
  if (
    !second ||
    second.messageId !== first.messageId ||
    !headersIdentical(first.headers, second.headers)
  ) {
    return buildResult(base, {
      ...notAttempted,
      executionEligibility: 'ineligible',
      mechanism: decision.mechanism,
      authenticationStatus: decision.authenticationStatus,
      reasons: [
        'Message identity or unsubscribe headers changed since the initial decision; refusing to execute.',
      ],
      targetHost: decision.targetHost,
    });
  }

  const revalidated = computeUnsubscribeDecision(second);
  if (revalidated.executionEligibility !== 'eligible' || !revalidated.targetUrl) {
    return buildResult(base, {
      ...notAttempted,
      executionEligibility: revalidated.executionEligibility,
      mechanism: revalidated.mechanism,
      authenticationStatus: revalidated.authenticationStatus,
      reasons: revalidated.reasons,
      targetHost: revalidated.targetHost,
    });
  }

  const sent = await sendOneClick({ url: revalidated.targetUrl });
  return buildResult(base, {
    requestSent: sent.requestSent,
    httpStatus: sent.httpStatus,
    outcome: sent.outcome,
    executionEligibility: 'eligible',
    mechanism: revalidated.mechanism,
    authenticationStatus: revalidated.authenticationStatus,
    reasons: sent.reason ? [...revalidated.reasons, sent.reason] : revalidated.reasons,
    targetHost: revalidated.targetHost,
  });
}
