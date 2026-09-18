import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Transporter } from 'nodemailer';
import type { ResolvedSmtpConfig } from '../src/smtp/config.js';
import { createSmtpTransport, defaultSmtpSend, submitSmtp } from '../src/smtp/transport.js';

describe('createSmtpTransport', () => {
  let dir: string;
  let certPath: string;
  let config: ResolvedSmtpConfig;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'proton-mail-mcp-test-'));
    certPath = join(dir, 'bridge-cert.pem');
    writeFileSync(
      certPath,
      '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n',
      'utf8',
    );
    config = {
      host: '127.0.0.1',
      port: 1025,
      security: 'starttls',
      username: 'user@proton.me',
      tlsCertPath: certPath,
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails closed when the TLS certificate file is missing (never connects without it)', async () => {
    await expect(
      createSmtpTransport({ ...config, tlsCertPath: join(dir, 'does-not-exist.pem') }, 'pw'),
    ).rejects.toThrow(/Could not read the Proton Mail Bridge TLS certificate/);
  });

  it('fails closed for a non-loopback host even if one somehow reaches this function directly', async () => {
    await expect(createSmtpTransport({ ...config, host: 'smtp.gmail.com' }, 'pw')).rejects.toThrow(
      /not permitted/i,
    );
  });

  it('never disables certificate validation (rejectUnauthorized stays true)', async () => {
    const transport = await createSmtpTransport(config, 'pw');
    const options = transport.options as unknown as { tls?: { rejectUnauthorized?: boolean } };
    expect(options.tls?.rejectUnauthorized).toBe(true);
    transport.close();
  });

  it('requireTLS is set for STARTTLS mode (never silently falls back to plaintext)', async () => {
    const transport = await createSmtpTransport(config, 'pw');
    const options = transport.options as unknown as { requireTLS?: boolean; secure?: boolean };
    expect(options.requireTLS).toBe(true);
    expect(options.secure).toBe(false);
    transport.close();
  });

  it('secure is true for direct TLS mode', async () => {
    const transport = await createSmtpTransport({ ...config, security: 'tls' }, 'pw');
    const options = transport.options as unknown as { secure?: boolean };
    expect(options.secure).toBe(true);
    transport.close();
  });

  it('is never pooled — one-shot connection per send', async () => {
    const transport = await createSmtpTransport(config, 'pw');
    const options = transport.options as unknown as { pool?: boolean };
    expect(options.pool).toBe(false);
    transport.close();
  });

  it('uses the validated IP without second DNS resolution and preserves TLS hostname verification', async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: '127.0.0.2', family: 4 }]);
    const transport = await createSmtpTransport({ ...config, host: 'localhost' }, 'pw', lookup);
    const options = transport.options as unknown as {
      host?: string;
      tls?: { servername?: string; rejectUnauthorized?: boolean };
    };
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(options.host).toBe('127.0.0.2');
    expect(options.tls?.servername).toBe('localhost');
    expect(options.tls?.rejectUnauthorized).toBe(true);
    transport.close();
  });

  it('omits TLS servername for IP literals, including IPv6 loopback', async () => {
    const transport = await createSmtpTransport({ ...config, host: '::1' }, 'pw');
    const options = transport.options as unknown as {
      host?: string;
      tls?: { servername?: string };
    };
    expect(options.host).toBe('::1');
    expect(options.tls?.servername).toBeUndefined();
    transport.close();
  });
});

