import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { type ResolvedSmtpConfig, SmtpConfigSchema } from '../smtp/config.js';

const execFileAsync = promisify(execFile);

/** macOS Keychain service name under which the Bridge IMAP password is stored. */
export const KEYCHAIN_SERVICE = 'proton-mail-mcp';

/**
 * macOS Keychain service/account under which the restore-receipt HMAC
 * signing secret is stored (0.4.2) — deliberately a *separate* Keychain
 * entry from `KEYCHAIN_SERVICE` above. This secret is not a credential to
 * any external system (unlike the Bridge password); it exists only so this
 * server can authenticate its own restore receipts to itself later. Reusing
 * the Bridge password as signing key material would tie two unrelated
 * secrets together for no benefit and would leak the receipt-signing
 * capability to anything that already has Bridge access. Provisioned by
 * `scripts/configure-receipt-signing.sh`; see `src/security/restore-receipt.ts`.
 */
export const RECEIPT_SIGNING_KEYCHAIN_SERVICE = 'proton-mail-mcp-receipt-signing';
export const RECEIPT_SIGNING_KEYCHAIN_ACCOUNT = 'restore-receipt-signing-key';

/**
 * macOS Keychain service/account under which the send-intent HMAC signing
 * secret is stored (0.5.0) — a *separate* Keychain entry from both
 * `KEYCHAIN_SERVICE` (the Bridge password) and
 * `RECEIPT_SIGNING_KEYCHAIN_SERVICE` (the restore-receipt secret). Signing
 * key material is never reused across unrelated purposes in this project —
 * see the identical reasoning on `RECEIPT_SIGNING_KEYCHAIN_SERVICE` above.
 * Provisioned by `scripts/configure-send-signing.sh`; see
 * `src/security/send-intent-receipt.ts`.
 */
export const SEND_SIGNING_KEYCHAIN_SERVICE = 'proton-mail-mcp-send-signing';
export const SEND_SIGNING_KEYCHAIN_ACCOUNT = 'send-intent-signing-key';

const BridgeConfigSchema = z.object({
  host: z.string().min(1).default('127.0.0.1'),
  port: z.number().int().positive(),
  username: z.string().min(1),
  tlsCertPath: z.string().min(1),
  // Bridge's own default IMAP connection mode is STARTTLS (secure: false —
  // ImapFlow upgrades the connection after the server advertises STARTTLS).
  // Set this to true only if you changed Bridge's Connection settings to SSL.
  secure: z.boolean().default(false),
  // Optional (0.5.0): a pre-0.5.0 config.json has no `smtp` key at all, and
  // must keep loading exactly as it did in 0.4.2 for every IMAP-only tool —
  // see src/smtp/config.ts's module doc. Only SMTP tools require it present.
  smtp: SmtpConfigSchema.optional(),
});

export type BridgeConfig = z.infer<typeof BridgeConfigSchema>;

export function getConfigDir(): string {
  return join(homedir(), '.config', 'proton-mail-mcp');
}

export function getConfigPath(): string {
  return join(getConfigDir(), 'config.json');
}

/**
 * Loads and validates the non-secret Bridge connection settings. Never
 * touches the Keychain — see {@link getBridgePassword} for the password.
 */
