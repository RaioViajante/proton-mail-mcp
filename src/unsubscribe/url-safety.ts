import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

/**
 * SSRF defenses for the one HTTPS request `mail_unsubscribe` is allowed to
 * make (RFC 8058 one-click POST). `List-Unsubscribe` is attacker-controlled
 * (see README.md "Threat model"), so every candidate URL is validated twice:
 * structurally (scheme/port/credentials/fragment/hostname shape) before any
 * DNS lookup, then again after resolution, requiring every returned address
 * to be public. The literal IP validated here is the one the socket connects
 * to (see `http-client.ts`'s custom `lookup`), which closes the DNS-rebinding
 * window between validation and connection — Node never re-resolves the
 * hostname itself.
 */

export const ALLOWED_UNSUBSCRIBE_PORT = 443;

export interface SafeResolvedTarget {
  /** The original hostname — used for TLS SNI and certificate hostname verification. */
  hostname: string;
  /** The literal, validated IP address the socket actually connects to. */
  address: string;
  family: 4 | 6;
}

export interface UrlSafetyCheck {
  safe: boolean;
  reason?: string;
}

function unsafe(reason: string): UrlSafetyCheck {
  return { safe: false, reason };
}

/** Parses a candidate unsubscribe URI. Returns null for anything not a well-formed absolute URL. */
export function parseCandidateUnsubscribeUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function isPrivateIpv4(octets: readonly [number, number, number, number]): boolean {
  const [a, b] = octets;
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata 169.254.169.254
  if (a === 0) return true; // "this network" / unspecified
  if (a === 100 && b >= 64 && b <= 127) return true; // shared address space (CGNAT)
  if (a === 192 && b === 0 && octets[2] === 0) return true; // IETF protocol assignments
  if (a === 192 && b === 0 && octets[2] === 2) return true; // documentation (TEST-NET-1)
  if (a === 198 && b === 18) return true; // benchmarking
  if (a === 198 && b === 51 && octets[2] === 100) return true; // documentation (TEST-NET-2)
  if (a === 203 && b === 0 && octets[2] === 113) return true; // documentation (TEST-NET-3)
  if (a >= 224) return true; // multicast (224-239) and reserved (240-255), incl. 255.255.255.255
  return false;
}

function parseIpv4(address: string): [number, number, number, number] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return octets as [number, number, number, number];
}

/**
 * Expands an IPv6 address (including `::` compression and an embedded IPv4
 * tail, e.g. `::ffff:192.168.0.1`) into 8 16-bit groups. Returns null for
 * anything that does not parse — callers must treat that as unsafe.
 */
function expandIpv6(address: string): number[] | null {
  const withoutZone = address.split('%')[0] ?? address;
  const [head, tail] = withoutZone.split('::');
  if (tail === undefined && withoutZone.split(':').length !== 8) return null;

  function groupsFrom(part: string): number[] | null {
    if (part === '') return [];
    const segments = part.split(':');
    const groups: number[] = [];
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      if (segment === undefined) return null;
      // An embedded IPv4 tail only ever appears as the last segment(s).
      if (segment.includes('.') && i === segments.length - 1) {
        const ipv4 = parseIpv4(segment);
        if (!ipv4) return null;
        groups.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(segment)) return null;
      groups.push(parseInt(segment, 16));
    }
    return groups;
  }

  const headGroups = groupsFrom(head ?? '');
  if (!headGroups) return null;
  if (tail === undefined) {
    return headGroups.length === 8 ? headGroups : null;
  }
  const tailGroups = groupsFrom(tail);
  if (!tailGroups) return null;
  const missing = 8 - headGroups.length - tailGroups.length;
  if (missing < 0) return null;
  const zeros: number[] = new Array<number>(missing).fill(0);
  return [...headGroups, ...zeros, ...tailGroups];
}

