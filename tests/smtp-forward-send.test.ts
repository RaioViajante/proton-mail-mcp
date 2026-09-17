import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForwardSourceContent } from '../src/mail/source-message.js';
import { resetReplayGuardForTests } from '../src/security/send-intent-replay-guard.js';
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

describe('sendForward (0.5.2)', () => {
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
        { getPassword, sendFn, liveDisabled: false },
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
    it('gate closed (default): rejected, submissionAttempted false, nonce NOT consumed', async () => {
      const receipt = previewReceipt();
      const sendFn = vi.fn();
      const blocked = await sendForward(
        source(),
        { ...basePayload, forwardIntentReceipt: receipt, ...liveParams },
        smtpConfig,
        SECRET,
        { getPassword, sendFn },
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
        { getPassword, sendFn, liveDisabled: false },
      );
      expect(opened.outcome).toBe('accepted');
    });

    it('gate open: nonce IS consumed on the first call; second call refused', async () => {
      const receipt = previewReceipt();
      const sendFn = vi
        .fn()
        .mockResolvedValue({ accepted: ['a@example.com'], rejected: [], response: '250 OK' });
      const first = await sendForward(
        source(),
        { ...basePayload, forwardIntentReceipt: receipt, ...liveParams },
        smtpConfig,
        SECRET,
        { getPassword, sendFn, liveDisabled: false },
      );
      expect(first.outcome).toBe('accepted');

      const second = await sendForward(
        source(),
        { ...basePayload, forwardIntentReceipt: receipt, ...liveParams },
        smtpConfig,
        SECRET,
        { getPassword, sendFn, liveDisabled: false },
      );
      expect(second.outcome).toBe('rejected');
      expect(second.reasons.join(' ')).toMatch(/already been used/i);
      expect(sendFn).toHaveBeenCalledTimes(1);
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
  });

  describe('0.5.3 regression: forward gate is unaffected by the reply gate being enabled', () => {
    it('with no override, a fully valid live forward call is still rejected by the real (still-true) LIVE_FORWARD_DISABLED gate', async () => {
      const receipt = previewReceipt();
      const sendFn = vi.fn();
      const result = await sendForward(
        source(),
        { ...basePayload, forwardIntentReceipt: receipt, ...liveParams },
        smtpConfig,
        SECRET,
        { getPassword, sendFn }, // no liveDisabled override — the real gate
      );
      expect(result.outcome).toBe('rejected');
      expect(result.submissionAttempted).toBe(false);
      expect(sendFn).not.toHaveBeenCalled();
      expect(getPassword).not.toHaveBeenCalled();
      expect(result.reasons.join(' ')).toMatch(/disabled/i);
    });
  });
});
