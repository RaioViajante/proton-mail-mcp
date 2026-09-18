import { readFileSync } from 'node:fs';
import { createTransport, type Transporter } from 'nodemailer';
import type { ResolvedSmtpConfig } from './config.js';
import { resolveAndValidateLoopbackHost, type SmtpLookup } from './host-safety.js';
import {
  classifySmtpError,
  classifySmtpSuccess,
  type SmtpAttemptResult,
  type SmtpLikeError,
  type SmtpSuccessInfo,
} from './outcome.js';

/**
 * The real SMTP transport, backed by `nodemailer`. Built and unit-tested
 * against controlled fakes in 0.5.0 while `mail_send`'s live feature gate
 * kept it structurally unreachable — mirroring
 * `mutations/permanent-delete.ts`'s still-gated `expungeExactUids`. **As of
 * 0.5.1, that gate is lifted**: `src/smtp/send.ts`'s `sendMail` calls
 * `submitSmtp` below for real once every pre-submission check (consent,
 * intent, receipt, replay guard) has passed. See SECURITY.md ("Live SMTP
 * submission (0.5.1)").
 */

const SMTP_CONNECTION_TIMEOUT_MS = 10_000;
const SMTP_GREETING_TIMEOUT_MS = 10_000;
const SMTP_SOCKET_TIMEOUT_MS = 20_000;

function readTlsCertificate(tlsCertPath: string): string {
  try {
    return readFileSync(tlsCertPath, 'utf8');
  } catch {
    throw new Error(
      `Could not read the Proton Mail Bridge TLS certificate at ${tlsCertPath}. See README.md ` +
        '("TLS certificate setup") for the export steps.',
    );
  }
}

/**
 * Builds a one-shot (never pooled) `nodemailer` transporter for exactly the
 * Bridge account this config resolves to. TLS validation is never disabled
 * (`rejectUnauthorized` stays at its secure default; trust comes from
 * Bridge's own exported certificate via `tls.ca`, exactly like
 * `bridge/client.ts`'s IMAP connection). `requireTLS` is set for STARTTLS
 * mode specifically so a Bridge that unexpectedly doesn't advertise STARTTLS
 * fails the connection rather than silently falling back to plaintext — see
 * SECURITY.md ("No plaintext SMTP, ever"). `disableFileAccess`/
 * `disableUrlAccess` are defense in depth: 0.5.0 has no attachment support
 * to exploit, but this keeps a future nodemailer message option from ever
 * being able to read a local file or fetch a URL by surprise.
 */
export async function createSmtpTransport(
  config: ResolvedSmtpConfig,
  password: string,
  lookup?: SmtpLookup,
): Promise<Transporter> {
  // Nodemailer receives only the validated IP. It cannot resolve the
  // configured hostname a second time after validation.
  const target = await resolveAndValidateLoopbackHost(config.host, lookup);
  const ca = readTlsCertificate(config.tlsCertPath);
  return createTransport({
    host: target.address,
    port: config.port,
    secure: config.security === 'tls',
    requireTLS: config.security === 'starttls',
    tls: {
      ca: [ca],
      rejectUnauthorized: true,
      // Retain hostname verification for DNS names; omit SNI for IP literals.
      ...(target.servername ? { servername: target.servername } : {}),
    },
    auth: { user: config.username, pass: password },
    connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
    socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
    pool: false,
    disableFileAccess: true,
    disableUrlAccess: true,
    // Disabled: the default logger can emit SMTP traffic, which may include
    // message content or authentication frames — mirrors bridge/client.ts.
    logger: false,
  });
}

export interface SmtpMessage {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  /** 0.5.2 — reply threading headers. Always derived internally (`src/smtp/reply-intent.ts`'s `buildReplyMessage`); `mail_send` never sets these. */
  inReplyTo?: string;
  references?: string[];
}

/** Sends the live message. Overridable in tests so no test ever opens a real socket — mirrors `unsubscribe/execute.ts`'s injectable `OneClickSender`. */
export type SmtpSendFn = (
  transporter: Transporter,
  message: SmtpMessage,
) => Promise<SmtpSuccessInfo>;

/** Exported for direct unit testing of the `SmtpMessage` -> nodemailer options mapping (0.5.2) — every other test in `smtp-transport.test.ts` exercises `submitSmtp` with a custom `sendFn` that bypasses this function entirely. */
export async function defaultSmtpSend(
  transporter: Transporter,
  message: SmtpMessage,
): Promise<SmtpSuccessInfo> {
  return transporter.sendMail({
    from: message.from,
    to: message.to,
    cc: message.cc.length > 0 ? message.cc : undefined,
    subject: message.subject,
    text: message.text,
    ...(message.inReplyTo ? { inReplyTo: message.inReplyTo } : {}),
    ...(message.references && message.references.length > 0
      ? { references: message.references }
      : {}),
  });
}

function toSmtpLikeError(error: unknown): SmtpLikeError {
  if (error && typeof error === 'object') {
    const err = error as Record<string, unknown>;
    return {
      code: typeof err.code === 'string' ? err.code : undefined,
      command: typeof err.command === 'string' ? err.command : undefined,
      responseCode: typeof err.responseCode === 'number' ? err.responseCode : undefined,
      message: error instanceof Error ? error.message : undefined,
    };
  }
  return { message: 'Unknown SMTP error.' };
}

/**
 * Full submission attempt: build the transport, send once, classify the
 * outcome (`src/smtp/outcome.ts`), always close the transport. Never retries
 * — a failure of any kind, including an ambiguous one, is returned to the
 * caller exactly once; retrying automatically is exactly what this project
 * refuses to do (see SECURITY.md, "Duplicate sends are worse than an
 * uncertain result").
 */
export async function submitSmtp(
  config: ResolvedSmtpConfig,
  password: string,
  message: SmtpMessage,
  sendFn: SmtpSendFn = defaultSmtpSend,
  lookup?: SmtpLookup,
): Promise<SmtpAttemptResult> {
  let transporter: Transporter;
  try {
    transporter = await createSmtpTransport(config, password, lookup);
  } catch {
    return {
      connectionEstablished: false,
      authenticated: false,
      submissionAttempted: false,
      acceptedRecipients: [],
      rejectedRecipients: [],
      smtpResponseCategory: null,
      outcome: 'failed',
      deliveryUncertain: false,
      reasons: ['Could not create a safe SMTP transport.'],
    };
  }

  try {
    const info = await sendFn(transporter, message);
    return classifySmtpSuccess(info);
  } catch (error) {
    return classifySmtpError(toSmtpLikeError(error));
  } finally {
    transporter.close();
  }
}
