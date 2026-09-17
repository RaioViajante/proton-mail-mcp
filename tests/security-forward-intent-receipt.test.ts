import { describe, expect, it } from 'vitest';
import { hashBody } from '../src/smtp/intent.js';
import type { ForwardIntent } from '../src/smtp/forward-intent.js';
import {
  computeForwardSourceFingerprint,
  FORWARD_INTENT_RECEIPT_TTL_MS,
  FORWARD_INTENT_RECEIPT_VERSION,
  receiptFieldsFromForwardIntent,
  signForwardIntentReceipt,
  validateForwardIntentReceipt,
} from '../src/security/forward-intent-receipt.js';
import {
  receiptFieldsFromIntent,
  signSendIntentReceipt,
} from '../src/security/send-intent-receipt.js';
import {
  computeReplySourceFingerprint,
  receiptFieldsFromReplyIntent,
  signReplyIntentReceipt,
} from '../src/security/reply-intent-receipt.js';
import type { ReplyIntent } from '../src/smtp/reply-intent.js';

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

function intent(overrides: Partial<ForwardIntent> = {}): ForwardIntent {
  const forwardedBlock =
    overrides.forwardedBlock ?? '---------- Forwarded message ----------\nbody';
  const introText = overrides.introText ?? '';
  const text = introText.length > 0 ? `${introText}\n\n${forwardedBlock}` : forwardedBlock;
  return {
    from: 'user@proton.me',
    to: ['a@example.com'],
    subject: 'Fwd: Hello',
    introText,
    forwardedBlock,
    text,
    bodyLength: text.length,
    introHash: hashBody(introText),
    forwardedContentHash: hashBody(forwardedBlock),
    sourceFolder: 'INBOX',
    sourceHasAttachments: false,
    ...overrides,
  };
}

function makeReceipt(
  baseIntent: ForwardIntent,
  secret = SECRET,
  issuedAt = ISSUED_AT,
  fingerprint = computeForwardSourceFingerprint(SECRET, IDENTITY),
) {
  return signForwardIntentReceipt(
    secret,
    receiptFieldsFromForwardIntent(baseIntent, fingerprint, issuedAt),
  );
}

describe('mail_forward — valid receipt round-trip', () => {
  it('a receipt issued for an intent+fingerprint verifies against those exact values', () => {
    const i = intent();
    const fingerprint = computeForwardSourceFingerprint(SECRET, IDENTITY);
    const receipt = makeReceipt(i, SECRET, ISSUED_AT, fingerprint);
    expect(validateForwardIntentReceipt(receipt, SECRET, i, fingerprint, NOW).valid).toBe(true);
  });

  it('the receipt never contains the plaintext forwarded content or raw Message-ID', () => {
    const i = intent({ forwardedBlock: 'super secret forwarded body' });
    const fingerprint = computeForwardSourceFingerprint(SECRET, IDENTITY);
    const receipt = makeReceipt(i, SECRET, ISSUED_AT, fingerprint);
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain('super secret forwarded body');
    expect(serialized).not.toContain('<abc@example.com>');
  });
});

