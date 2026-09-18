import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const setup = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  getPassword: vi.fn(),
  construct: vi.fn(),
  connect: vi.fn(),
  listFolders: vi.fn(),
}));

vi.mock('../src/bridge/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadBridgeConfig: setup.loadConfig,
  loadSmtpConfig: setup.loadConfig,
  getBridgePassword: setup.getPassword,
}));
vi.mock('imapflow', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ImapFlow: class {
    constructor() {
      setup.construct();
    }
    connect() {
      return setup.connect() as Promise<void>;
    }
    logout() {
      return Promise.resolve();
    }
    close() {}
  },
}));
vi.mock('../src/mail/folders.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listFolders: setup.listFolders,
}));

const markers = [
  'SENSITIVE_LOCAL_PATH',
  'SENSITIVE_ACCOUNT_ID',
  'SENSITIVE_EMAIL',
  'SENSITIVE_MESSAGE_ID',
  'SENSITIVE_TOKEN',
  'SENSITIVE_IMAP_RESPONSE',
];
const hostile = new Error(
  `SENSITIVE_LOCAL_PATH /Users/test/private/path SENSITIVE_ACCOUNT_ID ` +
    `SENSITIVE_EMAIL user@example.invalid SENSITIVE_MESSAGE_ID <fake@example.invalid> ` +
    `SENSITIVE_TOKEN FAKE_TOKEN_ABC123 SENSITIVE_IMAP_RESPONSE IMAP BAD sensitive server response`,
  { cause: new Error('SENSITIVE_CAUSE') },
);

let certDir: string;
let certPath: string;

beforeAll(() => {
  certDir = mkdtempSync(join(tmpdir(), 'mcp-boundary-test-'));
  certPath = join(certDir, 'synthetic-cert.pem');
  writeFileSync(certPath, 'synthetic public certificate fixture');
});

afterAll(() => {
  rmSync(certDir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.resetAllMocks();
  setup.loadConfig.mockReturnValue({
    host: '127.0.0.1',
    port: 1143,
    username: 'user@example.invalid',
    tlsCertPath: certPath,
    secure: false,
  });
  setup.getPassword.mockResolvedValue('synthetic-password');
  setup.connect.mockResolvedValue(undefined);
});

async function callTool(name = 'mail_list_folders', args: Record<string, unknown> = {}) {
  const { createServer } = await import('../src/server.js');
  const server = createServer();
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const responses: unknown[] = [];
  clientTransport.onmessage = (message) => responses.push(message);
  try {
    await server.connect(serverTransport);
    await clientTransport.start();
    await clientTransport.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'synthetic-test', version: '1' },
      },
    });
    await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await clientTransport.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    for (let attempt = 0; attempt < 100 && responses.length < 2; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const response = responses.find(
      (item) => typeof item === 'object' && item !== null && 'id' in item && item.id === 2,
    );
    expect(response).toBeDefined();
    return response;
  } finally {
    await server.close();
  }
}

function expectSafeError(response: unknown, category: string) {
  const serialized = JSON.stringify(response);
  expect(serialized).toContain(category);
  expect(serialized).toContain('"isError":true');
  for (const marker of [...markers, 'SENSITIVE_CAUSE', '/Users/test/', 'example.invalid']) {
    expect(serialized).not.toContain(marker);
  }
  expect(serialized).not.toContain('stack');
  expect(serialized).not.toContain('cause');
}

describe('actual MCP tool boundary for setup failures', () => {
  it.each([
    ['missing config', new Error(`missing config: ${hostile.message}`)],
    ['invalid JSON', new Error(`invalid JSON: ${hostile.message}`)],
    ['invalid schema', new Error(`invalid schema: ${hostile.message}`)],
    ['unexpected filesystem error', hostile],
  ])('sanitizes %s before starting Bridge setup', async (_case, error) => {
    setup.loadConfig.mockImplementation(() => {
      throw error;
    });
    expectSafeError(await callTool(), 'Mail configuration is unavailable.');
    expect(setup.getPassword).not.toHaveBeenCalled();
    expect(setup.construct).not.toHaveBeenCalled();
    expect(setup.connect).not.toHaveBeenCalled();
    expect(setup.listFolders).not.toHaveBeenCalled();
  });

  it('sanitizes Keychain failures before client creation', async () => {
    setup.getPassword.mockRejectedValue(hostile);
    expectSafeError(await callTool(), 'Mail credentials are unavailable.');
    expect(setup.construct).not.toHaveBeenCalled();
    expect(setup.connect).not.toHaveBeenCalled();
    expect(setup.listFolders).not.toHaveBeenCalled();
  });

  it('sanitizes certificate read failures before client creation', async () => {
    setup.loadConfig.mockReturnValue({
      host: '127.0.0.1',
      port: 1143,
      username: 'user@example.invalid',
      tlsCertPath: '/Users/test/SENSITIVE_LOCAL_PATH/bridge-cert.pem',
      secure: false,
    });
    expectSafeError(await callTool(), 'Mail certificate setup failed.');
    expect(setup.construct).not.toHaveBeenCalled();
    expect(setup.connect).not.toHaveBeenCalled();
    expect(setup.listFolders).not.toHaveBeenCalled();
  });

  it('sanitizes IMAP client construction failures', async () => {
    setup.construct.mockImplementation(() => {
      throw hostile;
    });
    expectSafeError(await callTool(), 'Mail Bridge connection failed.');
    expect(setup.connect).not.toHaveBeenCalled();
    expect(setup.listFolders).not.toHaveBeenCalled();
  });

  it('sanitizes IMAP connect and authentication failures', async () => {
    setup.connect.mockRejectedValue(hostile);
    expectSafeError(await callTool(), 'Mail Bridge connection failed.');
    expect(setup.listFolders).not.toHaveBeenCalled();
  });

  it('sanitizes unexpected callback exceptions even without lower-level classification', async () => {
    setup.listFolders.mockRejectedValue(hostile);
    expectSafeError(await callTool(), 'Mailbox operation failed.');
  });

  it('sanitizes unexpected errors in another registered tool before SMTP setup', async () => {
    setup.loadConfig.mockImplementation(() => {
      throw hostile;
    });
    expectSafeError(
      await callTool('mail_send_preview', {
        to: ['recipient@example.invalid'],
        subject: 'Synthetic',
        text: 'Synthetic',
      }),
      'Mail operation failed.',
    );
    expect(setup.construct).not.toHaveBeenCalled();
    expect(setup.connect).not.toHaveBeenCalled();
  });
});
