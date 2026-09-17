import { describe, expect, it } from 'vitest';
import {
  classifySmtpError,
  classifySmtpSuccess,
  sanitizeRecipientList,
} from '../src/smtp/outcome.js';

describe('classifySmtpSuccess', () => {
  it('all recipients accepted: outcome accepted, not uncertain', () => {
    const result = classifySmtpSuccess({
      accepted: ['a@example.com'],
      rejected: [],
      response: '250 OK',
    });
    expect(result.outcome).toBe('accepted');
    expect(result.deliveryUncertain).toBe(false);
    expect(result.submissionAttempted).toBe(true);
    expect(result.connectionEstablished).toBe(true);
    expect(result.authenticated).toBe(true);
    expect(result.acceptedRecipients).toEqual(['a@example.com']);
    expect(result.rejectedRecipients).toEqual([]);
    expect(result.smtpResponseCategory).toBe('2xx');
  });

  it('partial recipient acceptance: outcome partiallyAccepted', () => {
    const result = classifySmtpSuccess({
      accepted: ['a@example.com'],
      rejected: ['b@example.com'],
    });
    expect(result.outcome).toBe('partiallyAccepted');
    expect(result.acceptedRecipients).toEqual(['a@example.com']);
    expect(result.rejectedRecipients).toEqual(['b@example.com']);
  });

  it('all recipients rejected (but the call still resolved, not threw): outcome rejected', () => {
    const result = classifySmtpSuccess({
      accepted: [],
      rejected: ['a@example.com', 'b@example.com'],
    });
    expect(result.outcome).toBe('rejected');
    expect(result.deliveryUncertain).toBe(false);
  });

  it('never returns the raw SMTP response line, only a coarse category', () => {
    const result = classifySmtpSuccess({
      accepted: ['a@example.com'],
      rejected: [],
      response: '250 2.0.0 Ok: queued as ABC123',
    });
    expect(result.smtpResponseCategory).toBe('2xx');
    expect(JSON.stringify(result)).not.toContain('ABC123');
  });
});

