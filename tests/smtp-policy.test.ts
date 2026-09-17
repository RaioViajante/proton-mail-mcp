import { describe, expect, it } from 'vitest';
import {
  MAX_BODY_LENGTH,
  MAX_SEND_RECIPIENTS,
  MAX_SUBJECT_LENGTH,
  normalizeEmailAddress,
  validateBody,
  validateRecipients,
  validateSender,
  validateSubject,
} from '../src/smtp/policy.js';

const AUTHORIZED = 'user@proton.me';

describe('normalizeEmailAddress', () => {
  it('accepts a well-formed address', () => {
    expect(normalizeEmailAddress('a@example.com')).toBe('a@example.com');
  });

  it('trims surrounding whitespace only, never lowercases', () => {
    expect(normalizeEmailAddress('  Alice@Example.com  ')).toBe('Alice@Example.com');
  });

  it('rejects an address containing CR or LF (header injection)', () => {
    expect(normalizeEmailAddress('a@example.com\r\nBcc: victim@example.com')).toBeNull();
    expect(normalizeEmailAddress('a@example.com\n')).toBeNull();
    expect(normalizeEmailAddress('a@example.com\r')).toBeNull();
  });

  it('rejects an address containing other control characters', () => {
    expect(normalizeEmailAddress('a@example.com\x00')).toBeNull();
    expect(normalizeEmailAddress('a@example.com\x07')).toBeNull();
  });

  it('rejects malformed addresses', () => {
    expect(normalizeEmailAddress('not-an-email')).toBeNull();
    expect(normalizeEmailAddress('@example.com')).toBeNull();
    expect(normalizeEmailAddress('a@')).toBeNull();
    expect(normalizeEmailAddress('')).toBeNull();
    expect(normalizeEmailAddress('a b@example.com')).toBeNull();
  });

  it('rejects an address longer than 254 characters', () => {
    const long = `${'a'.repeat(250)}@example.com`;
    expect(normalizeEmailAddress(long)).toBeNull();
  });
});

describe('validateSender', () => {
  it('defaults to the authorized identity when from is omitted', () => {
    const result = validateSender(undefined, AUTHORIZED);
    expect(result.valid).toBe(true);
    expect(result.from).toBe(AUTHORIZED);
  });

  it('accepts from matching the authorized identity (case-insensitive)', () => {
    expect(validateSender('User@Proton.me', AUTHORIZED).valid).toBe(true);
  });

  it('rejects an unauthorized sender (spoofing attempt)', () => {
    const result = validateSender('ceo@google.com', AUTHORIZED);
    expect(result.valid).toBe(false);
    expect(result.from).toBeNull();
    expect(result.reasons.join(' ')).toMatch(/configured Bridge account identity/);
  });

  it('rejects a malformed from address', () => {
    expect(validateSender('not-an-email', AUTHORIZED).valid).toBe(false);
  });

  it('rejects header-injection via a CRLF in from', () => {
    expect(validateSender('a@example.com\r\nBcc: x@example.com', AUTHORIZED).valid).toBe(false);
  });
});

describe('validateRecipients', () => {
  it('accepts a single valid To recipient', () => {
    const result = validateRecipients(['a@example.com']);
    expect(result.valid).toBe(true);
    expect(result.to).toEqual(['a@example.com']);
  });

  it('rejects an empty To', () => {
    expect(validateRecipients([]).valid).toBe(false);
  });

  it('rejects a malformed To address', () => {
    expect(validateRecipients(['not-an-email']).valid).toBe(false);
  });

  it('rejects a CRLF/header-injection address', () => {
    const result = validateRecipients(['a@example.com\r\nBcc: victim@example.com']);
    expect(result.valid).toBe(false);
  });

  it('deduplicates recipients across To+Cc (case-insensitive), never rejects for that alone', () => {
    const result = validateRecipients(['a@example.com', 'A@Example.com'], ['a@example.com']);
    expect(result.to).toEqual(['a@example.com']);
    expect(result.cc).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.reasons.join(' ')).toMatch(/duplicate/i);
  });

  it(`enforces the ${MAX_SEND_RECIPIENTS}-recipient combined ceiling`, () => {
    const to = Array.from({ length: MAX_SEND_RECIPIENTS }, (_, i) => `u${i}@example.com`);
    expect(validateRecipients(to).valid).toBe(true);
    const tooMany = Array.from({ length: MAX_SEND_RECIPIENTS + 1 }, (_, i) => `u${i}@example.com`);
    expect(validateRecipients(tooMany).valid).toBe(false);
  });

  it('counts To and Cc together against the ceiling', () => {
    const to = Array.from({ length: MAX_SEND_RECIPIENTS }, (_, i) => `to${i}@example.com`);
    const result = validateRecipients(to, ['extra@example.com']);
    expect(result.valid).toBe(false);
  });

  it('handles Cc independently of To (Cc alone never satisfies "at least one To")', () => {
    const result = validateRecipients([], ['a@example.com']);
    expect(result.valid).toBe(false);
  });
});

describe('validateSubject', () => {
  it('accepts a normal subject', () => {
    expect(validateSubject('Hello there').valid).toBe(true);
  });

  it('rejects an empty subject', () => {
    expect(validateSubject('').valid).toBe(false);
    expect(validateSubject('   ').valid).toBe(false);
  });

  it(`rejects a subject over ${MAX_SUBJECT_LENGTH} characters`, () => {
    expect(validateSubject('a'.repeat(MAX_SUBJECT_LENGTH + 1)).valid).toBe(false);
    expect(validateSubject('a'.repeat(MAX_SUBJECT_LENGTH)).valid).toBe(true);
  });

  it('rejects CR/LF in the subject (header injection)', () => {
    expect(validateSubject('Subject\r\nBcc: victim@example.com').valid).toBe(false);
    expect(validateSubject('line1\nline2').valid).toBe(false);
  });

  it('rejects other control characters in the subject', () => {
    expect(validateSubject('subject\x00').valid).toBe(false);
  });
});

describe('validateBody', () => {
  it('accepts a normal plain-text body', () => {
    expect(validateBody('Hello, this is a test.').valid).toBe(true);
  });

  it('rejects an empty body', () => {
    expect(validateBody('').valid).toBe(false);
  });

  it(`rejects a body over ${MAX_BODY_LENGTH} characters`, () => {
    expect(validateBody('a'.repeat(MAX_BODY_LENGTH + 1)).valid).toBe(false);
    expect(validateBody('a'.repeat(MAX_BODY_LENGTH)).valid).toBe(true);
  });

  it('accepts Unicode content', () => {
    expect(validateBody('héllo wörld 你好 🎉').valid).toBe(true);
  });

  it('rejects an unpaired UTF-16 surrogate', () => {
    expect(validateBody('bad \uD800 surrogate').valid).toBe(false);
  });

  it('never interprets body content — a link/HTML/shell-looking body is still just text data', () => {
    const result = validateBody('<script>alert(1)</script> $(rm -rf /) https://evil.example/');
    expect(result.valid).toBe(true);
  });
});
