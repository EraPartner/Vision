/**
 * Validation-behavior pins for portfolioImportRoutes.js (ZOD-07).
 *
 * Pins the exact accept/reject/coercion behavior of the hand-rolled request
 * parsing BEFORE the zod migration: the Number()-coerced batch/row id guard,
 * parseBrokerageParams' multipart-string coercion, buildPortfolioConfig's
 * required/enum/trim/default build, and normalizePortfolioParserConfig's
 * pass-through semantics — so the swap cannot change the wire.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockConnection } from '../helpers/repoMocks.js';
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

vi.mock('../../src/database/connection.js', () => mockConnection());

vi.mock('../../src/config/logger.js', () => ({
  logger: mockLogger(),
}));

import { runPortfolioImportPipeline, commitPortfolioImport } from '../../src/services/portfolioImportPipeline/index.js';
// NOT mocked: only .../portfolioImportPipeline/index.js is. This is the real
// boundary function, run here over the mocked pg connection.
import { createBatch } from '../../src/services/portfolioImportPipeline/stage.js';
import { query as dbQuery } from '../../src/database/connection.js';
import { getBatch, overrideInvestment } from '../../src/services/portfolioImportBatchService.js';
import customParserConfigRepository from '../../src/repositories/customParserConfigRepository.js';
import { ValidationError } from '../../src/middleware/errorHandler.js';
await import('../../src/routes/portfolioImportRoutes.js');

const mockResponse = () => createMockResponse();
const file = () => ({ path: '/tmp/pin.csv', originalname: 'pin.csv', size: 10 });

const minimalQuery = { date_column: 'D', name_column: 'N', default_asset_class: 'etf' };

const runCustom = (query, body = {}) =>
  routeHandlers['post:/csv/custom']({ file: file(), query, body }, mockResponse());

beforeEach(() => {
  vi.clearAllMocks();
  runPortfolioImportPipeline.mockResolvedValue({
    requiresReview: false, batchId: 1, total: 1, skipped: 0, imported: 1, duplicates: 0, errors: 0,
  });
  customParserConfigRepository.create.mockResolvedValue({ id: 1 });
});

describe('batch-id coercion pins', () => {
  it("accepts '12.0' / ' 12 ' via Number() coercion", async () => {
    getBatch.mockResolvedValue({ id: 12, status: 'complete' });
    await routeHandlers['get:/batches/:id']({ params: { id: '12.0' } }, mockResponse());
    expect(getBatch).toHaveBeenLastCalledWith(12);
    await routeHandlers['get:/batches/:id']({ params: { id: ' 12 ' } }, mockResponse());
    expect(getBatch).toHaveBeenLastCalledWith(12);
  });

  it('rejects fractional/garbage ids on the commit and override sites', async () => {
    await expect(routeHandlers['post:/batches/:id/commit']({ params: { id: '2.5' }, body: {} }, mockResponse()))
      .rejects.toBeInstanceOf(ValidationError);
    await expect(routeHandlers['post:/batches/:id/rows/:rowId/investment-override'](
      { params: { id: '3.5', rowId: '1' }, body: {} }, mockResponse(),
    )).rejects.toBeInstanceOf(ValidationError);
    expect(getBatch).not.toHaveBeenCalled();
  });

  it('coerces both ids on the investment-override site', async () => {
    overrideInvestment.mockResolvedValue(1);
    await routeHandlers['post:/batches/:id/rows/:rowId/investment-override'](
      { params: { id: '5.0', rowId: ' 6 ' }, body: { investment_id: null } },
      mockResponse(),
    );
    expect(overrideInvestment).toHaveBeenCalledWith({ batchId: 5, rowId: 6, investmentId: null });
  });
});

describe('parseBrokerageParams pins (POST /csv/custom)', () => {
  it("coerces multipart strings: is_brokerage 'true'/'false', account_id '7'", async () => {
    await runCustom({ ...minimalQuery, is_brokerage: 'true', account_id: '7' });
    expect(runPortfolioImportPipeline).toHaveBeenLastCalledWith(
      expect.objectContaining({ isBrokerage: true, accountId: 7 }),
    );

    await runCustom({ ...minimalQuery, is_brokerage: 'false', account_id: '7' });
    expect(runPortfolioImportPipeline).toHaveBeenLastCalledWith(
      expect.objectContaining({ isBrokerage: false, accountId: 7 }),
    );

    await runCustom({ ...minimalQuery, is_brokerage: true, account_id: 7 });
    expect(runPortfolioImportPipeline).toHaveBeenLastCalledWith(
      expect.objectContaining({ isBrokerage: true, accountId: 7 }),
    );
  });

  it('treats an empty account_id as absent and defaults is_brokerage to false', async () => {
    await runCustom({ ...minimalQuery, account_id: '' });
    expect(runPortfolioImportPipeline).toHaveBeenLastCalledWith(
      expect.objectContaining({ isBrokerage: false, accountId: undefined }),
    );
  });

  it('rejects non-integer account ids and a brokerage import without an account', async () => {
    for (const account_id of ['abc', '7.5', '-1', '0']) {
      await expect(runCustom({ ...minimalQuery, account_id }))
        .rejects.toThrow('account_id must be a positive integer');
    }
    await expect(runCustom({ ...minimalQuery, is_brokerage: 'true' }))
      .rejects.toThrow(/brokerage import requires account_id/);
    expect(runPortfolioImportPipeline).not.toHaveBeenCalled();
  });
});

describe('buildPortfolioConfig pins (POST /csv/custom)', () => {
  it('builds the full customConfig with trims, coercions and parsed type_mapping', async () => {
    await runCustom({
      date_column: ' Date ', type_column: 'Type', symbol_column: ' Sym ', units_column: 'Units',
      default_asset_class: 'stock', default_type: 'sell', date_format: ' %d-%m-%Y ',
      separator: ';', encoding: ' latin1 ', skip_rows: '2.9',
      type_mapping: '{"K":"buy"}', adapter_name: ' custom ',
    });
    expect(runPortfolioImportPipeline).toHaveBeenCalledWith(expect.objectContaining({
      adapterName: 'custom',
      defaultAssetClass: 'stock',
      defaultType: 'sell',
      customConfig: {
        date_format: '%d-%m-%Y',
        separator: ';',
        encoding: 'latin1',
        skip_rows: 2,
        default_asset_class: 'stock',
        default_type: 'sell',
        type_mapping: { K: 'buy' },
        column_mapping: {
          date: 'Date', type: 'Type', symbol: 'Sym', name: '', units: 'Units',
          price: '', amount: '', fees: '', taxes: '', currency: '', fx_rate: '', note: '',
        },
      },
    }));
  });

  it('applies defaults for a minimal config', async () => {
    await runCustom(minimalQuery);
    expect(runPortfolioImportPipeline).toHaveBeenCalledWith(expect.objectContaining({
      adapterName: 'portfolio_generic',
      defaultType: 'buy',
      customConfig: expect.objectContaining({
        date_format: '%Y-%m-%d', separator: ',', encoding: 'utf-8', skip_rows: 0,
        default_type: 'buy', type_mapping: {},
      }),
    }));
  });

  it('empty separator falls back to ","; malformed type_mapping falls back to {}', async () => {
    await runCustom({ ...minimalQuery, separator: '', type_mapping: 'not-json' });
    expect(runPortfolioImportPipeline).toHaveBeenCalledWith(expect.objectContaining({
      customConfig: expect.objectContaining({ separator: ',', type_mapping: {} }),
    }));
  });

  it('rejects each invalid field with its message', async () => {
    await expect(runCustom({ name_column: 'N', default_asset_class: 'etf' }))
      .rejects.toThrow('date_column is required');
    await expect(runCustom({ date_column: 'D', default_asset_class: 'etf' }))
      .rejects.toThrow('map at least one of symbol_column or name_column');
    await expect(runCustom({ date_column: 'D', name_column: 'N' }))
      .rejects.toThrow('default_asset_class is required and must be a valid asset class');
    await expect(runCustom({ ...minimalQuery, default_asset_class: 'house' }))
      .rejects.toThrow('default_asset_class is required and must be a valid asset class');
    await expect(runCustom({ ...minimalQuery, default_type: 'yolo' }))
      .rejects.toThrow('default_type "yolo" is not a valid transaction type');
    await expect(runCustom({ ...minimalQuery, separator: ';;' }))
      .rejects.toThrow('separator must be a single character');
    await expect(runCustom({ ...minimalQuery, skip_rows: '-1' }))
      .rejects.toThrow('skip_rows must be zero or a positive integer');
    expect(runPortfolioImportPipeline).not.toHaveBeenCalled();
  });
});

describe('normalizePortfolioParserConfig pins (POST /parsers)', () => {
  const create = (config) =>
    routeHandlers['post:/parsers']({ body: { name: 'P', config } }, mockResponse());

  it('passes a valid config through UNCHANGED, unknown keys and all', async () => {
    const config = {
      dateColumn: ' Date ', symbolColumn: 'Sym', defaultAssetClass: 'stock',
      memoColumn: 42, separator: ';;', custom_extra: { nested: true },
    };
    await create(config);
    expect(customParserConfigRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ config, kind: 'portfolio' }),
    );
  });

  it('rejects missing dateColumn / symbol-or-name / bad asset class', async () => {
    await expect(create({ symbolColumn: 'S', defaultAssetClass: 'stock' }))
      .rejects.toThrow('config.dateColumn is required');
    await expect(create({ dateColumn: 'D', defaultAssetClass: 'stock' }))
      .rejects.toThrow('config requires symbolColumn or nameColumn');
    await expect(create({ dateColumn: 'D', nameColumn: 'N', defaultAssetClass: 'house' }))
      .rejects.toThrow('config.defaultAssetClass must be a valid asset class');
  });

  it('rejects a non-object or array config', async () => {
    for (const config of [null, 'str', [1]]) {
      await expect(create(config)).rejects.toThrow('Missing or invalid "config"');
    }
  });
});

/**
 * `batch_id` wire type — the portfolio half of the same split.
 *
 * `POST /csv/custom` relays `result.batchId` from `createBatch`
 * (services/portfolioImportPipeline/stage.js), while `POST /batches/:id/commit`
 * re-reads the id off the URL through `coercedIdSchema`. `createBatch` used to
 * hand back node-postgres's BIGSERIAL STRING, so the two responses typed the
 * same JSON field differently. NUMBER is now the single wire type (normalized at
 * the stage boundary; pinned by tests/importPipeline.stage.test.js).
 */
