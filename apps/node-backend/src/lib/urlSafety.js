/**
 * SSRF guard for outbound, user-controlled URLs.
 *
 * Investments may carry custom price-provider URLs supplied through the API
 * (price_provider_*_url). Those are fetched server-side at price-refresh time,
 * so without a guard a caller can point the backend at internal services
 * (cloud metadata 169.254.169.254, sibling containers, host-local ports).
 *
 * assertPublicHttpUrl() rejects:
 *   - non-http(s) schemes (file:, gopher:, data:, …)
 *   - IP-literal hosts in private / loopback / link-local / CGNAT / unspecified ranges
 *   - DNS names that resolve to any such address (defeats "evil.com → 127.0.0.1")
 *
 * Residual: TOCTOU DNS rebinding between our lookup and fetch's own resolution
 * is not fully closed here; the safeFetchJson() redirect handling re-validates
 * each hop, which is the main practical bypass. Pin-to-resolved-IP via a custom
 * undici dispatcher is the follow-up hardening if this surface ever grows.
 */

import dnsPromises from "node:dns/promises";
import net from "node:net";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

class BlockedUrlError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "BlockedUrlError";
  }
}

/**
 * @param {string} ip
 * @returns {number[]|undefined}
 */
function parseIpv4Octets(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((/** @type {string} */ p) => Number(p));
  if (
    octets.some(
      (/** @type {number} */ n) => !Number.isInteger(n) || n < 0 || n > 255,
    )
  )
    return undefined;
  return octets;
}

/**
 * @param {string} ip dotted-quad IPv4
 * @returns {boolean} true when the address must not be reached by the server
 */
function isBlockedIpv4(ip) {
  const o = parseIpv4Octets(ip);
  if (!o) return true; // unparseable → fail closed
  const [a, b] = o;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  return false;
}

/**
 * @param {string} ip IPv6 address (optionally with %zone)
 * @returns {boolean} true when the address must not be reached by the server
 */
function isBlockedIpv6(ip) {
  const addr = String(ip).toLowerCase().split("%")[0]; // drop zone id
  if (addr === "::1" || addr === "::") return true; // loopback / unspecified
  const mapped = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isBlockedIpv4(mapped[1]); // IPv4-mapped ::ffff:a.b.c.d
  if (addr.startsWith("fc") || addr.startsWith("fd")) return true; // fc00::/7 ULA
  if (/^fe[89ab]/.test(addr)) return true; // fe80::/10 link-local
  return false;
}

/**
 * @param {string} ip an IPv4 or IPv6 literal
 * @returns {boolean} true when the address is private/loopback/link-local/etc.
 */
function isBlockedAddress(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return isBlockedIpv4(ip);
  if (kind === 6) return isBlockedIpv6(ip);
  return true; // not a recognizable IP → fail closed
}

/**
 * Validate that a URL is safe for the server to fetch. Throws BlockedUrlError on
 * any violation. Returns the parsed URL on success.
 *
 * @param {string} rawUrl
 * @param {object} [opts]
 * @param {boolean} [opts.resolveDns=true] resolve DNS names and check each address.
 *        Pass false for cheap boundary validation (scheme + IP-literal only) that
 *        must not depend on DNS availability.
 * @param {(host: string, opts: object) => Promise<Array<{address: string}>>} [opts.lookup]
 *        injectable resolver (defaults to dns.lookup) — used by tests.
 * @returns {Promise<URL>}
 */
export async function assertPublicHttpUrl(rawUrl, opts = {}) {
  const { resolveDns = true, lookup = dnsPromises.lookup } = opts;

  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new BlockedUrlError(`Invalid URL: ${rawUrl}`);
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new BlockedUrlError(
      `Blocked URL scheme "${url.protocol}" — only http and https are allowed`,
    );
  }

  const host = url.hostname;
  if (!host) throw new BlockedUrlError("URL has no host");

  // URL.hostname keeps the [] around IPv6 literals (e.g. "[::1]"); strip them so
  // net.isIP recognizes the address — otherwise a bracketed literal would skip
  // the IP check and slip through as a "DNS name".
  const literal =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (net.isIP(literal)) {
    if (isBlockedAddress(literal)) {
      throw new BlockedUrlError(`Blocked private/loopback address: ${host}`);
    }
    return url;
  }

  if (!resolveDns) return url;

  let results;
  try {
    results = await lookup(host, { all: true });
  } catch {
    throw new BlockedUrlError(`DNS resolution failed for host: ${host}`);
  }
  if (!Array.isArray(results) || results.length === 0) {
    throw new BlockedUrlError(`No DNS records for host: ${host}`);
  }
  for (const r of results) {
    if (isBlockedAddress(r.address)) {
      throw new BlockedUrlError(
        `Host ${host} resolves to a blocked address: ${r.address}`,
      );
    }
  }
  return url;
}

export {
  BlockedUrlError,
  isBlockedIpv4 as __isBlockedIpv4,
  isBlockedIpv6 as __isBlockedIpv6,
  isBlockedAddress as __isBlockedAddress,
};
