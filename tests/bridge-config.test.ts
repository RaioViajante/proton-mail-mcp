import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ExecFileResult = { stdout: string; stderr: string };
type ExecFileCallback = (error: Error | null, result: ExecFileResult) => void;
type ExecFileFn = (command: string, args: readonly string[], callback: ExecFileCallback) => void;

const execFileMock = vi.fn<ExecFileFn>();

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

describe('loadBridgeConfig', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'proton-mail-mcp-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws a clear, actionable error when the config file is missing', async () => {
    const { loadBridgeConfig } = await import('../src/bridge/config.js');
    const missingPath = join(dir, 'does-not-exist.json');
    expect(() => loadBridgeConfig(missingPath)).toThrow(/not found/i);
    expect(() => loadBridgeConfig(missingPath)).toThrow(/configure-bridge\.sh/);
  });

  it('throws when the config file is not valid JSON', async () => {
    const { loadBridgeConfig } = await import('../src/bridge/config.js');
    const path = join(dir, 'config.json');
    writeFileSync(path, '{ not json', 'utf8');
    expect(() => loadBridgeConfig(path)).toThrow(/not valid JSON/i);
  });

  it('throws when required fields are missing', async () => {
    const { loadBridgeConfig } = await import('../src/bridge/config.js');
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ host: '127.0.0.1' }), 'utf8');
    expect(() => loadBridgeConfig(path)).toThrow(/invalid/i);
  });

  it('accepts a complete, valid config', async () => {
    const { loadBridgeConfig } = await import('../src/bridge/config.js');
    const path = join(dir, 'config.json');
    writeFileSync(
      path,
      JSON.stringify({
        host: '127.0.0.1',
        port: 1143,
        username: 'user@proton.me',
        tlsCertPath: '/Users/test/.config/proton-mail-mcp/bridge-cert.pem',
      }),
      'utf8',
    );
    const config = loadBridgeConfig(path);
    expect(config).toEqual({
      host: '127.0.0.1',
      port: 1143,
      username: 'user@proton.me',
      tlsCertPath: '/Users/test/.config/proton-mail-mcp/bridge-cert.pem',
      secure: false,
    });
  });

  it('defaults to STARTTLS (secure: false), matching Bridge’s own default', async () => {
    const { loadBridgeConfig } = await import('../src/bridge/config.js');
    const path = join(dir, 'config.json');
    writeFileSync(
      path,
      JSON.stringify({ port: 1143, username: 'user@proton.me', tlsCertPath: '/tmp/cert.pem' }),
      'utf8',
    );
    expect(loadBridgeConfig(path).secure).toBe(false);
  });
});

describe('getBridgePassword', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('retrieves the password from the Keychain via `security find-generic-password`', async () => {
    execFileMock.mockImplementation((_cmd, _args, callback) => {
      callback(null, { stdout: 'super-secret-bridge-password\n', stderr: '' });
    });
    const { getBridgePassword, KEYCHAIN_SERVICE } = await import('../src/bridge/config.js');
    const password = await getBridgePassword('user@proton.me');
    expect(password).toBe('super-secret-bridge-password');

    const call = execFileMock.mock.calls[0];
    expect(call?.[0]).toBe('security');
    expect(call?.[1]).toEqual([
      'find-generic-password',
      '-a',
      'user@proton.me',
      '-s',
      KEYCHAIN_SERVICE,
      '-w',
    ]);
  });

  it('throws a generic error, without echoing any secret, when the Keychain item is missing', async () => {
    execFileMock.mockImplementation((_cmd, _args, callback) => {
      callback(new Error('security: SecKeychainSearchCopyNext: item not found'), {
        stdout: '',
        stderr: '',
      });
    });
    const { getBridgePassword } = await import('../src/bridge/config.js');

    await expect(getBridgePassword('user@proton.me')).rejects.toThrow(
      /Could not read the Bridge password/,
    );
  });

  it('never lets a secret value leak into the thrown error message', async () => {
    // Deliberately not shaped like a real API key/token (e.g. no "sk-"
    // prefix): this must not itself trip a secret scanner on this repo.
    const secretLookingValue = 'totally-fake-marker-value-should-never-leak';
    execFileMock.mockImplementation((_cmd, _args, callback) => {
      callback(new Error(`unexpected failure near value ${secretLookingValue}`), {
        stdout: '',
        stderr: '',
      });
    });
    const { getBridgePassword } = await import('../src/bridge/config.js');

    try {
      await getBridgePassword('user@proton.me');
      expect.unreachable('expected getBridgePassword to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(secretLookingValue);
    }
  });
});
