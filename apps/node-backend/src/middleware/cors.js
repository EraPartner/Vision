/**
 * Strict allowlist CORS middleware.
 *
 * @typedef {import('../types/express.js').ExpressRequest} ExpressRequest
 * @typedef {import('../types/express.js').ExpressResponse} ExpressResponse
 * @typedef {import('../types/express.js').ExpressNextFunction} ExpressNextFunction
 */

const CORS_METHODS = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
const CORS_ALLOWED_HEADERS = "Content-Type,Authorization,X-Request-Id";
const CORS_EXPOSED_HEADERS = "X-Request-Id,X-Exported-Count";

/**
 * @param {() => string[]} getAllowedOrigins
 */
export function createCorsMiddleware(getAllowedOrigins) {
  return /** @param {ExpressRequest} req @param {ExpressResponse} res @param {ExpressNextFunction} next */ (
    req,
    res,
    next,
  ) => {
    // Origin is single-valued per fetch/HTTP semantics even though the generic
    // Node header type permits arrays for headers that can repeat.
    const origin = /** @type {string|undefined} */ (req.headers.origin);
    const originAllowed = getAllowedOrigins().includes(
      /** @type {string} */ (origin),
    );

    if (originAllowed && origin) {
      res.setHeader("Vary", "Origin");
      // codeql[js/cors-misconfiguration]: origin is validated against the settings allowlist above; wildcard is never combined with credentials.
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Methods", CORS_METHODS);
      res.setHeader("Access-Control-Allow-Headers", CORS_ALLOWED_HEADERS);
      res.setHeader("Access-Control-Expose-Headers", CORS_EXPOSED_HEADERS);
    }

    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Max-Age", "600");
      res.writeHead(204).end();
      return;
    }

    next();
  };
}
