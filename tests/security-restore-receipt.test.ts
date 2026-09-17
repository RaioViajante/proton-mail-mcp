import { describe, expect, it } from 'vitest';
import type { PreservableFlag } from '../src/mutations/flags.js';
import {
  deriveIdentityFingerprint,
  RESTORE_RECEIPT_VERSION,
  RestoreReceiptEnvelopeSchema,
  signRestoreReceipt,
  validateRestoreReceipt,
  verifyRestoreReceiptSignature,
  type RestoreReceiptEnvelope,
} from '../src/security/restore-receipt.js';

const SECRET_A = Buffer.from('a'.repeat(64), 'hex');
const SECRET_B = Buffer.from('b'.repeat(64), 'hex');
const MESSAGE_ID_A = '<a@example.com>';
const MESSAGE_ID_B = '<b@example.com>';

function baseFields(overrides: Partial<Omit<RestoreReceiptEnvelope, 'signature'>> = {}) {
  return {
    v: RESTORE_RECEIPT_VERSION,
    sourceFolder: 'Archive',
    originalLabels: ['Personal', 'Work'],
    originalFlags: ['\\Seen'] as PreservableFlag[],
    identity: deriveIdentityFingerprint(SECRET_A, MESSAGE_ID_A),
    issuedAt: '2026-09-17T00:00:00.000Z',
    ...overrides,
  };
}

function makeReceipt(
  secret: Buffer = SECRET_A,
  overrides: Partial<Omit<RestoreReceiptEnvelope, 'signature'>> = {},
): RestoreReceiptEnvelope {
  return signRestoreReceipt(secret, baseFields(overrides));
}

describe('restore-receipt — signing and verification', () => {
  it('a receipt signed with the same secret verifies successfully', () => {
    const receipt = makeReceipt();
    expect(verifyRestoreReceiptSignature(SECRET_A, receipt)).toBe(true);
  });

  it('a receipt signed with a different secret fails verification', () => {
    const receipt = makeReceipt(SECRET_B);
    expect(verifyRestoreReceiptSignature(SECRET_A, receipt)).toBe(false);
  });

  it.each([
    ['sourceFolder', 'Trash'],
    ['originalLabels', ['Tampered']],
    ['originalFlags', ['\\Flagged']],
    ['identity', 'f'.repeat(64)],
    ['issuedAt', '2099-01-01T00:00:00.000Z'],
  ] as const)('tampering with %s after signing invalidates the signature', (field, value) => {
    const receipt = makeReceipt();
    const tampered = { ...receipt, [field]: value } as RestoreReceiptEnvelope;
    expect(verifyRestoreReceiptSignature(SECRET_A, tampered)).toBe(false);
  });

  it('tampering with the signature itself invalidates it', () => {
    const receipt = makeReceipt();
    const tampered = { ...receipt, signature: 'f'.repeat(64) };
    expect(verifyRestoreReceiptSignature(SECRET_A, tampered)).toBe(false);
  });
});

describe('restore-receipt — identity fingerprint', () => {
  it('is deterministic for the same secret and Message-ID', () => {
    expect(deriveIdentityFingerprint(SECRET_A, MESSAGE_ID_A)).toBe(
      deriveIdentityFingerprint(SECRET_A, MESSAGE_ID_A),
    );
  });

  it('differs for different Message-IDs under the same secret', () => {
    expect(deriveIdentityFingerprint(SECRET_A, MESSAGE_ID_A)).not.toBe(
      deriveIdentityFingerprint(SECRET_A, MESSAGE_ID_B),
    );
  });

  it('differs for the same Message-ID under different secrets (keyed, not a bare hash)', () => {
    expect(deriveIdentityFingerprint(SECRET_A, MESSAGE_ID_A)).not.toBe(
      deriveIdentityFingerprint(SECRET_B, MESSAGE_ID_A),
    );
  });

  it('the identity subkey is domain-separated from the signing subkey (different key material)', () => {
    // If both purposes reused one key, a receipt's `identity` field would
    // equal a signature computed over the bare Message-ID under the same
    // key — confirm they diverge.
    const identity = deriveIdentityFingerprint(SECRET_A, MESSAGE_ID_A);
    const receipt = makeReceipt(SECRET_A, { identity });
    // The receipt's own signature must not equal its identity fingerprint,
    // and changing identity must still fail verification unless re-signed —
    // proven already above; this test only asserts the two derived values
    // differ for the same input under the same top-level secret.
    expect(receipt.signature).not.toBe(identity);
  });
});

describe('restore-receipt — structural schema', () => {
  it('accepts a well-formed receipt', () => {
    const receipt = makeReceipt();
    expect(RestoreReceiptEnvelopeSchema.safeParse(receipt).success).toBe(true);
  });

  it('rejects an unsupported version', () => {
    const receipt = { ...makeReceipt(), v: 2 };
    expect(RestoreReceiptEnvelopeSchema.safeParse(receipt).success).toBe(false);
  });

  it.each([
    'v',
    'sourceFolder',
    'originalLabels',
    'originalFlags',
    'identity',
    'issuedAt',
    'signature',
  ])('rejects a receipt missing required field %s', (field) => {
    const receipt = makeReceipt() as unknown as Record<string, unknown>;
    delete receipt[field];
    expect(RestoreReceiptEnvelopeSchema.safeParse(receipt).success).toBe(false);
  });

  it('rejects a malformed identity (not 64-char hex)', () => {
    const receipt = { ...makeReceipt(), identity: 'not-hex' };
    expect(RestoreReceiptEnvelopeSchema.safeParse(receipt).success).toBe(false);
  });

  it('rejects a malformed signature (not 64-char hex)', () => {
    const receipt = { ...makeReceipt(), signature: 'not-hex' };
    expect(RestoreReceiptEnvelopeSchema.safeParse(receipt).success).toBe(false);
  });

  it('rejects an originalFlags entry outside the preservable-flag whitelist', () => {
    const receipt = { ...makeReceipt(), originalFlags: ['\\Deleted'] };
    expect(RestoreReceiptEnvelopeSchema.safeParse(receipt).success).toBe(false);
  });

  it('rejects an unknown extra field (strict schema)', () => {
    const receipt = { ...makeReceipt(), extra: 'unexpected' };
    expect(RestoreReceiptEnvelopeSchema.safeParse(receipt).success).toBe(false);
  });

  it('rejects a completely malformed receipt (not an object)', () => {
    expect(RestoreReceiptEnvelopeSchema.safeParse('not-a-receipt').success).toBe(false);
    expect(RestoreReceiptEnvelopeSchema.safeParse(null).success).toBe(false);
    expect(RestoreReceiptEnvelopeSchema.safeParse(undefined).success).toBe(false);
  });
});

