/**
 * Validation-behavior pins for importRoutes.js (ZOD-07).
 *
 * Pins the exact accept/reject/coercion behavior of the hand-rolled request
 * parsing BEFORE the zod migration: the Number()-coerced batch-id guard
 * (copy-pasted per route), the multipart CSV option coercion
 * (parseCsvImportOptions), the csv/custom required/trim/default build, and
 * normalizeParserConfig's defaults — so the swap cannot change the wire.
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
import { ValidationError, NotFoundError } from '../../src/middleware/errorHandler.js';
await import('../../src/routes/importRoutes.js');

const mockResponse = () => createMockResponse();
const file = () => ({ path: '/tmp/pin.csv', originalname: 'pin.csv', size: 10 });

beforeEach(() => {
  vi.clearAllMocks();
  runImportPipeline.mockResolvedValue({ total: 1, imported: 1, duplicates: 0, errors: 0 });
  importRecipientsCSV.mockResolvedValue({ imported: 1, errors: 0 });
  customParserConfigRepository.create.mockResolvedValue({ id: 1 });
});

describe('batch-id coercion pins (Number() then integer > 0)', () => {
  it("accepts '12.0', ' 12 ' and '0x10' exactly like Number() coercion", async () => {
    getBatch.mockResolvedValue({ id: 12, status: 'complete' });

    await routeHandlers['get:/batches/:id']({ params: { id: '12.0' } }, mockResponse());
    expect(getBatch).toHaveBeenLastCalledWith(12);

    await routeHandlers['get:/batches/:id']({ params: { id: ' 12 ' } }, mockResponse());
    expect(getBatch).toHaveBeenLastCalledWith(12);

    await routeHandlers['get:/batches/:id']({ params: { id: '0x10' } }, mockResponse());
    expect(getBatch).toHaveBeenLastCalledWith(16);
  });

  it('does NOT 400 an absurdly large integral id — it 404s downstream', async () => {
    getBatch.mockResolvedValue(undefined);
    await expect(routeHandlers['get:/batches/:id']({ params: { id: '1e300' } }, mockResponse()))
      .rejects.toBeInstanceOf(NotFoundError);
    expect(getBatch).toHaveBeenCalledWith(1e300);
  });

  it('rejects fractional, trailing-garbage, zero, and negative ids on every site', async () => {
    const badIds = ['12.5', '12abc', '0', '-1', 'abc'];
    const sites = ['get:/batches/:id', 'delete:/batches/:id', 'get:/batches/:id/preview', 'post:/batches/:id/commit'];
    for (const site of sites) {
      for (const id of badIds) {
        await expect(routeHandlers[site]({ params: { id }, body: {} }, mockResponse()))
          .rejects.toBeInstanceOf(ValidationError);
      }
    }
    expect(getBatch).not.toHaveBeenCalled();
  });

  it('row-override sites validate both ids and coerce them', async () => {
    overrideRecipient.mockResolvedValue(1);
    await routeHandlers['post:/batches/:id/rows/:rowId/override'](
      { params: { id: '5', rowId: ' 6 ' }, body: { recipient_id: null } },
      mockResponse(),
    );
    expect(overrideRecipient).toHaveBeenCalledWith({ batchId: 5, rowId: 6, recipientId: null });

    for (const params of [{ id: '5', rowId: '0' }, { id: 'abc', rowId: '6' }, { id: '5.5', rowId: '6' }]) {
      await expect(
        routeHandlers['post:/batches/:id/rows/:rowId/override']({ params, body: {} }, mockResponse()),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        routeHandlers['post:/batches/:id/rows/:rowId/category-override']({ params, body: {} }, mockResponse()),
      ).rejects.toBeInstanceOf(ValidationError);
    }
  });
});

describe('parseCsvImportOptions pins (POST /recipients)', () => {
  const run = (query, body = {}) =>
    routeHandlers['post:/recipients']({ file: file(), query, body }, mockResponse());

  it('defaults separator to "," and encoding to "utf-8"', async () => {
    await run({});
    expect(importRecipientsCSV).toHaveBeenCalledWith('/tmp/pin.csv', { separator: ',', encoding: 'utf-8' });
  });

  it('query wins over body; body is the fallback', async () => {
    await run({ separator: ';' }, { separator: '|' });
    expect(importRecipientsCSV).toHaveBeenLastCalledWith('/tmp/pin.csv', { separator: ';', encoding: 'utf-8' });

    await run({}, { separator: '|', encoding: 'latin1' });
    expect(importRecipientsCSV).toHaveBeenLastCalledWith('/tmp/pin.csv', { separator: '|', encoding: 'latin1' });
  });

  it('stringifies a numeric separator (multipart/JSON tolerance)', async () => {
    await run({}, { separator: 5 });
    expect(importRecipientsCSV).toHaveBeenLastCalledWith('/tmp/pin.csv', { separator: '5', encoding: 'utf-8' });
  });

  it('empty-string separator falls back to the default', async () => {
    await run({ separator: '' });
    expect(importRecipientsCSV).toHaveBeenLastCalledWith('/tmp/pin.csv', { separator: ',', encoding: 'utf-8' });
  });

  it('rejects a multi-character separator', async () => {
    await expect(run({ separator: ';;' })).rejects.toThrow(/separator/);
    expect(importRecipientsCSV).not.toHaveBeenCalled();
  });
});

describe('POST /csv/custom config-build pins', () => {
  const run = (query, body = {}) =>
    routeHandlers['post:/csv/custom']({ file: file(), query, body }, mockResponse());

  const requiredQuery = {
    bank_name: 'Custom', date_format: '%d/%m/%Y',
    date_column: 'Date', recipient_column: 'Desc', amount_column: 'Amount',
  };

  it('trims mapped columns but forwards the RAW bank_name as adapterName', async () => {
    await run({
      bank_name: ' My Bank ', date_format: ' %d/%m/%Y ',
      date_column: ' Date ', recipient_column: ' Desc ', amount_column: ' Amt ',
      memo_column: ' Memo ', separator: ';', encoding: 'latin1', skip_rows: '2.9',
    });
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
    await run(requiredQuery);
    expect(runImportPipeline).toHaveBeenCalledWith(expect.objectContaining({
      customConfig: expect.objectContaining({
        encoding: 'utf-8', separator: ',', skip_rows: 0,
        column_mapping: expect.objectContaining({ memo: '' }),
      }),
    }));
  });

  it('coerces unparseable skip_rows to 0 and accepts an empty separator as default', async () => {
    await run({ ...requiredQuery, skip_rows: 'abc', separator: '' });
    expect(runImportPipeline).toHaveBeenCalledWith(expect.objectContaining({
      customConfig: expect.objectContaining({ skip_rows: 0, separator: ',' }),
    }));
  });

  it('body fields override query fields', async () => {
    await run(requiredQuery, { amount_column: 'BodyAmt' });
    expect(runImportPipeline).toHaveBeenCalledWith(expect.objectContaining({
      customConfig: expect.objectContaining({
        column_mapping: expect.objectContaining({ amount: 'BodyAmt' }),
      }),
    }));
  });
});

describe('normalizeParserConfig pins (POST /parsers)', () => {
  const create = (config) =>
    routeHandlers['post:/parsers']({ body: { name: 'P', config } }, mockResponse());

  const base = { dateColumn: 'Date', recipientColumn: 'Name', amountColumn: 'Amount' };

  it('coerces skipRows: numeric strings parse, floats floor, negatives become 0', async () => {
    for (const [input, expected] of [['3', 3], [-5, 0], ['2.9', 2], ['abc', 0]]) {
      await create({ ...base, skipRows: input });
      expect(customParserConfigRepository.create).toHaveBeenLastCalledWith(
        expect.objectContaining({ config: expect.objectContaining({ skipRows: expected }) }),
      );
    }
  });

  it('does NOT enforce a single-char separator here — any non-empty string sticks', async () => {
    await create({ ...base, separator: ';;' });
    expect(customParserConfigRepository.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ config: expect.objectContaining({ separator: ';;' }) }),
    );
  });

  it('strips unknown keys and blanks a non-string memoColumn', async () => {
    await create({ ...base, foo: 'bar', memoColumn: 123 });
    const { config } = customParserConfigRepository.create.mock.calls.at(-1)[0];
    expect('foo' in config).toBe(false);
    expect(config.memoColumn).toBe('');
    expect(Object.keys(config).sort()).toEqual([
      'amountColumn', 'dateColumn', 'dateFormat', 'encoding',
      'memoColumn', 'recipientColumn', 'separator', 'skipRows',
    ]);
  });

  it('rejects missing required columns with the per-key message', async () => {
    await expect(create({ dateColumn: 'Date', amountColumn: 'A' }))
      .rejects.toThrow('config.recipientColumn is required');
    await expect(create({ ...base, dateColumn: '  ' }))
      .rejects.toThrow('config.dateColumn is required');
  });

  it('rejects a non-object or array config', async () => {
    for (const config of [null, 'str', [1]]) {
      await expect(create(config)).rejects.toThrow('Missing or invalid "config"');
    }
  });
});
