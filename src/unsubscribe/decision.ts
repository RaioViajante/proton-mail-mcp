import { parseCandidateUnsubscribeUrl } from './url-safety.js';
import type { RawUnsubscribeHeaders, ResolvedUnsubscribeMessage } from './headers.js';

/**
 * The eligibility decision: whether a message has a supported unsubscribe
 * mechanism, and — much more narrowly — whether it is safe to execute
 * automatically. This is the ONLY place that decides `executionEligibility`;
 * both `mail_unsubscribe_preview` and `mail_unsubscribe` call
 * `computeUnsubscribeDecision` and never re-implement the rules themselves.
 */

export type UnsubscribeMechanism =
  'rfc8058-https-one-click' | 'mailto' | 'http-non-one-click' | 'none';

/**
 * Modeled explicitly per the task's request, rather than collapsing to a
 * boolean:
 *  - `verified`: the message's OWN authentication passed (DMARC pass, or
 *    DKIM pass whose signing domain aligns with the From address domain).
 *    This is not cryptographic verification performed by this project —
 *    it is trust in Proton's own receiving-MTA verdict, reported via the
 *    standard Authentication-Results header. See SECURITY.md.
 *  - `evidence-present-but-not-cryptographically-verified`: a
 *    DKIM-Signature or Authentication-Results header exists, but neither
 *    resolves to a clean, aligned pass.
 *  - `unavailable`: neither header is present at all.
 *  - `failed`: an explicit negative authentication result was reported.
 */
export type AuthenticationStatus =
  'verified' | 'evidence-present-but-not-cryptographically-verified' | 'unavailable' | 'failed';

export type ExecutionEligibility = 'eligible' | 'ineligible';

interface ParsedUri {
  scheme: 'https' | 'http' | 'mailto' | 'other';
  value: string;
}

/** Internal decision shape. `targetUrl` and `rawSnapshot` are NEVER serialized to a tool result — see `toPublicPreview`/`toPublicExecutionFields`. */
export interface UnsubscribeDecision {
  uid: number;
  supported: boolean;
  oneClick: boolean;
  mechanism: UnsubscribeMechanism;
  listIdPresent: boolean;
  authenticationStatus: AuthenticationStatus;
  executionEligibility: ExecutionEligibility;
  reasons: string[];
  targetHost: string | null;
  /** Never exposed outside this module's callers' internal control flow. */
  targetUrl: URL | null;
  /** Snapshot used for pre-execution revalidation — never exposed. */
  rawSnapshot: RawUnsubscribeHeaders;
}

function parseListUnsubscribeUris(value: string): ParsedUri[] {
  const bracketed = [...value.matchAll(/<([^>]*)>/g)].map((match) => (match[1] ?? '').trim());
  const candidates =
    bracketed.length > 0 ? bracketed : /^\s*(https?|mailto):/i.test(value) ? [value.trim()] : [];
  return candidates.map((raw) => ({ scheme: classifyScheme(raw), value: raw }));
}

function classifyScheme(value: string): ParsedUri['scheme'] {
  if (/^https:/i.test(value)) return 'https';
  if (/^http:/i.test(value)) return 'http';
  if (/^mailto:/i.test(value)) return 'mailto';
  return 'other';
}

/** RFC 8058's fixed grammar: the header's value must be exactly this token, nothing else. */
function isOneClickPostValue(value: string | undefined): boolean {
  if (!value) return false;
  return /^List-Unsubscribe=One-Click$/i.test(value.trim());
}

