import { describe, expect, it, vi } from 'vitest';
import {
  checkSmtpHostStructurallySafe,
  isLoopbackIp,
  resolveAndValidateLoopbackHost,
} from '../src/smtp/host-safety.js';

describe('isLoopbackIp', () => {
  it('accepts the full IPv4 loopback block', () => {
    expect(isLoopbackIp('127.0.0.1')).toBe(true);
    expect(isLoopbackIp('127.0.0.2')).toBe(true);
    expect(isLoopbackIp('127.255.255.255')).toBe(true);
  });

  it('accepts IPv6 loopback', () => {
    expect(isLoopbackIp('::1')).toBe(true);
  });

  it('rejects a public or private-but-non-loopback address', () => {
    expect(isLoopbackIp('8.8.8.8')).toBe(false);
    expect(isLoopbackIp('10.0.0.1')).toBe(false);
    expect(isLoopbackIp('192.168.1.1')).toBe(false);
    expect(isLoopbackIp('172.16.0.1')).toBe(false);
  });

  it('rejects a non-IP string', () => {
    expect(isLoopbackIp('localhost')).toBe(false);
    expect(isLoopbackIp('not-an-ip')).toBe(false);
  });
});

describe('checkSmtpHostStructurallySafe', () => {
  it('accepts the loopback IPv4 literal', () => {
    expect(checkSmtpHostStructurallySafe('127.0.0.1').safe).toBe(true);
  });

  it('accepts IPv6 loopback', () => {
    expect(checkSmtpHostStructurallySafe('::1').safe).toBe(true);
  });

  it('accepts "localhost" and "*.localhost"', () => {
    expect(checkSmtpHostStructurallySafe('localhost').safe).toBe(true);
    expect(checkSmtpHostStructurallySafe('LOCALHOST').safe).toBe(true);
    expect(checkSmtpHostStructurallySafe('foo.localhost').safe).toBe(true);
  });

  it('rejects a public SMTP provider hostname (smtp.gmail.com, smtp.office365.com)', () => {
    expect(checkSmtpHostStructurallySafe('smtp.gmail.com').safe).toBe(false);
    expect(checkSmtpHostStructurallySafe('smtp.office365.com').safe).toBe(false);
  });

  it('rejects an external public IP literal', () => {
    expect(checkSmtpHostStructurallySafe('8.8.8.8').safe).toBe(false);
  });

  it('rejects a LAN IP literal', () => {
    expect(checkSmtpHostStructurallySafe('192.168.1.50').safe).toBe(false);
    expect(checkSmtpHostStructurallySafe('10.0.0.5').safe).toBe(false);
  });

  it('rejects an arbitrary hostname (not localhost, not a loopback literal)', () => {
    expect(checkSmtpHostStructurallySafe('mail.internal.example.com').safe).toBe(false);
  });

  it('rejects an empty host', () => {
    expect(checkSmtpHostStructurallySafe('').safe).toBe(false);
    expect(checkSmtpHostStructurallySafe('   ').safe).toBe(false);
  });

  it('every rejection carries a human-readable reason', () => {
    const result = checkSmtpHostStructurallySafe('smtp.gmail.com');
    expect(result.safe).toBe(false);
    expect(typeof result.reason).toBe('string');
    expect(result.reason).toBeTruthy();
  });
});

describe('resolveAndValidateLoopbackHost', () => {
  it('resolves a loopback IP literal without DNS (short-circuits)', async () => {
    await expect(resolveAndValidateLoopbackHost('127.0.0.1')).resolves.toEqual({
      address: '127.0.0.1',
    });
    await expect(resolveAndValidateLoopbackHost('::1')).resolves.toEqual({ address: '::1' });
  });

  it('rejects a non-loopback IP literal without attempting DNS', async () => {
    await expect(resolveAndValidateLoopbackHost('8.8.8.8')).rejects.toThrow(/not permitted/i);
  });

  it('pins a hostname to a validated loopback address', async () => {
    const lookup = vi.fn().mockResolvedValue([
      { address: '127.0.0.1', family: 4 },
      { address: '::1', family: 6 },
    ]);
    await expect(resolveAndValidateLoopbackHost('localhost', lookup)).resolves.toEqual({
      address: '127.0.0.1',
      servername: 'localhost',
    });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ address: '8.8.8.8', family: 4 }],
    [{ address: '192.168.1.5', family: 4 }],
    [{ address: '169.254.1.1', family: 4 }],
    [{ address: '0.0.0.0', family: 4 }],
    [{ address: '224.0.0.1', family: 4 }],
    [{ address: '2001:4860:4860::8888', family: 6 }],
    [
      { address: '127.0.0.1', family: 4 },
      { address: '8.8.8.8', family: 4 },
    ],
  ])('rejects an unsafe or mixed DNS answer', async (...results) => {
    await expect(
      resolveAndValidateLoopbackHost('localhost', vi.fn().mockResolvedValue(results)),
    ).rejects.toThrow(/unsafe address/i);
  });

  it('fails closed on DNS error or empty response', async () => {
    await expect(
      resolveAndValidateLoopbackHost(
        'localhost',
        vi.fn().mockRejectedValue(new Error('DNS detail')),
      ),
    ).rejects.toThrow('SMTP host resolution failed.');
    await expect(
      resolveAndValidateLoopbackHost('localhost', vi.fn().mockResolvedValue([])),
    ).rejects.toThrow('SMTP host resolution returned no addresses.');
  });
});
