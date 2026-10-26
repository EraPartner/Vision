import { isIP } from "node:net";
import { ForbiddenError } from "./errorHandler.ts";
import type {
  ExpressNextFunction,
  ExpressRequest,
  ExpressResponse,
} from "../types/express.ts";

/** The loopback names the backend answers to (ADR-233). */
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"];

/**
 * True when an address only accepts or names local connections: localhost,
 * ::1 and the whole 127.0.0.0/8 block, including IPv4-mapped IPv6. Startup
 * refuses to bind anything else (ADR-233).
 */
export function isLoopbackHost(host: string | null | undefined): boolean {
  const h = (host ?? "").trim().toLowerCase();
  if (!h) return false;
  if (h === "localhost" || h === "::1" || h === "[::1]") return true;
  return /^(::ffff:)?127(\.\d{1,3}){3}$/.test(h);
}

interface HostHeader {
  host: string;
  port: number | undefined;
}

/** Parse a single HTTP authority without accepting URL credentials or paths. */
function parseHostHeader(value: unknown): HostHeader | undefined {
  if (typeof value !== "string" || !value || /[\s,@/\\?#]/u.test(value))
    return undefined;
  const match = value.startsWith("[")
    ? /^\[([^\]]+)\](?::([0-9]+))?$/u.exec(value)
    : /^([^:]+)(?::([0-9]+))?$/u.exec(value);
  const [, rawHost, rawPort] = match ?? [];
  if (rawHost === undefined) return undefined;
  const port = rawPort === undefined ? undefined : Number(rawPort);
  if (port !== undefined && (port < 1 || port > 65535)) return undefined;
  if (value.startsWith("[") && isIP(rawHost) !== 6) return undefined;
  if (!value.startsWith("[") && !/^[a-z0-9.-]+$/iu.test(rawHost))
    return undefined;
  try {
    // The URL parser canonicalizes IP spellings (127.1, 0x7f000001,
    // [0:0:0:0:0:0:0:1]) so the exact-match allowlist sees one form.
    const url = new URL(`http://${value}`);
    const host = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
    // DNS labels cannot be empty or start/end with a hyphen. A final root dot
    // is harmless, but must normalize consistently for exact allowlist matches.
    const canonical = host.replace(/\.$/u, "");
    if (
      canonical.length > 253 ||
      (isIP(canonical) === 0 &&
        !canonical
          .split(".")
          .every(
            (label) =>
              label.length <= 63 &&
              /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
          ))
    )
      return undefined;
    return { host: canonical, port };
  } catch {
    return undefined;
  }
}

/**
 * Reject any request whose Host is not a loopback name, so a DNS-rebinding
 * page (attacker.example resolving to 127.0.0.1) cannot reach the API even
 * though its requests are same-origin from the browser's point of view.
 *
 * The allowlist is fixed: localhost, 127.0.0.1, ::1, plus the loopback bind
 * address when it is spelled differently (startup refuses non-loopback binds).
 * With `port`, the Host must also name that port.
 */
export function createHostGuard({
  bindHost,
  port,
}: { bindHost?: string | undefined; port?: number | undefined } = {}) {
  const allowed = new Set(LOOPBACK_HOSTS);
  if (bindHost && isLoopbackHost(bindHost)) {
    const bind = parseHostHeader(
      isIP(bindHost) === 6 ? `[${bindHost}]` : bindHost,
    );
    if (bind) allowed.add(bind.host);
  }

  return function hostGuard(
    req: ExpressRequest,
    _res: ExpressResponse,
    next: ExpressNextFunction,
  ) {
    const target = parseHostHeader(req.headers.host);
    if (
      target &&
      allowed.has(target.host) &&
      (port === undefined || target.port === port)
    )
      return next();
    return next(new ForbiddenError("Invalid request host"));
  };
}
