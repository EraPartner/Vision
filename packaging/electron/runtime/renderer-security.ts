import { pathToFileURL } from "node:url";

export function isTrustedRendererUrl(
  candidate: string,
  appUrl: string,
  errorPagePath: string,
): boolean {
  try {
    const url = new URL(candidate);
    const appOrigin = new URL(appUrl).origin;
    if (url.protocol === "http:") {
      return url.origin === appOrigin && !url.username && !url.password;
    }
    if (url.protocol === "file:") {
      const errorUrl = pathToFileURL(errorPagePath);
      return url.host === "" && url.pathname === errorUrl.pathname;
    }
  } catch {
    // Malformed or relative destinations are never a renderer document.
  }
  return false;
}

const LOOPBACK_HOSTS = new Set(["localhost"]);

/** 127.0.0.0/8 (loopback) and 0.0.0.0/8 (unspecified, "this host"). */
function isLocalIpv4(octets: readonly number[]): boolean {
  return octets[0] === 127 || octets[0] === 0;
}

/**
 * The eight 16-bit groups of a bracketed IPv6 hostname as the URL parser
 * normalizes it (lowercase hex, `::` compression, no embedded dotted IPv4),
 * or undefined for any other hostname.
 */
function ipv6Groups(host: string): number[] | undefined {
  const match = /^\[([0-9a-f:]+)\]$/.exec(host);
  if (!match) return undefined;
  const [head = "", tail, extra] = (match[1] ?? "").split("::");
  if (extra !== undefined) return undefined;
  const parse = (part: string) =>
    part ? part.split(":").map((group) => Number.parseInt(group, 16)) : [];
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (tail === undefined && missing !== 0)) return undefined;
  const groups = [...left, ...new Array<number>(missing).fill(0), ...right];
  return groups.every((group) => Number.isInteger(group) && group <= 0xffff)
    ? groups
    : undefined;
}

/**
 * Whether an IPv6 hostname reaches this machine: `::` (unspecified), `::1`
 * (loopback), or an IPv4-mapped (`::ffff:a.b.c.d`), IPv4-translated
 * (`::ffff:0:a.b.c.d`) or IPv4-compatible (`::a.b.c.d`) form of a loopback
 * or unspecified IPv4 address.
 */
function isLocalIpv6(host: string): boolean {
  const groups = ipv6Groups(host);
  if (!groups) return false;
  const embedded = [
    (groups[6] ?? 0) >> 8,
    (groups[6] ?? 0) & 0xff,
    (groups[7] ?? 0) >> 8,
    (groups[7] ?? 0) & 0xff,
  ];
  const zeros = (count: number) =>
    groups.slice(0, count).every((group) => group === 0);
  if (zeros(7) && (groups[7] ?? 0) <= 1) return true;
  return (
    ((zeros(5) && (groups[5] === 0 || groups[5] === 0xffff)) ||
      (zeros(4) && groups[4] === 0xffff && groups[5] === 0)) &&
    isLocalIpv4(embedded)
  );
}

/** Whether a URL hostname names this machine rather than a public host. */
function isLocalHost(hostname: string): boolean {
  // A fully qualified name may end in a dot: `localhost.` is still local.
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost")) return true;
  // The URL parser already normalized decimal, octal and hex IPv4 forms.
  const ipv4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (ipv4) return isLocalIpv4(ipv4.slice(1).map(Number));
  return isLocalIpv6(host);
}

/**
 * Returns the normalized URL a renderer link may open in the OS browser, or
 * undefined. Only absolute http(s) URLs without credentials qualify. The app's
 * own origin and every loopback or unspecified host (IPv4, IPv6, or IPv4
 * embedded in IPv6) are refused, so a link can never hand the
 * local backend (or another local service) to the system browser.
 */
export function externalBrowserUrl(
  candidate: string,
  appUrl: string,
): string | undefined {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username || url.password || !url.hostname) return undefined;
  try {
    if (url.origin === new URL(appUrl).origin) return undefined;
  } catch {
    return undefined;
  }
  if (isLocalHost(url.hostname)) return undefined;
  return url.href;
}

export function isAllowedPermissionCheck(
  permission: string,
  requestingOrigin: string,
  appUrl: string,
): boolean {
  try {
    if (new URL(requestingOrigin).origin !== new URL(appUrl).origin)
      return false;
  } catch {
    return false;
  }
  // The renderer writes share links to the clipboard and talks to its own
  // loopback backend. It has no camera, microphone, file-system or notification
  // permission; main-process file dialogs and notifications remain separate.
  return [
    "clipboard-sanitized-write",
    "loopback-network",
    "local-network-access",
  ].includes(permission);
}
