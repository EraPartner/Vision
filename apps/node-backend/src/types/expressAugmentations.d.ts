/**
 * Adds the request id (middleware/requestId.ts) and the envelope helper that
 * middleware/envelope.ts installs on every response (`res.ok`) to Express's
 * own types, so strict TypeScript route handlers keep Express's contextual
 * request and response types.
 *
 * The legacy checkJs program does not include this file; its JavaScript
 * callers keep using the structural types in types/express.ts.
 */

import type { ResponseMeta } from "./express.ts";

declare global {
  namespace Express {
    interface Request {
      /** Request id stamped by middleware/requestId.ts. */
      id?: string;
    }
    interface Response {
      ok(data: unknown, meta?: ResponseMeta): this;
    }
  }
}
