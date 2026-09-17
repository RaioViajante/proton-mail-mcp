import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  doctorExitCode,
  renderDoctorReport,
  runDoctor,
  type DoctorOptions,
} from '../src/operations/doctor.js';

describe('read-only doctor', () => {
  let root: string;
  let options: DoctorOptions;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mcp-doctor-test-'));
    const configDir = join(root, 'config');
    const replayDir = join(configDir, 'replay');
    mkdirSync(replayDir, { recursive: true, mode: 0o700 });
    chmodSync(configDir, 0o700);
    const configPath = join(configDir, 'config.json');
    const cert = join(configDir, 'cert.pem');
    const entry = join(root, 'index.js');
    writeFileSync(configPath, '{}', { mode: 0o600 });
    writeFileSync(cert, 'public test certificate', { mode: 0o600 });
    writeFileSync(entry, '', { mode: 0o600 });
    options = {
      platform: 'darwin',
      nodeVersion: '24.1.0',
      configDir,
      configPath,
      replayDir,
      entrypointPath: entry,
      loadConfig: () => ({
        host: '127.0.0.1',
        port: 1143,
        username: 'fake@example.test',
        tlsCertPath: cert,
        secure: false,
        smtp: { host: '127.0.0.1', port: 1025, security: 'starttls' },
      }),
      bridgeCredential: () => Promise.resolve('fake-secret'),
      restoreSecret: () => Promise.resolve('fake-secret'),
      sendSecret: () => Promise.resolve('fake-secret'),
      imapProbe: () => Promise.resolve(true),
      processProbe: () => Promise.resolve(true),
    };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const status = (checks: Awaited<ReturnType<typeof runDoctor>>['checks'], id: string) =>
    checks.find((c) => c.id === id)?.status;

  it('reports a healthy controlled environment and JSON-safe output', async () => {
    const report = await runDoctor(options);
    expect(report.healthy).toBe(true);
    expect(report.version).toBe('0.6.0');
    expect(status(report.checks, 'smtpConnectivity')).toBe('NOT_CHECKED');
    expect(JSON.parse(renderDoctorReport(report, true))).toEqual(report);
    expect(renderDoctorReport(report, false)).toContain('PASS');
    expect(doctorExitCode(report)).toBe(0);
    expect(JSON.stringify(report)).not.toContain('fake-secret');
  });

  it('fails for missing or invalid config without printing parser input', async () => {
    const missing = await runDoctor({ ...options, configPath: join(root, 'missing') });
    expect(status(missing.checks, 'configFile')).toBe('FAIL');
    const invalid = await runDoctor({
      ...options,
      loadConfig: () => {
        throw new Error('secret parser text');
      },
    });
    expect(invalid.healthy).toBe(false);
    expect(doctorExitCode(invalid)).toBe(1);
    expect(status(invalid.checks, 'configParse')).toBe('FAIL');
    expect(JSON.stringify(invalid)).not.toContain('secret parser text');
  });

  it('reports missing certificate, unsafe permissions, and missing entrypoint', async () => {
    const missingCert = await runDoctor({
      ...options,
      loadConfig: () => ({
        host: '127.0.0.1',
        port: 1143,
        username: 'fake@example.test',
        tlsCertPath: join(root, 'missing'),
        secure: false,
        smtp: { host: '127.0.0.1', port: 1025, security: 'starttls' },
      }),
    });
    expect(status(missingCert.checks, 'certificateExists')).toBe('FAIL');
    const cert = join(root, 'config', 'cert.pem');
    chmodSync(cert, 0o644);
    const unsafe = await runDoctor({ ...options, entrypointPath: join(root, 'missing-entry') });
    expect(status(unsafe.checks, 'certificatePermissions')).toBe('WARN');
    expect(status(unsafe.checks, 'entrypoint')).toBe('FAIL');
  });

  it.each(['bridgeCredential', 'restoreSecret', 'sendSecret'] as const)(
    'fails safely when %s is unavailable',
    async (key) => {
      const report = await runDoctor({
        ...options,
        [key]: () => Promise.reject(new Error('private value')),
      });
      expect(status(report.checks, key)).toBe('FAIL');
      expect(JSON.stringify(report)).not.toContain('private value');
    },
  );

  it('flags replay state and IMAP failures without altering files', async () => {
    const missing = await runDoctor({
      ...options,
      replayDir: join(root, 'missing'),
      imapProbe: () => Promise.reject(new Error('AUTH secret')),
    });
    expect(status(missing.checks, 'replayDirectory')).toBe('FAIL');
    expect(status(missing.checks, 'imapConnectivity')).toBe('FAIL');
    expect(JSON.stringify(missing)).not.toContain('AUTH secret');
    chmodSync(options.replayDir!, 0o755);
    const unsafe = await runDoctor(options);
    expect(status(unsafe.checks, 'replayPermissions')).toBe('FAIL');
  });

  it('enforces macOS and Node >=24', async () => {
    const report = await runDoctor({ ...options, platform: 'linux', nodeVersion: '22.0.0' });
    expect(report.healthy).toBe(false);
    expect(status(report.checks, 'platform')).toBe('FAIL');
    expect(status(report.checks, 'node')).toBe('FAIL');
  });
});
