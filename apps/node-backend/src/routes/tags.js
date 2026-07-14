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
import { validateIdParam } from '../middleware/validation.js';
import { parsePagination } from '../lib/pagination.js';

const router = Router();

router.get('/', async (req, res) => {
  const { active = 'true' } = req.query;
  const activeFilter = active === 'all' ? null : active !== 'false';
  const { limit, offset } = parsePagination(req.query, { maxLimit: 1000 });
  const { items, total } = await tagService.list({ active: activeFilter, limit, offset });
  res.ok({ items, total, limit, offset, links: [] });
});

router.post('/', async (req, res) => {
  const { tag, reactivated, wasInactive, junctionCount } = await tagService.createOrReactivate(req.body);

  res.status(reactivated && !wasInactive ? 200 : 201);
  res.ok({
    ...tag,
    reactivated,
    reactivated_junction_count: reactivated && wasInactive ? junctionCount : undefined,
    links: [],
  });
});

router.patch('/:id', validateIdParam, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const updated = await tagService.update(id, req.body);
  res.ok({ ...updated, links: [] });
});

router.delete('/:id', validateIdParam, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const deleted = await tagService.softDelete(id);
  res.ok({ message: `Tag ${id} deactivated`, tag: deleted, links: [] });
});

export default router;
