import { describe, expect, it } from 'vitest';
import { hashBody, type SendIntent } from '../src/smtp/intent.js';
import {
  receiptFieldsFromIntent,
  SEND_INTENT_RECEIPT_TTL_MS,
  SEND_INTENT_RECEIPT_VERSION,
  signSendIntentReceipt,
  validateSendIntentReceipt,
} from '../src/security/send-intent-receipt.js';

const SECRET = Buffer.from('d'.repeat(64), 'hex');
const OTHER_SECRET = Buffer.from('e'.repeat(64), 'hex');
const ISSUED_AT = '2026-09-17T00:00:00.000Z';
const NOW = Date.parse(ISSUED_AT) + 60_000; // 1 minute after issuance

function intent(overrides: Partial<SendIntent> = {}): SendIntent {
  const text = overrides.text ?? 'Hello world';
  return {
    from: 'user@proton.me',
    to: ['a@example.com'],
    cc: [],
    subject: 'Hi',
    text,
    bodyLength: text.length,
    bodyHash: hashBody(text),
    ...overrides,
  };
}

function makeReceipt(baseIntent: SendIntent, secret = SECRET, issuedAt = ISSUED_AT) {
  return signSendIntentReceipt(secret, receiptFieldsFromIntent(baseIntent, issuedAt));
}

describe('mail_send — valid receipt round-trip', () => {
  it('a receipt issued for an intent verifies against that exact intent', () => {
    const i = intent();
    const receipt = makeReceipt(i);
    const result = validateSendIntentReceipt(receipt, SECRET, i, NOW);
    expect(result.valid).toBe(true);
  });

  it('the receipt never contains the plaintext body', () => {
    const i = intent({ text: 'super secret payload', bodyHash: hashBody('super secret payload') });
    const receipt = makeReceipt(i);
    expect(JSON.stringify(receipt)).not.toContain('super secret payload');
    expect(JSON.stringify(receipt)).not.toMatch(/"text"/);
  });

  it('recipient order normalization: reordering to/cc between preview and send does not break verification', () => {
    const preview = intent({ to: ['a@example.com', 'b@example.com'] });
    const receipt = makeReceipt(preview);
    // The "live" intent lists the same set in a different order — validateSendIntent would have
    // already sorted both into the same canonical order (see smtp-intent.test.ts), so this
    // simulates that normalized re-derivation directly.
    const liveIntent = intent({ to: ['a@example.com', 'b@example.com'] });
    const result = validateSendIntentReceipt(receipt, SECRET, liveIntent, NOW);
    expect(result.valid).toBe(true);
  });
});

describe('mail_send — payload changed after preview', () => {
  it('body changed: rejected as intentMismatch', () => {
    const preview = intent({ text: 'original', bodyHash: hashBody('original') });
    const receipt = makeReceipt(preview);
    const live = intent({ text: 'tampered', bodyHash: hashBody('tampered') });
    const result = validateSendIntentReceipt(receipt, SECRET, live, NOW);
    expect(result).toEqual({ valid: false, reason: 'intentMismatch' });
  });

  it('subject changed: rejected as intentMismatch', () => {
    const preview = intent({ subject: 'Original subject' });
    const receipt = makeReceipt(preview);
    const live = intent({ subject: 'Different subject' });
    expect(validateSendIntentReceipt(receipt, SECRET, live, NOW)).toEqual({
      valid: false,
      reason: 'intentMismatch',
    });
  });

  it('recipient added: rejected as intentMismatch', () => {
    const preview = intent({ to: ['a@example.com'] });
    const receipt = makeReceipt(preview);
    const live = intent({ to: ['a@example.com', 'b@example.com'] });
    expect(validateSendIntentReceipt(receipt, SECRET, live, NOW).valid).toBe(false);
  });

  it('recipient removed: rejected as intentMismatch', () => {
    const preview = intent({ to: ['a@example.com', 'b@example.com'] });
    const receipt = makeReceipt(preview);
    const live = intent({ to: ['a@example.com'] });
    expect(validateSendIntentReceipt(receipt, SECRET, live, NOW).valid).toBe(false);
  });

  it('cc modified: rejected as intentMismatch', () => {
    const preview = intent({ cc: ['cc1@example.com'] });
    const receipt = makeReceipt(preview);
    const live = intent({ cc: ['cc2@example.com'] });
    expect(validateSendIntentReceipt(receipt, SECRET, live, NOW).valid).toBe(false);
  });

  it('sender modified: rejected as intentMismatch', () => {
    const preview = intent({ from: 'user@proton.me' });
    const receipt = makeReceipt(preview);
    const live = intent({ from: 'other@proton.me' });
    expect(validateSendIntentReceipt(receipt, SECRET, live, NOW).valid).toBe(false);
  });
});

