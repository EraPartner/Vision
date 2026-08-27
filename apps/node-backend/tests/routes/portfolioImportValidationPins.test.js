/**
 * Validation-behavior pins for portfolioImportRoutes.js (ZOD-07).
 *
 * Pins the exact accept/reject/coercion behavior of the hand-rolled request
 * parsing BEFORE the zod migration: the Number()-coerced batch/row id guard,
 * parseBrokerageParams' multipart-string coercion, buildPortfolioConfig's
 * required/enum/trim/default build, and normalizePortfolioParserConfig's
 * pass-through semantics — so the swap cannot change the wire.
 *
 * Driven over HTTP against the real router (tests/helpers/routeApp.js),
 * mirroring importValidationPins.test.js: multer is stubbed to a pass-through
 * (no real multipart parsing) and the uploaded file is injected by a `before`
 * middleware, the same per-mount slot main.js uses (main.js:326 mounts
 * importRateLimiter there for this router).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockConnection } from '../helpers/repoMocks.js';
import { mockLogger } from '../helpers/mockLogger.js';
import { routeAgent } from '../helpers/routeApp.js';

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
  getPortfolioImportBatchPreview: vi.fn(),
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
import { getBatch, overrideInvestment, setBatchAccount } from '../../src/services/portfolioImportBatchService.js';
import accountService from '../../src/services/accountService.js';
import customParserConfigRepository from '../../src/repositories/customParserConfigRepository.js';

const { default: portfolioImportRouter } = await import('../../src/routes/portfolioImportRoutes.js');

const UPLOAD = { path: '/tmp/pin.csv', originalname: 'pin.csv', size: 10 };
const BASE = '/api/portfolio/import';
// multer is stubbed, so nothing populates req.file — inject it in the same
// per-mount slot main.js uses.
const api = routeAgent(portfolioImportRouter, {
  mountPath: BASE,
  before: [(req, _res, next) => { req.file = { ...UPLOAD }; next(); }],
});

/** Encode a path segment so ids with spaces survive the URL round-trip. */
const seg = (v) => encodeURIComponent(String(v));

const minimalQuery = { date_column: 'D', name_column: 'N', default_asset_class: 'etf' };

const runCustom = (query, body = {}) =>
  api.post(`${BASE}/csv/custom`).query(query).send(body);

beforeEach(() => {
  vi.clearAllMocks();
  runPortfolioImportPipeline.mockResolvedValue({
    requiresReview: false, batchId: 1, total: 1, skipped: 0, imported: 1, duplicates: 0, errors: 0,
  });
  customParserConfigRepository.create.mockResolvedValue({ id: 1 });
});