describe('mail_forward — source fingerprint (identity independent of Message-ID)', () => {
  it('is deterministic', () => {
    expect(computeForwardSourceFingerprint(SECRET, IDENTITY)).toBe(
      computeForwardSourceFingerprint(SECRET, IDENTITY),
    );
  });

  it('is fully computable with messageId: null', () => {
    expect(computeForwardSourceFingerprint(SECRET, { ...IDENTITY, messageId: null })).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it('differs under a different secret', () => {
    expect(computeForwardSourceFingerprint(SECRET, IDENTITY)).not.toBe(
      computeForwardSourceFingerprint(OTHER_SECRET, IDENTITY),
    );
  });
});

describe('mail_forward — payload/source changed after preview', () => {
  it('recipients changed: rejected as intentMismatch', () => {
    const fingerprint = computeForwardSourceFingerprint(SECRET, IDENTITY);
    const preview = intent({ to: ['a@example.com'] });
    const receipt = makeReceipt(preview, SECRET, ISSUED_AT, fingerprint);
    const live = intent({ to: ['attacker@example.com'] });
    expect(validateForwardIntentReceipt(receipt, SECRET, live, fingerprint, NOW).valid).toBe(false);
  });

  it('forwarded content changed: rejected as intentMismatch', () => {
    const fingerprint = computeForwardSourceFingerprint(SECRET, IDENTITY);
    const preview = intent({ forwardedBlock: 'original' });
    const receipt = makeReceipt(preview, SECRET, ISSUED_AT, fingerprint);
    const live = intent({ forwardedBlock: 'tampered' });
    expect(validateForwardIntentReceipt(receipt, SECRET, live, fingerprint, NOW).valid).toBe(false);
  });

  it('sourceHasAttachments changed: rejected as intentMismatch', () => {
    const fingerprint = computeForwardSourceFingerprint(SECRET, IDENTITY);
    const preview = intent({ sourceHasAttachments: false });
    const receipt = makeReceipt(preview, SECRET, ISSUED_AT, fingerprint);
    const live = intent({ sourceHasAttachments: true });
    expect(validateForwardIntentReceipt(receipt, SECRET, live, fingerprint, NOW).valid).toBe(false);
  });

  it('source changed (different fingerprint at send time): rejected as intentMismatch', () => {
    const fingerprintAtPreview = computeForwardSourceFingerprint(SECRET, IDENTITY);
    const i = intent();
    const receipt = makeReceipt(i, SECRET, ISSUED_AT, fingerprintAtPreview);
    const fingerprintAtSend = computeForwardSourceFingerprint(SECRET, { ...IDENTITY, uid: 999 });
    expect(validateForwardIntentReceipt(receipt, SECRET, i, fingerprintAtSend, NOW).valid).toBe(
      false,
    );
  });
});

describe('mail_forward — receipt fail-closed rejection', () => {
  it('malformed receipt: rejected', () => {
    const i = intent();
    const fingerprint = computeForwardSourceFingerprint(SECRET, IDENTITY);
    expect(validateForwardIntentReceipt({ garbage: true }, SECRET, i, fingerprint, NOW)).toEqual({
      valid: false,
      reason: 'malformedReceipt',
    });
  });

  it('signature tampered: signatureInvalid', () => {
    const i = intent();
    const fingerprint = computeForwardSourceFingerprint(SECRET, IDENTITY);
    const receipt = { ...makeReceipt(i, SECRET, ISSUED_AT, fingerprint), subject: 'Injected' };
    const tamperedIntent = intent({ subject: 'Injected' });
    expect(validateForwardIntentReceipt(receipt, SECRET, tamperedIntent, fingerprint, NOW)).toEqual(
      { valid: false, reason: 'signatureInvalid' },
    );
  });

  it('receipt signed under a different key: signatureInvalid', () => {
    const i = intent();
    const fingerprint = computeForwardSourceFingerprint(SECRET, IDENTITY);
    const receipt = makeReceipt(i, OTHER_SECRET, ISSUED_AT, fingerprint);
    expect(validateForwardIntentReceipt(receipt, SECRET, i, fingerprint, NOW)).toEqual({
      valid: false,
      reason: 'signatureInvalid',
    });
  });

  it('signing secret unavailable: fails closed', () => {
    const i = intent();
    const fingerprint = computeForwardSourceFingerprint(SECRET, IDENTITY);
    const receipt = makeReceipt(i, SECRET, ISSUED_AT, fingerprint);
    expect(validateForwardIntentReceipt(receipt, undefined, i, fingerprint, NOW)).toEqual({
      valid: false,
      reason: 'signingSecretUnavailable',
    });
  });

  it('expired receipt: rejected', () => {
    const i = intent();
    const fingerprint = computeForwardSourceFingerprint(SECRET, IDENTITY);
    const receipt = makeReceipt(i, SECRET, ISSUED_AT, fingerprint);
    const wayLater = Date.parse(ISSUED_AT) + FORWARD_INTENT_RECEIPT_TTL_MS + 1;
    expect(validateForwardIntentReceipt(receipt, SECRET, i, fingerprint, wayLater)).toEqual({
      valid: false,
      reason: 'expired',
    });
  });
});

describe('FORWARD_INTENT_RECEIPT_VERSION', () => {
  it('is 1', () => {
    expect(FORWARD_INTENT_RECEIPT_VERSION).toBe(1);
  });
});

describe('cross-purpose receipt rejection (section 27/39 — wrong purpose)', () => {
  it('a valid sendIntentReceipt does NOT verify as a forwardIntentReceipt', () => {
    const sendIntent = {
      from: 'user@proton.me',
      to: ['a@example.com'],
      cc: [],
      subject: 'Fwd: Hello',
      text: 'block',
      bodyLength: 5,
      bodyHash: hashBody('block'),
    };
    const sendReceipt = signSendIntentReceipt(
      SECRET,
      receiptFieldsFromIntent(sendIntent, ISSUED_AT),
    );
    const i = intent();
    const fingerprint = computeForwardSourceFingerprint(SECRET, IDENTITY);
    expect(validateForwardIntentReceipt(sendReceipt, SECRET, i, fingerprint, NOW).valid).toBe(
      false,
    );
  });

  it('a valid replyIntentReceipt does NOT verify as a forwardIntentReceipt', () => {
    const replyIntent: ReplyIntent = {
      from: 'user@proton.me',
      to: 'a@example.com',
      recipientSource: 'from',
      subject: 'Re: Hello',
      text: 'Thanks',
      bodyLength: 6,
      bodyHash: hashBody('Thanks'),
      sourceFolder: 'INBOX',
      threadingAvailable: false,
      inReplyTo: null,
      references: [],
    };
    const replyReceipt = signReplyIntentReceipt(
      SECRET,
      receiptFieldsFromReplyIntent(
        replyIntent,
        computeReplySourceFingerprint(SECRET, IDENTITY),
        'x'.repeat(64),
        ISSUED_AT,
      ),
    );
    const i = intent();
    const fingerprint = computeForwardSourceFingerprint(SECRET, IDENTITY);
    expect(validateForwardIntentReceipt(replyReceipt, SECRET, i, fingerprint, NOW).valid).toBe(
      false,
    );
  });
});
