/**
 * Validation-behavior pins for importRoutes.js (ZOD-07).
 *
 * Pins the exact accept/reject/coercion behavior of the request parsing: the
 * Number()-coerced batch-id guard (copy-pasted per route), the multipart CSV
 * option coercion (parseCsvImportOptions), the csv/custom required/trim/default
 * build, and normalizeParserConfig's defaults — so a change cannot alter the wire.
 *
 * Driven over HTTP against the real router (tests/helpers/routeApp.js), which
 * also puts the router's own trailing error middleware
 * (`router.use(csvUploadErrorTranslator)`, routes/importRoutes.js:580) on the
 * tested path — the mock-router harness dropped it entirely.
 *
 * multer is still stubbed to a pass-through (no real multipart parsing); the
 * uploaded file is injected by a `before` middleware, which is the same slot
 * `main.js` uses for per-mount middleware.
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

vi.mock('../../src/services/importPipeline/index.js', () => ({
  runImportPipeline: vi.fn(),
  commitImport: vi.fn(),
}));

vi.mock('../../src/services/dataImportService.js', () => ({
  importRecipientsCSV: vi.fn(),
  importCategoriesCSV: vi.fn(),
}));

vi.mock('../../src/config/logger.js', () => ({
  logger: mockLogger(),
}));

vi.mock('../../src/repositories/importBatchRepository.js', () => ({
  listBatches: vi.fn(),
  getBatch: vi.fn(),
  rollbackBatch: vi.fn(),
  getPreviewRows: vi.fn(),
  overrideRecipient: vi.fn(),
  overrideCategory: vi.fn(),
  categoryExists: vi.fn(),
}));

vi.mock('../../src/services/aggregationRefresh.js', () => ({
  refreshAggregations: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/repositories/customParserConfigRepository.js', () => ({
  default: {
    getAll: vi.fn(), getById: vi.fn(), getByName: vi.fn(),
    create: vi.fn(), update: vi.fn(), delete: vi.fn(),
  },
}));

vi.mock('../../src/database/connection.js', () => mockConnection());

import { runImportPipeline } from '../../src/services/importPipeline/index.js';
import { importRecipientsCSV } from '../../src/services/dataImportService.js';
import { getBatch, overrideRecipient } from '../../src/repositories/importBatchRepository.js';
import customParserConfigRepository from '../../src/repositories/customParserConfigRepository.js';

const { default: importRouter } = await import('../../src/routes/importRoutes.js');

const UPLOAD = { path: '/tmp/pin.csv', originalname: 'pin.csv', size: 10 };

const BASE = '/api/import';
// multer is stubbed, so nothing populates req.file — inject it in the same
// per-mount slot main.js uses (main.js:325 mounts importRateLimiter there).
const api = routeAgent(importRouter, {
  mountPath: BASE,
  before: [(req, _res, next) => { req.file = { ...UPLOAD }; next(); }],
});

/** Encode a path segment so ids with spaces survive the URL round-trip. */
const seg = (v) => encodeURIComponent(String(v));

beforeEach(() => {
  vi.clearAllMocks();
  runImportPipeline.mockResolvedValue({ total: 1, imported: 1, duplicates: 0, errors: 0 });
  importRecipientsCSV.mockResolvedValue({ imported: 1, errors: 0 });
  customParserConfigRepository.create.mockResolvedValue({ id: 1 });
});

