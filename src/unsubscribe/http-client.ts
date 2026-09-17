import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import type { SafeResolvedTarget } from './url-safety.js';

/**
 * The single outbound HTTP call this project ever makes. Deliberately
 * minimal: RFC 8058 one-click POST, nothing else. No redirects are followed
 * (Node's `https.request` never follows them on its own — a 3xx response is
 * simply returned as `uncertain`, see below). No cookies, no Authorization,
 * no Referer, and no message headers beyond what RFC 8058 itself requires
 * are ever sent. The response body is never read into memory beyond a byte
 * count and never returned.
 */

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 65_536;
const ONE_CLICK_BODY = 'List-Unsubscribe=One-Click';
const ALLOWED_HTTPS_PORT = 443;

export type OneClickOutcome = 'accepted' | 'uncertain' | 'rejected' | 'failed';

export interface OneClickPostResult {
  requestSent: boolean;
  httpStatus: number | null;
  outcome: OneClickOutcome;
  /** Sanitized, fixed-vocabulary reason — never a raw error message that could carry a URL or host detail beyond what is already public. */
  failureReason?: string;
}

/** 2xx -> accepted. 3xx -> uncertain (redirect target is never fetched). 4xx -> rejected. Anything else -> failed. */
export function classifyStatus(status: number): OneClickOutcome {
  if (status >= 200 && status < 300) return 'accepted';
  if (status >= 300 && status < 400) return 'uncertain';
  if (status >= 400 && status < 500) return 'rejected';
  return 'failed';
}

/**
 * Test-only escape hatch, never used by production code
 * (`unsubscribe/execute.ts` always calls this function with two arguments).
 * `port` lets tests point at a local, ephemeral-port test server instead of
 * 443; `ca` lets tests extend trust to that local server's own certificate
 * without touching `rejectUnauthorized`, which stays at Node's secure
 * default (`true`) unconditionally in every case.
 */
export interface TestOnlyConnectionOverride {
  port?: number;
  ca?: string | Buffer;
}

/**
 * Sends the RFC 8058 one-click POST. `target` must already have been
 * produced by `resolveAndValidateHost` — this function does not re-validate
 * it. The custom `lookup` below pins the connection to that pre-validated
 * address: Node never re-resolves `target.hostname` itself, which closes the
 * DNS-rebinding window between validation and connection. `servername` keeps
 * TLS SNI and certificate hostname verification against the real hostname.
 */
export async function postOneClickUnsubscribe(
  url: URL,
  target: SafeResolvedTarget,
  testOnly?: TestOnlyConnectionOverride,
): Promise<OneClickPostResult> {
  return new Promise((resolve) => {
    const body = Buffer.from(ONE_CLICK_BODY, 'utf8');
    // Node's `net.connect` may request either the legacy single-address
    // form or (when Happy Eyeballs / autoSelectFamily is active) an array
    // via `options.all` — honor whichever this specific call asked for,
    // always resolving to the one pre-validated address, never re-resolving
    // `_hostname` ourselves.
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) {
        callback(null, [{ address: target.address, family: target.family }]);
      } else {
        callback(null, target.address, target.family);
      }
    };

    let settled = false;
    const settle = (result: OneClickPostResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    // SNI (the servername TLS extension) is only valid for DNS hostnames,
    // not IP literals (RFC 6066) — matches the same rule already applied in
    // bridge/client.ts for the local Bridge connection.
    const servername = isIP(target.hostname) === 0 ? target.hostname : undefined;

    const req = httpsRequest(
      {
        method: 'POST',
        hostname: target.hostname,
        ...(servername ? { servername } : {}),
        port: testOnly?.port ?? ALLOWED_HTTPS_PORT,
        ...(testOnly?.ca ? { ca: testOnly.ca } : {}),
        path: `${url.pathname}${url.search}`,
        lookup: pinnedLookup,
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': body.length,
        },
      },
      (res) => {
        let received = 0;
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > MAX_RESPONSE_BYTES) {
            req.destroy();
            settle({
              requestSent: true,
              httpStatus: res.statusCode ?? null,
              outcome: 'failed',
              failureReason: 'response-too-large',
            });
          }
        });
        res.on('end', () => {
          settle({
            requestSent: true,
            httpStatus: res.statusCode ?? null,
            outcome: classifyStatus(res.statusCode ?? 0),
          });
        });
        res.on('error', () => {
          settle({
            requestSent: true,
            httpStatus: res.statusCode ?? null,
            outcome: 'failed',
            failureReason: 'response-stream-error',
          });
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      settle({ requestSent: true, httpStatus: null, outcome: 'failed', failureReason: 'timeout' });
    });
    req.on('error', () => {
      settle({
        requestSent: true,
        httpStatus: null,
        outcome: 'failed',
        failureReason: 'network-error',
      });
    });

    req.write(body);
    req.end();
  });
}
