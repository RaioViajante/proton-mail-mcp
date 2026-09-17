import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:https';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyStatus, postOneClickUnsubscribe } from '../src/unsubscribe/http-client.js';
import type { SafeResolvedTarget } from '../src/unsubscribe/url-safety.js';

/**
 * These tests exercise the real TLS + HTTP request path against a local,
 * self-signed test server bound to 127.0.0.1 — never a real mailing list
 * (see the task's "NO LIVE UNSUBSCRIBE" constraint). `rejectUnauthorized`
 * is never touched; trust is extended to this one test certificate via the
 * test-only `ca` override (see http-client.ts), exactly the way a caller
 * would trust any specific CA — not a weakening of certificate validation.
 * If `openssl` is unavailable, this whole suite is skipped rather than
 * failing the run.
 */

let hasOpenssl = true;
try {
  execFileSync('openssl', ['version'], { stdio: 'ignore' });
} catch {
  hasOpenssl = false;
}

describe.skipIf(!hasOpenssl)('postOneClickUnsubscribe (local TLS test server)', () => {
  let dir: string;
  let certPem: string;
  let target: SafeResolvedTarget;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'unsub-test-'));
    const keyPath = join(dir, 'key.pem');
    const certPath = join(dir, 'cert.pem');
    execFileSync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-nodes',
      '-subj',
      '/CN=unsub.test.internal',
      '-addext',
      'subjectAltName=DNS:unsub.test.internal',
    ]);
    certPem = readFileSync(certPath, 'utf8');
    target = { hostname: 'unsub.test.internal', address: '127.0.0.1', family: 4 };
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function withServer(handler: (req: IncomingMessage, res: ServerResponse) => void): {
    server: Server;
    port: number;
    requestCount: () => number;
  } {
    let requestCount = 0;
    const dir2 = dir;
    const server = createServer(
      {
        key: readFileSync(join(dir2, 'key.pem')),
        cert: readFileSync(join(dir2, 'cert.pem')),
      },
      (req, res) => {
        requestCount++;
        handler(req, res);
      },
    );
    return { server, port: 0, requestCount: () => requestCount };
  }

  async function listen(server: Server): Promise<number> {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected an AddressInfo.');
    return address.port;
  }

  it('classifies a 2xx response as accepted', async () => {
    const { server } = withServer((_req, res) => {
      res.writeHead(202);
      res.end();
    });
    const port = await listen(server);
    try {
      const result = await postOneClickUnsubscribe(
        new URL('https://unsub.test.internal/u'),
        target,
        { port, ca: certPem },
      );
      expect(result.requestSent).toBe(true);
      expect(result.httpStatus).toBe(202);
      expect(result.outcome).toBe('accepted');
    } finally {
      server.close();
    }
  });

  it('classifies a 4xx response as rejected', async () => {
    const { server } = withServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    const port = await listen(server);
    try {
      const result = await postOneClickUnsubscribe(
        new URL('https://unsub.test.internal/u'),
        target,
        { port, ca: certPem },
      );
      expect(result.outcome).toBe('rejected');
    } finally {
      server.close();
    }
  });

  it('classifies a 5xx response as failed', async () => {
    const { server } = withServer((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    const port = await listen(server);
    try {
      const result = await postOneClickUnsubscribe(
        new URL('https://unsub.test.internal/u'),
        target,
        { port, ca: certPem },
      );
      expect(result.outcome).toBe('failed');
    } finally {
      server.close();
    }
  });

  it('classifies a redirect as uncertain and never follows it (no second request)', async () => {
    const { server, requestCount } = withServer((_req, res) => {
      res.writeHead(302, { location: 'https://attacker.example/steal' });
      res.end();
    });
    const port = await listen(server);
    try {
      const result = await postOneClickUnsubscribe(
        new URL('https://unsub.test.internal/u'),
        target,
        { port, ca: certPem },
      );
      expect(result.outcome).toBe('uncertain');
      expect(result.httpStatus).toBe(302);
      expect(requestCount()).toBe(1);
    } finally {
      server.close();
    }
  });

  it('sends the exact RFC 8058 POST body, no extra headers, and never a Referer/Cookie/Authorization', async () => {
    let receivedBody = '';
    let receivedHeaders: Record<string, string | string[] | undefined> = {};
    const { server } = withServer((req, res) => {
      receivedHeaders = req.headers;
      req.on('data', (chunk: Buffer) => (receivedBody += chunk.toString('utf8')));
      req.on('end', () => {
        res.writeHead(200);
        res.end();
      });
    });
    const port = await listen(server);
    try {
      await postOneClickUnsubscribe(new URL('https://unsub.test.internal/u'), target, {
        port,
        ca: certPem,
      });
      expect(receivedBody).toBe('List-Unsubscribe=One-Click');
      expect(receivedHeaders.cookie).toBeUndefined();
      expect(receivedHeaders.authorization).toBeUndefined();
      expect(receivedHeaders.referer).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('fails cleanly on a response exceeding the size cap, without ever exposing the body', async () => {
    const { server } = withServer((_req, res) => {
      res.writeHead(200);
      res.end(Buffer.alloc(200_000, 'x'));
    });
    const port = await listen(server);
    try {
      const result = await postOneClickUnsubscribe(
        new URL('https://unsub.test.internal/u'),
        target,
        { port, ca: certPem },
      );
      expect(result.outcome).toBe('failed');
      expect(result.failureReason).toBe('response-too-large');
      expect(Object.keys(result)).not.toContain('body');
    } finally {
      server.close();
    }
  });

  it('fails with a TLS error against an untrusted (not-extended) certificate', async () => {
    const { server } = withServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    const port = await listen(server);
    try {
      // Deliberately omit the `ca` override this time — the server's
      // self-signed cert is not in the system trust store, so this must
      // fail at the TLS layer, never silently succeed.
      const result = await postOneClickUnsubscribe(
        new URL('https://unsub.test.internal/u'),
        target,
        {
          port,
        },
      );
      expect(result.outcome).toBe('failed');
      expect(result.requestSent).toBe(true);
      expect(result.httpStatus).toBeNull();
    } finally {
      server.close();
    }
  });

  it('times out against a server that never responds', async () => {
    const { server } = withServer(() => {
      // Never call res.end() — simulates a hung server.
    });
    const port = await listen(server);
    try {
      const result = await postOneClickUnsubscribe(
        new URL('https://unsub.test.internal/u'),
        target,
        { port, ca: certPem },
      );
      expect(result.outcome).toBe('failed');
      expect(result.failureReason).toBe('timeout');
    } finally {
      server.close();
    }
  }, 15_000);
});

describe('classifyStatus', () => {
  it.each([
    [200, 'accepted'],
    [204, 'accepted'],
    [299, 'accepted'],
    [301, 'uncertain'],
    [399, 'uncertain'],
    [400, 'rejected'],
    [404, 'rejected'],
    [499, 'rejected'],
    [500, 'failed'],
    [599, 'failed'],
    [0, 'failed'],
  ] as const)('classifies %i as %s', (status, expected) => {
    expect(classifyStatus(status)).toBe(expected);
  });
});
