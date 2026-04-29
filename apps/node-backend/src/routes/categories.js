/**
 * Category routes.
 */

import { Router } from 'express';
// eslint-disable-next-line vision-local/no-repo-direct-from-route
import categoryRepository from '../repositories/categoryRepository.js';
import { NotFoundError, ValidationError } from '../middleware/errorHandler.js';
import { validateIdParam } from '../middleware/validation.js';

const router = Router();

router.get('/', async (req, res) => {
  const { limit = 50, offset = 0, general, detail, active = 'true', search } = req.query;
  const opts = {
    limit: Math.max(1, Math.min(parseInt(limit, 10) || 50, 1000)),
    offset: Math.max(0, parseInt(offset, 10) || 0),
    general: general || null,
    detail: detail || null,
    search: search ? String(search).slice(0, 200) : null,
    active: active !== 'false',
  };

  const [items, total] = await Promise.all([
    categoryRepository.getAll(opts),
    categoryRepository.getCount(opts),
  ]);

  res.ok({
    items: items.map((c) => ({ ...c, links: [] })),
    total,
    limit: opts.limit,
    offset: opts.offset,
    links: [],
  });
});

router.post('/', async (req, res) => {
  const { general, detail, description } = req.body;
  if (!general || !detail) throw new ValidationError('Missing required fields: general, detail');

  const { category, created } = await categoryRepository.createOrGet({ general, detail, description });
  res.status(created ? 201 : 200);
  res.ok({ ...category, links: [] });
});

// Must precede /:id route so "assign" does not match as id param.
router.post('/assign', async (req, res) => {
  const { category_general, category_detail, recipient_ids } = req.body;
  if (!category_general || !category_detail) {
    throw new ValidationError('Missing required fields: category_general, category_detail');
  }
  if (!recipient_ids) throw new ValidationError('Missing recipient_ids');

  const ids = Array.isArray(recipient_ids) ? recipient_ids : [recipient_ids];
  const { category } = await categoryRepository.createOrGet({
    general: category_general,
    detail: category_detail,
  });
  const updated = await categoryRepository.assignToRecipients(category.id, ids);
  res.ok({ updated_recipients: updated, links: [] });
});

router.get('/:id', validateIdParam, async (req, res) => {
  const category = await categoryRepository.getById(parseInt(req.params.id, 10));
  if (!category) throw new NotFoundError(`Category ${req.params.id} not found`);
  res.ok({ ...category, links: [] });
});

router.patch('/:id', validateIdParam, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const updated = await categoryRepository.update(id, req.body);
  if (!updated) throw new NotFoundError(`Category ${id} not found`);
  res.ok({ ...updated, links: [] });
});

router.delete('/:id', validateIdParam, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const deleted = await categoryRepository.hardDelete(id);
  if (!deleted) throw new NotFoundError(`Category ${id} not found`);
  res.ok({ message: `Category ${id} deleted permanently`, links: [] });
});

router.post('/:id/assign', validateIdParam, async (req, res) => {
  const categoryId = parseInt(req.params.id, 10);
  let { recipient_ids } = req.body;
  if (!recipient_ids) throw new ValidationError('Missing recipient_ids');
  if (!Array.isArray(recipient_ids)) recipient_ids = [recipient_ids];

  const updated = await categoryRepository.assignToRecipients(categoryId, recipient_ids);
  res.ok({ updated_recipients: updated, links: [] });
});

export default router;
