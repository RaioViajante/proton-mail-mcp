import { describe, expect, it } from 'vitest';
import { hashBody } from '../src/smtp/intent.js';
import type { ReplyIntent } from '../src/smtp/reply-intent.js';
import {
  computeReplySourceFingerprint,
  receiptFieldsFromReplyIntent,
  REPLY_INTENT_RECEIPT_TTL_MS,
  REPLY_INTENT_RECEIPT_VERSION,
  signReplyIntentReceipt,
  validateReplyIntentReceipt,
} from '../src/security/reply-intent-receipt.js';
import {
  receiptFieldsFromIntent,
  signSendIntentReceipt,
} from '../src/security/send-intent-receipt.js';
import {
  receiptFieldsFromForwardIntent,
  signForwardIntentReceipt,
} from '../src/security/forward-intent-receipt.js';
import type { ForwardIntent } from '../src/smtp/forward-intent.js';

const SECRET = Buffer.from('d'.repeat(64), 'hex');
const OTHER_SECRET = Buffer.from('e'.repeat(64), 'hex');
const ISSUED_AT = '2026-09-17T00:00:00.000Z';
const NOW = Date.parse(ISSUED_AT) + 60_000;

const IDENTITY = {
  folder: 'INBOX',
  uidValidity: '12345',
  uid: 7,
  from: 'sender@example.com',
  subject: 'Hello',
  date: '2026-09-16T00:00:00.000Z',
  messageId: '<abc@example.com>',
};

function intent(overrides: Partial<ReplyIntent> = {}): ReplyIntent {
  const text = overrides.text ?? 'Thanks!';
  return {
    from: 'user@proton.me',
    to: 'sender@example.com',
    recipientSource: 'from',
    subject: 'Re: Hello',
    text,
    bodyLength: text.length,
    bodyHash: hashBody(text),
    sourceFolder: 'INBOX',
    threadingAvailable: true,
    inReplyTo: '<abc@example.com>',
    references: ['<abc@example.com>'],
    ...overrides,
  };
}

const THREADING_HASH = 'a'.repeat(64);

function makeReceipt(
  baseIntent: ReplyIntent,
  secret = SECRET,
  issuedAt = ISSUED_AT,
  fingerprint = computeReplySourceFingerprint(SECRET, IDENTITY),
  threadingHash = THREADING_HASH,
) {
  return signReplyIntentReceipt(
    secret,
    receiptFieldsFromReplyIntent(baseIntent, fingerprint, threadingHash, issuedAt),
  );
}

describe('mail_reply — valid receipt round-trip', () => {
  it('a receipt issued for an intent+fingerprint+threading verifies against those exact values', () => {
    const i = intent();
    const fingerprint = computeReplySourceFingerprint(SECRET, IDENTITY);
    const receipt = makeReceipt(i, SECRET, ISSUED_AT, fingerprint);
    const result = validateReplyIntentReceipt(receipt, SECRET, i, fingerprint, THREADING_HASH, NOW);
    expect(result.valid).toBe(true);
  });

  it('the receipt never contains the plaintext body or raw Message-ID', () => {
    const i = intent({ text: 'super secret payload', bodyHash: hashBody('super secret payload') });
    const fingerprint = computeReplySourceFingerprint(SECRET, IDENTITY);
    const receipt = makeReceipt(i, SECRET, ISSUED_AT, fingerprint);
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain('super secret payload');
    expect(serialized).not.toMatch(/"text"/);
    expect(serialized).not.toContain('<abc@example.com>');
  });
});