describe('batch_id wire type', () => {
  const BATCH_ID = 12;

  // The pipeline is mocked, but its `batchId` comes from the REAL `createBatch`
  // running over the mocked pg connection primed with what node-postgres
  // actually returns for a BIGSERIAL: the STRING '12'. Before the stage-boundary
  // fix these pins failed with `batch_id: "12"`.
  const realBatchId = async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ id: String(BATCH_ID) }] });
    return createBatch({ adapterName: 'generic' });
  };
  // createMockResponse's res.ok() funnels into the res.json spy as { ok, data }.
  const payload = (res) => res.json.mock.calls[0][0].data;

  it('POST /csv/custom emits a numeric batch_id on both the 201 and the 202', async () => {
    runPortfolioImportPipeline.mockImplementation(async () => ({
      requiresReview: false, batchId: await realBatchId(), total: 1, skipped: 0, imported: 1, duplicates: 0, errors: 0,
    }));
    const committed = mockResponse();
    await routeHandlers['post:/csv/custom']({ file: file(), query: minimalQuery, body: {} }, committed);
    expect(typeof payload(committed).batch_id).toBe('number');
    expect(payload(committed).batch_id).toBe(BATCH_ID);

    runPortfolioImportPipeline.mockImplementation(async () => ({
      requiresReview: true, batchId: await realBatchId(), matchSourceCounts: { symbol: 1 },
    }));
    const review = mockResponse();
    await routeHandlers['post:/csv/custom']({ file: file(), query: minimalQuery, body: {} }, review);
    expect(typeof payload(review).batch_id).toBe('number');
    expect(payload(review).batch_id).toStrictEqual(payload(committed).batch_id);
  });

  it('POST /batches/:id/commit emits the SAME type and value for the same batch', async () => {
    runPortfolioImportPipeline.mockImplementation(async () => ({
      requiresReview: true, batchId: await realBatchId(), matchSourceCounts: {},
    }));
    const started = mockResponse();
    await routeHandlers['post:/csv/custom']({ file: file(), query: minimalQuery, body: {} }, started);

    getBatch.mockResolvedValue({ id: BATCH_ID, status: 'awaiting_review' });
    commitPortfolioImport.mockResolvedValue({ imported: 1, duplicates: 0, errors: 0 });
    const committed = mockResponse();
    await routeHandlers['post:/batches/:id/commit']({ params: { id: String(BATCH_ID) }, body: {} }, committed);

    expect(typeof payload(committed).batch_id).toBe('number');
    // The whole point of the finding: strict equality across the two responses.
    expect(payload(committed).batch_id).toStrictEqual(payload(started).batch_id);
  });
});
