import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { ImapFlow } from 'imapflow';
import { publicOperationError } from '../security/public-operation-error.js';
import { PublicMcpError } from '../security/mcp-tool-error.js';
import { type BridgeConfig, getBridgePassword, loadBridgeConfig } from './config.js';

function readTlsCertificate(tlsCertPath: string): string {
  try {
    return readFileSync(tlsCertPath, 'utf8');
  } catch {
    throw new Error(
      `Could not read the Proton Mail Bridge TLS certificate at ${tlsCertPath}. ` +
        'See README.md ("TLS certificate setup") for the export steps.',
    );
  }
}

async function connectToBridge(config: BridgeConfig): Promise<ImapFlow> {
  let password: string;
  try {
    password = await getBridgePassword(config.username);
  } catch {
    throw new PublicMcpError('Mail credentials are unavailable.');
  }
  let ca: string;
  try {
    ca = readTlsCertificate(config.tlsCertPath);
  } catch {
    throw new PublicMcpError('Mail certificate setup failed.');
  }

  let client: ImapFlow;
  try {
    client = new ImapFlow({
      host: config.host,
      port: config.port,
      // Bridge's default is STARTTLS (secure: false), matching config.secure's
      // own default; see the comment on BridgeConfigSchema.secure in config.ts.
      secure: config.secure,
      // SNI (the servername TLS extension) is only valid for DNS hostnames, not
      // IP literals (RFC 6066) — Bridge is almost always reached via 127.0.0.1,
      // so this is omitted for IP hosts. Node still validates the certificate
      // against the `host` we connect to either way.
      ...(isIP(config.host) === 0 ? { servername: config.host } : {}),
      auth: {
        user: config.username,
        pass: password,
      },
      tls: {
        ca: [ca],
        // Trust is established via the Bridge's own exported certificate above.
        // rejectUnauthorized stays at its secure Node.js default (true) — never
        // disable certificate validation to "make it work".
      },
      // Disabled: the default logger can emit IMAP traffic, which may include
      // message content or authentication frames.
      logger: false,
    });
  } catch {
    throw new PublicMcpError('Mail Bridge connection failed.');
  }

  try {
    await client.connect();
  } catch {
    // Deliberately discard the original error object instead of attaching it
    // as `cause`: IMAP client errors are not documented to omit the raw
    // AUTHENTICATE command/response from their properties, so propagating it
    // risks leaking the password into whatever eventually logs this error.
    throw new PublicMcpError('Mail Bridge connection failed.');
  }

  return client;
}

/**
 * Opens a fresh, read-only-by-convention Bridge IMAP connection, runs `fn`,
 * and always closes the connection afterwards — including when `fn` throws.
 * A new connection per tool call keeps connection lifetime trivial to reason
 * about instead of managing a long-lived shared session.
 */
export async function withBridgeConnection<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  let config: BridgeConfig;
  try {
    config = loadBridgeConfig();
  } catch {
    throw new PublicMcpError('Mail configuration is unavailable.');
  }
  const client = await connectToBridge(config);
  try {
    return await fn(client);
  } catch (error) {
    throw publicOperationError(error);
  } finally {
    await client.logout().catch(() => {
      client.close();
    });
  }
}