function isPrivateIpv6(groups: readonly number[]): boolean {
  const isZero = groups.every((g) => g === 0);
  if (isZero) return true; // ::
  const isLoopback = groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1;
  if (isLoopback) return true; // ::1
  const first = groups[0] ?? 0;
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) — re-check
  // the embedded IPv4 address so a literal like ::ffff:127.0.0.1 cannot
  // bypass the IPv4 loopback/private rules above.
  const isMapped =
    groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 0xffff || groups[5] === 0);
  if (isMapped) {
    const g6 = groups[6] ?? 0;
    const g7 = groups[7] ?? 0;
    const embedded: [number, number, number, number] = [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff];
    return isPrivateIpv4(embedded);
  }
  // 64:ff9b::/96 NAT64 — not a public Internet destination for our purposes.
  if (first === 0x0064 && groups[1] === 0xff9b) return true;
  return false;
}

/** The WHATWG URL parser keeps IPv6 hostnames bracketed (e.g. `[::1]`) — strip that for every IP-address check and for DNS lookups, which never accept brackets. */
function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/** True for a literal IP address that is safe to connect to (public, non-reserved). */
export function isPublicIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const octets = parseIpv4(address);
    return octets !== null && !isPrivateIpv4(octets);
  }
  if (family === 6) {
    const groups = expandIpv6(address);
    return groups !== null && !isPrivateIpv6(groups);
  }
  return false;
}

/**
 * Structural checks only — no DNS, no network. Must pass before any
 * resolution is attempted. Rejects everything the task's threat model names
 * explicitly: non-HTTPS scheme, embedded credentials, fragments, non-443
 * ports, localhost/.local hostnames, and literal private/loopback/
 * link-local/multicast/unspecified IP addresses.
 */
export function checkUrlStructurallySafe(url: URL): UrlSafetyCheck {
  if (url.protocol !== 'https:') {
    return unsafe('URL scheme must be https.');
  }
  if (url.username || url.password) {
    return unsafe('URL must not contain embedded credentials.');
  }
  if (url.hash) {
    return unsafe('URL must not contain a fragment.');
  }
  const port = url.port ? Number(url.port) : ALLOWED_UNSUBSCRIBE_PORT;
  if (port !== ALLOWED_UNSUBSCRIBE_PORT) {
    return unsafe(`Only port ${ALLOWED_UNSUBSCRIBE_PORT} is permitted.`);
  }
  const hostname = stripIpv6Brackets(url.hostname.toLowerCase());
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return unsafe('localhost is not permitted.');
  }
  if (hostname.endsWith('.local')) {
    return unsafe('.local hostnames are not permitted.');
  }
  if (hostname === 'metadata.google.internal' || hostname === 'metadata.azure.com') {
    return unsafe('Known cloud metadata hostnames are not permitted.');
  }
  if (isIP(hostname) !== 0) {
    if (!isPublicIp(hostname)) {
      return unsafe('Literal IP address is not a public address.');
    }
  }
  return { safe: true };
}

/**
 * Resolves `hostname` and validates EVERY returned address is public before
 * pinning the connection to one of them. Rejecting if any address in the
 * response is private defends against a resolver that mixes public and
 * private answers to slip a private target through on a later attempt.
 */
export async function resolveAndValidateHost(rawHostname: string): Promise<SafeResolvedTarget> {
  const hostname = stripIpv6Brackets(rawHostname);
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  if (results.length === 0) {
    throw new Error(`DNS resolution for "${hostname}" returned no addresses.`);
  }
  for (const result of results) {
    if (!isPublicIp(result.address)) {
      throw new Error(
        `DNS resolution for "${hostname}" returned a non-public address; refusing to connect ` +
          '(possible DNS rebinding or private-network target).',
      );
    }
  }
  const chosen = results[0];
  if (!chosen) {
    throw new Error(`DNS resolution for "${hostname}" returned no addresses.`);
  }
  return { hostname, address: chosen.address, family: chosen.family === 6 ? 6 : 4 };
}
