import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetReplayGuardForTests } from '../src/security/send-intent-replay-guard.js';
import {
  receiptFieldsFromIntent,
  signSendIntentReceipt,
} from '../src/security/send-intent-receipt.js';
import { validateSendIntent } from '../src/smtp/intent.js';
import { previewSend } from '../src/smtp/preview.js';
import type { ResolvedSmtpConfig } from '../src/smtp/config.js';
import { sendMail } from '../src/smtp/send.js';

const SECRET = Buffer.from('c'.repeat(64), 'hex');
const OTHER_SECRET = Buffer.from('f'.repeat(64), 'hex');

const validPayload = { to: ['a@example.com'], subject: 'Hi', text: 'Hello' };

function previewReceipt(smtpConfig: ResolvedSmtpConfig, payload = validPayload) {
  const preview = previewSend(payload, smtpConfig, SECRET);
  return preview.sendIntentReceipt;
}

describe('mail_send (0.5.1 — live path)', () => {
  let dir: string;
  let certPath: string;
  let smtpConfig: ResolvedSmtpConfig;
  let getPassword: () => Promise<string>;

  beforeEach(() => {
    resetReplayGuardForTests();
    dir = mkdtempSync(join(tmpdir(), 'proton-mail-mcp-test-'));
    certPath = join(dir, 'bridge-cert.pem');
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

  const liveIntent = { dryRun: false, confirm: true, acknowledgeExternalSend: true } as const;

  describe('consent gate defaults', () => {
    it('dryRun defaults meaningfully: a dry-run call never needs confirm/acknowledge', async () => {
      const result = await sendMail(
        { ...validPayload, dryRun: true, confirm: false, acknowledgeExternalSend: false },
        smtpConfig,
        SECRET,
      );
      expect(result.intentValidated).toBe(true);
      expect(result.outcome).toBeUndefined();
    });

    it('live missing confirm: throws, zero send', async () => {
      const sendFn = vi.fn();
      await expect(
        sendMail(
          {
            ...validPayload,
            sendIntentReceipt: previewReceipt(smtpConfig),
            dryRun: false,
            confirm: false,
            acknowledgeExternalSend: true,
          },
          smtpConfig,
          SECRET,
          { getPassword, sendFn },
        ),
      ).rejects.toThrow(/confirm=true and acknowledgeExternalSend=true/);
      expect(sendFn).not.toHaveBeenCalled();
      expect(getPassword).not.toHaveBeenCalled();
    });

    it('live missing acknowledgeExternalSend: throws, zero send', async () => {
      const sendFn = vi.fn();
      await expect(
        sendMail(
          {
            ...validPayload,
            sendIntentReceipt: previewReceipt(smtpConfig),
            dryRun: false,
            confirm: true,
            acknowledgeExternalSend: false,
          },
          smtpConfig,
          SECRET,
          { getPassword, sendFn },
        ),
      ).rejects.toThrow(/confirm=true and acknowledgeExternalSend=true/);
      expect(sendFn).not.toHaveBeenCalled();
    });
  });

  describe('dry-run: zero network, ever', () => {
    it('dryRun=true performs zero SMTP submission regardless of confirm/acknowledge', async () => {
      const sendFn = vi.fn();
      const result = await sendMail(
        { ...validPayload, dryRun: true, confirm: true, acknowledgeExternalSend: true },
        smtpConfig,
        SECRET,
        { getPassword, sendFn },
      );
      expect(result.submissionAttempted).toBeUndefined();
      expect(result.connectionEstablished).toBeUndefined();
      expect(sendFn).not.toHaveBeenCalled();
      expect(getPassword).not.toHaveBeenCalled();
    });

    it('dryRun=true with a valid receipt: reports receiptValid=true, never touches the network, never consumes the nonce', async () => {
      const receipt = previewReceipt(smtpConfig);
      const sendFn = vi.fn();
      const dryRunResult = await sendMail(
        {
          ...validPayload,
          sendIntentReceipt: receipt,
          dryRun: true,
          confirm: false,
          acknowledgeExternalSend: false,
        },
        smtpConfig,
        SECRET,
        { getPassword, sendFn },
      );
      expect(dryRunResult.receiptValid).toBe(true);
      expect(sendFn).not.toHaveBeenCalled();
      expect(getPassword).not.toHaveBeenCalled();

      // The same receipt must still work for a REAL live call afterwards —
      // the dry-run check above must not have burned the nonce.
      sendFn.mockResolvedValue({ accepted: ['a@example.com'], rejected: [], response: '250 OK' });
      const liveResult = await sendMail(
        { ...validPayload, sendIntentReceipt: receipt, ...liveIntent },
        smtpConfig,
        SECRET,
        { getPassword, sendFn },
      );
      expect(liveResult.outcome).toBe('accepted');
      expect(sendFn).toHaveBeenCalledTimes(1);
    });

    it('dryRun=true with an invalid (tampered) receipt: reports receiptValid=false with a reason', async () => {
      const receipt = previewReceipt(smtpConfig);
      const result = await sendMail(
        {
          to: ['different@example.com'],
          subject: 'Hi',
          text: 'Hello',
          sendIntentReceipt: receipt,
          dryRun: true,
          confirm: false,
          acknowledgeExternalSend: false,
        },
        smtpConfig,
        SECRET,
      );
      expect(result.receiptValid).toBe(false);
      expect(result.reasons.join(' ')).toMatch(/does not match/i);
    });
  });

  describe('receipt requirements (live)', () => {
    it('missing receipt on a live call: rejected, zero send', async () => {
      const sendFn = vi.fn();
      const result = await sendMail({ ...validPayload, ...liveIntent }, smtpConfig, SECRET, {
        getPassword,
        sendFn,
      });
      expect(result.outcome).toBe('rejected');
      expect(result.reasons.join(' ')).toMatch(/malformed/i);
      expect(sendFn).not.toHaveBeenCalled();
    });

    it('invalid (malformed) receipt: rejected, zero send', async () => {
      const sendFn = vi.fn();
      const result = await sendMail(
        { ...validPayload, sendIntentReceipt: { garbage: true }, ...liveIntent },
        smtpConfig,
        SECRET,
        { getPassword, sendFn },
      );
      expect(result.outcome).toBe('rejected');
      expect(sendFn).not.toHaveBeenCalled();
    });

    it('receipt for a different payload (tampered after preview): rejected, zero send', async () => {
      const receipt = previewReceipt(smtpConfig);
      const sendFn = vi.fn();
      const result = await sendMail(
        {
          to: ['b@example.com'],
          subject: 'Hi',
          text: 'Hello',
          sendIntentReceipt: receipt,
          ...liveIntent,
        },
        smtpConfig,
        SECRET,
        { getPassword, sendFn },
      );
      expect(result.outcome).toBe('rejected');
      expect(result.reasons.join(' ')).toMatch(/does not match/i);
      expect(sendFn).not.toHaveBeenCalled();
    });

    it('receipt signed under a different secret than the one available now: rejected, zero send', async () => {
      const preview = previewSend(validPayload, smtpConfig, OTHER_SECRET);
      const sendFn = vi.fn();
      const result = await sendMail(
        { ...validPayload, sendIntentReceipt: preview.sendIntentReceipt, ...liveIntent },
        smtpConfig,
        SECRET,
        { getPassword, sendFn },
      );
      expect(result.outcome).toBe('rejected');
      expect(sendFn).not.toHaveBeenCalled();
    });

    it('signing secret unavailable at send time: every receipt fails closed, zero send', async () => {
      const receipt = previewReceipt(smtpConfig);
      const sendFn = vi.fn();
      const result = await sendMail(
        { ...validPayload, sendIntentReceipt: receipt, ...liveIntent },
        smtpConfig,
        undefined,
        { getPassword, sendFn },
      );
      expect(result.outcome).toBe('rejected');
      expect(sendFn).not.toHaveBeenCalled();
    });

    it('an expired receipt: rejected, zero send', async () => {
      const { intent } = validateSendIntent(validPayload, smtpConfig.username);
      expect(intent).not.toBeNull();
      if (!intent) return;
      const issuedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago — well past the 15-minute TTL
      const expiredReceipt = signSendIntentReceipt(
        SECRET,
        receiptFieldsFromIntent(intent, issuedAt),
      );
      const sendFn = vi.fn();
      const result = await sendMail(
        { ...validPayload, sendIntentReceipt: expiredReceipt, ...liveIntent },
        smtpConfig,
        SECRET,
        { getPassword, sendFn },
      );
      expect(result.outcome).toBe('rejected');
      expect(result.reasons.join(' ')).toMatch(/expired/i);
      expect(sendFn).not.toHaveBeenCalled();
    });
  });

  describe('invalid intent on a live call', () => {
    it('unauthorized sender: rejected before receipt is even checked, zero send', async () => {
      const sendFn = vi.fn();
      const result = await sendMail(
        {
          from: 'ceo@google.com',
          to: ['a@example.com'],
          subject: 'Hi',
          text: 'Hello',
          ...liveIntent,
        },
        smtpConfig,
        SECRET,
        { getPassword, sendFn },
      );
      expect(result.outcome).toBe('rejected');
      expect(result.intentValidated).toBe(false);
      expect(sendFn).not.toHaveBeenCalled();
    });

    it('external (non-loopback) SMTP host in config: zero send', async () => {
      const receipt = previewReceipt(smtpConfig);
      const externalConfig = { ...smtpConfig, host: 'smtp.gmail.com' };
      const sendFn = vi.fn();
      const result = await sendMail(
        { ...validPayload, sendIntentReceipt: receipt, ...liveIntent },
        externalConfig,
        SECRET,
        { getPassword, sendFn },
      );
      expect(result.outcome).toBe('failed');
      expect(sendFn).not.toHaveBeenCalled();
      expect(result.connectionEstablished).toBe(false);
    });
  });

  describe('missing credential / TLS config (section 13)', () => {
    it('Bridge password unavailable in the Keychain: fails before any SMTP attempt', async () => {
      const receipt = previewReceipt(smtpConfig);
      const failingGetPassword = vi
        .fn<() => Promise<string>>()
        .mockRejectedValue(
          new Error('fake@example.test <fake-id@example.test> /tmp/private-fixture'),
        );
      const sendFn = vi.fn();
      const result = await sendMail(
        { ...validPayload, sendIntentReceipt: receipt, ...liveIntent },
        smtpConfig,
        SECRET,
        { getPassword: failingGetPassword, sendFn },
      );
      expect(result.outcome).toBe('failed');
      expect(result.connectionEstablished).toBe(false);
      expect(result.submissionAttempted).toBe(false);
      expect(sendFn).not.toHaveBeenCalled();
      expect(result.reasons).toContain('Could not retrieve the Bridge SMTP credential.');
      expect(JSON.stringify(result)).not.toContain('fake@example.test');
    });

    it('TLS certificate missing: fails closed, zero send attempt', async () => {
      const receipt = previewReceipt(smtpConfig);
      const missingCertConfig = { ...smtpConfig, tlsCertPath: join(dir, 'does-not-exist.pem') };
      const sendFn = vi.fn();
      const result = await sendMail(
        { ...validPayload, sendIntentReceipt: receipt, ...liveIntent },
        missingCertConfig,
        SECRET,
        { getPassword, sendFn },
      );
      expect(result.outcome).toBe('failed');
      expect(sendFn).not.toHaveBeenCalled();
    });
  });

  describe('a fully valid live call reaches the transport exactly once', () => {
    it('accepted submission: outcome accepted, sendFn called exactly once, sentFolderObserved null', async () => {
      const receipt = previewReceipt(smtpConfig);
      const sendFn = vi
        .fn()
        .mockResolvedValue({ accepted: ['a@example.com'], rejected: [], response: '250 OK' });
      const result = await sendMail(
        { ...validPayload, sendIntentReceipt: receipt, ...liveIntent },
        smtpConfig,
        SECRET,
        { getPassword, sendFn },
      );
      expect(result.outcome).toBe('accepted');
      expect(result.connectionEstablished).toBe(true);
      expect(result.authenticated).toBe(true);
      expect(result.submissionAttempted).toBe(true);
      expect(result.acceptedRecipients).toEqual(['a@example.com']);
      expect(result.rejectedRecipients).toEqual([]);
      expect(result.sentFolderObserved).toBeNull();
      expect(sendFn).toHaveBeenCalledTimes(1);
      expect(getPassword).toHaveBeenCalledTimes(1);
    });

    it('never claims "delivered", "received", or "read" anywhere in the result', async () => {
      const receipt = previewReceipt(smtpConfig);
      const sendFn = vi
        .fn()
        .mockResolvedValue({ accepted: ['a@example.com'], rejected: [], response: '250 OK' });
      const result = await sendMail(
        { ...validPayload, sendIntentReceipt: receipt, ...liveIntent },
        smtpConfig,
        SECRET,
        { getPassword, sendFn },
      );
      const serialized = JSON.stringify(result);
      expect(serialized).not.toMatch(/delivered/i);
      expect(serialized).not.toMatch(/\breceived\b/i);
      expect(serialized).not.toMatch(/\bread\b/i);
    });
  });

  describe('auth rejection', () => {
    it('SMTP auth reject: outcome failed, authenticated false, zero retry', async () => {
      const receipt = previewReceipt(smtpConfig);
      const sendFn = vi.fn().mockRejectedValue({ command: 'AUTH', message: 'Invalid login' });
      const result = await sendMail(
        { ...validPayload, sendIntentReceipt: receipt, ...liveIntent },
        smtpConfig,
        SECRET,
        { getPassword, sendFn },
      );
      expect(result.outcome).toBe('failed');
      expect(result.authenticated).toBe(false);
      expect(result.submissionAttempted).toBe(false);
      expect(sendFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('recipient acceptance results (section 6)', () => {
    it('one recipient rejected out of two: outcome partiallyAccepted, sanitized recipient lists', async () => {
      const payload = { to: ['a@example.com', 'b@example.com'], subject: 'Hi', text: 'Hello' };
      const receipt = previewReceipt(smtpConfig, payload);
      const sendFn = vi
        .fn()
        .mockResolvedValue({ accepted: ['a@example.com'], rejected: ['b@example.com'] });
      const result = await sendMail(
        { ...payload, sendIntentReceipt: receipt, ...liveIntent },
        smtpConfig,
        SECRET,
        { getPassword, sendFn },
      );
      expect(result.outcome).toBe('partiallyAccepted');
      expect(result.acceptedRecipients).toEqual(['a@example.com']);
      expect(result.rejectedRecipients).toEqual(['b@example.com']);
    });

    it('never surfaces an address the caller did not submit, even if the library reports one', async () => {
      const receipt = previewReceipt(smtpConfig);
      const sendFn = vi.fn().mockResolvedValue({
        accepted: ['a@example.com', 'unexpected-internal@bridge.local'],
        rejected: [],
      });
      const result = await sendMail(
        { ...validPayload, sendIntentReceipt: receipt, ...liveIntent },
        smtpConfig,
        SECRET,
        { getPassword, sendFn },
      );
      expect(result.acceptedRecipients).toEqual(['a@example.com']);
      expect(JSON.stringify(result)).not.toContain('unexpected-internal@bridge.local');
    });
  });

  describe('disconnects and uncertainty — never retried, never silently resolved', () => {
    it('disconnect before DATA (no response code): outcome uncertain, sendFn called exactly once', async () => {
      const receipt = previewReceipt(smtpConfig);
      const sendFn = vi
        .fn()
        .mockRejectedValue({ command: 'MAIL FROM', code: 'ECONNRESET', message: 'lost' });
      const result = await sendMail(
        { ...validPayload, sendIntentReceipt: receipt, ...liveIntent },
        smtpConfig,
        SECRET,
        { getPassword, sendFn },
      );
      expect(result.outcome).toBe('uncertain');
      expect(result.deliveryUncertain).toBe(true);
      expect(sendFn).toHaveBeenCalledTimes(1);
    });

    it('disconnect during DATA: outcome uncertain, never treated as clean success or failure', async () => {
      const receipt = previewReceipt(smtpConfig);
      const sendFn = vi
        .fn()
        .mockRejectedValue({ command: 'DATA', code: 'ECONNRESET', message: 'lost mid-body' });
      const result = await sendMail(
        { ...validPayload, sendIntentReceipt: receipt, ...liveIntent },
        smtpConfig,
        SECRET,
        { getPassword, sendFn },
      );
      expect(result.outcome).toBe('uncertain');
      expect(result.deliveryUncertain).toBe(true);
      expect(sendFn).toHaveBeenCalledTimes(1);
    });

    it('disconnect after DATA accepted (never modeled as a second attempt): a fresh call needs a fresh receipt', async () => {
      const receipt = previewReceipt(smtpConfig);
      const sendFn = vi
        .fn()
        .mockRejectedValueOnce({ command: 'DATA', code: 'ECONNRESET', message: 'lost after body' });
      const first = await sendMail(
        { ...validPayload, sendIntentReceipt: receipt, ...liveIntent },
        smtpConfig,
        SECRET,
        { getPassword, sendFn },
      );
      expect(first.outcome).toBe('uncertain');
      expect(sendFn).toHaveBeenCalledTimes(1);

      // This project never retries automatically. If the caller invokes
      // mail_send again with the SAME (already-consumed) receipt, it must
      // be refused with zero further SMTP attempt.
      const second = await sendMail(
        { ...validPayload, sendIntentReceipt: receipt, ...liveIntent },
        smtpConfig,
        SECRET,
        { getPassword, sendFn },
      );
      expect(second.outcome).toBe('rejected');
      expect(sendFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('at-most-once and replay (sections 9, 10)', () => {
    it('one live call makes at most one sendFn call', async () => {
      const receipt = previewReceipt(smtpConfig);
      const sendFn = vi
        .fn()
        .mockResolvedValue({ accepted: ['a@example.com'], rejected: [], response: '250 OK' });
      await sendMail(
        { ...validPayload, sendIntentReceipt: receipt, ...liveIntent },
        smtpConfig,
        SECRET,
        { getPassword, sendFn },
      );
      expect(sendFn).toHaveBeenCalledTimes(1);
    });

    it('reusing an already-consumed receipt after a SUCCESSFUL send is refused, not resubmitted', async () => {
      const receipt = previewReceipt(smtpConfig);
      const sendFn = vi
        .fn()
        .mockResolvedValue({ accepted: ['a@example.com'], rejected: [], response: '250 OK' });
      const first = await sendMail(
        { ...validPayload, sendIntentReceipt: receipt, ...liveIntent },
        smtpConfig,
        SECRET,
        { getPassword, sendFn },
      );
      expect(first.outcome).toBe('accepted');

      const second = await sendMail(
        { ...validPayload, sendIntentReceipt: receipt, ...liveIntent },
        smtpConfig,
        SECRET,
        { getPassword, sendFn },
      );
      expect(second.outcome).toBe('rejected');
      expect(second.reasons.join(' ')).toMatch(/already been used/i);
      expect(sendFn).toHaveBeenCalledTimes(1);
    });

    it('reusing a receipt after a connection-level FAILURE (zero risk of duplication) is still refused — the receipt is single-use per attempt, not per success', async () => {
      const receipt = previewReceipt(smtpConfig);
      const missingCertConfig = { ...smtpConfig, tlsCertPath: join(dir, 'does-not-exist.pem') };
      const sendFn = vi.fn();
      const first = await sendMail(
        { ...validPayload, sendIntentReceipt: receipt, ...liveIntent },
        missingCertConfig,
        SECRET,
        { getPassword, sendFn },
      );
      expect(first.outcome).toBe('failed');
      expect(sendFn).not.toHaveBeenCalled();

      const second = await sendMail(
        { ...validPayload, sendIntentReceipt: receipt, ...liveIntent },
        smtpConfig, // even with a WORKING config now
        SECRET,
        { getPassword, sendFn },
      );
      expect(second.outcome).toBe('rejected');
      expect(second.reasons.join(' ')).toMatch(/already been used/i);
      expect(sendFn).not.toHaveBeenCalled();
    });

    it('two DIFFERENT receipts for the same intent are each independently single-use', async () => {
      const receiptA = previewReceipt(smtpConfig);
      const receiptB = previewReceipt(smtpConfig);
      expect(receiptA).toBeDefined();
      expect(receiptB).toBeDefined();
      if (receiptA && receiptB) {
        expect(receiptA.id).not.toBe(receiptB.id);
      }
      const sendFn = vi
        .fn()
        .mockResolvedValue({ accepted: ['a@example.com'], rejected: [], response: '250 OK' });
      const first = await sendMail(
        { ...validPayload, sendIntentReceipt: receiptA, ...liveIntent },
        smtpConfig,
        SECRET,
        { getPassword, sendFn },
      );
      const secondWithB = await sendMail(
        { ...validPayload, sendIntentReceipt: receiptB, ...liveIntent },
        smtpConfig,
        SECRET,
        { getPassword, sendFn },
      );
      expect(first.outcome).toBe('accepted');
      expect(secondWithB.outcome).toBe('accepted');
      expect(sendFn).toHaveBeenCalledTimes(2);
    });

    it('the nodemailer transport itself is never configured with automatic retry — one sendFn call per submitSmtp call is the library-level guarantee this project relies on (see smtp-transport.test.ts)', async () => {
      // Documented cross-reference: transport-level "never retries" is
      // exercised directly in tests/smtp-transport.test.ts ("never retries
      // automatically: sendFn is called exactly once per submitSmtp call,
      // on every path"). This test only confirms the send.ts layer built on
      // top of it doesn't add its own retry loop.
      const receipt = previewReceipt(smtpConfig);
      const sendFn = vi.fn().mockRejectedValue({ code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' });
      const result = await sendMail(
        { ...validPayload, sendIntentReceipt: receipt, ...liveIntent },
        smtpConfig,
        SECRET,
        { getPassword, sendFn },
      );
      expect(result.outcome).toBe('failed');
      expect(sendFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('own-account self-send scenario (section 17 — future live-validation fixture)', () => {
    it('From == To == the configured mailbox identity is a policy-accepted intent (never actually sent here)', async () => {
      const selfPayload = {
        to: [smtpConfig.username],
        subject: `proton-mail-mcp self-test ${new Date().toISOString()}`,
        text: 'Deterministic harmless self-send validation payload for a future live test.',
      };
      const preview = previewSend(selfPayload, smtpConfig, SECRET);
      expect(preview.eligible).toBe(true);
      expect(preview.from).toBe(smtpConfig.username);
      expect(preview.to).toEqual([smtpConfig.username]);
      expect(preview.cc).toEqual([]);

      const sendFn = vi.fn();
      const dryRunResult = await sendMail(
        {
          ...selfPayload,
          sendIntentReceipt: preview.sendIntentReceipt,
          dryRun: true,
          confirm: false,
          acknowledgeExternalSend: false,
        },
        smtpConfig,
        SECRET,
        { getPassword, sendFn },
      );
      expect(dryRunResult.intentValidated).toBe(true);
      expect(dryRunResult.receiptValid).toBe(true);
      // Zero network — this is still not a live send.
      expect(sendFn).not.toHaveBeenCalled();
    });
  });

  describe('0.5.3 regression: mail_send is unaffected by enabling live reply', () => {
    it('sendMail never imports or consults the reply/forward feature gates — a live send still reaches the transport exactly once, unconditionally', async () => {
      const receipt = previewReceipt(smtpConfig);
      const sendFn = vi
        .fn()
        .mockResolvedValue({ accepted: ['a@example.com'], rejected: [], response: '250 OK' });
      const result = await sendMail(
        { ...validPayload, sendIntentReceipt: receipt, ...liveIntent },
        smtpConfig,
        SECRET,
        { getPassword, sendFn },
      );
      expect(result.outcome).toBe('accepted');
      expect(sendFn).toHaveBeenCalledTimes(1);
    });

    it('does not expose hostile SMTP error fields in the returned send result', async () => {
      const sendFn = vi.fn().mockRejectedValue({
        code: 'SENSITIVE_ERROR_CODE',
        command: 'SENSITIVE_SMTP_COMMAND',
        response: 'SENSITIVE_SMTP_RESPONSE',
        responseCode: 450,
        message: 'SENSITIVE_EMAIL@example.invalid /Users/test/private/config.json',
        cause: new Error('FAKE_SECRET_TOKEN_123'),
        stack: 'SENSITIVE_STACK',
      });
      const result = await sendMail(
        { ...validPayload, sendIntentReceipt: previewReceipt(smtpConfig), ...liveIntent },
        smtpConfig,
        SECRET,
        { getPassword, sendFn },
      );
      expect(result.outcome).toBe('uncertain');
      expect(result.deliveryUncertain).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/SENSITIVE_|example\.invalid|\/Users\/test/);
      expect(sendFn).toHaveBeenCalledTimes(1);
    });
  });
});
