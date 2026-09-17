import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  getBridgePassword,
  getConfigDir,
  getConfigPath,
  getReceiptSigningSecret,
  getSendIntentSigningSecret,
  loadBridgeConfig,
  type BridgeConfig,
} from '../bridge/config.js';
import { withBridgeConnection } from '../bridge/client.js';
import { getReplayStateDir } from '../security/send-intent-replay-guard.js';
import { checkSmtpHostStructurallySafe } from '../smtp/host-safety.js';
import { SERVER_VERSION } from '../version.js';

export type CheckStatus = 'PASS' | 'WARN' | 'FAIL' | 'NOT_CHECKED';
export interface DoctorCheck {
  id: string;
  status: CheckStatus;
  detail: string;
}
export interface DoctorReport {
  version: string;
  healthy: boolean;
  checks: DoctorCheck[];
}

export function doctorExitCode(report: DoctorReport): number {
  return report.healthy ? 0 : 1;
}

export function renderDoctorReport(report: DoctorReport, json: boolean): string {
  if (json) return JSON.stringify(report, null, 2) + '\n';
  return (
    [
      `proton-mail-mcp doctor ${report.version}`,
      ...report.checks.map((check) => `${check.status.padEnd(11)} ${check.id}: ${check.detail}`),
    ].join('\n') + '\n'
  );
}
export interface DoctorOptions {
  platform?: string;
  nodeVersion?: string;
  configPath?: string;
  configDir?: string;
  replayDir?: string;
  entrypointPath?: string;
  loadConfig?: (path: string) => BridgeConfig;
  bridgeCredential?: (username: string) => Promise<unknown>;
  restoreSecret?: () => Promise<unknown>;
  sendSecret?: () => Promise<unknown>;
  imapProbe?: () => Promise<unknown>;
  processProbe?: () => Promise<boolean>;
}

const defaultEntrypoint = fileURLToPath(new URL('../index.js', import.meta.url));
const execFileAsync = promisify(execFile);

function privateMode(path: string, mode: number): boolean {
  try {
    const stat = lstatSync(path);
    return (
      !stat.isSymbolicLink() &&
      (stat.mode & 0o777) === mode &&
      (!process.getuid || stat.uid === process.getuid())
    );
  } catch {
    return false;
  }
}