export function loadBridgeConfig(configPath: string = getConfigPath()): BridgeConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch {
    throw new Error(
      `Proton Mail Bridge configuration not found at ${configPath}. Run scripts/configure-bridge.sh first.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Proton Mail Bridge configuration at ${configPath} is not valid JSON.`);
  }

  const result = BridgeConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Proton Mail Bridge configuration at ${configPath} is invalid: ${issues}`);
  }

  return result.data;
}

/**
 * Retrieves the Bridge IMAP password from the macOS Keychain. The password
 * never touches disk and is never logged; on any failure a generic error is
 * thrown that deliberately discards the underlying `security` output, which
 * could otherwise echo account/service details in its stderr.
 */
export async function getBridgePassword(username: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password',
      '-a',
      username,
      '-s',
      KEYCHAIN_SERVICE,
      '-w',
    ]);
    const password = stdout.replace(/\r?\n+$/, '');
    if (password.length === 0) {
      throw new Error('empty credential');
    }
    return password;
  } catch {
    throw new Error(
      `Could not read the Bridge password from the macOS Keychain (service "${KEYCHAIN_SERVICE}", ` +
        `account "${username}"). Run scripts/configure-bridge.sh to store it.`,
    );
  }
}

/**
 * Retrieves the restore-receipt HMAC signing secret from the macOS Keychain
 * (0.4.2), as 32 raw bytes decoded from the hex string
 * `scripts/configure-receipt-signing.sh` stores there. Never touches disk,
 * never logged; on any failure (missing entry, wrong length, non-hex
 * content) a generic error is thrown that discards the underlying `security`
 * output, exactly like {@link getBridgePassword}.
 */
export async function getReceiptSigningSecret(): Promise<Buffer> {
  let hex: string;
  try {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password',
      '-a',
      RECEIPT_SIGNING_KEYCHAIN_ACCOUNT,
      '-s',
      RECEIPT_SIGNING_KEYCHAIN_SERVICE,
      '-w',
    ]);
    hex = stdout.replace(/\r?\n+$/, '');
  } catch {
    throw new Error(
      `Could not read the restore-receipt signing secret from the macOS Keychain (service ` +
        `"${RECEIPT_SIGNING_KEYCHAIN_SERVICE}"). Run scripts/configure-receipt-signing.sh to ` +
        'generate and store it.',
    );
  }
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error(
      `The restore-receipt signing secret in the macOS Keychain (service ` +
        `"${RECEIPT_SIGNING_KEYCHAIN_SERVICE}") is not a 32-byte hex value. Re-run ` +
        'scripts/configure-receipt-signing.sh to regenerate it.',
    );
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Same as {@link getReceiptSigningSecret}, but resolves to `undefined`
 * instead of throwing when the secret is not (yet) provisioned. Restore
 * receipts are an additive 0.4.2 capability, not a required upgrade step —
 * every tool that uses this must keep working exactly as it did in 0.4.1
 * for an install that has not run `scripts/configure-receipt-signing.sh`
 * yet, just without the stronger preservation guarantee a receipt provides.
 */
export async function getReceiptSigningSecretOrUndefined(): Promise<Buffer | undefined> {
  try {
    return await getReceiptSigningSecret();
  } catch {
    return undefined;
  }
}

/**
 * Resolves the full SMTP connection config (0.5.0): the `smtp` sub-config
 * plus the `username`/`tlsCertPath` it shares with the IMAP config, both
 * loaded from the one `config.json`. Throws with a message pointing at
 * `scripts/configure-bridge.sh` when `smtp` was never configured — an
 * install that only ever ran the pre-0.5.0 setup flow has no SMTP settings
 * at all, and this must fail closed rather than guess a host/port.
 */
export function loadSmtpConfig(configPath: string = getConfigPath()): ResolvedSmtpConfig {
  const config = loadBridgeConfig(configPath);
  if (!config.smtp) {
    throw new Error(
      `Proton Mail Bridge SMTP configuration not found at ${configPath}. Re-run ` +
        'scripts/configure-bridge.sh (0.5.0+) to add SMTP settings — the message-mutation and ' +
        'read-only tools do not require this, only mail_send / mail_send_preview.',
    );
  }
  return {
    host: config.smtp.host,
    port: config.smtp.port,
    security: config.smtp.security,
    username: config.username,
    tlsCertPath: config.tlsCertPath,
  };
}

/**
 * Retrieves the send-intent-receipt HMAC signing secret from the macOS
 * Keychain (0.5.0), the same 32-raw-bytes-from-hex shape as
 * {@link getReceiptSigningSecret}. Never touches disk, never logged; on any
 * failure a generic error is thrown that discards the underlying `security`
 * output, exactly like {@link getBridgePassword} and
 * {@link getReceiptSigningSecret}.
 */
export async function getSendIntentSigningSecret(): Promise<Buffer> {
  let hex: string;
  try {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password',
      '-a',
      SEND_SIGNING_KEYCHAIN_ACCOUNT,
      '-s',
      SEND_SIGNING_KEYCHAIN_SERVICE,
      '-w',
    ]);
    hex = stdout.replace(/\r?\n+$/, '');
  } catch {
    throw new Error(
      `Could not read the send-intent signing secret from the macOS Keychain (service ` +
        `"${SEND_SIGNING_KEYCHAIN_SERVICE}"). Run scripts/configure-send-signing.sh to generate ` +
        'and store it. Until then, mail_send_preview issues no sendIntentReceipt and live ' +
        'mail_send fails closed.',
    );
  }
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error(
      `The send-intent signing secret in the macOS Keychain (service ` +
        `"${SEND_SIGNING_KEYCHAIN_SERVICE}") is not a 32-byte hex value. Re-run ` +
        'scripts/configure-send-signing.sh to regenerate it.',
    );
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Same as {@link getSendIntentSigningSecret}, but resolves to `undefined`
 * instead of throwing when the secret is not (yet) provisioned — mirrors
 * {@link getReceiptSigningSecretOrUndefined}. `mail_send_preview` uses this
 * to decide whether it can issue a `sendIntentReceipt` at all; live
 * `mail_send` is unconditionally feature-gated in 0.5.0 regardless (see
 * `src/smtp/send.ts`), so an absent secret never silently weakens a live
 * send — there is no live send in this version to weaken.
 */
export async function getSendIntentSigningSecretOrUndefined(): Promise<Buffer | undefined> {
  try {
    return await getSendIntentSigningSecret();
  } catch {
    return undefined;
  }
}