describe('batch-id shape pins (validateId, bounded to MAX_SAFE_ID)', () => {
  // Mirror of the transaction-import block: this pinned the raw `Number()`
  // coercion ('12.0' and ' 12 ' → 12) that the zod swap preserved, not an
  // intended contract. coercedIdSchema delegates to validateId now, so the
  // portfolio router shares the one definition of a valid id.
  it("rejects '12.0' / ' 12 ' instead of coercing them to a batch", async () => {
    getBatch.mockResolvedValue({ id: 12, status: 'complete' });

    for (const id of ['12.0', ' 12 ', '0x10', '1e3', '+12']) {
      const res = await api.get(`${BASE}/batches/${seg(id)}`).expect(400);
      expect(res.body.error.code, `expected ${JSON.stringify(id)} to be rejected`)
        .toBe('VALIDATION_ERROR');
    }
    expect(getBatch).not.toHaveBeenCalled();

    await api.get(`${BASE}/batches/12`).expect(200);
    expect(getBatch).toHaveBeenLastCalledWith(12);
  });

  // portfolio_import_batches.id is BIGSERIAL too (0040_add_portfolio_import_
  // staging.py), so the bound is MAX_SAFE_ID rather than validateId's int32
  // default — an id past int32 is a legal row and still reaches the repository.
  it('accepts an integral id past int32 and 404s it, but rejects one past 2^53', async () => {
    getBatch.mockResolvedValue(undefined);

    await api.get(`${BASE}/batches/2147483648`).expect(404);
    expect(getBatch).toHaveBeenCalledWith(2147483648);

    getBatch.mockClear();
    const res = await api.get(`${BASE}/batches/9007199254740993`).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(getBatch).not.toHaveBeenCalled();
  });

  it('rejects fractional/garbage ids on the commit and override sites', async () => {
    const res1 = await api.post(`${BASE}/batches/${seg('2.5')}/commit`).send({}).expect(400);
    expect(res1.body.error.code).toBe('VALIDATION_ERROR');

    const res2 = await api.post(`${BASE}/batches/${seg('3.5')}/rows/1/investment-override`).send({}).expect(400);
    expect(res2.body.error.code).toBe('VALIDATION_ERROR');

    expect(getBatch).not.toHaveBeenCalled();
  });

  it('validates both ids on the investment-override site', async () => {
    overrideInvestment.mockResolvedValue(1);

    // Was '5.0' / ' 6 ' → 5 / 6. Both forms reject now; the happy path is the
    // plain digit string, and each id is checked independently.
    await api.post(`${BASE}/batches/5/rows/6/investment-override`)
      .send({ investment_id: null })
      .expect(200);

    expect(overrideInvestment).toHaveBeenCalledWith({ batchId: 5, rowId: 6, investmentId: null });

    for (const { id, rowId } of [
      { id: '5.0', rowId: '6' },
      { id: '5', rowId: ' 6 ' },
      { id: '0x10', rowId: '6' },
      { id: '5', rowId: '0' },
    ]) {
      const res = await api.post(`${BASE}/batches/${seg(id)}/rows/${seg(rowId)}/investment-override`)
        .send({}).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });
});

/**
 * Override/commit body ids (`investment_id`, `account_id`).
 *
 * Same defect as the transaction importer's recipient/category overrides:
 * `Number.isInteger(Number(x))` rejects '12abc' but reads '1e3' as 1000, '0x10'
 * as 16, `true` as 1 and `[7]` as 7 — so the row was not rejected, it was
 * pointed at a different instrument, and the committed lot recorded holdings
 * the user never matched. The commit-time `account_id` is worse per request: it
 * is stamped on the batch, so every lot the batch commits inherits it, and the
 * `accountService.get` existence check only ever saw the already-coerced value,
 * so a retargeted-but-real account passed it.
 */
describe('override/commit body id shape', () => {
  const RETARGETING = ['1e3', '0x10', '0o17', '0b11', true, [7], '+7', ' 7 ', '7.0'];
  const MALFORMED = ['12abc', 'abc', '1.5', '0', '-1', '', {}];

  it('rejects every investment_id that used to resolve to a different instrument', async () => {
    for (const investment_id of [...RETARGETING, ...MALFORMED]) {
      const res = await api.post(`${BASE}/batches/5/rows/6/investment-override`)
        .send({ investment_id })
        .expect(400);
      expect(res.body.error.code, `expected ${JSON.stringify(investment_id)} to be rejected`)
        .toBe('VALIDATION_ERROR');
    }
    expect(overrideInvestment).not.toHaveBeenCalled();
  });

  it('still accepts an investment_id digit string or integer, and clears on null or absent', async () => {
    overrideInvestment.mockResolvedValue(1);

    for (const investment_id of [7, '7', '007']) {
      await api.post(`${BASE}/batches/5/rows/6/investment-override`).send({ investment_id }).expect(200);
      expect(overrideInvestment).toHaveBeenLastCalledWith({ batchId: 5, rowId: 6, investmentId: 7 });
    }

    for (const body of [{}, { investment_id: null }]) {
      const res = await api.post(`${BASE}/batches/5/rows/6/investment-override`).send(body).expect(200);
      expect(overrideInvestment).toHaveBeenLastCalledWith({ batchId: 5, rowId: 6, investmentId: null });
      expect(res.body.data.user_override_investment_id).toBeNull();
    }
  });

  it('rejects a commit account_id that used to stamp the batch with another account', async () => {
    getBatch.mockResolvedValue({ id: 5, status: 'awaiting_review' });

    for (const account_id of [...RETARGETING, ...MALFORMED]) {
      const res = await api.post(`${BASE}/batches/5/commit`).send({ account_id }).expect(400);
      expect(res.body.error.code, `expected ${JSON.stringify(account_id)} to be rejected`)
        .toBe('VALIDATION_ERROR');
    }
    expect(accountService.get).not.toHaveBeenCalled();
    expect(setBatchAccount).not.toHaveBeenCalled();
    expect(commitPortfolioImport).not.toHaveBeenCalled();
  });

  it('still accepts a commit account_id, and absent/null still means "no batch account"', async () => {
    getBatch.mockResolvedValue({ id: 5, status: 'awaiting_review' });
    accountService.get.mockResolvedValue({ id: 7 });
    commitPortfolioImport.mockResolvedValue({ imported: 1, duplicates: 0, errors: 0 });

    await api.post(`${BASE}/batches/5/commit`).send({ account_id: '7' }).expect(200);
    expect(accountService.get).toHaveBeenCalledWith(7);
    expect(setBatchAccount).toHaveBeenCalledWith(5, 7);

    for (const body of [{}, { account_id: null }]) {
      setBatchAccount.mockClear();
      await api.post(`${BASE}/batches/5/commit`).send(body).expect(200);
      expect(setBatchAccount).not.toHaveBeenCalled();
    }
  });
});

describe('parseBrokerageParams pins (POST /csv/custom)', () => {
  it("coerces multipart strings: is_brokerage 'true'/'false', account_id '7'", async () => {
    await runCustom({ ...minimalQuery, is_brokerage: 'true', account_id: '7' }).expect(201);
    expect(runPortfolioImportPipeline).toHaveBeenLastCalledWith(
      expect.objectContaining({ isBrokerage: true, accountId: 7 }),
    );

    await runCustom({ ...minimalQuery, is_brokerage: 'false', account_id: '7' }).expect(201);
    expect(runPortfolioImportPipeline).toHaveBeenLastCalledWith(
      expect.objectContaining({ isBrokerage: false, accountId: 7 }),
    );

    await runCustom({ ...minimalQuery, is_brokerage: true, account_id: 7 }).expect(201);
    expect(runPortfolioImportPipeline).toHaveBeenLastCalledWith(
      expect.objectContaining({ isBrokerage: true, accountId: 7 }),
    );
  });

  it('treats an empty account_id as absent and defaults is_brokerage to false', async () => {
    await runCustom({ ...minimalQuery, account_id: '' }).expect(201);
    expect(runPortfolioImportPipeline).toHaveBeenLastCalledWith(
      expect.objectContaining({ isBrokerage: false, accountId: undefined }),
    );
  });

  // The reject list used to stop at 'abc'/'7.5'/'-1'/'0'. Those are the cases a
  // `Number()` coercion happens to fail; the ones it *passes* were the dangerous
  // half and went untested — '1e3' set up the whole CSV to land on account 1000
  // and '0x10' on account 16, neither of which the uploader named. The intent
  // ("a positive integer") was right; the implementation under it was not.
  it('rejects non-integer account ids and a brokerage import without an account', async () => {
    for (const account_id of ['abc', '7.5', '-1', '0', '1e3', '0x10', '0o17', '+7', ' 7 ', '7.0', '12abc']) {
      const res = await runCustom({ ...minimalQuery, account_id }).expect(400);
      expect(res.body.error.message, `expected ${JSON.stringify(account_id)} to be rejected`)
        .toContain('account_id must be a positive integer');
    }
    for (const account_id of [true, [7], {}]) {
      const res = await runCustom(minimalQuery, { account_id }).expect(400);
      expect(res.body.error.message, `expected ${JSON.stringify(account_id)} to be rejected`)
        .toContain('account_id must be a positive integer');
    }
    const res = await runCustom({ ...minimalQuery, is_brokerage: 'true' }).expect(400);
    expect(res.body.error.message).toMatch(/brokerage import requires account_id/);
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
    }).expect(201);
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
    await runCustom(minimalQuery).expect(201);
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
    await runCustom({ ...minimalQuery, separator: '', type_mapping: 'not-json' }).expect(201);
    expect(runPortfolioImportPipeline).toHaveBeenCalledWith(expect.objectContaining({
      customConfig: expect.objectContaining({ separator: ',', type_mapping: {} }),
    }));
  });

  it('rejects each invalid field with its message', async () => {
    let res = await runCustom({ name_column: 'N', default_asset_class: 'etf' }).expect(400);
    expect(res.body.error.message).toContain('date_column is required');

    res = await runCustom({ date_column: 'D', default_asset_class: 'etf' }).expect(400);
    expect(res.body.error.message).toContain('map at least one of symbol_column or name_column');

    res = await runCustom({ date_column: 'D', name_column: 'N' }).expect(400);
    expect(res.body.error.message).toContain('default_asset_class is required and must be a valid asset class');

    res = await runCustom({ ...minimalQuery, default_asset_class: 'house' }).expect(400);
    expect(res.body.error.message).toContain('default_asset_class is required and must be a valid asset class');

    res = await runCustom({ ...minimalQuery, default_type: 'yolo' }).expect(400);
    expect(res.body.error.message).toContain('default_type "yolo" is not a valid transaction type');

    res = await runCustom({ ...minimalQuery, separator: ';;' }).expect(400);
    expect(res.body.error.message).toContain('separator must be a single character');

    res = await runCustom({ ...minimalQuery, skip_rows: '-1' }).expect(400);
    expect(res.body.error.message).toContain('skip_rows must be zero or a positive integer');

    expect(runPortfolioImportPipeline).not.toHaveBeenCalled();
  });
});

