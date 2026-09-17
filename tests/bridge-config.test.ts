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

describe('getReceiptSigningSecret / getReceiptSigningSecretOrUndefined', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  const VALID_HEX = 'a'.repeat(64);

  it('retrieves and hex-decodes the secret from the Keychain via `security find-generic-password`', async () => {
    execFileMock.mockImplementation((_cmd, _args, callback) => {
      callback(null, { stdout: `${VALID_HEX}\n`, stderr: '' });
    });
    const {
      getReceiptSigningSecret,
      RECEIPT_SIGNING_KEYCHAIN_SERVICE,
      RECEIPT_SIGNING_KEYCHAIN_ACCOUNT,
    } = await import('../src/bridge/config.js');
    const secret = await getReceiptSigningSecret();
    expect(secret).toEqual(Buffer.from(VALID_HEX, 'hex'));
    expect(secret.length).toBe(32);

    const call = execFileMock.mock.calls[0];
    expect(call?.[1]).toEqual([
      'find-generic-password',
      '-a',
      RECEIPT_SIGNING_KEYCHAIN_ACCOUNT,
      '-s',
      RECEIPT_SIGNING_KEYCHAIN_SERVICE,
      '-w',
    ]);
  });

  it('uses a Keychain service distinct from the Bridge password', async () => {
    const { RECEIPT_SIGNING_KEYCHAIN_SERVICE, KEYCHAIN_SERVICE } =
      await import('../src/bridge/config.js');
    expect(RECEIPT_SIGNING_KEYCHAIN_SERVICE).not.toBe(KEYCHAIN_SERVICE);
  });

  it('throws a clear, actionable error when the Keychain item is missing', async () => {
    execFileMock.mockImplementation((_cmd, _args, callback) => {
      callback(new Error('security: SecKeychainSearchCopyNext: item not found'), {
        stdout: '',
        stderr: '',
      });
    });
    const { getReceiptSigningSecret } = await import('../src/bridge/config.js');
    await expect(getReceiptSigningSecret()).rejects.toThrow(/configure-receipt-signing\.sh/);
  });

  it('throws when the stored value is not 32 bytes of hex', async () => {
    execFileMock.mockImplementation((_cmd, _args, callback) => {
      callback(null, { stdout: 'not-hex-at-all\n', stderr: '' });
    });
    const { getReceiptSigningSecret } = await import('../src/bridge/config.js');
    await expect(getReceiptSigningSecret()).rejects.toThrow(/not a 32-byte hex value/);
  });

  it('never lets the secret value leak into a thrown error message', async () => {
    execFileMock.mockImplementation((_cmd, _args, callback) => {
      callback(new Error(`unexpected failure near value ${VALID_HEX}`), { stdout: '', stderr: '' });
    });
    const { getReceiptSigningSecret } = await import('../src/bridge/config.js');
    try {
      await getReceiptSigningSecret();
      expect.unreachable('expected getReceiptSigningSecret to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(VALID_HEX);
    }
  });

  it('getReceiptSigningSecretOrUndefined resolves to undefined instead of throwing when unprovisioned', async () => {
    execFileMock.mockImplementation((_cmd, _args, callback) => {
      callback(new Error('not found'), { stdout: '', stderr: '' });
    });
    const { getReceiptSigningSecretOrUndefined } = await import('../src/bridge/config.js');
    await expect(getReceiptSigningSecretOrUndefined()).resolves.toBeUndefined();
  });

  it('getReceiptSigningSecretOrUndefined resolves to the secret when provisioned', async () => {
    execFileMock.mockImplementation((_cmd, _args, callback) => {
      callback(null, { stdout: `${VALID_HEX}\n`, stderr: '' });
    });
    const { getReceiptSigningSecretOrUndefined } = await import('../src/bridge/config.js');
    await expect(getReceiptSigningSecretOrUndefined()).resolves.toEqual(
      Buffer.from(VALID_HEX, 'hex'),
    );
  });
});