describe('mail_reply — source fingerprint (identity independent of Message-ID)', () => {
  it('is deterministic for identical inputs', () => {
    const a = computeReplySourceFingerprint(SECRET, IDENTITY);
    const b = computeReplySourceFingerprint(SECRET, IDENTITY);
    expect(a).toBe(b);
  });

  it('is fully computable with messageId: null — a missing Message-ID never blocks fingerprinting', () => {
    const fingerprint = computeReplySourceFingerprint(SECRET, { ...IDENTITY, messageId: null });
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs when the uid differs (identity, not just content, is bound)', () => {
    const a = computeReplySourceFingerprint(SECRET, IDENTITY);
    const b = computeReplySourceFingerprint(SECRET, { ...IDENTITY, uid: 8 });
    expect(a).not.toBe(b);
  });

  it('differs when uidValidity differs', () => {
    const a = computeReplySourceFingerprint(SECRET, IDENTITY);
    const b = computeReplySourceFingerprint(SECRET, { ...IDENTITY, uidValidity: '99999' });
    expect(a).not.toBe(b);
  });

  it('differs under a different secret (keyed, not a plain hash)', () => {
    const a = computeReplySourceFingerprint(SECRET, IDENTITY);
    const b = computeReplySourceFingerprint(OTHER_SECRET, IDENTITY);
    expect(a).not.toBe(b);
  });
});

describe('mail_reply — payload/source changed after preview', () => {
  it('text changed: rejected as intentMismatch', () => {
    const fingerprint = computeReplySourceFingerprint(SECRET, IDENTITY);
    const preview = intent({ text: 'original', bodyHash: hashBody('original') });
    const receipt = makeReceipt(preview, SECRET, ISSUED_AT, fingerprint);
    const live = intent({ text: 'tampered', bodyHash: hashBody('tampered') });
    expect(
      validateReplyIntentReceipt(receipt, SECRET, live, fingerprint, THREADING_HASH, NOW),
    ).toEqual({ valid: false, reason: 'intentMismatch' });
  });

  it('recipient changed: rejected as intentMismatch', () => {
    const fingerprint = computeReplySourceFingerprint(SECRET, IDENTITY);
    const preview = intent({ to: 'sender@example.com' });
    const receipt = makeReceipt(preview, SECRET, ISSUED_AT, fingerprint);
    const live = intent({ to: 'attacker@example.com' });
    expect(
      validateReplyIntentReceipt(receipt, SECRET, live, fingerprint, THREADING_HASH, NOW).valid,
    ).toBe(false);
  });

  it('source changed (different fingerprint at send time): rejected as intentMismatch', () => {
    const fingerprintAtPreview = computeReplySourceFingerprint(SECRET, IDENTITY);
    const i = intent();
    const receipt = makeReceipt(i, SECRET, ISSUED_AT, fingerprintAtPreview);
    const fingerprintAtSend = computeReplySourceFingerprint(SECRET, { ...IDENTITY, uid: 999 });
    expect(
      validateReplyIntentReceipt(receipt, SECRET, i, fingerprintAtSend, THREADING_HASH, NOW).valid,
    ).toBe(false);
  });

  it('threading changed (different threadingHash at send time): rejected as intentMismatch', () => {
    const fingerprint = computeReplySourceFingerprint(SECRET, IDENTITY);
    const i = intent();
    const receipt = makeReceipt(i, SECRET, ISSUED_AT, fingerprint, 'b'.repeat(64));
    expect(
      validateReplyIntentReceipt(receipt, SECRET, i, fingerprint, 'c'.repeat(64), NOW).valid,
    ).toBe(false);
  });
});

