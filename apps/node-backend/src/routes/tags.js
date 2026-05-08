/**
 * Tag routes.
 *
 * GET    /api/tags          — list (filter by ?active=true|false|all)
 * POST   /api/tags          — create or reactivate by slug
 * PATCH  /api/tags/:id      — update color and/or is_active
 * DELETE /api/tags/:id      — soft delete
 */

import { Router } from 'express';
import tagRepository from '../repositories/tagRepository.js';
import { slugify } from '../lib/slugify.js';
import { NotFoundError, ValidationError } from '../middleware/errorHandler.js';
import { validateIdParam } from '../middleware/validation.js';

const router = Router();

router.get('/', async (req, res) => {
  const { active = 'true' } = req.query;
  const activeFilter = active === 'all' ? null : active !== 'false';
  const tags = await tagRepository.getAll({ active: activeFilter });
  res.ok({ items: tags, total: tags.length, links: [] });
});

router.post('/', async (req, res) => {
  const { slug: rawSlug, color = null } = req.body;
  if (!rawSlug) throw new ValidationError('Missing required field: slug');

  const slug = slugify(rawSlug);
  if (!slug) throw new ValidationError('slug is empty after normalization');

  if (color !== null && color !== undefined && typeof color !== 'string') {
    throw new ValidationError('color must be a string');
  }

  const preexisting = await tagRepository.getBySlug(slug);
  const wasInactive = preexisting && !preexisting.is_active;
  let junctionCount = 0;
  if (wasInactive) {
    junctionCount = await tagRepository.countTransactionReferences(preexisting.id);
  }

  const { tag, reactivated } = await tagRepository.findOrCreateBySlug(slug, color ?? null);

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
  const { color, is_active } = req.body;

  if (color !== undefined && color !== null && typeof color !== 'string') {
    throw new ValidationError('color must be a string or null');
  }
  if (is_active !== undefined && is_active !== null && typeof is_active !== 'boolean') {
    throw new ValidationError('is_active must be a boolean');
  }

  const updated = await tagRepository.update(id, { color, is_active });
  if (!updated) throw new NotFoundError(`Tag ${id} not found`);
  res.ok({ ...updated, links: [] });
});

router.delete('/:id', validateIdParam, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const deleted = await tagRepository.softDelete(id);
  if (!deleted) throw new NotFoundError(`Tag ${id} not found`);
  res.ok({ message: `Tag ${id} deactivated`, tag: deleted, links: [] });
});

export default router;