describe('getSendIntentSigningSecret / getSendIntentSigningSecretOrUndefined', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  const VALID_HEX = 'b'.repeat(64);

  it('retrieves and hex-decodes the secret from the Keychain via `security find-generic-password`', async () => {
    execFileMock.mockImplementation((_cmd, _args, callback) => {
      callback(null, { stdout: `${VALID_HEX}\n`, stderr: '' });
    });
    const {
      getSendIntentSigningSecret,
      SEND_SIGNING_KEYCHAIN_SERVICE,
      SEND_SIGNING_KEYCHAIN_ACCOUNT,
    } = await import('../src/bridge/config.js');
    const secret = await getSendIntentSigningSecret();
    expect(secret).toEqual(Buffer.from(VALID_HEX, 'hex'));
    expect(secret.length).toBe(32);

    const call = execFileMock.mock.calls[0];
    expect(call?.[1]).toEqual([
      'find-generic-password',
      '-a',
      SEND_SIGNING_KEYCHAIN_ACCOUNT,
      '-s',
      SEND_SIGNING_KEYCHAIN_SERVICE,
      '-w',
    ]);
  });

  it('uses a Keychain service distinct from the Bridge password AND the restore-receipt secret', async () => {
    const { SEND_SIGNING_KEYCHAIN_SERVICE, RECEIPT_SIGNING_KEYCHAIN_SERVICE, KEYCHAIN_SERVICE } =
      await import('../src/bridge/config.js');
    expect(SEND_SIGNING_KEYCHAIN_SERVICE).not.toBe(KEYCHAIN_SERVICE);
    expect(SEND_SIGNING_KEYCHAIN_SERVICE).not.toBe(RECEIPT_SIGNING_KEYCHAIN_SERVICE);
  });

  it('throws a clear, actionable error when the Keychain item is missing', async () => {
    execFileMock.mockImplementation((_cmd, _args, callback) => {
      callback(new Error('security: SecKeychainSearchCopyNext: item not found'), {
        stdout: '',
        stderr: '',
      });
    });
    const { getSendIntentSigningSecret } = await import('../src/bridge/config.js');
    await expect(getSendIntentSigningSecret()).rejects.toThrow(/configure-send-signing\.sh/);
  });

  it('throws when the stored value is not 32 bytes of hex', async () => {
    execFileMock.mockImplementation((_cmd, _args, callback) => {
      callback(null, { stdout: 'not-hex-at-all\n', stderr: '' });
    });
    const { getSendIntentSigningSecret } = await import('../src/bridge/config.js');
    await expect(getSendIntentSigningSecret()).rejects.toThrow(/not a 32-byte hex value/);
  });

  it('never lets the secret value leak into a thrown error message', async () => {
    execFileMock.mockImplementation((_cmd, _args, callback) => {
      callback(new Error(`unexpected failure near value ${VALID_HEX}`), { stdout: '', stderr: '' });
    });
    const { getSendIntentSigningSecret } = await import('../src/bridge/config.js');
    try {
      await getSendIntentSigningSecret();
      expect.unreachable('expected getSendIntentSigningSecret to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(VALID_HEX);
    }
  });

  it('getSendIntentSigningSecretOrUndefined resolves to undefined instead of throwing when unprovisioned', async () => {
    execFileMock.mockImplementation((_cmd, _args, callback) => {
      callback(new Error('not found'), { stdout: '', stderr: '' });
    });
    const { getSendIntentSigningSecretOrUndefined } = await import('../src/bridge/config.js');
    await expect(getSendIntentSigningSecretOrUndefined()).resolves.toBeUndefined();
  });

  it('getSendIntentSigningSecretOrUndefined resolves to the secret when provisioned', async () => {
    execFileMock.mockImplementation((_cmd, _args, callback) => {
      callback(null, { stdout: `${VALID_HEX}\n`, stderr: '' });
    });
    const { getSendIntentSigningSecretOrUndefined } = await import('../src/bridge/config.js');
    await expect(getSendIntentSigningSecretOrUndefined()).resolves.toEqual(
      Buffer.from(VALID_HEX, 'hex'),
    );
  });
});
