import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForwardSourceContent } from '../src/mail/source-message.js';
import { resetReplayGuardForTests } from '../src/security/send-intent-replay-guard.js';
import { FORWARD_INTENT_RECEIPT_TTL_MS } from '../src/security/forward-intent-receipt.js';
import type { ResolvedSmtpConfig } from '../src/smtp/config.js';
import { previewForward } from '../src/smtp/forward-preview.js';
import { sendForward } from '../src/smtp/forward-send.js';

const SECRET = Buffer.from('c'.repeat(64), 'hex');
const OTHER_SECRET = Buffer.from('f'.repeat(64), 'hex');

function source(overrides: Partial<ForwardSourceContent> = {}): ForwardSourceContent {
  return {
    folder: 'INBOX',
    uid: 1,
    uidValidity: '111',
    from: 'sender@example.com',
    to: ['user@proton.me'],
    messageId: '<abc@example.com>',
    subject: 'Hello',
    date: '2026-01-01T00:00:00.000Z',
    hasAttachments: false,
    sourceContentComplete: true,
    plainText: 'Original message body.',
    ...overrides,
  };
}

describe('sendForward (0.5.4)', () => {
  let dir: string;
  let smtpConfig: ResolvedSmtpConfig;
  let getPassword: () => Promise<string>;

  beforeEach(() => {
    resetReplayGuardForTests();
    dir = mkdtempSync(join(tmpdir(), 'proton-mail-mcp-test-'));
    const certPath = join(dir, 'bridge-cert.pem');
    writeFileSync(
      certPath,
      '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n',
      'utf8',
    );
    smtpConfig = {
      host: '127.0.0.1',
      port: 1025,
      security: 'starttls',
      username: 'user@proton.me',
      tlsCertPath: certPath,
    };
    getPassword = vi.fn<() => Promise<string>>().mockResolvedValue('bridge-password');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const liveParams = {
    dryRun: false,
    confirm: true,
    acknowledgeExternalForward: true,
    acknowledgeAttachmentsWillBeOmitted: false,
  } as const;
  const basePayload = { sourceFolder: 'INBOX', uid: 1, to: ['a@example.com'] };

  function previewReceipt(src: ForwardSourceContent = source(), to = ['a@example.com']) {
    return previewForward(src, { to }, smtpConfig.username, SECRET).forwardIntentReceipt;
  }

  describe('consent gate', () => {
    it('live missing confirm: throws, zero send', async () => {
      const sendFn = vi.fn();
      await expect(
        sendForward(
          source(),
          { ...basePayload, forwardIntentReceipt: previewReceipt(), ...liveParams, confirm: false },
          smtpConfig,
          SECRET,
          { getPassword, sendFn },
        ),
      ).rejects.toThrow(/confirm=true and acknowledgeExternalForward=true/);
      expect(sendFn).not.toHaveBeenCalled();
    });

    it('live missing acknowledgeExternalForward: throws before SMTP', async () => {
      const sendFn = vi.fn();
      await expect(
        sendForward(
          source(),
          {
            ...basePayload,
            forwardIntentReceipt: previewReceipt(),
            ...liveParams,
            acknowledgeExternalForward: false,
          },
          smtpConfig,
          SECRET,
          { getPassword, sendFn },
        ),
      ).rejects.toThrow(/acknowledgeExternalForward=true/);
      expect(sendFn).not.toHaveBeenCalled();
      expect(getPassword).not.toHaveBeenCalled();
    });
  });

  describe('dry-run: zero SMTP, ever', () => {
    it('dryRun=true performs zero SMTP submission', async () => {
      const sendFn = vi.fn();
      const result = await sendForward(
        source(),
        {
          ...basePayload,
          dryRun: true,
          confirm: true,
          acknowledgeExternalForward: true,
          acknowledgeAttachmentsWillBeOmitted: false,
        },
        smtpConfig,
        SECRET,
        { getPassword, sendFn },
      );
      expect(result.submissionAttempted).toBeUndefined();
      expect(sendFn).not.toHaveBeenCalled();
    });

    it('dryRun=true with a valid receipt: receiptValid=true, never consumes the nonce', async () => {
      const receipt = previewReceipt();
      const dryRunResult = await sendForward(
        source(),
        {
          ...basePayload,
          forwardIntentReceipt: receipt,
          dryRun: true,
          confirm: false,
          acknowledgeExternalForward: false,
          acknowledgeAttachmentsWillBeOmitted: false,
        },
        smtpConfig,
        SECRET,
      );
      expect(dryRunResult.receiptValid).toBe(true);

      const sendFn = vi
        .fn()
        .mockResolvedValue({ accepted: ['a@example.com'], rejected: [], response: '250 OK' });
      const liveResult = await sendForward(
        source(),
        { ...basePayload, forwardIntentReceipt: receipt, ...liveParams },
        smtpConfig,
        SECRET,
        { getPassword, sendFn },
      );
      expect(liveResult.outcome).toBe('accepted');
    });
  });

  describe('attachment acknowledgement (sections 18, 21, 32)', () => {
    it('source has attachments, acknowledgeAttachmentsWillBeOmitted=false: rejected, zero send, nonce NOT consumed', async () => {
      const withAttachments = source({ hasAttachments: true });
      const receipt = previewReceipt(withAttachments);
      const sendFn = vi.fn();
      const result = await sendForward(
        withAttachments,
        {
          ...basePayload,
          forwardIntentReceipt: receipt,
          ...liveParams,
          acknowledgeAttachmentsWillBeOmitted: false,
        },
        smtpConfig,
        SECRET,
        { getPassword, sendFn, liveDisabled: false },
      );
      expect(result.outcome).toBe('rejected');
      expect(result.reasons.join(' ')).toMatch(/attachments/i);
      expect(sendFn).not.toHaveBeenCalled();

      // Not consumed by the attachment-ack rejection (no external effect occurred).
      const acknowledged = await sendForward(
        withAttachments,
        {
          ...basePayload,
          forwardIntentReceipt: receipt,
          ...liveParams,
          acknowledgeAttachmentsWillBeOmitted: true,
        },
        smtpConfig,
        SECRET,
        {
          getPassword,
          sendFn: sendFn.mockResolvedValue({
            accepted: ['a@example.com'],
            rejected: [],
            response: '250 OK',
          }),
          liveDisabled: false,
        },
      );
      expect(acknowledged.outcome).toBe('accepted');
    });

    it('source has attachments, acknowledgeAttachmentsWillBeOmitted=true: proceeds normally', async () => {
      const withAttachments = source({ hasAttachments: true });
      const receipt = previewReceipt(withAttachments);
      const sendFn = vi
        .fn()
        .mockResolvedValue({ accepted: ['a@example.com'], rejected: [], response: '250 OK' });
      const result = await sendForward(
        withAttachments,
        {
          ...basePayload,
          forwardIntentReceipt: receipt,
          ...liveParams,
          acknowledgeAttachmentsWillBeOmitted: true,
        },
        smtpConfig,
        SECRET,
        { getPassword, sendFn, liveDisabled: false },
      );
      expect(result.outcome).toBe('accepted');
    });

    it('source has NO attachments: acknowledgeAttachmentsWillBeOmitted=false is fine', async () => {
      const receipt = previewReceipt(source({ hasAttachments: false }));
      const sendFn = vi
        .fn()
        .mockResolvedValue({ accepted: ['a@example.com'], rejected: [], response: '250 OK' });
      const result = await sendForward(
        source({ hasAttachments: false }),
        {
          ...basePayload,
          forwardIntentReceipt: receipt,
          ...liveParams,
          acknowledgeAttachmentsWillBeOmitted: false,
        },
        smtpConfig,
        SECRET,
        { getPassword, sendFn, liveDisabled: false },
      );
      expect(result.outcome).toBe('accepted');
    });

    it('attachment ack is checked against the VERIFIED receipt, not a caller claim: a caller cannot lie sourceHasAttachments=false was previewed', async () => {
      // Preview against a source WITH attachments, but the source re-fetched
      // at send time claims none (simulating a spoofed re-fetch input) —
      // this should be caught by fingerprint/content mismatch, not attachment ack.
      const receipt = previewReceipt(source({ hasAttachments: true }));
      const sendFn = vi.fn();
      const result = await sendForward(
        source({ hasAttachments: false }),
        {
          ...basePayload,
          forwardIntentReceipt: receipt,
          ...liveParams,
          acknowledgeAttachmentsWillBeOmitted: false,
        },
        smtpConfig,
        SECRET,
        { getPassword, sendFn, liveDisabled: false },
      );
      expect(result.outcome).toBe('rejected');
      expect(sendFn).not.toHaveBeenCalled();
    });
  });

  describe('source revalidation (section 20)', () => {
    it.each([
      ['UIDVALIDITY', { uidValidity: 'changed' }],
      ['sender', { from: 'different@example.com' }],
      ['subject', { subject: 'Changed' }],
      ['attachment state', { hasAttachments: true }],
    ])('%s drift since preview: zero SMTP', async (_name, change) => {
      const receipt = previewReceipt();
      const sendFn = vi.fn();
      const result = await sendForward(
        source(change),
        { ...basePayload, forwardIntentReceipt: receipt, ...liveParams },
        smtpConfig,
        SECRET,
        { getPassword, sendFn },
      );
      expect(result.outcome).toBe('rejected');
      expect(result.submissionAttempted).toBe(false);
      expect(sendFn).not.toHaveBeenCalled();
      expect(getPassword).not.toHaveBeenCalled();
    });

    it.each([
      ['recipient', { to: ['changed@example.com'] }],
      ['intro text', { text: 'Changed intro' }],
    ])('%s change since preview: zero SMTP', async (_name, change) => {
      const receipt = previewReceipt();
      const sendFn = vi.fn();
      const result = await sendForward(
        source(),
        { ...basePayload, ...change, forwardIntentReceipt: receipt, ...liveParams },
        smtpConfig,
        SECRET,
        { getPassword, sendFn },
      );
      expect(result.outcome).toBe('rejected');
      expect(result.submissionAttempted).toBe(false);
      expect(sendFn).not.toHaveBeenCalled();
      expect(getPassword).not.toHaveBeenCalled();
    });

    it('forwarded content changed since preview: rejected before SMTP', async () => {
      const receipt = previewReceipt(source({ plainText: 'Original message body.' }));
      const sendFn = vi.fn();
      const result = await sendForward(
        source({ plainText: 'Tampered body.' }),
        { ...basePayload, forwardIntentReceipt: receipt, ...liveParams },
        smtpConfig,
        SECRET,
        { getPassword, sendFn, liveDisabled: false },
      );
      expect(result.outcome).toBe('rejected');
      expect(sendFn).not.toHaveBeenCalled();
    });

    it('message not found at send time: rejected, zero send', async () => {
      const receipt = previewReceipt();
      const sendFn = vi.fn();
      const result = await sendForward(
        null,
        { ...basePayload, forwardIntentReceipt: receipt, ...liveParams },
        smtpConfig,
        SECRET,
        { getPassword, sendFn, liveDisabled: false },
      );
      expect(result.outcome).toBe('rejected');
      expect(sendFn).not.toHaveBeenCalled();
    });
  });

  describe('feature gate ordering (gate BEFORE nonce consumption)', () => {
    it('gate closed by test override: rejected, submissionAttempted false, nonce NOT consumed', async () => {
      const receipt = previewReceipt();
      const sendFn = vi.fn();
      const blocked = await sendForward(
        source(),
        { ...basePayload, forwardIntentReceipt: receipt, ...liveParams },
        smtpConfig,
        SECRET,
        { getPassword, sendFn, liveDisabled: true },
      );
      expect(blocked.outcome).toBe('rejected');
      expect(blocked.submissionAttempted).toBe(false);
      expect(sendFn).not.toHaveBeenCalled();
      expect(getPassword).not.toHaveBeenCalled();

      sendFn.mockResolvedValue({ accepted: ['a@example.com'], rejected: [], response: '250 OK' });
      const opened = await sendForward(
        source(),
        { ...basePayload, forwardIntentReceipt: receipt, ...liveParams },
        smtpConfig,
        SECRET,
        { getPassword, sendFn },
      );
      expect(opened.outcome).toBe('accepted');
    });

    it('default gate open: nonce is consumed before SMTP and a second call is refused', async () => {
      const receipt = previewReceipt();
      const sendFn = vi
        .fn()
        .mockResolvedValue({ accepted: ['a@example.com'], rejected: [], response: '250 OK' });
      const first = await sendForward(
        source(),
        { ...basePayload, forwardIntentReceipt: receipt, ...liveParams },
        smtpConfig,
        SECRET,
        { getPassword, sendFn },
      );
      expect(first.outcome).toBe('accepted');

      const second = await sendForward(
        source(),
        { ...basePayload, forwardIntentReceipt: receipt, ...liveParams },
        smtpConfig,
        SECRET,
        { getPassword, sendFn },
      );
      expect(second.outcome).toBe('rejected');
      expect(second.reasons.join(' ')).toMatch(/already been used/i);
      expect(sendFn).toHaveBeenCalledTimes(1);
      expect(getPassword).toHaveBeenCalledTimes(1);
    });
  });

  describe('no attachments sent — buildForwardMessage reaches SMTP correctly', () => {
    it('the submitted message has the caller recipients, derived subject, and forwarded text', async () => {
      const receipt = previewReceipt();
      const sendFn = vi
        .fn()
        .mockResolvedValue({ accepted: ['a@example.com'], rejected: [], response: '250 OK' });
      await sendForward(
        source(),
        { ...basePayload, forwardIntentReceipt: receipt, ...liveParams },
        smtpConfig,
        SECRET,
        { getPassword, sendFn, liveDisabled: false },
      );
      const [, message] = sendFn.mock.calls[0] as [
        unknown,
        { to: string[]; subject: string; text: string },
      ];
      expect(message.to).toEqual(['a@example.com']);
      expect(message.subject).toBe('Fwd: Hello');
      expect(message.text).toContain('Original message body.');
      expect(message).toHaveProperty('cc', []);
      expect(message).not.toHaveProperty('bcc');
      expect(message).not.toHaveProperty('replyAll');
    });
  });

  describe('receipt cross-check', () => {
    it('receipt signed under a different secret: rejected, zero send', async () => {
      const otherReceipt = previewForward(
        source(),
        { to: ['a@example.com'] },
        smtpConfig.username,
        OTHER_SECRET,
      ).forwardIntentReceipt;
      const sendFn = vi.fn();
      const result = await sendForward(
        source(),
        { ...basePayload, forwardIntentReceipt: otherReceipt, ...liveParams },
        smtpConfig,
        SECRET,
        { getPassword, sendFn, liveDisabled: false },
      );
      expect(result.outcome).toBe('rejected');
      expect(sendFn).not.toHaveBeenCalled();
    });

    it('expired receipt: zero SMTP', async () => {
      const receipt = previewReceipt();
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now + FORWARD_INTENT_RECEIPT_TTL_MS + 1);
      const sendFn = vi.fn();
      const result = await sendForward(
        source(),
        { ...basePayload, forwardIntentReceipt: receipt, ...liveParams },
        smtpConfig,
        SECRET,
        { getPassword, sendFn },
      );
      expect(result.outcome).toBe('rejected');
      expect(result.reasons.join(' ')).toMatch(/expired/i);
      expect(sendFn).not.toHaveBeenCalled();
      expect(getPassword).not.toHaveBeenCalled();
    });
  });

  it('SMTP failure does not retry automatically', async () => {
    const receipt = previewReceipt();
    const sendFn = vi.fn().mockRejectedValue(new Error('SMTP unavailable'));
    const result = await sendForward(
      source(),
      { ...basePayload, forwardIntentReceipt: receipt, ...liveParams },
      smtpConfig,
      SECRET,
      { getPassword, sendFn },
    );
    expect(result.outcome).not.toBe('accepted');
    expect(sendFn).toHaveBeenCalledTimes(1);
  });

  it('does not expose hostile SMTP error fields in the returned forward result', async () => {
    const sendFn = vi.fn().mockRejectedValue({
      code: 'SENSITIVE_ERROR_CODE',
      command: 'SENSITIVE_SMTP_COMMAND',
      response: 'SENSITIVE_SMTP_RESPONSE',
      responseCode: 450,
      message: 'SENSITIVE_EMAIL@example.invalid /Users/test/private/config.json',
      cause: new Error('FAKE_SECRET_TOKEN_123'),
      stack: 'SENSITIVE_STACK',
    });
    const result = await sendForward(
      source(),
      { ...basePayload, forwardIntentReceipt: previewReceipt(), ...liveParams },
      smtpConfig,
      SECRET,
      { getPassword, sendFn },
    );
    expect(result.outcome).toBe('uncertain');
    expect(result.deliveryUncertain).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/SENSITIVE_|example\.invalid|\/Users\/test/);
    expect(sendFn).toHaveBeenCalledTimes(1);
  });

  describe('0.5.4 default gate', () => {
    it('with no override, a fully valid live forward reaches SMTP exactly once', async () => {
      const receipt = previewReceipt();
      const sendFn = vi
        .fn()
        .mockResolvedValue({ accepted: ['a@example.com'], rejected: [], response: '250 OK' });
      const result = await sendForward(
        source(),
        { ...basePayload, forwardIntentReceipt: receipt, ...liveParams },
        smtpConfig,
        SECRET,
        { getPassword, sendFn },
      );
      expect(result.outcome).toBe('accepted');
      expect(result.submissionAttempted).toBe(true);
      expect(sendFn).toHaveBeenCalledTimes(1);
      expect(getPassword).toHaveBeenCalledTimes(1);
    });
  });
});
