import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getConfigDir } from '../bridge/config.js';

/** One hour beyond the receipt expiry, to tolerate clock skew during cleanup. */
export const REPLAY_CLEANUP_MARGIN_MS = 60 * 60 * 1000;
const CLEANUP_SCAN_LIMIT = 64;
const MARKER_VERSION = 1;
type Purpose = 'send' | 'reply' | 'forward';

let testStateDir: string | undefined;
let cleanupOffset = 0;

export function getReplayStateDir(): string {
  return testStateDir ?? join(getConfigDir(), 'replay');
}

function splitKey(key: string): { purpose: Purpose; nonce: string } {
  if (key.startsWith('reply:')) return { purpose: 'reply', nonce: key.slice(6) };
  if (key.startsWith('forward:')) return { purpose: 'forward', nonce: key.slice(8) };
  return { purpose: 'send', nonce: key };
}

export function replayMarkerName(key: string): string {
  const { purpose, nonce } = splitKey(key);
  if (!/^[0-9a-f]{32}$/i.test(nonce)) throw new Error('Invalid replay nonce.');
  return createHash('sha256').update(purpose).update('\0').update(nonce).digest('hex');
}

function assertPrivateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error('Replay state directory is not private.');
  }
  if (process.getuid && stat.uid !== process.getuid()) {
    throw new Error('Replay state directory is not owned by this user.');
  }
}

function ensureReplayDirectory(stateDir: string): void {
  const parent = dirname(stateDir);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(parent);
  try {
    mkdirSync(stateDir, { mode: 0o700 });
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error;
  }
  assertPrivateDirectory(stateDir);
}

/** Read-only state availability check for doctor and mail_system_status. */
export function replayStateAvailable(stateDir: string = getReplayStateDir()): boolean {
  try {
    assertPrivateDirectory(dirname(stateDir));
    assertPrivateDirectory(stateDir);
    return true;
  } catch {
    return false;
  }
}

interface Marker {
  version: number;
  purpose: Purpose;
  consumedAt: number;
  expiresAt: number;
}

/** Best-effort, bounded, lazy cleanup. Malformed and partial markers remain consumed. */
export function cleanupExpiredReplayMarkers(
  stateDir: string = getReplayStateDir(),
  now: number = Date.now(),
): number {
  assertPrivateDirectory(stateDir);
  let removed = 0;
  const entries = readdirSync(stateDir, { withFileTypes: true });
  if (entries.length === 0) return 0;
  const start = cleanupOffset % entries.length;
  const count = Math.min(CLEANUP_SCAN_LIMIT, entries.length);
  cleanupOffset = (start + count) % entries.length;
  for (let inspected = 0; inspected < count; inspected++) {
    const entry = entries[(start + inspected) % entries.length]!;
    if (!entry.isFile() || !/^[0-9a-f]{64}$/.test(entry.name)) continue;
    const path = join(stateDir, entry.name);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) continue;
      const marker = JSON.parse(readFileSync(path, 'utf8')) as Marker;
      if (
        marker.version !== MARKER_VERSION ||
        !['send', 'reply', 'forward'].includes(marker.purpose) ||
        !Number.isFinite(marker.expiresAt) ||
        !Number.isFinite(marker.consumedAt) ||
        marker.expiresAt + REPLAY_CLEANUP_MARGIN_MS > now
      )
        continue;
      unlinkSync(path);
      removed++;
    } catch {
      // Incomplete, malformed, or concurrently changed markers are left in place.
    }
  }
  return removed;
}

export interface ReceiptNonceConsumption {
  consumed: boolean;
}

/**
 * Exclusive file creation is the only consume decision. A marker remains spent
 * even if writing/fsync fails or the process crashes before SMTP: at-most-once
 * authorization, not exactly-once delivery. No rollback is attempted.
 */
export function consumeReceiptNonce(
  id: string,
  expiresAt: number,
  now: number = Date.now(),
  stateDir: string = getReplayStateDir(),
): ReceiptNonceConsumption {
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new Error('Replay receipt expiry is invalid.');
  }
  const { purpose } = splitKey(id);
  const filename = replayMarkerName(id);
  ensureReplayDirectory(stateDir);
  const path = join(stateDir, filename);
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if ((error as { code?: string }).code === 'EEXIST') return { consumed: false };
    // Discard the OS error path so tool responses never reveal local state paths.
    // eslint-disable-next-line preserve-caught-error -- deliberately sanitized
    throw new Error('Could not atomically consume outbound receipt.');
  }
  try {
    const marker: Marker = { version: MARKER_VERSION, purpose, consumedAt: now, expiresAt };
    writeFileSync(fd, JSON.stringify(marker));
    fsyncSync(fd);
  } catch {
    throw new Error('Outbound receipt marker could not be persisted; receipt remains consumed.');
  } finally {
    closeSync(fd);
  }
  // Persist directory entry before any credential/SMTP work. Failure leaves
  // the exclusive marker in place and refuses this attempt.
  let directoryFd: number | undefined;
  try {
    directoryFd = openSync(stateDir, constants.O_RDONLY);
    fsyncSync(directoryFd);
  } catch {
    throw new Error('Outbound receipt directory could not be persisted; receipt remains consumed.');
  } finally {
    if (directoryFd !== undefined) closeSync(directoryFd);
  }
  // Cleanup is never a condition for a valid new authorization.
  try {
    cleanupExpiredReplayMarkers(stateDir, now);
  } catch {
    // Retry lazily on a later consume.
  }
  return { consumed: true };
}

/** Test-only isolation: each test gets a new private state directory. */
export function resetReplayGuardForTests(): void {
  if (testStateDir) rmSync(dirname(testStateDir), { recursive: true, force: true });
  const root = join(tmpdir(), `proton-mail-mcp-replay-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  testStateDir = join(root, 'replay');
  cleanupOffset = 0;
}
