import { describe, expect, it } from 'vitest';
import { hashBody, validateSendIntent } from '../src/smtp/intent.js';

const AUTHORIZED = 'user@proton.me';

describe('validateSendIntent', () => {
  it('builds a normalized intent for a valid request', () => {
    const result = validateSendIntent(
      { to: ['b@example.com'], subject: 'Hi', text: 'Hello' },
      AUTHORIZED,
    );
    expect(result.valid).toBe(true);
    expect(result.intent).toEqual({
      from: AUTHORIZED,
      to: ['b@example.com'],
      cc: [],
      subject: 'Hi',
      text: 'Hello',
      bodyLength: 5,
      bodyHash: hashBody('Hello'),
    });
  });

  it('sorts to/cc case-insensitively (recipient order normalization)', () => {
    const result = validateSendIntent(
      { to: ['zeta@example.com', 'alpha@example.com'], subject: 'Hi', text: 'Hello' },
      AUTHORIZED,
    );
    expect(result.intent?.to).toEqual(['alpha@example.com', 'zeta@example.com']);
  });

  it('two calls with the same recipient set in different order produce an identical intent', () => {
    const a = validateSendIntent(
      { to: ['a@example.com', 'b@example.com'], subject: 'Hi', text: 'Hello' },
      AUTHORIZED,
    );
    const b = validateSendIntent(
      { to: ['b@example.com', 'a@example.com'], subject: 'Hi', text: 'Hello' },
      AUTHORIZED,
    );
    expect(a.intent).toEqual(b.intent);
  });

  it('rejects an unauthorized sender before ever building an intent', () => {
    const result = validateSendIntent(
      { from: 'ceo@google.com', to: ['b@example.com'], subject: 'Hi', text: 'Hello' },
      AUTHORIZED,
    );
    expect(result.valid).toBe(false);
    expect(result.intent).toBeNull();
  });

  it('aggregates reasons from every failing field at once', () => {
    const result = validateSendIntent(
      { from: 'ceo@google.com', to: [], subject: '', text: '' },
      AUTHORIZED,
    );
    expect(result.valid).toBe(false);
    expect(result.reasons.length).toBeGreaterThanOrEqual(3);
  });

  it('bodyHash never contains the plaintext body', () => {
    const result = validateSendIntent(
      { to: ['b@example.com'], subject: 'Hi', text: 'super secret content' },
      AUTHORIZED,
    );
    expect(result.intent?.bodyHash).not.toContain('secret');
    expect(result.intent?.bodyHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('hashBody', () => {
  it('is deterministic', () => {
    expect(hashBody('hello')).toBe(hashBody('hello'));
  });

  it('differs for different content', () => {
    expect(hashBody('hello')).not.toBe(hashBody('hello!'));
  });
});
