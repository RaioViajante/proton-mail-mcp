import { addressKey } from './policy.js';

/**
 * Pure classification of an SMTP submission attempt into this project's
 * conservative result model (0.5.0) — see README.md ("mail_send result
 * model") and section 18 of the 0.5.0 task. Deliberately decoupled from
 * `nodemailer`'s own types: this module only depends on the handful of
 * fields nodemailer's SMTP transport documents on its resolve/reject values,
 * so it can be unit-tested with plain objects and never needs a real (or
 * even a mocked) `Transporter` to exercise every branch. See
 * `src/smtp/transport.ts` for where this is actually wired to nodemailer.
 *
 * The core rule this project will not compromise on (see SECURITY.md,
 * "Duplicate sends are worse than an uncertain result"): a failure with no
 * definitive server response is `uncertain`, never silently treated as
 * either success or a clean failure, and NEVER automatically retried by
 * anything in this codebase.
 */

export type SmtpOutcome = 'accepted' | 'partiallyAccepted' | 'rejected' | 'uncertain' | 'failed';

export interface SmtpAttemptResult {
  connectionEstablished: boolean;
  authenticated: boolean;
  submissionAttempted: boolean;
  acceptedRecipients: string[];
  rejectedRecipients: string[];
  /** A coarse category only (e.g. "2xx") — never the raw SMTP response line, which can echo back submitted content. */
  smtpResponseCategory: string | null;
  outcome: SmtpOutcome;
  deliveryUncertain: boolean;
  reasons: string[];
}

/** The subset of nodemailer's successful `SentMessageInfo` this module reads. */
export interface SmtpSuccessInfo {
  accepted?: unknown[] | undefined;
  rejected?: unknown[] | undefined;
  response?: string | undefined;
}

/** The subset of fields nodemailer's SMTP transport documents on a thrown error. Every field is optional because not every failure mode populates all of them. */
export interface SmtpLikeError {
  code?: string | undefined;
  command?: string | undefined;
  responseCode?: number | undefined;
  message?: string | undefined;
}

function categoryOf(responseCode: number | undefined, response: string | undefined): string | null {
  if (typeof responseCode === 'number') {
    return `${Math.floor(responseCode / 100)}xx`;
  }
  const match = response ? /^(\d)\d\d/.exec(response.trim()) : null;
  return match ? `${match[1]}xx` : null;
}

