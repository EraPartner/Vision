/**
 * Shared batch-history and rollback route registration for both CSV import
 * pipelines. Pipeline-specific rollback effects stay in callbacks.
 */

import { parseBatchIdParam } from '../lib/importBatchIds.ts';
import { parsePagination } from '../lib/pagination.ts';
import { NotFoundError, ValidationError } from '../middleware/errorHandler.ts';

/**
 * @typedef {import('../types/express.ts').ExpressRequest} ExpressRequest
 * @typedef {import('../types/express.ts').ExpressResponse} ExpressResponse
 * @typedef {import('../types/express.ts').ExpressRouter} ExpressRouter
 */

/**
 * @param {ExpressRouter} router
 * @param {{
 *   listBatches: (page: {limit: number, offset: number}) => Promise<{batches: any[], total: number}>;
 *   getBatch: (id: number) => Promise<any>;
 *   inProgressStatuses: string[];
 *   rollback: (id: number) => Promise<Record<string, any>>;
 * }} options
 */
export function registerImportBatchRoutes(router, options) {
  const {
    listBatches,
    getBatch,
    inProgressStatuses,
    rollback,
  } = options;

  router.get('/batches', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
    const { limit, offset } = parsePagination(req.query, { maxLimit: 200 });
    const { batches, total } = await listBatches({ limit, offset });
    res.ok({ items: batches, total, limit, offset });
  });

  router.get('/batches/:id', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
    const id = parseBatchIdParam(req);
    const batch = await getBatch(id);
    if (!batch) throw new NotFoundError(`Import batch ${id} not found`);
    res.ok(batch);
  });

  router.delete('/batches/:id', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
    const id = parseBatchIdParam(req);
    const batch = await getBatch(id);
    if (!batch) throw new NotFoundError(`Import batch ${id} not found`);
    if (batch.status === 'aborted') throw new ValidationError('Batch is already aborted');
    if (inProgressStatuses.includes(batch.status)) {
      throw new ValidationError('Cannot rollback a batch that is still in progress');
    }

    res.ok(await rollback(id));
  });
}
