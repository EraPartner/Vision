/**
 * Maintenance endpoints:
 *   - POST /refresh-views — refresh materialized views
 */

import { Router } from 'express';
import { refreshMaterializedViews } from '../../services/materializedViewService.js';
import { adminRateLimiter } from '../../middleware/rateLimiter.js';

const router = Router();

router.post('/refresh-views', adminRateLimiter, async (req, res) => {
  const start = Date.now();
  await refreshMaterializedViews();
  res.ok({ message: 'Materialized views refreshed', duration_ms: Date.now() - start });
});

export default router;