function asAddressList(value: unknown[] | undefined): string[] {
  if (!value) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Sanitizes `accepted`/`rejected` recipient lists before they ever leave
 * this project (0.5.1, section 6): intersects whatever the SMTP library
 * reports against the caller's own normalized recipient set (`known` — the
 * validated intent's `to`/`cc`), matched case-insensitively via
 * {@link addressKey}, and returns the caller's own normalized spelling —
 * never nodemailer's raw echoed string. An address the library reports that
 * isn't one this project actually submitted is dropped rather than
 * surfaced; this never happens with a well-behaved SMTP library but this
 * project does not trust that as the only guarantee. Also drops duplicates
 * and preserves `known`'s order.
 */
export function sanitizeRecipientList(reported: string[], known: readonly string[]): string[] {
  const reportedKeys = new Set(reported.map((address) => addressKey(address.trim())));
  return known.filter((address) => reportedKeys.has(addressKey(address)));
}

/** Classifies a successful (non-throwing) `sendMail` resolution — nodemailer resolves even when SOME recipients were rejected; only a full failure throws. */
export function classifySmtpSuccess(info: SmtpSuccessInfo): SmtpAttemptResult {
  const accepted = asAddressList(info.accepted);
  const rejected = asAddressList(info.rejected);
  const outcome: SmtpOutcome =
    rejected.length === 0 ? 'accepted' : accepted.length === 0 ? 'rejected' : 'partiallyAccepted';
  return {
    connectionEstablished: true,
    authenticated: true,
    submissionAttempted: true,
    acceptedRecipients: accepted,
    rejectedRecipients: rejected,
    smtpResponseCategory: categoryOf(undefined, info.response),
    outcome,
    deliveryUncertain: false,
    reasons:
      outcome === 'accepted'
        ? []
        : [
            'The SMTP server accepted the connection and submission but rejected one or more ' +
              'recipients.',
          ],
  };
}

/**
 * Classifies a thrown `sendMail` error into a phase-aware outcome. Never
 * treats an ambiguous connection loss as a clean failure: only a definitive
 * negative server response (a numeric SMTP response code) is ever reported
 * as `rejected`; every other failure after submission was attempted is
 * `uncertain`, exactly what SECURITY.md and the task both require — the
 * caller/tool layer is responsible for never retrying automatically on
 * either.
 *
 * Deliberately never forwards the underlying error's raw `.message` into
 * `reasons` — mirrors `bridge/client.ts`'s IMAP connect-error handling
 * exactly (see its comment: "IMAP client errors are not documented to omit
 * the raw AUTHENTICATE command/response from their properties"). Nothing in
 * `nodemailer`/`smtp-connection`'s public API documents that an error
 * message can never end up echoing part of an AUTH exchange, so this never
 * relies on that being true. Every reason here is a fixed, stable sentence
 * built from `code`/`command`/`responseCode` only — safe to log, safe to
 * return, and exactly as informative to a caller either way.
 */
export function classifySmtpError(error: SmtpLikeError): SmtpAttemptResult {
  // A definitive server response code always wins, regardless of phase: the
  // server told us something concrete, so this is never "uncertain".
  if (typeof error.responseCode === 'number') {
    const category = categoryOf(error.responseCode, undefined);
    const permanent = error.responseCode >= 500;
    return {
      connectionEstablished: true,
      authenticated: error.command !== 'AUTH',
      submissionAttempted:
        error.command === 'MAIL FROM' || error.command === 'RCPT TO' || error.command === 'DATA',
      acceptedRecipients: [],
      rejectedRecipients: [],
      smtpResponseCategory: category,
      // A 4xx (temporary failure) explicitly invites a retry — this project
      // never retries automatically (see module doc), so it is reported as
      // uncertain rather than a clean rejection, exactly like a genuine
      // connection-loss ambiguity.
      outcome: permanent ? 'rejected' : 'uncertain',
      deliveryUncertain: !permanent,
      reasons: [
        `The SMTP server returned a ${category} response` +
          (error.command ? ` to ${error.command}` : '') +
          '.',
      ],
    };
  }

  // No response code at all: a connection-level failure. Phase (via
  // `command`, which nodemailer/smtp-connection sets to the last command
  // attempted) determines whether anything was ever at risk of being
  // duplicated.
  if (error.command === undefined || error.command === 'CONN') {
    return {
      connectionEstablished: false,
      authenticated: false,
      submissionAttempted: false,
      acceptedRecipients: [],
      rejectedRecipients: [],
      smtpResponseCategory: null,
      outcome: 'failed',
      deliveryUncertain: false,
      reasons: [`Could not establish an SMTP connection${error.code ? ` (${error.code})` : ''}.`],
    };
  }
  if (error.command === 'AUTH') {
    return {
      connectionEstablished: true,
      authenticated: false,
      submissionAttempted: false,
      acceptedRecipients: [],
      rejectedRecipients: [],
      smtpResponseCategory: null,
      outcome: 'failed',
      deliveryUncertain: false,
      reasons: ['SMTP authentication failed.'],
    };
  }

  // MAIL FROM / RCPT TO / DATA / anything else after auth: the connection
  // was lost or timed out while a submission was in flight, with no
  // definitive server response — the exact case this project refuses to
  // guess about.
  return {
    connectionEstablished: true,
    authenticated: true,
    submissionAttempted: true,
    acceptedRecipients: [],
    rejectedRecipients: [],
    smtpResponseCategory: null,
    outcome: 'uncertain',
    deliveryUncertain: true,
    reasons: [
      `The connection was lost or timed out during ${error.command}${error.code ? ` (${error.code})` : ''}; ` +
        'delivery state is unknown and this was not retried automatically.',
    ],
  };
}
