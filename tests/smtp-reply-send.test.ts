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

describe('sendReply (0.5.3)', () => {
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

    it('live missing acknowledgeExternalReply: throws, zero send (0.5.3 — the gate being open does not relax this)', async () => {
      const sendFn = vi.fn();
      await expect(
        sendReply(
          source(),
          {
            ...basePayload,
            replyIntentReceipt: previewReceipt(),
            dryRun: false,
            confirm: true,
            acknowledgeExternalReply: false,
          },
          smtpConfig,
          SECRET,
          { getPassword, sendFn },
        ),
      ).rejects.toThrow(/confirm=true and acknowledgeExternalReply=true/);
      expect(sendFn).not.toHaveBeenCalled();
      expect(getPassword).not.toHaveBeenCalled();
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

      // The same receipt must still work afterwards — the dry-run check
      // must not have burned the nonce.
      const sendFn = vi
        .fn()
        .mockResolvedValue({ accepted: ['sender@example.com'], rejected: [], response: '250 OK' });
      const liveResult = await sendReply(
        source(),
        { ...basePayload, replyIntentReceipt: receipt, ...liveParams },
        smtpConfig,
        SECRET,
        { getPassword, sendFn },
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

    it('receipt with a tampered signature: rejected before credential or SMTP', async () => {
      const receipt = previewReceipt()!;
      const sendFn = vi.fn();
      const result = await sendReply(
        source(),
        {
          ...basePayload,
          replyIntentReceipt: { ...receipt, signature: '0'.repeat(64) },
          ...liveParams,
        },
        smtpConfig,
        SECRET,
        { getPassword, sendFn },
      );
      expect(result.outcome).toBe('rejected');
      expect(result.submissionAttempted).toBe(false);
      expect(getPassword).not.toHaveBeenCalled();
      expect(sendFn).not.toHaveBeenCalled();
    });

    it('expired receipt: rejected before credential or SMTP', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        const receipt = previewReceipt();
        vi.setSystemTime(new Date('2026-01-01T00:16:00.000Z'));
        const sendFn = vi.fn();
        const result = await sendReply(
          source(),
          { ...basePayload, replyIntentReceipt: receipt, ...liveParams },
          smtpConfig,
          SECRET,
          { getPassword, sendFn },
        );
        expect(result.outcome).toBe('rejected');
        expect(result.submissionAttempted).toBe(false);
        expect(result.reasons.join(' ')).toMatch(/expired/i);
        expect(getPassword).not.toHaveBeenCalled();
        expect(sendFn).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
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

  describe('feature gate ordering (0.5.3 — LIVE_REPLY_DISABLED is now false by default)', () => {
    it('the real (unset) gate now defaults to ENABLED: a fully valid live call reaches SMTP exactly once with no override needed', async () => {
      const receipt = previewReceipt();
      const sendFn = vi
        .fn()
        .mockResolvedValue({ accepted: ['sender@example.com'], rejected: [], response: '250 OK' });
      const result = await sendReply(
        source(),
        { ...basePayload, replyIntentReceipt: receipt, ...liveParams },
        smtpConfig,
        SECRET,
        { getPassword, sendFn }, // no liveDisabled override — this is the real, 0.5.3 default gate
      );
      expect(result.outcome).toBe('accepted');
      expect(result.submissionAttempted).toBe(true);
      expect(sendFn).toHaveBeenCalledTimes(1);
      expect(getPassword).toHaveBeenCalledTimes(1);
    });

    it('nonce consumed exactly once: a second call with the same receipt is refused, zero further SMTP attempt', async () => {
      const receipt = previewReceipt();
      const sendFn = vi
        .fn()
        .mockResolvedValue({ accepted: ['sender@example.com'], rejected: [], response: '250 OK' });
      const first = await sendReply(
        source(),
        { ...basePayload, replyIntentReceipt: receipt, ...liveParams },
        smtpConfig,
        SECRET,
        { getPassword, sendFn },
      );
      expect(first.outcome).toBe('accepted');

      const second = await sendReply(
        source(),
        { ...basePayload, replyIntentReceipt: receipt, ...liveParams },
        smtpConfig,
        SECRET,
        { getPassword, sendFn },
      );
      expect(second.outcome).toBe('rejected');
      expect(second.reasons.join(' ')).toMatch(/already been used/i);
      expect(sendFn).toHaveBeenCalledTimes(1);
    });

    it('regression: the gate-closed code path (deps.liveDisabled: true) still rejects before nonce consumption and still preserves the receipt — this is what mail_forward relies on today', async () => {
      const receipt = previewReceipt();
      const sendFn = vi.fn();
      const blocked = await sendReply(
        source(),
        { ...basePayload, replyIntentReceipt: receipt, ...liveParams },
        smtpConfig,
        SECRET,
        { getPassword, sendFn, liveDisabled: true },
      );
      expect(blocked.outcome).toBe('rejected');
      expect(blocked.submissionAttempted).toBe(false);
      expect(sendFn).not.toHaveBeenCalled();
      expect(getPassword).not.toHaveBeenCalled();
      expect(blocked.reasons.join(' ')).toMatch(/disabled/i);

      // The SAME receipt must still be usable afterwards — a gate-blocked
      // call must not burn the one-time nonce.
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
        { getPassword, sendFn }, // real (now-open) gate
      );
      expect(opened.outcome).toBe('accepted');
      expect(sendFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('threading actually reaches the SMTP message', () => {
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