describe('normalizePortfolioParserConfig pins (POST /parsers)', () => {
  const create = (config) => api.post(`${BASE}/parsers`).send({ name: 'P', config });

  it('passes a valid config through UNCHANGED, unknown keys and all', async () => {
    const config = {
      dateColumn: ' Date ', symbolColumn: 'Sym', defaultAssetClass: 'stock',
      memoColumn: 42, separator: ';;', custom_extra: { nested: true },
    };
    await create(config).expect(201);
    expect(customParserConfigRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ config, kind: 'portfolio' }),
    );
  });

  it('rejects missing dateColumn / symbol-or-name / bad asset class', async () => {
    let res = await create({ symbolColumn: 'S', defaultAssetClass: 'stock' }).expect(400);
    expect(res.body.error.message).toContain('config.dateColumn is required');

    res = await create({ dateColumn: 'D', defaultAssetClass: 'stock' }).expect(400);
    expect(res.body.error.message).toContain('config requires symbolColumn or nameColumn');

    res = await create({ dateColumn: 'D', nameColumn: 'N', defaultAssetClass: 'house' }).expect(400);
    expect(res.body.error.message).toContain('config.defaultAssetClass must be a valid asset class');
  });

  it('rejects a non-object or array config', async () => {
    for (const config of [null, 'str', [1]]) {
      const res = await create(config).expect(400);
      expect(res.body.error.message).toContain('Missing or invalid "config"');
    }
  });
});

