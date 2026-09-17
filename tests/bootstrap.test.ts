import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = resolve('scripts/bootstrap.sh');

describe('bootstrap --check', () => {
  let root: string;
  let bin: string;
  let home: string;
  const executable = (name: string, body: string) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/bash\n${body}\n`);
    chmodSync(path, 0o700);
  };
  const run = (
    scriptPath: string = script,
    args: string[] = ['--check'],
    extraEnv: Record<string, string> = {},
  ) =>
    spawnSync('/bin/bash', [scriptPath, ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin`, ...extraEnv },
    });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mcp bootstrap space '));
    home = join(root, 'home space');
    bin = join(root, 'fake-bin');
    mkdirSync(home);
    mkdirSync(bin);
    executable('uname', 'echo Darwin');
    executable('node', `exec "${process.execPath}" "$@"`);
    executable('pnpm', 'if [[ "$1" == "--version" ]]; then echo 12.4.2; else exit 99; fi');
    executable('pgrep', 'exit 1');
    executable('security', 'exit 1');
    executable('codex', 'echo "Usage: codex mcp add"');
    executable('claude', 'echo "Usage: claude mcp add"');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('rejects non-macOS before any setup', () => {
    executable('uname', 'echo Linux');
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('currently supports macOS only');
    expect(existsSync(join(home, '.config'))).toBe(false);
  });

  it('rejects old Node and missing pnpm', () => {
    executable('node', 'if [[ "$1" == "-p" ]]; then echo 22; else exit 99; fi');
    expect(run().stderr).toContain('Node >=24');
    executable('node', `exec "${process.execPath}" "$@"`);
    rmSync(join(bin, 'pnpm'));
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('pnpm 12');
  });

  it('reports missing setup without writing config, secrets, or running pnpm install', () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Bridge setup: needed');
    expect(result.stdout).toContain('Restore signing secret: missing');
    expect(result.stdout).toContain('Send signing secret: missing');
    expect(existsSync(join(home, '.config'))).toBe(false);
    expect(result.stdout).not.toContain('password=');
    expect(result.stdout).toContain('codex mcp add');
    expect(result.stdout).toContain('claude mcp add');
  });

  it('preserves an already configured system and handles spaces in paths', () => {
    const configDir = join(home, '.config', 'proton-mail-mcp');
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const cert = join(configDir, 'cert with space.pem');
    writeFileSync(cert, 'public test cert', { mode: 0o600 });
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({
        host: '127.0.0.1',
        port: 1143,
        username: 'fake@example.test',
        tlsCertPath: cert,
        smtp: { host: '127.0.0.1', port: 1025, security: 'starttls' },
      }),
      { mode: 0o600 },
    );
    executable(
      'security',
      `if [[ "$*" == *"proton-mail-mcp-receipt-signing"* ||
      "$*" == *"proton-mail-mcp-send-signing"* ]]; then
      printf '%064d\\n' 0
    else echo fake-bridge-credential; fi`,
    );
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Bridge config and TLS certificate: present');
    expect(result.stdout).not.toContain('Bridge setup: needed');
    expect(result.stdout).toContain('Restore signing secret: valid');
    expect(result.stdout).toContain('Send signing secret: valid');
    expect(existsSync(join(configDir, 'replay'))).toBe(false);
    expect(result.stdout).not.toContain('fake-bridge-credential');
  });

  it('failed Bridge setup preserves an existing invalid config', () => {
    executable('pnpm', 'if [[ "$1" == "--version" ]]; then echo 12.4.2; else exit 0; fi');
    const scripts = join(root, 'project with space', 'scripts');
    mkdirSync(scripts, { recursive: true });
    const bootstrap = join(scripts, 'bootstrap.sh');
    copyFileSync(script, bootstrap);
    writeFileSync(join(scripts, 'configure-bridge.sh'), '#!/bin/bash\nexit 17\n', { mode: 0o700 });
    const configDir = join(home, '.config', 'proton-mail-mcp');
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const configPath = join(configDir, 'config.json');
    writeFileSync(configPath, '{"invalid":true}', { mode: 0o600 });
    const result = run(bootstrap, []);
    expect(result.status).toBe(17);
    expect(result.stdout).toContain('Bridge setup: needed');
    expect(readFileSync(configPath, 'utf8')).toBe('{"invalid":true}');
  });

  it('runs only missing signing setup steps and preserves working Bridge config', () => {
    executable('pnpm', 'if [[ "$1" == "--version" ]]; then echo 12.4.2; else exit 0; fi');
    executable(
      'security',
      'if [[ "$*" == *"-s proton-mail-mcp "* ]]; then echo fake-bridge-credential; else exit 1; fi',
    );
    const scripts = join(root, 'project with space', 'scripts');
    mkdirSync(scripts, { recursive: true });
    const bootstrap = join(scripts, 'bootstrap.sh');
    copyFileSync(script, bootstrap);
    writeFileSync(join(scripts, 'configure-bridge.sh'), '#!/bin/bash\nexit 99\n', { mode: 0o700 });
    writeFileSync(
      join(scripts, 'configure-receipt-signing.sh'),
      '#!/bin/bash\necho receipt >> "$TEST_LOG"\n',
      { mode: 0o700 },
    );
    writeFileSync(
      join(scripts, 'configure-send-signing.sh'),
      '#!/bin/bash\necho send >> "$TEST_LOG"\n',
      { mode: 0o700 },
    );
    const configDir = join(home, '.config', 'proton-mail-mcp');
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const cert = join(configDir, 'cert with space.pem');
    writeFileSync(cert, 'public test cert', { mode: 0o600 });
    const configPath = join(configDir, 'config.json');
    const config = JSON.stringify({
      host: '127.0.0.1',
      port: 1143,
      username: 'fake@example.test',
      tlsCertPath: cert,
      smtp: { host: '127.0.0.1', port: 1025, security: 'starttls' },
    });
    writeFileSync(configPath, config, { mode: 0o600 });
    const log = join(root, 'setup.log');
    const result = run(bootstrap, [], { TEST_LOG: log });
    expect(result.status).toBe(0);
    expect(readFileSync(configPath, 'utf8')).toBe(config);
    expect(readFileSync(log, 'utf8')).toBe('receipt\nsend\n');
    expect(result.stdout).not.toContain('fake-bridge-credential');
  });
});
