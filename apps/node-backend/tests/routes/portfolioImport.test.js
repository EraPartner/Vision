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

import { getBatch, getPreviewRows, listBatches } from '../../src/services/portfolioImportBatchService.js';

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
