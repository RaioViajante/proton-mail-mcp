import { describe, expect, it, vi } from 'vitest';
import {
  checkUrlStructurallySafe,
  isPublicIp,
  parseCandidateUnsubscribeUrl,
  resolveAndValidateHost,
} from '../src/unsubscribe/url-safety.js';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));
import { lookup as mockedLookup } from 'node:dns/promises';

describe('parseCandidateUnsubscribeUrl', () => {
  it('parses a well-formed absolute URL', () => {
    const url = parseCandidateUnsubscribeUrl('https://example.com/unsub?id=1');
    expect(url?.hostname).toBe('example.com');
  });

  it('returns null for a malformed URI', () => {
    expect(parseCandidateUnsubscribeUrl('not a url')).toBeNull();
    expect(parseCandidateUnsubscribeUrl('https://')).toBeNull();
  });
});

describe('checkUrlStructurallySafe', () => {
  const safe = (raw: string) => checkUrlStructurallySafe(new URL(raw));

  it('accepts a plain public HTTPS URL on port 443', () => {
    expect(safe('https://example.com/unsub').safe).toBe(true);
  });

  it('rejects non-HTTPS schemes', () => {
    expect(safe('http://example.com/unsub').safe).toBe(false);
  });

  it('rejects embedded credentials', () => {
    expect(safe('https://user:pass@example.com/unsub').safe).toBe(false);
  });

  it('rejects a fragment', () => {
    expect(safe('https://example.com/unsub#frag').safe).toBe(false);
  });

  it('rejects a non-443 port', () => {
    expect(safe('https://example.com:8443/unsub').safe).toBe(false);
  });

  it('accepts an explicit port 443', () => {
    expect(safe('https://example.com:443/unsub').safe).toBe(true);
  });

  it('rejects localhost', () => {
    expect(safe('https://localhost/unsub').safe).toBe(false);
    expect(safe('https://foo.localhost/unsub').safe).toBe(false);
  });

  it('rejects .local hostnames', () => {
    expect(safe('https://printer.local/unsub').safe).toBe(false);
  });

  it('rejects known cloud metadata hostnames', () => {
    expect(safe('https://metadata.google.internal/unsub').safe).toBe(false);
  });

  it('rejects a literal loopback IPv4 address', () => {
    expect(safe('https://127.0.0.1/unsub').safe).toBe(false);
  });

  it('rejects a literal loopback IPv6 address', () => {
    expect(safe('https://[::1]/unsub').safe).toBe(false);
  });

  it('rejects RFC1918 private IPv4 ranges', () => {
    expect(safe('https://10.0.0.1/unsub').safe).toBe(false);
    expect(safe('https://172.16.0.1/unsub').safe).toBe(false);
    expect(safe('https://192.168.1.1/unsub').safe).toBe(false);
  });

  it('rejects link-local IPv4 (including the cloud metadata address)', () => {
    expect(safe('https://169.254.169.254/unsub').safe).toBe(false);
  });

  it('rejects multicast and unspecified IPv4', () => {
    expect(safe('https://224.0.0.1/unsub').safe).toBe(false);
    expect(safe('https://0.0.0.0/unsub').safe).toBe(false);
  });

  it('rejects link-local and unique-local IPv6', () => {
    expect(safe('https://[fe80::1]/unsub').safe).toBe(false);
    expect(safe('https://[fc00::1]/unsub').safe).toBe(false);
  });

  it('rejects an IPv4-mapped IPv6 loopback (bypass attempt)', () => {
    expect(safe('https://[::ffff:127.0.0.1]/unsub').safe).toBe(false);
  });

  it('accepts a literal public IPv4 address', () => {
    expect(safe('https://93.184.216.34/unsub').safe).toBe(true);
  });
});

describe('isPublicIp', () => {
  it('rejects non-IP input', () => {
    expect(isPublicIp('not-an-ip')).toBe(false);
  });

  it('accepts a public IPv6 address', () => {
    expect(isPublicIp('2606:2800:220:1:248:1893:25c8:1946')).toBe(true);
  });
});

describe('resolveAndValidateHost (DNS rebinding / mixed-answer defenses)', () => {
  it('accepts a hostname that resolves only to public addresses', async () => {
    vi.mocked(mockedLookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
    const target = await resolveAndValidateHost('example.com');
    expect(target.address).toBe('93.184.216.34');
    expect(target.hostname).toBe('example.com');
  });

  it('rejects a hostname that resolves to a private address', async () => {
    vi.mocked(mockedLookup).mockResolvedValue([{ address: '10.0.0.5', family: 4 }] as never);
    await expect(resolveAndValidateHost('evil.example')).rejects.toThrow(/non-public/);
  });

  it('rejects when DNS returns a mix of public and private addresses', async () => {
    vi.mocked(mockedLookup).mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ] as never);
    await expect(resolveAndValidateHost('mixed.example')).rejects.toThrow(/non-public/);
  });

  it('rejects when DNS returns no addresses', async () => {
    vi.mocked(mockedLookup).mockResolvedValue([] as never);
    await expect(resolveAndValidateHost('empty.example')).rejects.toThrow(/no addresses/);
  });
});