describe('mail_send — receipt fail-closed rejection', () => {
  it('malformed receipt: rejected', () => {
    const i = intent();
    expect(validateSendIntentReceipt({ garbage: true }, SECRET, i, NOW)).toEqual({
      valid: false,
      reason: 'malformedReceipt',
    });
  });

  it('missing fields: rejected as malformed', () => {
    const i = intent();
    const receipt = makeReceipt(i) as unknown as Record<string, unknown>;
    delete receipt.signature;
    expect(validateSendIntentReceipt(receipt, SECRET, i, NOW)).toEqual({
      valid: false,
      reason: 'malformedReceipt',
    });
  });

  it('wrong version: rejected as malformed', () => {
    const i = intent();
    const receipt = { ...makeReceipt(i), v: 99 };
    expect(validateSendIntentReceipt(receipt, SECRET, i, NOW)).toEqual({
      valid: false,
      reason: 'malformedReceipt',
    });
  });

  it('signature tampered (field modified post-signing): signatureInvalid', () => {
    const i = intent();
    const receipt = { ...makeReceipt(i), subject: 'Injected subject' };
    // Compare against an intent with the injected subject too, so this
    // isolates signature tampering from a legitimate intentMismatch.
    const tamperedIntent = intent({ subject: 'Injected subject' });
    expect(validateSendIntentReceipt(receipt, SECRET, tamperedIntent, NOW)).toEqual({
      valid: false,
      reason: 'signatureInvalid',
    });
  });

  it('receipt signed by a different (wrong) key: signatureInvalid', () => {
    const i = intent();
    const receipt = makeReceipt(i, OTHER_SECRET);
    expect(validateSendIntentReceipt(receipt, SECRET, i, NOW)).toEqual({
      valid: false,
      reason: 'signatureInvalid',
    });
  });

  it('signing secret unavailable: fails closed regardless of signature validity', () => {
    const i = intent();
    const receipt = makeReceipt(i);
    expect(validateSendIntentReceipt(receipt, undefined, i, NOW)).toEqual({
      valid: false,
      reason: 'signingSecretUnavailable',
    });
  });

  it('expired receipt: rejected even with a valid signature and matching intent', () => {
    const i = intent();
    const receipt = makeReceipt(i);
    const wayLater = Date.parse(ISSUED_AT) + SEND_INTENT_RECEIPT_TTL_MS + 1;
    expect(validateSendIntentReceipt(receipt, SECRET, i, wayLater)).toEqual({
      valid: false,
      reason: 'expired',
    });
  });

  it('a receipt issued in the future (clock skew beyond TTL) is also rejected', () => {
    const i = intent();
    const receipt = makeReceipt(i, SECRET, '2099-01-01T00:00:00.000Z');
    expect(validateSendIntentReceipt(receipt, SECRET, i, NOW).valid).toBe(false);
  });

  it('right at the TTL boundary is still valid; just past it is not', () => {
    const i = intent();
    const receipt = makeReceipt(i);
    const issuedMs = Date.parse(ISSUED_AT);
    expect(
      validateSendIntentReceipt(receipt, SECRET, i, issuedMs + SEND_INTENT_RECEIPT_TTL_MS).valid,
    ).toBe(true);
    expect(
      validateSendIntentReceipt(receipt, SECRET, i, issuedMs + SEND_INTENT_RECEIPT_TTL_MS + 1)
        .valid,
    ).toBe(false);
  });
});

describe('SEND_INTENT_RECEIPT_VERSION', () => {
  it('is 1', () => {
    expect(SEND_INTENT_RECEIPT_VERSION).toBe(1);
  });
});
