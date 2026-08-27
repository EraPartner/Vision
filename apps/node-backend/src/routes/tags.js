/**
 * Tag routes.
 *
 * GET    /api/tags          — list (filter by ?active=true|false|all)
 * POST   /api/tags          — create or reactivate by slug
 * PATCH  /api/tags/:id      — update color and/or is_active
 * DELETE /api/tags/:id      — soft delete
 *
 * Data access + orchestration live in services/tagService.js — routes never
 * touch the repository layer directly (vision-local/no-repo-direct-from-route).
 */

import { Router } from 'express';
import tagService from '../services/tagService.js';
import { validateIdParam, assertIdParam } from '../middleware/validation.js';
import { listBody, parseOptionalPagination } from '../lib/pagination.js';

/**
 * @typedef {import('../types/express.js').ExpressRequest} ExpressRequest
 * @typedef {import('../types/express.js').ExpressResponse} ExpressResponse
 */

const router = Router();

// Pagination is opt-in: without limit/offset this still answers the complete
// list (the tag pickers/filters render all of them), so no client is truncated.
router.get('/', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const { active = 'true' } = req.query;
  const activeFilter = active === 'all' ? null : active !== 'false';
  const page = parseOptionalPagination(req.query, { maxLimit: 1000 });
  const { items, total } = await tagService.list({ active: activeFilter, ...(page ?? {}) });
  res.ok({ ...listBody(items, total, page), links: [] });
});

router.post('/', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const { tag, reactivated, wasInactive, junctionCount } = await tagService.createOrReactivate(req.body);

  res.status(reactivated && !wasInactive ? 200 : 201);
  res.ok({
    ...tag,
    reactivated,
    reactivated_junction_count: reactivated && wasInactive ? junctionCount : undefined,
    links: [],
  });
});

router.patch('/:id', validateIdParam, /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const id = assertIdParam(req);
  const updated = await tagService.update(id, req.body);
  res.ok({ ...updated, links: [] });
});

// Deactivation, not a hard delete: the row survives with is_active = false, so
// this returns the deactivated entity rather than 204 (docs/reference/code-patterns.md,
// "DELETE responses").
router.delete('/:id', validateIdParam, /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const id = assertIdParam(req);
  const deactivated = await tagService.softDelete(id);
  res.ok({ ...deactivated, links: [] });
});

export default router;
