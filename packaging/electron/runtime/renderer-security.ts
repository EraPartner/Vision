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

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

/**
 * Returns the normalized URL a renderer link may open in the OS browser, or
 * undefined. Only absolute http(s) URLs without credentials qualify. The app's
 * own origin and every loopback host are refused, so a link can never hand the
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
  const host = url.hostname.toLowerCase();
  if (
    LOOPBACK_HOSTS.has(host) ||
    host.endsWith(".localhost") ||
    /^127\.\d+\.\d+\.\d+$/.test(host)
  )
    return undefined;
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
