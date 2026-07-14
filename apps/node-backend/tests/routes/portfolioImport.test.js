/**
 * Portfolio import route tests.
 *
 * Focused on the batch/row id guards: ids are positive bigserial PKs, so
 * non-positive or trailing-garbage values must 400 before touching the DB
 * (previously "-1"/"0"/"12abc" slipped through as NaN-tolerant parseInt).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../helpers/mockLogger.js';
import { createMockRouter, createMockResponse } from '../helpers/routeHarness.js';

const { router: mockRouter, handlers: routeHandlers } = createMockRouter();

vi.mock('express', () => ({
  default: { Router: () => mockRouter },
  Router: () => mockRouter,
}));

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

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('../../src/config/logger.js', () => ({
  logger: mockLogger(),
}));

import { getBatch, getPreviewRows } from '../../src/services/portfolioImportBatchService.js';
import { ValidationError } from '../../src/middleware/errorHandler.js';
await import('../../src/routes/portfolioImportRoutes.js');

describe('Portfolio Import Routes — batch/row id guards', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET /batches/:id/preview rejects a negative batch id with a 400', async () => {
    const req = { params: { id: '-1' } };
    const res = createMockResponse();

    await expect(routeHandlers['get:/batches/:id/preview'](req, res))
      .rejects.toBeInstanceOf(ValidationError);
    expect(getBatch).not.toHaveBeenCalled();
    expect(getPreviewRows).not.toHaveBeenCalled();
  });

  it('GET /batches/:id rejects a trailing-garbage id like "12abc"', async () => {
    const req = { params: { id: '12abc' } };
    const res = createMockResponse();

    await expect(routeHandlers['get:/batches/:id'](req, res))
      .rejects.toBeInstanceOf(ValidationError);
    expect(getBatch).not.toHaveBeenCalled();
  });

  it('POST /batches/:id/rows/:rowId/investment-override rejects a zero rowId', async () => {
    const req = { params: { id: '5', rowId: '0' }, body: {} };
    const res = createMockResponse();

    await expect(routeHandlers['post:/batches/:id/rows/:rowId/investment-override'](req, res))
      .rejects.toBeInstanceOf(ValidationError);
  });
});
