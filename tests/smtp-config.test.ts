import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadBridgeConfig, loadSmtpConfig } from '../src/bridge/config.js';
import { SmtpConfigSchema } from '../src/smtp/config.js';

describe('SmtpConfigSchema', () => {
  it('accepts a valid loopback config', () => {
    expect(
      SmtpConfigSchema.safeParse({ host: '127.0.0.1', port: 1025, security: 'starttls' }).success,
    ).toBe(true);
  });

  it('defaults host to 127.0.0.1 when omitted', () => {
    const result = SmtpConfigSchema.parse({ port: 1025, security: 'tls' });
    expect(result.host).toBe('127.0.0.1');
  });

  it('rejects an external host (smtp.gmail.com)', () => {
    expect(
      SmtpConfigSchema.safeParse({ host: 'smtp.gmail.com', port: 587, security: 'starttls' })
        .success,
    ).toBe(false);
  });

  it('accepts "localhost" as host', () => {
    expect(
      SmtpConfigSchema.safeParse({ host: 'localhost', port: 1025, security: 'starttls' }).success,
    ).toBe(true);
  });

  it('rejects an invalid port (zero, negative, non-integer)', () => {
    expect(SmtpConfigSchema.safeParse({ port: 0, security: 'starttls' }).success).toBe(false);
    expect(SmtpConfigSchema.safeParse({ port: -1, security: 'starttls' }).success).toBe(false);
    expect(SmtpConfigSchema.safeParse({ port: 1.5, security: 'starttls' }).success).toBe(false);
  });

  it('rejects a missing security mode', () => {
    expect(SmtpConfigSchema.safeParse({ port: 1025 }).success).toBe(false);
  });

  it('rejects an unsupported security mode (no plaintext option exists)', () => {
    expect(SmtpConfigSchema.safeParse({ port: 1025, security: 'plaintext' }).success).toBe(false);
    expect(SmtpConfigSchema.safeParse({ port: 1025, security: 'none' }).success).toBe(false);
    expect(SmtpConfigSchema.safeParse({ port: 1025, security: 'ssl' }).success).toBe(false);
  });

  it('accepts both starttls and tls', () => {
    expect(SmtpConfigSchema.safeParse({ port: 1025, security: 'starttls' }).success).toBe(true);
    expect(SmtpConfigSchema.safeParse({ port: 465, security: 'tls' }).success).toBe(true);
  });

  it('rejects unknown extra keys (strict)', () => {
    expect(
      SmtpConfigSchema.safeParse({ port: 1025, security: 'starttls', plaintext: true }).success,
    ).toBe(false);
  });
});

describe('loadBridgeConfig / loadSmtpConfig — backward compatibility and SMTP loading', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'proton-mail-mcp-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a pre-0.5.0 config.json (no smtp key) still loads fine via loadBridgeConfig', () => {
    const path = join(dir, 'config.json');
    writeFileSync(
      path,
      JSON.stringify({
        host: '127.0.0.1',
        port: 1143,
        username: 'user@proton.me',
        tlsCertPath: '/tmp/cert.pem',
      }),
      'utf8',
    );
    const config = loadBridgeConfig(path);
    expect(config.smtp).toBeUndefined();
  });

  it('loadSmtpConfig throws a clear, actionable error when smtp is not configured', () => {
    const path = join(dir, 'config.json');
    writeFileSync(
      path,
      JSON.stringify({
        host: '127.0.0.1',
        port: 1143,
        username: 'user@proton.me',
        tlsCertPath: '/tmp/cert.pem',
      }),
      'utf8',
    );
    expect(() => loadSmtpConfig(path)).toThrow(/configure-bridge\.sh/);
  });

  it('loadSmtpConfig resolves host/port/security plus the shared username/tlsCertPath', () => {
    const path = join(dir, 'config.json');
    writeFileSync(
      path,
      JSON.stringify({
        host: '127.0.0.1',
        port: 1143,
        username: 'user@proton.me',
        tlsCertPath: '/tmp/cert.pem',
        smtp: { host: '127.0.0.1', port: 1025, security: 'starttls' },
      }),
      'utf8',
    );
    expect(loadSmtpConfig(path)).toEqual({
      host: '127.0.0.1',
      port: 1025,
      security: 'starttls',
      username: 'user@proton.me',
      tlsCertPath: '/tmp/cert.pem',
    });
  });

  it('rejects a config whose smtp.host is not loopback', () => {
    const path = join(dir, 'config.json');
    writeFileSync(
      path,
      JSON.stringify({
        host: '127.0.0.1',
        port: 1143,
        username: 'user@proton.me',
        tlsCertPath: '/tmp/cert.pem',
        smtp: { host: 'smtp.gmail.com', port: 587, security: 'tls' },
      }),
      'utf8',
    );
    expect(() => loadBridgeConfig(path)).toThrow(/invalid/i);
  });
});
