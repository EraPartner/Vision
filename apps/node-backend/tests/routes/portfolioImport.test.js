/**
 * Portfolio import route tests.
 *
 * Focused on the batch/row id guards: ids are positive bigserial PKs, so
 * non-positive or trailing-garbage values must 400 before touching the DB
 * (previously "-1"/"0"/"12abc" slipped through as NaN-tolerant parseInt).
 *
 * Runs against the REAL router mounted on a throwaway Express app (see
 * tests/helpers/routeApp.js), which also puts the router's own trailing error
 * middleware (`router.use(csvUploadErrorTranslator)`, routes/
 * portfolioImportRoutes.js:494) on the tested path — the mock-router harness
 * dropped it entirely. multer is still stubbed to a pass-through (no real
 * multipart parsing); this suite doesn't exercise the upload routes, so no
 * `req.file` injection is needed (see portfolioImportValidationPins.test.js
 * for that, mirroring importValidationPins.test.js's pattern).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockConnection } from '../helpers/repoMocks.js';
import { mockLogger } from '../helpers/mockLogger.js';
import { routeAgent, okEnvelope, errEnvelope } from '../helpers/routeApp.js';

vi.mock('multer', () => {
  const multer = vi.fn(() => ({
    single: vi.fn(() => (req, res, next) => next()),
  }));
  multer.MulterError = class MulterError extends Error {
    constructor(code) { super(code); this.code = code; }
  };
  return { default: multer };
});

vi.mock('fs', () => {
  const unlink = vi.fn().mockResolvedValue(undefined);
  return {
    default: { existsSync: vi.fn(() => false), unlinkSync: vi.fn(), promises: { unlink } },
    existsSync: vi.fn(() => false),
    unlinkSync: vi.fn(),
    promises: { unlink },
  };
});

vi.mock('os', () => ({
  default: { tmpdir: vi.fn(() => '/tmp') },
  tmpdir: vi.fn(() => '/tmp'),
}));

vi.mock('../../src/services/portfolioImportPipeline/index.js', () => ({
  runPortfolioImportPipeline: vi.fn(),
  commitPortfolioImport: vi.fn(),
}));

vi.mock('../../src/services/portfolioImportBatchService.js', () => ({
  listBatches: vi.fn(),
  getBatch: vi.fn(),
  getPreviewRows: vi.fn(),
  overrideInvestment: vi.fn(),
  createInvestmentForRow: vi.fn(),
  resolveInvestmentRows: vi.fn(),
  rollbackBatch: vi.fn(),
  setBatchAccount: vi.fn(),
}));

vi.mock('../../src/services/accountService.js', () => ({
  default: { get: vi.fn() },
}));

vi.mock('../../src/repositories/customParserConfigRepository.js', () => ({
  default: {
    getAll: vi.fn(), getById: vi.fn(), getByName: vi.fn(),
    create: vi.fn(), update: vi.fn(), delete: vi.fn(),
  },
}));

vi.mock('../../src/database/connection.js', () => mockConnection());

vi.mock('../../src/config/logger.js', () => ({
  logger: mockLogger(),
}));

import {
  getBatch,
  getPreviewRows,
  listBatches,
  createInvestmentForRow,
  resolveInvestmentRows,
} from '../../src/services/portfolioImportBatchService.js';

const { default: portfolioImportRouter } = await import('../../src/routes/portfolioImportRoutes.js');

const BASE = '/api/portfolio/import';
const api = routeAgent(portfolioImportRouter, { mountPath: BASE });

describe('Portfolio Import Routes — batch/row id guards', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET /batches/:id/preview rejects a negative batch id with a 400', async () => {
    const res = await api.get(`${BASE}/batches/-1/preview`).expect(400);
    expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
    expect(getBatch).not.toHaveBeenCalled();
    expect(getPreviewRows).not.toHaveBeenCalled();
  });

  it('GET /batches/:id rejects a trailing-garbage id like "12abc"', async () => {
    const res = await api.get(`${BASE}/batches/12abc`).expect(400);
    expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
    expect(getBatch).not.toHaveBeenCalled();
  });

  it('POST /batches/:id/rows/:rowId/investment-override rejects a zero rowId', async () => {
    const res = await api.post(`${BASE}/batches/5/rows/0/investment-override`).send({}).expect(400);
    expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
  });

  it('maps a missing create-new row from the legacy endpoint to 404', async () => {
    createInvestmentForRow.mockRejectedValue(Object.assign(new Error('Row not found'), { code: 'NOT_FOUND' }));

    const res = await api.post(`${BASE}/batches/5/rows/6/investment-override`)
      .send({ create_new: true })
      .expect(404);

    expect(res.body).toEqual(errEnvelope({ code: 'NOT_FOUND' }));
  });
});

describe('Portfolio Import Routes — collection response shape', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET /batches returns the canonical { items, total, limit, offset } body', async () => {
    listBatches.mockResolvedValue({ batches: [{ id: 1, status: 'complete' }], total: 1 });

    const res = await api.get(`${BASE}/batches`).expect(200);

    // The old `batches` wire key is gone; the service still speaks `batches`.
    expect(res.body.data.batches).toBeUndefined();
    expect(res.body).toEqual(okEnvelope({
      items: [{ id: 1, status: 'complete' }],
      total: 1,
      limit: 50,
      offset: 0,
    }));
  });
});

describe('Portfolio Import Routes — bulk investment resolution', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves a complete row set through one service call', async () => {
    resolveInvestmentRows.mockResolvedValue({
      investmentId: 42,
      created: false,
      resolved: 3,
    });

    const res = await api.post(`${BASE}/batches/5/rows/investment-override`)
      .send({ row_ids: [10, 11, 12], investment_id: 42 })
      .expect(200);

    expect(resolveInvestmentRows).toHaveBeenCalledTimes(1);
    expect(resolveInvestmentRows).toHaveBeenCalledWith({
      batchId: 5,
      rowIds: [10, 11, 12],
      investmentId: 42,
      createNew: false,
    });
    expect(res.body).toEqual(okEnvelope({ investment_id: 42, created: false, resolved: 3 }));
  });

  it('rejects malformed, duplicate, or ambiguous row-set bodies before the service', async () => {
    const invalidBodies = [
      { row_ids: [], investment_id: 42 },
      { row_ids: [10, '11abc'], investment_id: 42 },
      { row_ids: [10, 10], investment_id: 42 },
      { row_ids: [10] },
      { row_ids: [10], investment_id: 42, create_new: true },
      { row_ids: [10], investment_id: 42, create_new: false },
    ];

    for (const body of invalidBodies) {
      await api.post(`${BASE}/batches/5/rows/investment-override`).send(body).expect(400);
    }

    expect(resolveInvestmentRows).not.toHaveBeenCalled();
  });

  it('maps an ineligible row set to 404 without reporting partial success', async () => {
    const err = Object.assign(new Error('One or more rows are no longer reviewable'), {
      code: 'NOT_FOUND',
    });
    resolveInvestmentRows.mockRejectedValue(err);

    const res = await api.post(`${BASE}/batches/5/rows/investment-override`)
      .send({ row_ids: [10, 11], create_new: true })
      .expect(404);

    expect(res.body).toEqual(errEnvelope({ code: 'NOT_FOUND' }));
  });
});
