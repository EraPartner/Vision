/**
 * CSRF guard for state-changing requests.
 *
 * The backend only listens on loopback, so the realistic cross-origin threat
 * is a malicious web page the user visits issuing fetch()/form POSTs to
 * http://localhost:PORT/... . The browser's same-origin policy hides the
 * *response* but does NOT stop the *request* from executing, so a destructive
 * POST (e.g. /api/admin/database/reset) could still fire. This guard rejects
 * cross-site state-changing requests.
 *
 * Strategy (zero-config, no tokens/cookies needed):
 *   - Safe methods (GET/HEAD/OPTIONS) are never blocked.
 *   - `Sec-Fetch-Site` (sent by all current browsers) is authoritative: allow
 *     `same-origin` and `none` (user-initiated, e.g. typed URL); reject
 *     `same-site` and `cross-site`.
 *   - When `Sec-Fetch-Site` is absent (older browsers / non-browser clients),
 *     fall back to `Origin`: a present Origin must be one of the backend's own
 *     loopback origins (plus the Vite dev server's outside production); an
 *     absent Origin is treated as a non-browser client (curl, server-to-server,
 *     the Electron main process) and allowed.
 */

import { ForbiddenError } from "./errorHandler.ts";
import type {
  ExpressNextFunction,
  ExpressRequest,
  ExpressResponse,
} from "../types/express.ts";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Vite's development server port (apps/frontend/vite.config.ts). */
const VITE_DEV_SERVER_PORT = 8080;

/**
 * Every loopback spelling of the origin the backend serves itself on. With
 * `includeDevServer`, also the Vite development server's loopback origins:
 * its proxy forwards the browser's Origin header unchanged.
 */
export function loopbackOrigins(
  port: number,
  { includeDevServer = false }: { includeDevServer?: boolean } = {},
): string[] {
  const ports = includeDevServer ? [port, VITE_DEV_SERVER_PORT] : [port];
  return ports.flatMap((p) => [
    `http://localhost:${p}`,
    `http://127.0.0.1:${p}`,
    `http://[::1]:${p}`,
  ]);
}

/**
 * @param getAllowedOrigins  returns the exact origins a state-changing request
 *        without `Sec-Fetch-Site` may carry (see {@link loopbackOrigins}).
 */
export function createCsrfGuard(getAllowedOrigins: () => readonly string[]) {
  return function csrfGuard(
    req: ExpressRequest,
    res: ExpressResponse,
    next: ExpressNextFunction,
  ) {
    if (SAFE_METHODS.has(String(req.method).toUpperCase())) return next();

    const secFetchSite = req.headers["sec-fetch-site"];
    if (typeof secFetchSite === "string" && secFetchSite.length > 0) {
      if (secFetchSite === "same-origin" || secFetchSite === "none")
        return next();
      return next(new ForbiddenError("Cross-site request blocked"));
    }

    // No Sec-Fetch-Site header: rely on Origin when the client sent one.
    const origin = req.headers.origin;
    if (origin === undefined || origin === "") return next(); // non-browser client

    // A repeated Origin arrives as an array and never matches an entry.
    if (typeof origin === "string" && getAllowedOrigins().includes(origin))
      return next();

    return next(new ForbiddenError("Cross-origin request blocked"));
  };
}
