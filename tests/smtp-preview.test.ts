import { describe, expect, it } from 'vitest';
import { previewSend } from '../src/smtp/preview.js';
import type { ResolvedSmtpConfig } from '../src/smtp/config.js';
import { validateSendIntentReceipt } from '../src/security/send-intent-receipt.js';
import { validateSendIntent } from '../src/smtp/intent.js';

const SECRET = Buffer.from('c'.repeat(64), 'hex');
const smtpConfig: ResolvedSmtpConfig = {
  host: '127.0.0.1',
  port: 1025,
  security: 'starttls',
  username: 'user@proton.me',
  tlsCertPath: '/tmp/cert.pem',
};

describe('mail_send_preview — eligible intent', () => {
  it('reports eligible: true with normalized fields', () => {
    const result = previewSend(
      { to: ['a@example.com'], subject: 'Hi', text: 'Hello' },
      smtpConfig,
      SECRET,
    );
    expect(result.eligible).toBe(true);
    expect(result.from).toBe('user@proton.me');
    expect(result.to).toEqual(['a@example.com']);
    expect(result.totalRecipients).toBe(1);
    expect(result.bodyLength).toBe(5);
    expect(result.smtpHost).toBe('127.0.0.1');
    expect(result.smtpPort).toBe(1025);
    expect(result.securityMode).toBe('starttls');
  });

  it('never returns the password anywhere in the result', () => {
    const result = previewSend(
      { to: ['a@example.com'], subject: 'Hi', text: 'Hello' },
      smtpConfig,
      SECRET,
    );
    expect(JSON.stringify(result)).not.toMatch(/password/i);
  });

  it('bodyDigest is a hash, never the raw body text', () => {
    const result = previewSend(
      { to: ['a@example.com'], subject: 'Hi', text: 'super secret content' },
      smtpConfig,
      SECRET,
    );
    expect(result.bodyDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(result)).not.toContain('secret content');
  });

  it('issues a sendIntentReceipt when a signing secret is provisioned', () => {
    const result = previewSend(
      { to: ['a@example.com'], subject: 'Hi', text: 'Hello' },
      smtpConfig,
      SECRET,
    );
    expect(result.sendIntentReceipt).toBeDefined();
    const intent = validateSendIntent(
      { to: ['a@example.com'], subject: 'Hi', text: 'Hello' },
      smtpConfig.username,
    ).intent;
    expect(intent).not.toBeNull();
    if (intent) {
      expect(validateSendIntentReceipt(result.sendIntentReceipt, SECRET, intent).valid).toBe(true);
    }
  });

  it('issues no receipt when no signing secret is provisioned, but still reports eligible', () => {
    const result = previewSend(
      { to: ['a@example.com'], subject: 'Hi', text: 'Hello' },
      smtpConfig,
      undefined,
    );
    expect(result.eligible).toBe(true);
    expect(result.sendIntentReceipt).toBeUndefined();
    expect(result.reasons.join(' ')).toMatch(/configure-send-signing\.sh/);
  });
});

describe('mail_send_preview — ineligible intent', () => {
  it('reports eligible: false with reasons for an unauthorized sender', () => {
    const result = previewSend(
      { from: 'ceo@google.com', to: ['a@example.com'], subject: 'Hi', text: 'Hello' },
      smtpConfig,
      SECRET,
    );
    expect(result.eligible).toBe(false);
    expect(result.sendIntentReceipt).toBeUndefined();
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('reports eligible: false for an empty recipient list', () => {
    const result = previewSend({ to: [], subject: 'Hi', text: 'Hello' }, smtpConfig, SECRET);
    expect(result.eligible).toBe(false);
  });

  it('reports eligible: false for a CRLF header injection attempt in subject', () => {
    const result = previewSend(
      { to: ['a@example.com'], subject: 'Hi\r\nBcc: victim@example.com', text: 'Hello' },
      smtpConfig,
      SECRET,
    );
    expect(result.eligible).toBe(false);
  });
});

describe('mail_send_preview — zero SMTP connections', () => {
  it('never touches the network — a bogus/unreachable smtpConfig still returns a synchronous result', () => {
    const unreachable: ResolvedSmtpConfig = { ...smtpConfig, host: '127.0.0.1', port: 1 };
    const result = previewSend(
      { to: ['a@example.com'], subject: 'Hi', text: 'Hello' },
      unreachable,
      SECRET,
    );
    // No throw, no timeout, no connection attempt — purely local validation.
    expect(result.eligible).toBe(true);
  });
});
