/**
 * Admin auth middleware.
 *
 * When ADMIN_AUTH_TOKEN is set: enforce Bearer token on every request.
 * When unset: allow requests from loopback or private network addresses
 * (RFC 1918 + IPv6 ULA). In Docker, the host browser reaches the container
 * via docker-proxy, so the source IP is the bridge gateway (172.x.x.x) rather
 * than 127.0.0.1. Trusting private ranges is safe because docker-compose binds
 * the host port to 127.0.0.1 only — no LAN device can reach the container.
 * WARNING: if the host port mapping is changed back to 0.0.0.0, LAN devices
 * would also pass this check. Set ADMIN_AUTH_TOKEN in that case.
 */

import { UnauthorizedError } from './errorHandler.js';

function normalizeIp(ip) {
  if (typeof ip !== 'string') return null;
  // Strip IPv6-mapped IPv4 prefix so ::ffff:192.168.1.1 → 192.168.1.1
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function isPrivateIpv4(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  const [a, b] = parts.map(Number);
  // 127.0.0.0/8
  if (a === 127) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  return false;
}

function isPrivateIpv6(ip) {
  if (ip === '::1') return true;
  // IPv6 ULA: fc00::/7 covers fc00:: – fdff::
  const lower = ip.toLowerCase();
  return lower.startsWith('fc') || lower.startsWith('fd');
}

export function isLocalNetworkRequest(req) {
  const candidates = [req?.ip, req?.socket?.remoteAddress, req?.connection?.remoteAddress];
  for (const raw of candidates) {
    const ip = normalizeIp(raw);
    if (!ip) continue;
    if (isPrivateIpv4(ip) || isPrivateIpv6(ip)) return true;
  }
  return false;
}

// Keep old name as alias so existing tests/callers don't break
export const isLoopbackRequest = isLocalNetworkRequest;

export function extractAdminBearerToken(authorizationHeader) {
  if (typeof authorizationHeader !== 'string') return undefined;
  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : undefined;
}

export function createAdminAuthMiddleware(getConfiguredToken) {
  return function adminAuthMiddleware(req, res, next) {
    const configuredToken = getConfiguredToken();
    if (!configuredToken) {
      if (isLocalNetworkRequest(req)) return next();
      return next(new UnauthorizedError('Admin requires ADMIN_AUTH_TOKEN for non-local access'));
    }

    const providedToken = extractAdminBearerToken(req.headers.authorization);
    if (!providedToken || providedToken !== configuredToken) {
      return next(new UnauthorizedError('Unauthorized'));
    }

    return next();
  };
}
