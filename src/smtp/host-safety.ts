import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

export interface ResolvedLoopbackHost {
  address: string;
  /** Set only for DNS names, so TLS verifies the configured name. */
  servername?: string;
}

export type SmtpLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<{ address: string; family: number }[]>;

/**
 * Host allowlist for the SMTP transport (0.5.0). This project is a client
 * for exactly one thing: a locally running Proton Mail Bridge instance. It
 * must never become a generic SMTP client — see SECURITY.md ("SMTP host is
 * loopback-only"). This mirrors `src/unsubscribe/url-safety.ts`'s structural
 * check + DNS-pinning pattern, but inverted: that module requires every
 * resolved address to be PUBLIC (defending against SSRF into the local
 * network); this one requires every resolved address to be LOOPBACK
 * (defending against this project being pointed at some other mail
 * server entirely, local or remote).
 */

export interface SmtpHostSafetyCheck {
  safe: boolean;
  reason?: string;
}

function unsafe(reason: string): SmtpHostSafetyCheck {
  return { safe: false, reason };
}

/** True for a literal IP address in the IPv4 loopback block (127.0.0.0/8) or the IPv6 loopback address (::1). */
export function isLoopbackIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return address.startsWith('127.');
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    return normalized === '::1' || normalized === '0:0:0:0:0:0:0:1';
  }
  return false;
}

/**
 * Structural check only — no DNS, no network. A configured SMTP host must be
 * one of exactly two shapes: a loopback IP literal, or the hostname
 * `localhost` (optionally `*.localhost`, per RFC 6761), which is still
 * resolved and re-checked by {@link resolveAndValidateLoopbackHost} before
 * any connection — this function alone never assumes `localhost` actually
 * resolves to loopback on every system. Anything else — a public hostname
 * (`smtp.gmail.com`), a LAN IP, a non-loopback literal — is rejected
 * immediately, without attempting DNS resolution at all.
 */
export function checkSmtpHostStructurallySafe(rawHost: string): SmtpHostSafetyCheck {
  const host = rawHost.trim().toLowerCase();
  if (host.length === 0) {
    return unsafe('SMTP host must not be empty.');
  }

  const family = isIP(host);
  if (family !== 0) {
    if (!isLoopbackIp(host)) {
      return unsafe(
        `SMTP host "${rawHost}" is not a loopback address. proton-mail-mcp only ever connects to ` +
          'a locally running Proton Mail Bridge; only 127.0.0.0/8 or ::1 are permitted.',
      );
    }
    return { safe: true };
  }

  if (host === 'localhost' || host.endsWith('.localhost')) {
    return { safe: true };
  }

  return unsafe(
    `SMTP host "${rawHost}" is not permitted. Only a loopback IP literal (e.g. 127.0.0.1) or ` +
      '"localhost" may be configured — proton-mail-mcp is a Bridge-only SMTP client, never a ' +
      'general-purpose one (see SECURITY.md, "SMTP host is loopback-only").',
  );
}

/**
 * Resolves `host` and validates EVERY returned address is loopback before
 * trusting it — the same DNS-rebinding defense as
 * `unsubscribe/url-safety.ts`'s `resolveAndValidateHost`, inverted. A literal
 * loopback IP short-circuits without a DNS lookup (nothing to resolve); only
 * `localhost`/`*.localhost` actually reaches the resolver, since
 * {@link checkSmtpHostStructurallySafe} already rejected every other
 * hostname before this is ever called.
 */
export async function resolveAndValidateLoopbackHost(
  rawHost: string,
  lookup: SmtpLookup = dnsLookup,
): Promise<ResolvedLoopbackHost> {
  const host = rawHost.trim().toLowerCase();
  if (!checkSmtpHostStructurallySafe(host).safe) {
    throw new Error('SMTP host is not permitted.');
  }
  if (isIP(host) !== 0) {
    if (!isLoopbackIp(host)) {
      throw new Error('SMTP host is not a loopback address.');
    }
    return { address: host };
  }

  let results: { address: string; family: number }[];
  try {
    results = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error('SMTP host resolution failed.');
  }
  if (results.length === 0) {
    throw new Error('SMTP host resolution returned no addresses.');
  }
  for (const result of results) {
    if (!isLoopbackIp(result.address) || isIP(result.address) !== result.family) {
      throw new Error('SMTP host resolution returned an unsafe address.');
    }
  }
  return { address: results[0]!.address, servername: host };
}