describe('mail_reply — receipt fail-closed rejection', () => {
  it('malformed receipt: rejected', () => {
    const i = intent();
    const fingerprint = computeReplySourceFingerprint(SECRET, IDENTITY);
    expect(
      validateReplyIntentReceipt({ garbage: true }, SECRET, i, fingerprint, THREADING_HASH, NOW),
    ).toEqual({ valid: false, reason: 'malformedReceipt' });
  });

  it('receipt with reply-all shape (to as array) is malformed — schema requires a single string', () => {
    const i = intent();
    const fingerprint = computeReplySourceFingerprint(SECRET, IDENTITY);
    const receipt = makeReceipt(i, SECRET, ISSUED_AT, fingerprint);
    const tampered = { ...receipt, to: ['a@example.com', 'b@example.com'] };
    expect(
      validateReplyIntentReceipt(tampered, SECRET, i, fingerprint, THREADING_HASH, NOW),
    ).toEqual({ valid: false, reason: 'malformedReceipt' });
  });

  it('signature tampered: signatureInvalid', () => {
    const i = intent();
    const fingerprint = computeReplySourceFingerprint(SECRET, IDENTITY);
    const receipt = { ...makeReceipt(i, SECRET, ISSUED_AT, fingerprint), subject: 'Injected' };
    const tamperedIntent = intent({ subject: 'Injected' });
    expect(
      validateReplyIntentReceipt(receipt, SECRET, tamperedIntent, fingerprint, THREADING_HASH, NOW),
    ).toEqual({ valid: false, reason: 'signatureInvalid' });
  });

  it('receipt signed under a different key: signatureInvalid', () => {
    const i = intent();
    const fingerprint = computeReplySourceFingerprint(SECRET, IDENTITY);
    const receipt = makeReceipt(i, OTHER_SECRET, ISSUED_AT, fingerprint);
    expect(
      validateReplyIntentReceipt(receipt, SECRET, i, fingerprint, THREADING_HASH, NOW),
    ).toEqual({ valid: false, reason: 'signatureInvalid' });
  });

  it('signing secret unavailable: fails closed', () => {
    const i = intent();
    const fingerprint = computeReplySourceFingerprint(SECRET, IDENTITY);
    const receipt = makeReceipt(i, SECRET, ISSUED_AT, fingerprint);
    expect(
      validateReplyIntentReceipt(receipt, undefined, i, fingerprint, THREADING_HASH, NOW),
    ).toEqual({ valid: false, reason: 'signingSecretUnavailable' });
  });

  it('expired receipt: rejected', () => {
    const i = intent();
    const fingerprint = computeReplySourceFingerprint(SECRET, IDENTITY);
    const receipt = makeReceipt(i, SECRET, ISSUED_AT, fingerprint);
    const wayLater = Date.parse(ISSUED_AT) + REPLY_INTENT_RECEIPT_TTL_MS + 1;
    expect(
      validateReplyIntentReceipt(receipt, SECRET, i, fingerprint, THREADING_HASH, wayLater),
    ).toEqual({ valid: false, reason: 'expired' });
  });
});

describe('REPLY_INTENT_RECEIPT_VERSION', () => {
  it('is 1', () => {
    expect(REPLY_INTENT_RECEIPT_VERSION).toBe(1);
  });
});

describe('cross-purpose receipt rejection (section 27/39 — wrong purpose)', () => {
  it('a valid sendIntentReceipt does NOT verify as a replyIntentReceipt', () => {
    const sendIntent = {
      from: 'user@proton.me',
      to: ['sender@example.com'],
      cc: [],
      subject: 'Re: Hello',
      text: 'Thanks!',
      bodyLength: 7,
      bodyHash: hashBody('Thanks!'),
    };
    const sendReceipt = signSendIntentReceipt(
      SECRET,
      receiptFieldsFromIntent(sendIntent, ISSUED_AT),
    );
    const i = intent();
    const fingerprint = computeReplySourceFingerprint(SECRET, IDENTITY);
    // Even ignoring the schema mismatch (to: array vs string), the signature
    // was produced under a different domain-separated key entirely.
    const result = validateReplyIntentReceipt(
      sendReceipt,
      SECRET,
      i,
      fingerprint,
      THREADING_HASH,
      NOW,
    );
    expect(result.valid).toBe(false);
  });

  it('a valid forwardIntentReceipt does NOT verify as a replyIntentReceipt', () => {
    const forwardIntent: ForwardIntent = {
      from: 'user@proton.me',
      to: ['a@example.com'],
      subject: 'Fwd: Hello',
      introText: '',
      forwardedBlock: 'block',
      text: 'block',
      bodyLength: 5,
      introHash: hashBody(''),
      forwardedContentHash: hashBody('block'),
      sourceFolder: 'INBOX',
      sourceHasAttachments: false,
    };
    const forwardReceipt = signForwardIntentReceipt(
      SECRET,
      receiptFieldsFromForwardIntent(forwardIntent, 'f'.repeat(64), ISSUED_AT),
    );
    const i = intent();
    const fingerprint = computeReplySourceFingerprint(SECRET, IDENTITY);
    expect(
      validateReplyIntentReceipt(forwardReceipt, SECRET, i, fingerprint, THREADING_HASH, NOW).valid,
    ).toBe(false);
  });
});