/** All details are fixed strings; dependency errors are deliberately discarded. */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const add = (id: string, status: CheckStatus, detail: string) =>
    checks.push({ id, status, detail });
  const currentPlatform = options.platform ?? platform();
  add(
    'platform',
    currentPlatform === 'darwin' ? 'PASS' : 'FAIL',
    currentPlatform === 'darwin'
      ? 'macOS supported'
      : 'proton-mail-mcp 0.6.0 currently supports macOS only.',
  );
  const major = Number.parseInt(
    (options.nodeVersion ?? process.versions.node).split('.')[0] ?? '',
    10,
  );
  add('node', major >= 24 ? 'PASS' : 'FAIL', major >= 24 ? 'Node >=24' : 'Node >=24 required');
  add('version', 'PASS', SERVER_VERSION);
  const configDir = options.configDir ?? getConfigDir();
  const configPath = options.configPath ?? getConfigPath();
  const replayDir = options.replayDir ?? getReplayStateDir();
  const entrypoint = options.entrypointPath ?? defaultEntrypoint;
  add(
    'configDirectory',
    privateMode(configDir, 0o700) ? 'PASS' : 'WARN',
    'Expected owner-only directory (0700)',
  );
  add(
    'configFile',
    existsSync(configPath) ? 'PASS' : 'FAIL',
    existsSync(configPath) ? 'present' : 'missing',
  );
  add(
    'configPermissions',
    privateMode(configPath, 0o600) ? 'PASS' : 'WARN',
    'Expected private file (0600)',
  );
  let config: BridgeConfig | undefined;
  try {
    config = (options.loadConfig ?? loadBridgeConfig)(configPath);
    add('configParse', 'PASS', 'valid');
  } catch {
    add('configParse', 'FAIL', 'invalid or unavailable');
  }
  if (config) {
    add(
      'imapConfig',
      config.host && config.port && config.username ? 'PASS' : 'FAIL',
      'connection settings checked',
    );
    add('smtpConfig', config.smtp ? 'PASS' : 'FAIL', config.smtp ? 'configured' : 'missing');
    add(
      'smtpHost',
      config.smtp && checkSmtpHostStructurallySafe(config.smtp.host).safe ? 'PASS' : 'FAIL',
      config.smtp ? 'loopback policy checked' : 'SMTP unavailable',
    );
    add(
      'certificateExists',
      existsSync(config.tlsCertPath) ? 'PASS' : 'FAIL',
      existsSync(config.tlsCertPath) ? 'present' : 'missing',
    );
    let readable = false;
    try {
      accessSync(config.tlsCertPath, constants.R_OK);
      readable = true;
    } catch {
      /* read-only check */
    }
    add('certificateReadable', readable ? 'PASS' : 'FAIL', readable ? 'readable' : 'unreadable');
    add(
      'certificatePermissions',
      privateMode(config.tlsCertPath, 0o600) ? 'PASS' : 'WARN',
      'Expected private certificate file (0600)',
    );
    try {
      await (options.bridgeCredential ?? getBridgePassword)(config.username);
      add('bridgeCredential', 'PASS', 'available in Keychain');
    } catch {
      add('bridgeCredential', 'FAIL', 'unavailable in Keychain');
    }
  } else {
    for (const id of [
      'imapConfig',
      'smtpConfig',
      'smtpHost',
      'certificateExists',
      'certificateReadable',
      'certificatePermissions',
      'bridgeCredential',
    ]) {
      add(id, 'NOT_CHECKED', 'requires valid config');
    }
  }
  try {
    await (options.restoreSecret ?? getReceiptSigningSecret)();
    add('restoreSecret', 'PASS', 'available in Keychain');
  } catch {
    add('restoreSecret', 'FAIL', 'unavailable in Keychain');
  }
  try {
    await (options.sendSecret ?? getSendIntentSigningSecret)();
    add('sendSecret', 'PASS', 'available in Keychain');
  } catch {
    add('sendSecret', 'FAIL', 'unavailable in Keychain');
  }
  add(
    'replayDirectory',
    existsSync(replayDir) ? 'PASS' : 'FAIL',
    existsSync(replayDir) ? 'present' : 'missing',
  );
  add(
    'replayPermissions',
    privateMode(replayDir, 0o700) && privateMode(dirname(replayDir), 0o700) ? 'PASS' : 'FAIL',
    'Expected owner-only state directories (0700)',
  );
  add(
    'entrypoint',
    existsSync(entrypoint) ? 'PASS' : 'FAIL',
    existsSync(entrypoint) ? 'present' : 'missing',
  );
  try {
    const found = await (
      options.processProbe ??
      (async () => {
        await execFileAsync('pgrep', ['-f', 'Proton Mail Bridge']);
        return true;
      })
    )();
    add(
      'bridgeProcess',
      found ? 'PASS' : 'WARN',
      found ? 'Bridge process detected' : 'Bridge process not detected',
    );
  } catch {
    add('bridgeProcess', 'NOT_CHECKED', 'process probe unavailable');
  }
  if (config) {
    try {
      await (options.imapProbe ?? (() => withBridgeConnection(() => Promise.resolve(true))))();
      add('imapConnectivity', 'PASS', 'Bridge IMAP connection succeeded');
    } catch {
      add('imapConnectivity', 'FAIL', 'Bridge IMAP connection unavailable');
    }
  } else {
    add('imapConnectivity', 'NOT_CHECKED', 'requires valid config');
  }
  add('smtpConnectivity', 'NOT_CHECKED', 'no SMTP connection made');
  return { version: SERVER_VERSION, healthy: !checks.some((c) => c.status === 'FAIL'), checks };
}