function domainsAligned(a: string, b: string): boolean {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`);
}

function parseAuthResultToken(
  authResults: string,
  mechanism: 'dkim' | 'dmarc',
): { result: string; domain: string | null } | null {
  const pattern = new RegExp(
    `\\b${mechanism}=(\\w+)(?:[^;]*?header\\.(?:d|from)=([a-zA-Z0-9.-]+))?`,
    'i',
  );
  const match = pattern.exec(authResults);
  if (!match) return null;
  const result = match[1];
  if (!result) return null;
  return { result, domain: match[2] ?? null };
}

const NEGATIVE_AUTH_RESULTS = /^(fail|softfail|permerror|hardfail)$/i;

function computeAuthenticationStatus(
  headers: RawUnsubscribeHeaders,
  fromDomain: string | null,
): AuthenticationStatus {
  const { authenticationResults, dkimSignaturePresent } = headers;
  if (!authenticationResults && !dkimSignaturePresent) {
    return 'unavailable';
  }

  const dmarc = authenticationResults ? parseAuthResultToken(authenticationResults, 'dmarc') : null;
  const dkim = authenticationResults ? parseAuthResultToken(authenticationResults, 'dkim') : null;

  // DMARC pass already guarantees From-domain alignment (RFC 7489) — no
  // separate domain check needed for that branch.
  if (dmarc && dmarc.result.toLowerCase() === 'pass') {
    return 'verified';
  }
  if (
    dkim &&
    dkim.result.toLowerCase() === 'pass' &&
    dkim.domain &&
    fromDomain &&
    domainsAligned(dkim.domain, fromDomain)
  ) {
    return 'verified';
  }
  if (
    (dmarc && NEGATIVE_AUTH_RESULTS.test(dmarc.result)) ||
    (dkim && NEGATIVE_AUTH_RESULTS.test(dkim.result))
  ) {
    return 'failed';
  }
  return 'evidence-present-but-not-cryptographically-verified';
}

function classifyMechanism(headers: RawUnsubscribeHeaders): {
  mechanism: UnsubscribeMechanism;
  targetUrl: URL | null;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (!headers.listUnsubscribe) {
    return {
      mechanism: 'none',
      targetUrl: null,
      reasons: ['No List-Unsubscribe header is present.'],
    };
  }

  const uris = parseListUnsubscribeUris(headers.listUnsubscribe);
  const httpsUris = uris.filter((uri) => uri.scheme === 'https');
  const httpUris = uris.filter((uri) => uri.scheme === 'http');
  const mailtoUris = uris.filter((uri) => uri.scheme === 'mailto');

  if (httpsUris.length > 1) {
    reasons.push('Multiple HTTPS unsubscribe URIs are present; ambiguous, refusing to pick one.');
    return { mechanism: 'http-non-one-click', targetUrl: null, reasons };
  }

  if (httpsUris.length === 1) {
    const candidate = httpsUris[0];
    const url = candidate ? parseCandidateUnsubscribeUrl(candidate.value) : null;
    if (!url) {
      reasons.push('The HTTPS unsubscribe URI is not a well-formed absolute URL.');
      return { mechanism: 'http-non-one-click', targetUrl: null, reasons };
    }
    if (isOneClickPostValue(headers.listUnsubscribePost)) {
      return { mechanism: 'rfc8058-https-one-click', targetUrl: url, reasons };
    }
    reasons.push(
      headers.listUnsubscribePost
        ? 'List-Unsubscribe-Post is present but its value does not match the required ' +
            '"List-Unsubscribe=One-Click" token.'
        : 'List-Unsubscribe-Post header is absent; RFC 8058 one-click requires it.',
    );
    return { mechanism: 'http-non-one-click', targetUrl: url, reasons };
  }

  if (httpUris.length > 0) {
    reasons.push(
      'Only a plain HTTP (non-HTTPS) unsubscribe URI is present; HTTPS is required and this is ' +
        'never eligible for execution.',
    );
    return { mechanism: 'http-non-one-click', targetUrl: null, reasons };
  }

  if (mailtoUris.length > 0) {
    reasons.push(
      'Only a mailto unsubscribe URI is present; mailto execution is not supported in 0.3.0.',
    );
    return { mechanism: 'mailto', targetUrl: null, reasons };
  }

  reasons.push(
    'List-Unsubscribe header is present but contains no recognizable http(s)/mailto URI.',
  );
  return { mechanism: 'none', targetUrl: null, reasons };
}

export function computeUnsubscribeDecision(
  resolved: ResolvedUnsubscribeMessage,
): UnsubscribeDecision {
  const { mechanism, targetUrl, reasons } = classifyMechanism(resolved.headers);
  const authenticationStatus = computeAuthenticationStatus(resolved.headers, resolved.fromDomain);

  const allReasons = [...reasons];
  if (authenticationStatus !== 'verified') {
    allReasons.push(
      authenticationStatus === 'unavailable'
        ? 'No Authentication-Results or DKIM-Signature header is available for this message.'
        : authenticationStatus === 'failed'
          ? 'The message failed its own DKIM/DMARC authentication.'
          : 'Authentication evidence is present but does not resolve to a clean, aligned pass.',
    );
  }

  const oneClick = mechanism === 'rfc8058-https-one-click';
  const executionEligibility: ExecutionEligibility =
    oneClick && authenticationStatus === 'verified' && targetUrl !== null
      ? 'eligible'
      : 'ineligible';

  if (executionEligibility === 'ineligible' && allReasons.length === 0) {
    allReasons.push('Not eligible for automatic execution.');
  }

  return {
    uid: resolved.uid,
    supported: mechanism !== 'none',
    oneClick,
    mechanism,
    listIdPresent: Boolean(resolved.headers.listId),
    authenticationStatus,
    executionEligibility,
    reasons: allReasons,
    targetHost: targetUrl ? targetUrl.hostname.toLowerCase() : null,
    targetUrl,
    rawSnapshot: resolved.headers,
  };
}

export interface PublicUnsubscribePreview {
  operation: 'mail_unsubscribe_preview';
  folder: string;
  uid: number;
  supported: boolean;
  oneClick: boolean;
  mechanism: UnsubscribeMechanism;
  listIdPresent: boolean;
  authenticationStatus: AuthenticationStatus;
  executionEligibility: ExecutionEligibility;
  reasons: string[];
  targetHost: string | null;
}

/**
 * The ONLY function that builds what `mail_unsubscribe_preview` returns.
 * Every field is copied out individually — never a spread of the internal
 * decision object — so `targetUrl` (full URL, query, path) and
 * `rawSnapshot` (raw header values) can never leak into a tool result even
 * if a field is added to the internal shape later.
 */
export function toPublicPreview(
  folder: string,
  decision: UnsubscribeDecision,
): PublicUnsubscribePreview {
  return {
    operation: 'mail_unsubscribe_preview',
    folder,
    uid: decision.uid,
    supported: decision.supported,
    oneClick: decision.oneClick,
    mechanism: decision.mechanism,
    listIdPresent: decision.listIdPresent,
    authenticationStatus: decision.authenticationStatus,
    executionEligibility: decision.executionEligibility,
    reasons: decision.reasons,
    targetHost: decision.targetHost,
  };
}
