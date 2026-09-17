import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  cleanupExpiredReplayMarkers,
  consumeReceiptNonce,
  getReplayStateDir,
  replayMarkerName,
  resetReplayGuardForTests,
} from '../src/security/send-intent-replay-guard.js';

const NOW = Date.parse('2026-09-17T00:00:00.000Z');
const TTL_MS = 15 * 60 * 1000;

describe('consumeReceiptNonce', () => {
  beforeEach(() => {
    resetReplayGuardForTests();
  });

  it('the first presentation of an id is consumed', () => {
    const result = consumeReceiptNonce('a'.repeat(32), NOW + TTL_MS, NOW);
    expect(result.consumed).toBe(true);
  });

  it('a second presentation of the same id is refused', () => {
    consumeReceiptNonce('a'.repeat(32), NOW + TTL_MS, NOW);
    const second = consumeReceiptNonce('a'.repeat(32), NOW + TTL_MS, NOW + 1);
    expect(second.consumed).toBe(false);
  });

  it('two different ids are each independently consumable', () => {
    const first = consumeReceiptNonce('a'.repeat(32), NOW + TTL_MS, NOW);
    const second = consumeReceiptNonce('b'.repeat(32), NOW + TTL_MS, NOW);
    expect(first.consumed).toBe(true);
    expect(second.consumed).toBe(true);
  });

  it('an expired receipt remains invalid; cleanup only removes an old marker after the safety margin', () => {
    const expiresAt = NOW + TTL_MS;
    consumeReceiptNonce('c'.repeat(32), expiresAt, NOW);
    const stillTracked = consumeReceiptNonce('c'.repeat(32), expiresAt, expiresAt - 1);
    expect(stillTracked.consumed).toBe(false);
    expect(cleanupExpiredReplayMarkers(getReplayStateDir(), expiresAt + 1)).toBe(0);
    expect(cleanupExpiredReplayMarkers(getReplayStateDir(), expiresAt + 60 * 60 * 1000)).toBe(1);
    expect(() => consumeReceiptNonce('c'.repeat(32), expiresAt, expiresAt + 1)).toThrow();
  });

  it('resetReplayGuardForTests clears all in-memory state', () => {
    consumeReceiptNonce('d'.repeat(32), NOW + TTL_MS, NOW);
    resetReplayGuardForTests();
    const result = consumeReceiptNonce('d'.repeat(32), NOW + TTL_MS, NOW);
    expect(result.consumed).toBe(true);
  });
});

describe('durable replay state', () => {
  beforeEach(() => resetReplayGuardForTests());

  it('uses private files with no receipt or mail fields, and survives a new call context', () => {
    const id = 'a1'.repeat(16);
    const stateDir = getReplayStateDir();
    expect(consumeReceiptNonce(id, NOW + TTL_MS, NOW).consumed).toBe(true);
    const files = readdirSync(stateDir);
    expect(files).toEqual([replayMarkerName(id)]);
    expect(statSync(stateDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(stateDir, files[0]!)).mode & 0o777).toBe(0o600);
    const data = readFileSync(join(stateDir, files[0]!), 'utf8');
    expect(data).not.toContain(id);
    expect(data).not.toMatch(/recipient|subject|body|receipt|@/i);
    expect(consumeReceiptNonce(id, NOW + TTL_MS, NOW + 1, stateDir).consumed).toBe(false);
  });

  it('a malformed or crash-style partial marker blocks reuse and is not cleaned', () => {
    const id = 'b1'.repeat(16);
    const stateDir = getReplayStateDir();
    consumeReceiptNonce(id, NOW + TTL_MS, NOW);
    const file = join(stateDir, replayMarkerName(id));
    writeFileSync(file, '{', { mode: 0o600 });
    expect(consumeReceiptNonce(id, NOW + TTL_MS, NOW + 1, stateDir).consumed).toBe(false);
    expect(cleanupExpiredReplayMarkers(stateDir, NOW + TTL_MS + 10000000)).toBe(0);
  });

  it('only one independent Node process consumes the same receipt', async () => {
    execFileSync('pnpm', ['build'], { stdio: 'ignore' });
    const root = mkdtempSync(join(tmpdir(), 'replay-process-test-'));
    const stateDir = join(root, 'replay');
    const moduleUrl = pathToFileURL(
      join(process.cwd(), 'dist/security/send-intent-replay-guard.js'),
    ).href;
    const code = `import { consumeReceiptNonce } from ${JSON.stringify(moduleUrl)};
      await new Promise(resolve => setTimeout(resolve, 100));
      process.stdout.write(String(consumeReceiptNonce('c1'.repeat(16), Date.now()+900000, Date.now(), process.argv[1]).consumed));`;
    const run = () =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', code, stateDir]);
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.on('error', reject);
        child.on('close', (exit) =>
          exit === 0 ? resolve(output) : reject(new Error('child failed')),
        );
      });
    try {
      const results = await Promise.all([run(), run()]);
      expect(results.sort()).toEqual(['false', 'true']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('0.5.2 — purpose-prefixed nonces (reply/forward share this module, unmodified)', () => {
  beforeEach(() => {
    resetReplayGuardForTests();
  });

  it('the same 32-hex id, prefixed differently for send/reply/forward, is independently consumable under each prefix', () => {
    const id = 'e'.repeat(32);
    const send = consumeReceiptNonce(id, NOW + TTL_MS, NOW);
    const reply = consumeReceiptNonce(`reply:${id}`, NOW + TTL_MS, NOW);
    const forward = consumeReceiptNonce(`forward:${id}`, NOW + TTL_MS, NOW);
    expect(send.consumed).toBe(true);
    expect(reply.consumed).toBe(true);
    expect(forward.consumed).toBe(true);
  });

  it('a reply nonce cannot be replayed under the reply prefix once consumed', () => {
    const id = `reply:${'f'.repeat(32)}`;
    consumeReceiptNonce(id, NOW + TTL_MS, NOW);
    const second = consumeReceiptNonce(id, NOW + TTL_MS, NOW + 1);
    expect(second.consumed).toBe(false);
  });

  it('a forward nonce cannot be replayed under the forward prefix once consumed', () => {
    const id = `forward:${'a1'.repeat(16)}`;
    consumeReceiptNonce(id, NOW + TTL_MS, NOW);
    const second = consumeReceiptNonce(id, NOW + TTL_MS, NOW + 1);
    expect(second.consumed).toBe(false);
  });

  it('consuming a reply-prefixed nonce does not consume the same bare id (send) or forward-prefixed id', () => {
    const bareId = 'b2'.repeat(16);
    consumeReceiptNonce(`reply:${bareId}`, NOW + TTL_MS, NOW);
    expect(consumeReceiptNonce(bareId, NOW + TTL_MS, NOW).consumed).toBe(true);
    expect(consumeReceiptNonce(`forward:${bareId}`, NOW + TTL_MS, NOW).consumed).toBe(true);
  });

  it('concurrency: two "simultaneous" consume calls for the identical prefixed id — only the first wins', () => {
    const id = `reply:${'c3'.repeat(16)}`;
    const results = [
      consumeReceiptNonce(id, NOW + TTL_MS, NOW),
      consumeReceiptNonce(id, NOW + TTL_MS, NOW),
    ];
    const consumedCount = results.filter((r) => r.consumed).length;
    expect(consumedCount).toBe(1);
  });
});