describe('batch-id coercion pins (Number() then integer > 0)', () => {
  it("accepts '12.0', ' 12 ' and '0x10' exactly like Number() coercion", async () => {
    getBatch.mockResolvedValue({ id: 12, status: 'complete' });

    await api.get(`${BASE}/batches/${seg('12.0')}`).expect(200);
    expect(getBatch).toHaveBeenLastCalledWith(12);

    await api.get(`${BASE}/batches/${seg(' 12 ')}`).expect(200);
    expect(getBatch).toHaveBeenLastCalledWith(12);

    await api.get(`${BASE}/batches/${seg('0x10')}`).expect(200);
    expect(getBatch).toHaveBeenLastCalledWith(16);
  });

  it('does NOT 400 an absurdly large integral id — it 404s downstream', async () => {
    getBatch.mockResolvedValue(undefined);

    const res = await api.get(`${BASE}/batches/1e300`).expect(404);

    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(getBatch).toHaveBeenCalledWith(1e300);
  });

  it('rejects fractional, trailing-garbage, zero, and negative ids on every site', async () => {
    const badIds = ['12.5', '12abc', '0', '-1', 'abc'];
    const sites = [
      (id) => api.get(`${BASE}/batches/${seg(id)}`),
      (id) => api.delete(`${BASE}/batches/${seg(id)}`),
      (id) => api.get(`${BASE}/batches/${seg(id)}/preview`),
      (id) => api.post(`${BASE}/batches/${seg(id)}/commit`).send({}),
    ];
    for (const site of sites) {
      for (const id of badIds) {
        const res = await site(id).expect(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
    }
    expect(getBatch).not.toHaveBeenCalled();
  });

  it('row-override sites validate both ids and coerce them', async () => {
    overrideRecipient.mockResolvedValue(1);

    await api.post(`${BASE}/batches/5/rows/${seg(' 6 ')}/override`)
      .send({ recipient_id: null })
      .expect(200);
    expect(overrideRecipient).toHaveBeenCalledWith({ batchId: 5, rowId: 6, recipientId: null });

    for (const { id, rowId } of [
      { id: '5', rowId: '0' },
      { id: 'abc', rowId: '6' },
      { id: '5.5', rowId: '6' },
    ]) {
      await api.post(`${BASE}/batches/${seg(id)}/rows/${seg(rowId)}/override`).send({}).expect(400);
      await api.post(`${BASE}/batches/${seg(id)}/rows/${seg(rowId)}/category-override`).send({}).expect(400);
    }
  });
});

describe('parseCsvImportOptions pins (POST /recipients)', () => {
  const run = (query, body = {}) =>
    api.post(`${BASE}/recipients`).query(query).send(body);

  it('defaults separator to "," and encoding to "utf-8"', async () => {
    await run({}).expect(201);
    expect(importRecipientsCSV).toHaveBeenCalledWith('/tmp/pin.csv', { separator: ',', encoding: 'utf-8' });
  });

  it('query wins over body; body is the fallback', async () => {
    await run({ separator: ';' }, { separator: '|' }).expect(201);
    expect(importRecipientsCSV).toHaveBeenLastCalledWith('/tmp/pin.csv', { separator: ';', encoding: 'utf-8' });

    await run({}, { separator: '|', encoding: 'latin1' }).expect(201);
    expect(importRecipientsCSV).toHaveBeenLastCalledWith('/tmp/pin.csv', { separator: '|', encoding: 'latin1' });
  });

  it('stringifies a numeric separator (multipart/JSON tolerance)', async () => {
    await run({}, { separator: 5 }).expect(201);
    expect(importRecipientsCSV).toHaveBeenLastCalledWith('/tmp/pin.csv', { separator: '5', encoding: 'utf-8' });
  });

  it('empty-string separator falls back to the default', async () => {
    await run({ separator: '' }).expect(201);
    expect(importRecipientsCSV).toHaveBeenLastCalledWith('/tmp/pin.csv', { separator: ',', encoding: 'utf-8' });
  });

  it('rejects a multi-character separator', async () => {
    const res = await run({ separator: ';;' }).expect(400);
    expect(res.body.error.message).toMatch(/separator/);
    expect(importRecipientsCSV).not.toHaveBeenCalled();
  });
});

describe('POST /csv/custom config-build pins', () => {
  const run = (query, body = {}) =>
    api.post(`${BASE}/csv/custom`).query(query).send(body);

  const requiredQuery = {
    bank_name: 'Custom', date_format: '%d/%m/%Y',
    date_column: 'Date', recipient_column: 'Desc', amount_column: 'Amount',
  };

  it('trims mapped columns but forwards the RAW bank_name as adapterName', async () => {
    await run({
      bank_name: ' My Bank ', date_format: ' %d/%m/%Y ',
      date_column: ' Date ', recipient_column: ' Desc ', amount_column: ' Amt ',
      memo_column: ' Memo ', separator: ';', encoding: 'latin1', skip_rows: '2.9',
    }).expect(201);
    expect(runImportPipeline).toHaveBeenCalledWith(expect.objectContaining({
      adapterName: ' My Bank ',
      customConfig: {
        bank_name: 'My Bank',
        date_format: '%d/%m/%Y',
        encoding: 'latin1',
        separator: ';',
        skip_rows: 2,
        column_mapping: { date: 'Date', recipient: 'Desc', amount: 'Amt', memo: 'Memo' },
      },
    }));
  });

  it('applies defaults: memo "", separator ",", encoding utf-8, skip_rows 0', async () => {
    await run(requiredQuery).expect(201);
    expect(runImportPipeline).toHaveBeenCalledWith(expect.objectContaining({
      customConfig: expect.objectContaining({
        encoding: 'utf-8', separator: ',', skip_rows: 0,
        column_mapping: expect.objectContaining({ memo: '' }),
      }),
    }));
  });

  it('coerces unparseable skip_rows to 0 and accepts an empty separator as default', async () => {
    await run({ ...requiredQuery, skip_rows: 'abc', separator: '' }).expect(201);
    expect(runImportPipeline).toHaveBeenCalledWith(expect.objectContaining({
      customConfig: expect.objectContaining({ skip_rows: 0, separator: ',' }),
    }));
  });

  it('body fields override query fields', async () => {
    await run(requiredQuery, { amount_column: 'BodyAmt' }).expect(201);
    expect(runImportPipeline).toHaveBeenCalledWith(expect.objectContaining({
      customConfig: expect.objectContaining({
        column_mapping: expect.objectContaining({ amount: 'BodyAmt' }),
      }),
    }));
  });
});

describe('normalizeParserConfig pins (POST /parsers)', () => {
  const create = (config) => api.post(`${BASE}/parsers`).send({ name: 'P', config });

  const base = { dateColumn: 'Date', recipientColumn: 'Name', amountColumn: 'Amount' };

  it('coerces skipRows: numeric strings parse, floats floor, negatives become 0', async () => {
    for (const [input, expected] of [['3', 3], [-5, 0], ['2.9', 2], ['abc', 0]]) {
      await create({ ...base, skipRows: input }).expect(201);
      expect(customParserConfigRepository.create).toHaveBeenLastCalledWith(
        expect.objectContaining({ config: expect.objectContaining({ skipRows: expected }) }),
      );
    }
  });

  it('does NOT enforce a single-char separator here — any non-empty string sticks', async () => {
    await create({ ...base, separator: ';;' }).expect(201);
    expect(customParserConfigRepository.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ config: expect.objectContaining({ separator: ';;' }) }),
    );
  });

  it('strips unknown keys and blanks a non-string memoColumn', async () => {
    await create({ ...base, foo: 'bar', memoColumn: 123 }).expect(201);
    const { config } = customParserConfigRepository.create.mock.calls.at(-1)[0];
    expect('foo' in config).toBe(false);
    expect(config.memoColumn).toBe('');
    expect(Object.keys(config).sort()).toEqual([
      'amountColumn', 'dateColumn', 'dateFormat', 'encoding',
      'memoColumn', 'recipientColumn', 'separator', 'skipRows',
    ]);
  });

  it('rejects missing required columns with the per-key message', async () => {
    const res1 = await create({ dateColumn: 'Date', amountColumn: 'A' }).expect(400);
    expect(res1.body.error.message).toContain('config.recipientColumn is required');

    const res2 = await create({ ...base, dateColumn: '  ' }).expect(400);
    expect(res2.body.error.message).toContain('config.dateColumn is required');
  });

  it('rejects a non-object or array config', async () => {
    for (const config of [null, 'str', [1]]) {
      const res = await create(config).expect(400);
      expect(res.body.error.message).toContain('Missing or invalid "config"');
    }
  });
});
