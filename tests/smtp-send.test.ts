import { describe, expect, it } from 'vitest';
import { previewSend } from '../src/smtp/preview.js';
import type { ResolvedSmtpConfig } from '../src/smtp/config.js';
import { LIVE_SEND_DISABLED_REASON, sendMail } from '../src/smtp/send.js';

const SECRET = Buffer.from('c'.repeat(64), 'hex');
const OTHER_SECRET = Buffer.from('f'.repeat(64), 'hex');
const smtpConfig: ResolvedSmtpConfig = {
  host: '127.0.0.1',
  port: 1025,
  security: 'starttls',
  username: 'user@proton.me',
  tlsCertPath: '/tmp/cert.pem',
};

const validPayload = { to: ['a@example.com'], subject: 'Hi', text: 'Hello' };

function previewReceipt(payload = validPayload) {
  const preview = previewSend(payload, smtpConfig, SECRET);
  return preview.sendIntentReceipt;
}

describe('mail_send — consent gate defaults', () => {
  it('dryRun defaults meaningfully: a dry-run call never needs confirm/acknowledge', () => {
    const result = sendMail(
      { ...validPayload, dryRun: true, confirm: false, acknowledgeExternalSend: false },
      smtpConfig,
      SECRET,
    );
    expect(result.intentValidated).toBe(true);
    expect(result.outcome).toBeUndefined();
  });

  it('live missing confirm: throws', () => {
    expect(() =>
      sendMail(
        {
          ...validPayload,
          sendIntentReceipt: previewReceipt(),
          dryRun: false,
          confirm: false,
          acknowledgeExternalSend: true,
        },
        smtpConfig,
        SECRET,
      ),
    ).toThrow(/confirm=true and acknowledgeExternalSend=true/);
  });

  it('live missing acknowledgeExternalSend: throws', () => {
    expect(() =>
      sendMail(
        {
          ...validPayload,
          sendIntentReceipt: previewReceipt(),
          dryRun: false,
          confirm: true,
          acknowledgeExternalSend: false,
        },
        smtpConfig,
        SECRET,
      ),
    ).toThrow(/confirm=true and acknowledgeExternalSend=true/);
  });

  it('dryRun=true performs zero SMTP submission regardless of confirm/acknowledge', () => {
    const result = sendMail(
      { ...validPayload, dryRun: true, confirm: true, acknowledgeExternalSend: true },
      smtpConfig,
      SECRET,
    );
    expect(result.submissionAttempted).toBeUndefined();
    expect(result.connectionEstablished).toBeUndefined();
  });
});

describe('mail_send — receipt requirements', () => {
  const liveIntent = { dryRun: false, confirm: true, acknowledgeExternalSend: true } as const;

  it('missing receipt on a live call: rejected', () => {
    const result = sendMail({ ...validPayload, ...liveIntent }, smtpConfig, SECRET);
    expect(result.outcome).toBe('rejected');
    expect(result.reasons.join(' ')).toMatch(/malformed/i);
  });

  it('invalid (malformed) receipt: rejected', () => {
    const result = sendMail(
      { ...validPayload, sendIntentReceipt: { garbage: true }, ...liveIntent },
      smtpConfig,
      SECRET,
    );
    expect(result.outcome).toBe('rejected');
  });

  it('receipt for a different payload (tampered after preview): rejected', () => {
    const receipt = previewReceipt();
    const result = sendMail(
      {
        to: ['b@example.com'],
        subject: 'Hi',
        text: 'Hello',
        sendIntentReceipt: receipt,
        ...liveIntent,
      },
      smtpConfig,
      SECRET,
    );
    expect(result.outcome).toBe('rejected');
    expect(result.reasons.join(' ')).toMatch(/does not match/i);
  });

  it('receipt signed under a different secret than the one available now: rejected', () => {
    const preview = previewSend(validPayload, smtpConfig, OTHER_SECRET);
    const result = sendMail(
      { ...validPayload, sendIntentReceipt: preview.sendIntentReceipt, ...liveIntent },
      smtpConfig,
      SECRET,
    );
    expect(result.outcome).toBe('rejected');
  });

  it('signing secret unavailable at send time: every receipt fails closed', () => {
    const receipt = previewReceipt();
    const result = sendMail(
      { ...validPayload, sendIntentReceipt: receipt, ...liveIntent },
      smtpConfig,
      undefined,
    );
    expect(result.outcome).toBe('rejected');
  });
});

describe('mail_send — live feature gate (0.5.0: unconditionally blocked)', () => {
  const liveIntent = { dryRun: false, confirm: true, acknowledgeExternalSend: true } as const;

  it('a fully valid live call — correct consent, valid intent, valid matching receipt — is still blocked', () => {
    const receipt = previewReceipt();
    const result = sendMail(
      { ...validPayload, sendIntentReceipt: receipt, ...liveIntent },
      smtpConfig,
      SECRET,
    );
    expect(result.blocked).toBe(true);
    expect(result.blockReason).toBe(LIVE_SEND_DISABLED_REASON);
    expect(result.outcome).toBe('blocked');
  });

  it('the gate blocks before any SMTP connection is attempted', () => {
    const receipt = previewReceipt();
    const result = sendMail(
      { ...validPayload, sendIntentReceipt: receipt, ...liveIntent },
      smtpConfig,
      SECRET,
    );
    expect(result.connectionEstablished).toBe(false);
    expect(result.authenticated).toBe(false);
    expect(result.submissionAttempted).toBe(false);
    expect(result.deliveryUncertain).toBe(false);
    expect(result.sentFolderObserved).toBeNull();
  });
});

describe('mail_send — invalid intent on a live call', () => {
  const liveIntent = { dryRun: false, confirm: true, acknowledgeExternalSend: true } as const;

  it('unauthorized sender on a live call: rejected before receipt is even checked', () => {
    const result = sendMail(
      {
        from: 'ceo@google.com',
        to: ['a@example.com'],
        subject: 'Hi',
        text: 'Hello',
        ...liveIntent,
      },
      smtpConfig,
      SECRET,
    );
    expect(result.outcome).toBe('rejected');
    expect(result.intentValidated).toBe(false);
  });
});
