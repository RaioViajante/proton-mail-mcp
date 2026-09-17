import { beforeEach, describe, expect, it } from 'vitest';
import {
  consumeReceiptNonce,
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

  it('an id is eligible for pruning once its own expiry passes, and behaves as unconsumed again after being pruned', () => {
    const expiresAt = NOW + TTL_MS;
    consumeReceiptNonce('c'.repeat(32), expiresAt, NOW);
    // Just before expiry: still refused (still tracked).
    const stillTracked = consumeReceiptNonce('c'.repeat(32), expiresAt, expiresAt - 1);
    expect(stillTracked.consumed).toBe(false);
    // At/after its own expiry, the entry is pruned as stale bookkeeping —
    // this is safe because the receipt itself would independently fail
    // `validateSendIntentReceipt`'s own expiry check by then, so nothing
    // can actually be replayed through this path; it only bounds this
    // module's memory to the TTL window.
    const afterExpiry = consumeReceiptNonce('c'.repeat(32), expiresAt, expiresAt + 1);
    expect(afterExpiry.consumed).toBe(true);
  });

  it('resetReplayGuardForTests clears all in-memory state', () => {
    consumeReceiptNonce('d'.repeat(32), NOW + TTL_MS, NOW);
    resetReplayGuardForTests();
    const result = consumeReceiptNonce('d'.repeat(32), NOW + TTL_MS, NOW);
    expect(result.consumed).toBe(true);
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
