/**
 * Category routes.
 */

import { Router } from 'express';
import categoryService from '../services/categoryService.js';
import { NotFoundError, ValidationError } from '../middleware/errorHandler.js';
import { validateIdParam } from '../middleware/validation.js';
import { listBody, parseOptionalPagination } from '../lib/pagination.js';
// mv_monthly_summary / mv_category_totals embed the category name and the
// recipient default-category mapping, so category mutations must schedule a
// refresh — otherwise renamed/reassigned categories serve stale until an
// unrelated transaction mutation happens to refresh the views.
import { scheduleRefresh } from '../services/materializedViewService.js';

/**
 * @typedef {import('../types/express.js').ExpressRequest} ExpressRequest
 * @typedef {import('../types/express.js').ExpressResponse} ExpressResponse
 */

const router = Router();

// Pagination is opt-in: without limit/offset this still answers the complete
// list (category pickers/pages render all of them), so no client is truncated.
// When unpaginated, `total` is just the row count and the extra COUNT
// round-trip is skipped; a supplied limit/offset pages the rows while `total`
// stays the full match count.
router.get('/', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const { general, detail, active = 'true', search } = req.query;
  const page = parseOptionalPagination(req.query, { maxLimit: 1000 });
  const opts = {
    ...(page ?? {}),
    general: general || null,
    detail: detail || null,
    search: search ? String(search).slice(0, 200) : null,
    active: active !== 'false',
  };

  const items = await categoryService.getAll(opts);
  const total = page ? await categoryService.getCount(opts) : items.length;

  const enriched = items.map((c) => ({
    ...c,
    /** @type {any[]} */
    links: [],
  }));
  res.ok({ ...listBody(enriched, total, page), links: [] });
});

router.post('/', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const { general, detail, description } = req.body;
  if (!general || !detail) throw new ValidationError('Missing required fields: general, detail');

  const { category, created } = await categoryService.createOrGet({ general, detail, description });
  res.status(created ? 201 : 200);
  res.ok({ ...category, links: [] });
});

// Must precede /:id route so "assign" does not match as id param.
router.post('/assign', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const { category_general, category_detail, recipient_ids } = req.body;
  if (!category_general || !category_detail) {
    throw new ValidationError('Missing required fields: category_general, category_detail');
  }
  if (!recipient_ids) throw new ValidationError('Missing recipient_ids');

  const ids = Array.isArray(recipient_ids) ? recipient_ids : [recipient_ids];
  const { category } = await categoryService.createOrGet({
    general: category_general,
    detail: category_detail,
  });
  const updated = await categoryService.assignToRecipients(category.id, ids);
  scheduleRefresh();
  res.ok({ updated_recipients: updated, links: [] });
});

router.get('/:id', validateIdParam, /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const category = await categoryService.getById(parseInt(req.params.id, 10));
  if (!category) throw new NotFoundError(`Category ${req.params.id} not found`);
  res.ok({ ...category, links: [] });
});

router.patch('/:id', validateIdParam, /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const updated = await categoryService.update(id, req.body);
  if (!updated) throw new NotFoundError(`Category ${id} not found`);
  scheduleRefresh();
  res.ok({ ...updated, links: [] });
});

router.delete('/:id', validateIdParam, /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const deleted = await categoryService.hardDelete(id);
  if (!deleted) throw new NotFoundError(`Category ${id} not found`);
  scheduleRefresh();
  // Hard delete → 204 No Content (docs/reference/code-patterns.md, "DELETE responses").
  res.status(204).send();
});

router.post('/:id/assign', validateIdParam, /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const categoryId = parseInt(req.params.id, 10);
  let { recipient_ids } = req.body;
  if (!recipient_ids) throw new ValidationError('Missing recipient_ids');
  if (!Array.isArray(recipient_ids)) recipient_ids = [recipient_ids];

  const updated = await categoryService.assignToRecipients(categoryId, recipient_ids);
  scheduleRefresh();
  res.ok({ updated_recipients: updated, links: [] });
});

export default router;
