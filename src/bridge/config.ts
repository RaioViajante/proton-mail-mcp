import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

/** macOS Keychain service name under which the Bridge IMAP password is stored. */
export const KEYCHAIN_SERVICE = 'proton-mail-mcp';

const BridgeConfigSchema = z.object({
  host: z.string().min(1).default('127.0.0.1'),
  port: z.number().int().positive(),
  username: z.string().min(1),
  tlsCertPath: z.string().min(1),
  // Bridge's own default IMAP connection mode is STARTTLS (secure: false —
  // ImapFlow upgrades the connection after the server advertises STARTTLS).
  // Set this to true only if you changed Bridge's Connection settings to SSL.
  secure: z.boolean().default(false),
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