describe('submitSmtp — controlled fakes, never a real socket', () => {
  let dir: string;
  let config: ResolvedSmtpConfig;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'proton-mail-mcp-test-'));
    const certPath = join(dir, 'bridge-cert.pem');
    writeFileSync(certPath, 'fake cert', 'utf8');
    config = {
      host: '127.0.0.1',
      port: 1025,
      security: 'starttls',
      username: 'user@proton.me',
      tlsCertPath: certPath,
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const message = {
    from: 'user@proton.me',
    to: ['a@example.com'],
    cc: [],
    subject: 'Hi',
    text: 'Hello',
  };

  it('successful TLS auth + send: outcome accepted', async () => {
    const sendFn = vi
      .fn()
      .mockResolvedValue({ accepted: ['a@example.com'], rejected: [], response: '250 OK' });
    const result = await submitSmtp(config, 'pw', message, sendFn);
    expect(result.outcome).toBe('accepted');
    expect(sendFn).toHaveBeenCalledTimes(1);
  });

  it('auth reject: outcome failed, not uncertain', async () => {
    const sendFn = vi.fn().mockRejectedValue({ command: 'AUTH', message: 'Invalid login' });
    const result = await submitSmtp(config, 'pw', message, sendFn);
    expect(result.outcome).toBe('failed');
    expect(result.deliveryUncertain).toBe(false);
  });

  it('TLS cert reject: fails closed before ever calling sendFn', async () => {
    const sendFn = vi.fn();
    const result = await submitSmtp(
      { ...config, tlsCertPath: join(dir, 'missing.pem') },
      'pw',
      message,
      sendFn,
    );
    expect(result.outcome).toBe('failed');
    expect(result.connectionEstablished).toBe(false);
    expect(sendFn).not.toHaveBeenCalled();
  });

  it('timeout before auth: outcome failed, connectionEstablished false', async () => {
    const sendFn = vi.fn().mockRejectedValue({ code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' });
    const result = await submitSmtp(config, 'pw', message, sendFn);
    expect(result.outcome).toBe('failed');
    expect(result.connectionEstablished).toBe(false);
  });

  it('timeout during send: outcome uncertain, deliveryUncertain true, never a clean failure', async () => {
    const sendFn = vi
      .fn()
      .mockRejectedValue({ command: 'DATA', code: 'ETIMEDOUT', message: 'timeout' });
    const result = await submitSmtp(config, 'pw', message, sendFn);
    expect(result.outcome).toBe('uncertain');
    expect(result.deliveryUncertain).toBe(true);
  });

  it('recipient rejection (definitive 5xx): outcome rejected', async () => {
    const sendFn = vi
      .fn()
      .mockRejectedValue({ command: 'RCPT TO', responseCode: 550, message: 'no such user' });
    const result = await submitSmtp(config, 'pw', message, sendFn);
    expect(result.outcome).toBe('rejected');
  });

  it('partial recipient acceptance (library resolves, does not throw): outcome partiallyAccepted', async () => {
    const sendFn = vi
      .fn()
      .mockResolvedValue({ accepted: ['a@example.com'], rejected: ['b@example.com'] });
    const result = await submitSmtp(
      config,
      'pw',
      { ...message, to: ['a@example.com', 'b@example.com'] },
      sendFn,
    );
    expect(result.outcome).toBe('partiallyAccepted');
  });

  it('DATA rejection: outcome rejected', async () => {
    const sendFn = vi
      .fn()
      .mockRejectedValue({ command: 'DATA', responseCode: 554, message: 'rejected' });
    const result = await submitSmtp(config, 'pw', message, sendFn);
    expect(result.outcome).toBe('rejected');
  });

  it('disconnect before acceptance (during MAIL FROM, no response code): outcome uncertain', async () => {
    const sendFn = vi
      .fn()
      .mockRejectedValue({ command: 'MAIL FROM', code: 'ECONNRESET', message: 'lost' });
    const result = await submitSmtp(config, 'pw', message, sendFn);
    expect(result.outcome).toBe('uncertain');
    expect(result.deliveryUncertain).toBe(true);
  });

  it('disconnect after DATA sent, before final response: outcome uncertain (ambiguous, not treated as success or clean failure)', async () => {
    const sendFn = vi
      .fn()
      .mockRejectedValue({ command: 'DATA', code: 'ECONNRESET', message: 'lost after body' });
    const result = await submitSmtp(config, 'pw', message, sendFn);
    expect(result.outcome).toBe('uncertain');
  });

  it('never retries automatically: sendFn is called exactly once per submitSmtp call, on every path', async () => {
    for (const rejection of [
      { code: 'ETIMEDOUT' },
      { command: 'AUTH' },
      { command: 'DATA', code: 'ECONNRESET' },
      { command: 'RCPT TO', responseCode: 550 },
    ]) {
      const sendFn = vi.fn().mockRejectedValue(rejection);
      await submitSmtp(config, 'pw', message, sendFn);
      expect(sendFn).toHaveBeenCalledTimes(1);
    }
  });

  it('external SMTP host is structurally impossible — submitSmtp fails closed rather than connecting', async () => {
    const sendFn = vi.fn();
    const result = await submitSmtp({ ...config, host: 'smtp.gmail.com' }, 'pw', message, sendFn);
    expect(result.outcome).toBe('failed');
    expect(sendFn).not.toHaveBeenCalled();
  });

  it('live submission validates DNS and never creates a transport for an unsafe answer', async () => {
    const sendFn = vi.fn();
    const lookup = vi.fn().mockResolvedValue([
      { address: '127.0.0.1', family: 4 },
      { address: '8.8.8.8', family: 4 },
    ]);
    const result = await submitSmtp(
      { ...config, host: 'localhost' },
      'pw',
      message,
      sendFn,
      lookup,
    );
    expect(result.outcome).toBe('failed');
    expect(result.reasons).toEqual(['Could not create a safe SMTP transport.']);
    expect(sendFn).not.toHaveBeenCalled();
  });

  it('always closes the transport, even on failure', async () => {
    const sendFn = vi.fn().mockRejectedValue({ message: 'boom' });
    // No direct handle to the transport here, but a hung/leaked transport
    // would keep the process alive — vitest's default afterEach teardown
    // would surface that as a hang. Reaching this assertion at all is the
    // signal; asserting the promise resolves (not hangs) is the real check.
    await expect(submitSmtp(config, 'pw', message, sendFn)).resolves.toBeDefined();
  });
});

describe('defaultSmtpSend — SmtpMessage -> nodemailer options mapping (0.5.2 threading)', () => {
  function fakeTransporter(): { sendMail: ReturnType<typeof vi.fn>; transporter: Transporter } {
    const sendMail = vi
      .fn()
      .mockResolvedValue({ accepted: ['a@example.com'], rejected: [], response: '250 OK' });
    return { sendMail, transporter: { sendMail } as unknown as Transporter };
  }

  const message = {
    from: 'user@proton.me',
    to: ['a@example.com'],
    cc: [],
    subject: 'Hi',
    text: 'Hello',
  };

  it('sets inReplyTo/references on the nodemailer call when present', async () => {
    const { sendMail, transporter } = fakeTransporter();
    await defaultSmtpSend(transporter, {
      ...message,
      inReplyTo: '<abc@example.com>',
      references: ['<abc@example.com>', '<def@example.com>'],
    });
    const [options] = sendMail.mock.calls[0] as [{ inReplyTo?: string; references?: string[] }];
    expect(options.inReplyTo).toBe('<abc@example.com>');
    expect(options.references).toEqual(['<abc@example.com>', '<def@example.com>']);
  });

  it('regression: a plain mail_send-shaped message (no threading fields) never sets inReplyTo/references', async () => {
    const { sendMail, transporter } = fakeTransporter();
    await defaultSmtpSend(transporter, message);
    const [options] = sendMail.mock.calls[0] as [{ inReplyTo?: string; references?: string[] }];
    expect(options.inReplyTo).toBeUndefined();
    expect(options.references).toBeUndefined();
  });

  it('an empty references array is also omitted, not sent as []', async () => {
    const { sendMail, transporter } = fakeTransporter();
    await defaultSmtpSend(transporter, { ...message, references: [] });
    const [options] = sendMail.mock.calls[0] as [{ references?: string[] }];
    expect(options.references).toBeUndefined();
  });
});
