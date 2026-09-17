import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReplySourceHeaders } from '../src/mail/source-message.js';
import { resetReplayGuardForTests } from '../src/security/send-intent-replay-guard.js';
import type { ResolvedSmtpConfig } from '../src/smtp/config.js';
import { previewReply } from '../src/smtp/reply-preview.js';
import { sendReply } from '../src/smtp/reply-send.js';

const SECRET = Buffer.from('c'.repeat(64), 'hex');
const OTHER_SECRET = Buffer.from('f'.repeat(64), 'hex');

function source(overrides: Partial<ReplySourceHeaders> = {}): ReplySourceHeaders {
  return {
    folder: 'INBOX',
    uid: 1,
    uidValidity: '111',
    from: 'sender@example.com',
    messageId: '<abc@example.com>',
    subject: 'Hello',
    date: '2026-01-01T00:00:00.000Z',
    replyTo: { headerPresent: false, malformed: false, addresses: [] },
    references: { headerPresent: false, malformed: false, raw: null },
    ...overrides,
  };
}

describe('sendReply (0.5.2)', () => {
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

  const liveParams = { dryRun: false, confirm: true, acknowledgeExternalReply: true } as const;
  const basePayload = { sourceFolder: 'INBOX', uid: 1, text: 'Thanks!' };

  function previewReceipt(src: ReplySourceHeaders = source(), text = 'Thanks!') {
    return previewReply(src, { text }, smtpConfig.username, SECRET).replyIntentReceipt;
  }

  describe('consent gate', () => {
    it('live missing confirm: throws, zero send', async () => {
      const sendFn = vi.fn();
      await expect(
        sendReply(
          source(),
          {
            ...basePayload,
            replyIntentReceipt: previewReceipt(),
            dryRun: false,
            confirm: false,
            acknowledgeExternalReply: true,
          },
          smtpConfig,
          SECRET,
          { getPassword, sendFn },
        ),
      ).rejects.toThrow(/confirm=true and acknowledgeExternalReply=true/);
      expect(sendFn).not.toHaveBeenCalled();
    });
  });

  describe('dry-run: zero SMTP, ever', () => {
    it('dryRun=true performs zero SMTP submission', async () => {
      const sendFn = vi.fn();
      const result = await sendReply(
        source(),
        { ...basePayload, dryRun: true, confirm: true, acknowledgeExternalReply: true },
        smtpConfig,
        SECRET,
        { getPassword, sendFn },
      );
      expect(result.submissionAttempted).toBeUndefined();
      expect(sendFn).not.toHaveBeenCalled();
      expect(getPassword).not.toHaveBeenCalled();
    });

    it('dryRun=true with a valid receipt: receiptValid=true, never consumes the nonce', async () => {
      const receipt = previewReceipt();
      const dryRunResult = await sendReply(
        source(),
        {
          ...basePayload,
          replyIntentReceipt: receipt,
          dryRun: true,
          confirm: false,
          acknowledgeExternalReply: false,
        },
        smtpConfig,
        SECRET,
      );
      expect(dryRunResult.receiptValid).toBe(true);

      // The same receipt must still work afterwards (with the live gate
      // overridden open) — the dry-run check must not have burned the nonce.
      const sendFn = vi
        .fn()
        .mockResolvedValue({ accepted: ['sender@example.com'], rejected: [], response: '250 OK' });
      const liveResult = await sendReply(
        source(),
        { ...basePayload, replyIntentReceipt: receipt, ...liveParams },
        smtpConfig,
        SECRET,
        { getPassword, sendFn, liveDisabled: false },
      );
      expect(liveResult.outcome).toBe('accepted');
    });
  });

  describe('receipt requirements (live)', () => {
    it('missing receipt: rejected, zero send', async () => {
      const sendFn = vi.fn();
      const result = await sendReply(
        source(),
        { ...basePayload, ...liveParams },
        smtpConfig,
        SECRET,
        {
          getPassword,
          sendFn,
          liveDisabled: false,
        },
      );
      expect(result.outcome).toBe('rejected');
      expect(sendFn).not.toHaveBeenCalled();
    });

    it('receipt for different text (tampered after preview): rejected, zero send', async () => {
      const receipt = previewReceipt();
      const sendFn = vi.fn();
      const result = await sendReply(
        source(),
        { ...basePayload, text: 'Different text', replyIntentReceipt: receipt, ...liveParams },
        smtpConfig,
        SECRET,
        { getPassword, sendFn, liveDisabled: false },
      );
      expect(result.outcome).toBe('rejected');
      expect(sendFn).not.toHaveBeenCalled();
    });

    it('receipt signed under a different secret: rejected, zero send', async () => {
      const otherReceipt = previewReply(
        source(),
        { text: 'Thanks!' },
        smtpConfig.username,
        OTHER_SECRET,
      ).replyIntentReceipt;
      const sendFn = vi.fn();
      const result = await sendReply(
        source(),
        { ...basePayload, replyIntentReceipt: otherReceipt, ...liveParams },
        smtpConfig,
        SECRET,
        { getPassword, sendFn, liveDisabled: false },
      );
      expect(result.outcome).toBe('rejected');
      expect(sendFn).not.toHaveBeenCalled();
    });
  });

  describe('source revalidation (section 9)', () => {
    it('source changed since preview (different uid at send time): rejected before SMTP', async () => {
      const receipt = previewReceipt(source({ uid: 1 }));
      const sendFn = vi.fn();
      const result = await sendReply(
        source({ uid: 2 }), // a different message re-fetched at send time
        { ...basePayload, replyIntentReceipt: receipt, ...liveParams },
        smtpConfig,
        SECRET,
        { getPassword, sendFn, liveDisabled: false },
      );
      expect(result.outcome).toBe('rejected');
      expect(sendFn).not.toHaveBeenCalled();
    });

    it('Reply-To changed since preview: rejected before SMTP', async () => {
      const originalSource = source();
      const receipt = previewReceipt(originalSource);
      const changedSource = source({
        replyTo: { headerPresent: true, malformed: false, addresses: ['new-reply-to@example.com'] },
      });
      const sendFn = vi.fn();
      const result = await sendReply(
        changedSource,
        { ...basePayload, replyIntentReceipt: receipt, ...liveParams },
        smtpConfig,
        SECRET,
        { getPassword, sendFn, liveDisabled: false },
      );
      expect(result.outcome).toBe('rejected');
      expect(sendFn).not.toHaveBeenCalled();
    });

    it('message not found at send time (deleted since preview): rejected, zero send', async () => {
      const receipt = previewReceipt();
      const sendFn = vi.fn();
      const result = await sendReply(
        null,
        { ...basePayload, replyIntentReceipt: receipt, ...liveParams },
        smtpConfig,
        SECRET,
        { getPassword, sendFn, liveDisabled: false },
      );
      expect(result.outcome).toBe('rejected');
      expect(sendFn).not.toHaveBeenCalled();
    });

    it('message not found at send time, dryRun=true: reports intentValidated=false, zero send', async () => {
      const result = await sendReply(
        null,
        { ...basePayload, dryRun: true, confirm: false, acknowledgeExternalReply: false },
        smtpConfig,
        SECRET,
      );
      expect(result.intentValidated).toBe(false);
    });
  });

  describe('feature gate ordering (corrected 0.5.2 semantics — gate BEFORE nonce consumption)', () => {
    it('gate closed (default): live call is rejected, submissionAttempted false, and the receipt is NOT consumed', async () => {
      const receipt = previewReceipt();
      const sendFn = vi.fn();
      const blocked = await sendReply(
        source(),
        { ...basePayload, replyIntentReceipt: receipt, ...liveParams },
        smtpConfig,
        SECRET,
        { getPassword, sendFn }, // no liveDisabled override — uses the real (true) gate
      );
      expect(blocked.outcome).toBe('rejected');
      expect(blocked.submissionAttempted).toBe(false);
      expect(sendFn).not.toHaveBeenCalled();
      expect(getPassword).not.toHaveBeenCalled();
      expect(blocked.reasons.join(' ')).toMatch(/disabled/i);

      // The SAME receipt must still be usable — a gate-blocked call must not
      // burn the one-time nonce, since it caused no external side effect.
      sendFn.mockResolvedValue({
        accepted: ['sender@example.com'],
        rejected: [],
        response: '250 OK',
      });
      const opened = await sendReply(
        source(),
        { ...basePayload, replyIntentReceipt: receipt, ...liveParams },
        smtpConfig,
        SECRET,
        { getPassword, sendFn, liveDisabled: false },
      );
      expect(opened.outcome).toBe('accepted');
      expect(sendFn).toHaveBeenCalledTimes(1);
    });

    it('gate open (test override): nonce IS consumed on the first call; a second call with the same receipt is refused regardless of gate state', async () => {
      const receipt = previewReceipt();
      const sendFn = vi
        .fn()
        .mockResolvedValue({ accepted: ['sender@example.com'], rejected: [], response: '250 OK' });
      const first = await sendReply(
        source(),
        { ...basePayload, replyIntentReceipt: receipt, ...liveParams },
        smtpConfig,
        SECRET,
        { getPassword, sendFn, liveDisabled: false },
      );
      expect(first.outcome).toBe('accepted');

      const second = await sendReply(
        source(),
        { ...basePayload, replyIntentReceipt: receipt, ...liveParams },
        smtpConfig,
        SECRET,
        { getPassword, sendFn, liveDisabled: false },
      );
      expect(second.outcome).toBe('rejected');
      expect(second.reasons.join(' ')).toMatch(/already been used/i);
      expect(sendFn).toHaveBeenCalledTimes(1);
    });

    it('the real (unset) gate defaults to disabled — no override needed to observe the block', async () => {
      const receipt = previewReceipt();
      const sendFn = vi.fn();
      const result = await sendReply(
        source(),
        { ...basePayload, replyIntentReceipt: receipt, ...liveParams },
        smtpConfig,
        SECRET,
        { getPassword, sendFn },
      );
      expect(result.outcome).toBe('rejected');
      expect(sendFn).not.toHaveBeenCalled();
    });
  });

  describe('threading actually reaches the SMTP message (gate opened for this test only)', () => {
    it('a threaded reply sets inReplyTo/references on the submitted message', async () => {
      const receipt = previewReceipt();
      const sendFn = vi
        .fn()
        .mockResolvedValue({ accepted: ['sender@example.com'], rejected: [], response: '250 OK' });
      await sendReply(
        source(),
        { ...basePayload, replyIntentReceipt: receipt, ...liveParams },
        smtpConfig,
        SECRET,
        { getPassword, sendFn, liveDisabled: false },
      );
      const [, message] = sendFn.mock.calls[0] as [
        unknown,
        { inReplyTo?: string; references?: string[] },
      ];
      expect(message.inReplyTo).toBe('<abc@example.com>');
      expect(message.references).toEqual(['<abc@example.com>']);
    });
  });

  describe('zero automatic retry on ambiguous outcome', () => {
    it('disconnect mid-submission: outcome uncertain, never retried', async () => {
      const receipt = previewReceipt();
      const sendFn = vi
        .fn()
        .mockRejectedValueOnce({ command: 'DATA', code: 'ECONNRESET', message: 'lost' });
      const first = await sendReply(
        source(),
        { ...basePayload, replyIntentReceipt: receipt, ...liveParams },
        smtpConfig,
        SECRET,
        { getPassword, sendFn, liveDisabled: false },
      );
      expect(first.outcome).toBe('uncertain');
      expect(sendFn).toHaveBeenCalledTimes(1);

      const second = await sendReply(
        source(),
        { ...basePayload, replyIntentReceipt: receipt, ...liveParams },
        smtpConfig,
        SECRET,
        { getPassword, sendFn, liveDisabled: false },
      );
      expect(second.outcome).toBe('rejected');
      expect(sendFn).toHaveBeenCalledTimes(1);
    });
  });
});