describe('classifySmtpError — connection phase', () => {
  it('timeout before auth / connection failure: failed, nothing established, never uncertain', () => {
    const result = classifySmtpError({ code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' });
    expect(result.outcome).toBe('failed');
    expect(result.connectionEstablished).toBe(false);
    expect(result.submissionAttempted).toBe(false);
    expect(result.deliveryUncertain).toBe(false);
  });

  it('explicit CONN command failure: same as no command at all', () => {
    const result = classifySmtpError({ command: 'CONN', message: 'ECONNREFUSED' });
    expect(result.outcome).toBe('failed');
    expect(result.connectionEstablished).toBe(false);
  });
});

describe('classifySmtpError — auth phase', () => {
  it('auth reject: connection established, not authenticated, never uncertain', () => {
    const result = classifySmtpError({ command: 'AUTH', message: 'Invalid credentials' });
    expect(result.outcome).toBe('failed');
    expect(result.connectionEstablished).toBe(true);
    expect(result.authenticated).toBe(false);
    expect(result.submissionAttempted).toBe(false);
    expect(result.deliveryUncertain).toBe(false);
  });
});

describe('classifySmtpError — TLS certificate rejection', () => {
  it('a certificate error before any command is a connection-phase failure, not uncertain', () => {
    const result = classifySmtpError({ code: 'ESOCKET', message: 'self signed certificate' });
    expect(result.outcome).toBe('failed');
    expect(result.connectionEstablished).toBe(false);
    expect(result.deliveryUncertain).toBe(false);
  });
});

describe('classifySmtpError — recipient/DATA rejection (definitive server response)', () => {
  it('RCPT TO rejected with a 5xx response code: rejected, not uncertain', () => {
    const result = classifySmtpError({
      command: 'RCPT TO',
      responseCode: 550,
      message: 'Mailbox unavailable',
    });
    expect(result.outcome).toBe('rejected');
    expect(result.deliveryUncertain).toBe(false);
    expect(result.smtpResponseCategory).toBe('5xx');
  });

  it('DATA rejected with a 5xx response code: rejected, not uncertain', () => {
    const result = classifySmtpError({
      command: 'DATA',
      responseCode: 554,
      message: 'Message rejected',
    });
    expect(result.outcome).toBe('rejected');
    expect(result.deliveryUncertain).toBe(false);
  });

  it('a 4xx temporary-failure response is treated as uncertain, never auto-retried', () => {
    const result = classifySmtpError({
      command: 'RCPT TO',
      responseCode: 450,
      message: 'Mailbox busy',
    });
    expect(result.outcome).toBe('uncertain');
    expect(result.deliveryUncertain).toBe(true);
    expect(result.smtpResponseCategory).toBe('4xx');
  });
});

describe('classifySmtpError — disconnect during/after submission (ambiguous, never guessed)', () => {
  it('disconnect after MAIL FROM/RCPT TO with no response code: uncertain, deliveryUncertain, submissionAttempted', () => {
    const result = classifySmtpError({
      command: 'MAIL FROM',
      code: 'ECONNRESET',
      message: 'socket hang up',
    });
    expect(result.outcome).toBe('uncertain');
    expect(result.deliveryUncertain).toBe(true);
    expect(result.submissionAttempted).toBe(true);
    expect(result.connectionEstablished).toBe(true);
  });

  it('disconnect during DATA transmission with no response code: uncertain', () => {
    const result = classifySmtpError({
      command: 'DATA',
      code: 'ECONNRESET',
      message: 'socket hang up',
    });
    expect(result.outcome).toBe('uncertain');
    expect(result.deliveryUncertain).toBe(true);
  });

  it('reasons explain that this was not retried automatically', () => {
    const result = classifySmtpError({ command: 'DATA', message: 'connection lost' });
    expect(result.reasons.join(' ')).toMatch(/not retried automatically/i);
  });
});

describe('classifySmtpError — never guesses acceptedRecipients/rejectedRecipients on a throw', () => {
  it('every error path reports empty accepted/rejected arrays — a throw never claims partial success', () => {
    for (const error of [
      { message: 'timeout' },
      { command: 'AUTH', message: 'bad creds' },
      { command: 'RCPT TO', responseCode: 550, message: 'no' },
      { command: 'DATA', code: 'ECONNRESET', message: 'lost' },
    ]) {
      const result = classifySmtpError(error);
      expect(result.acceptedRecipients).toEqual([]);
      expect(result.rejectedRecipients).toEqual([]);
    }
  });
});

describe('sanitizeRecipientList (0.5.1, section 6 — never echo raw SMTP internals)', () => {
  it('returns the caller-known address when the library reports exactly it', () => {
    expect(sanitizeRecipientList(['a@example.com'], ['a@example.com'])).toEqual(['a@example.com']);
  });

  it('matches case-insensitively but returns the KNOWN (caller-normalized) spelling, not the library-reported one', () => {
    expect(sanitizeRecipientList(['A@Example.com'], ['a@example.com'])).toEqual(['a@example.com']);
  });

  it('drops any address the library reports that the caller never actually submitted', () => {
    expect(
      sanitizeRecipientList(
        ['a@example.com', 'internal-bridge-only@bridge.local'],
        ['a@example.com'],
      ),
    ).toEqual(['a@example.com']);
  });

  it('drops a known address entirely if the library never reported it', () => {
    expect(sanitizeRecipientList([], ['a@example.com', 'b@example.com'])).toEqual([]);
    expect(sanitizeRecipientList(['a@example.com'], ['a@example.com', 'b@example.com'])).toEqual([
      'a@example.com',
    ]);
  });

  it('preserves the known list order, not the library-reported order', () => {
    expect(
      sanitizeRecipientList(['b@example.com', 'a@example.com'], ['a@example.com', 'b@example.com']),
    ).toEqual(['a@example.com', 'b@example.com']);
  });

  it('never duplicates an address even if the library reports it more than once', () => {
    expect(sanitizeRecipientList(['a@example.com', 'a@example.com'], ['a@example.com'])).toEqual([
      'a@example.com',
    ]);
  });
});