/**
 * `:id` on the portfolio half of the parser CRUD. The shape matrix lives in
 * parserConfigIdValidation.test.js — this pins that THIS router carries the
 * guard, since the two routers register the shared handlers independently and
 * a regression could reach one and not the other. `DELETE /parsers/22abc` used
 * to answer 204 having deleted parser 22.
 */
describe('parser :id shape (PATCH/DELETE /parsers/:id)', () => {
  it('rejects a malformed id on both operations, repository untouched', async () => {
    customParserConfigRepository.delete.mockResolvedValue(true);
    customParserConfigRepository.update.mockResolvedValue({ id: 22, name: 'X' });

    for (const id of ['22abc', '1e3', '0']) {
      await api.delete(`${BASE}/parsers/${id}`).expect(400);
      await api.patch(`${BASE}/parsers/${id}`).send({ name: 'X' }).expect(400);
    }
    expect(customParserConfigRepository.delete).not.toHaveBeenCalled();
    expect(customParserConfigRepository.update).not.toHaveBeenCalled();
  });

  it('still deletes on a real id', async () => {
    customParserConfigRepository.delete.mockResolvedValue(true);
    await api.delete(`${BASE}/parsers/22`).expect(204);
    expect(customParserConfigRepository.delete).toHaveBeenCalledWith(22);
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

  it('POST /csv/custom emits a numeric batch_id on both the 201 and the 202', async () => {
    runPortfolioImportPipeline.mockImplementation(async () => ({
      requiresReview: false, batchId: await realBatchId(), total: 1, skipped: 0, imported: 1, duplicates: 0, errors: 0,
    }));
    const committed = await runCustom(minimalQuery, {}).expect(201);
    expect(typeof committed.body.data.batch_id).toBe('number');
    expect(committed.body.data.batch_id).toBe(BATCH_ID);

    runPortfolioImportPipeline.mockImplementation(async () => ({
      requiresReview: true, batchId: await realBatchId(), matchSourceCounts: { symbol: 1 },
    }));
    const review = await runCustom(minimalQuery, {}).expect(202);
    expect(typeof review.body.data.batch_id).toBe('number');
    expect(review.body.data.batch_id).toStrictEqual(committed.body.data.batch_id);
  });

  it('POST /batches/:id/commit emits the SAME type and value for the same batch', async () => {
    runPortfolioImportPipeline.mockImplementation(async () => ({
      requiresReview: true, batchId: await realBatchId(), matchSourceCounts: {},
    }));
    const started = await runCustom(minimalQuery, {}).expect(202);

    getBatch.mockResolvedValue({ id: BATCH_ID, status: 'awaiting_review' });
    commitPortfolioImport.mockResolvedValue({ imported: 1, duplicates: 0, errors: 0 });
    const committed = await api.post(`${BASE}/batches/${BATCH_ID}/commit`).send({}).expect(200);

    expect(typeof committed.body.data.batch_id).toBe('number');
    // The whole point of the finding: strict equality across the two responses.
    expect(committed.body.data.batch_id).toStrictEqual(started.body.data.batch_id);
  });
});