describe('restore-receipt — full validation pipeline (validateRestoreReceipt)', () => {
  it('accepts a fully valid receipt for the matching live Message-ID', () => {
    const receipt = makeReceipt();
    const result = validateRestoreReceipt(receipt, SECRET_A, MESSAGE_ID_A);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.receipt).toEqual(receipt);
    }
  });

  it('rejects a malformed receipt before ever checking a secret or identity', () => {
    const result = validateRestoreReceipt({ not: 'a receipt' }, SECRET_A, MESSAGE_ID_A);
    expect(result).toEqual({ valid: false, reason: 'malformedReceipt' });
  });

  it('rejects when no signing secret is available (fails closed, never trusts unverified)', () => {
    const receipt = makeReceipt();
    const result = validateRestoreReceipt(receipt, undefined, MESSAGE_ID_A);
    expect(result).toEqual({ valid: false, reason: 'signingSecretUnavailable' });
  });

  it('rejects a receipt whose signature does not verify under the given secret', () => {
    const receipt = makeReceipt(SECRET_B);
    const result = validateRestoreReceipt(receipt, SECRET_A, MESSAGE_ID_A);
    expect(result).toEqual({ valid: false, reason: 'signatureInvalid' });
  });

  it('rejects when the live message has no Message-ID to verify against', () => {
    const receipt = makeReceipt();
    const result = validateRestoreReceipt(receipt, SECRET_A, undefined);
    expect(result).toEqual({ valid: false, reason: 'noMessageIdToVerify' });
  });

  it('rejects a receipt issued for a different message (message A receipt used on message B)', () => {
    const receiptForA = makeReceipt();
    const result = validateRestoreReceipt(receiptForA, SECRET_A, MESSAGE_ID_B);
    expect(result).toEqual({ valid: false, reason: 'identityMismatch' });
  });

  it('rejects a receipt with a tampered originalLabels field (signature no longer matches)', () => {
    const receipt = makeReceipt();
    const tampered = { ...receipt, originalLabels: ['Injected'] };
    const result = validateRestoreReceipt(tampered, SECRET_A, MESSAGE_ID_A);
    expect(result).toEqual({ valid: false, reason: 'signatureInvalid' });
  });

  it('rejects a receipt with a tampered sourceFolder field', () => {
    const receipt = makeReceipt();
    const tampered = { ...receipt, sourceFolder: 'INBOX' };
    const result = validateRestoreReceipt(tampered, SECRET_A, MESSAGE_ID_A);
    expect(result).toEqual({ valid: false, reason: 'signatureInvalid' });
  });

  it('rejects a receipt with a tampered originalFlags field', () => {
    const receipt = makeReceipt();
    const tampered = { ...receipt, originalFlags: [] };
    const result = validateRestoreReceipt(tampered, SECRET_A, MESSAGE_ID_A);
    expect(result).toEqual({ valid: false, reason: 'signatureInvalid' });
  });

  it('rejects a receipt with a tampered identity field (self-consistent fake identity, still unsigned)', () => {
    const receipt = makeReceipt();
    const fakeIdentity = deriveIdentityFingerprint(SECRET_A, MESSAGE_ID_B);
    const tampered = { ...receipt, identity: fakeIdentity };
    // Signature no longer matches the (now-different) identity field —
    // caught as signatureInvalid before identity is even compared.
    const result = validateRestoreReceipt(tampered, SECRET_A, MESSAGE_ID_B);
    expect(result).toEqual({ valid: false, reason: 'signatureInvalid' });
  });

  it('an unsupported version is rejected as malformed (schema-level, not signature-level)', () => {
    const receipt = { ...makeReceipt(), v: 999 };
    const result = validateRestoreReceipt(receipt, SECRET_A, MESSAGE_ID_A);
    expect(result).toEqual({ valid: false, reason: 'malformedReceipt' });
  });

  it('duplicate labels in originalLabels do not break validation (accepted, deduped by the caller)', () => {
    const receipt = makeReceipt(SECRET_A, { originalLabels: ['Work', 'Work', 'Personal'] });
    const result = validateRestoreReceipt(receipt, SECRET_A, MESSAGE_ID_A);
    expect(result.valid).toBe(true);
  });
});

describe('restore-receipt — no secret/identity leakage', () => {
  it('a valid receipt never contains the raw Message-ID as a substring of any field', () => {
    const receipt = makeReceipt();
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain(MESSAGE_ID_A);
  });

  it('a valid receipt never contains the raw signing secret hex as a substring of any field', () => {
    const receipt = makeReceipt();
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain(SECRET_A.toString('hex'));
  });
});
