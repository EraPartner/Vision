import { BlockList, isIP } from "node:net";
import { ForbiddenError } from "./errorHandler.ts";
import type {
  ExpressNextFunction,
  ExpressRequest,
  ExpressResponse,
} from "../types/express.ts";

const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

/** Parse a single HTTP authority without accepting URL credentials or paths. */
function parseAuthority(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || /[\s,@/\\?#]/u.test(value))
    return undefined;
  const match = value.startsWith("[")
    ? /^\[([^\]]+)\](?::([0-9]+))?$/u.exec(value)
    : /^([^:]+)(?::([0-9]+))?$/u.exec(value);
  const [, rawHost, port] = match ?? [];
  if (rawHost === undefined) return undefined;
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535))
    return undefined;
  if (value.startsWith("[") && isIP(rawHost) !== 6) return undefined;
  if (!value.startsWith("[") && !/^[a-z0-9.-]+$/iu.test(rawHost))
    return undefined;
  try {
    const url = new URL(`http://${value}`);
    const host = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
    // DNS labels cannot be empty or start/end with a hyphen. A final root dot
    // is harmless, but must normalize consistently for exact allowlist matches.
    const canonical = host.replace(/\.$/u, "");
    if (
      canonical.length > 253 ||
      (!isIP(canonical) &&
        !canonical
          .split(".")
          .every(
            (label) =>
              label.length <= 63 &&
              /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
          ))
    )
      return undefined;
    return canonical;
  } catch {
    return undefined;
  }
}

/**
 * Validate the destination authority independently of CORS, CSRF and proxy IPs.
 * Bind addresses such as 0.0.0.0 and :: never become wildcard permissions.
 */
export function createHostGuard({
  bindHost,
  allowedHosts = [],
}: { bindHost?: string; allowedHosts?: string[] } = {}) {
  const allowed = new Set(["localhost"]);
  for (const value of allowedHosts) {
    const authority = isIP(value) === 6 ? `[${value}]` : value;
    const host = parseAuthority(authority);
    if (
      !host ||
      (isIP(value) !== 6 && value.includes(":")) ||
      host === "0.0.0.0" ||
      host === "::"
    )
      throw new Error(
        "SERVER_ALLOWED_HOSTS must contain exact hostnames or IP addresses without ports",
      );
    allowed.add(host);
  }
  if (bindHost && bindHost !== "0.0.0.0" && bindHost !== "::") {
    const host = parseAuthority(
      isIP(bindHost) === 6 ? `[${bindHost}]` : bindHost,
    );
    if (host) allowed.add(host);
  }

  return function hostGuard(
    req: ExpressRequest,
    _res: ExpressResponse,
    next: ExpressNextFunction,
  ) {
    // Node discards duplicate Host headers in req.headers. Inspect the wire
    // header list too, so a proxy/backend disagreement cannot bypass this guard.
    if (req.rawHeaders) {
      let count = 0;
      for (let i = 0; i < req.rawHeaders.length; i += 2)
        if (req.rawHeaders[i]?.toLowerCase() === "host") count += 1;
      if (count !== 1) return next(new ForbiddenError("Invalid request host"));
    }
    const host = parseAuthority(req.headers.host);
    const ip = host && isIP(host);
    if (
      host &&
      (allowed.has(host) ||
        (ip && loopback.check(host, ip === 4 ? "ipv4" : "ipv6")))
    )
      return next();
    return next(new ForbiddenError("Invalid request host"));
  };
}
