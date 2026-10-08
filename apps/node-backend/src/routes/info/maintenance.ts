/**
 * Maintenance endpoints:
 *   - POST /refresh-views — refresh materialized views
 */

import { Router } from "express";
import { refreshMaterializedViews } from "../../services/materializedViewService.ts";
import { adminRateLimiter } from "../../middleware/rateLimiter.ts";

const router = Router();

router.post("/refresh-views", adminRateLimiter, async (req, res) => {
  const start = Date.now();
  await refreshMaterializedViews();
  res.ok({
    message: "Materialized views refreshed",
    duration_ms: Date.now() - start,
  });
});

export default router;
