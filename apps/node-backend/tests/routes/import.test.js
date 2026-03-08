/**
 * Import route tests.
 * Mirrors: apps/backend/tests/test_import.py
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const routeHandlers = {};
const mockRouter = {
  get: vi.fn((path, ...args) => { routeHandlers[`get:${path}`] = args[args.length - 1]; }),
  post: vi.fn((path, ...args) => { routeHandlers[`post:${path}`] = args[args.length - 1]; }),
  use: vi.fn(),
};

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

vi.mock('fs', () => ({
  default: { existsSync: vi.fn(() => false), unlinkSync: vi.fn() },
  existsSync: vi.fn(() => false),
  unlinkSync: vi.fn(),
}));

vi.mock('os', () => ({
  default: { tmpdir: vi.fn(() => '/tmp') },
  tmpdir: vi.fn(() => '/tmp'),
}));

vi.mock('path', () => ({
  default: { join: vi.fn((...args) => args.join('/')) },
}));

vi.mock('../../src/services/importService.js', () => ({
  importCSV: vi.fn(),
}));

vi.mock('../../src/services/rawTransactionImportService.js', () => ({
  importCSVWithRawStorage: vi.fn(),
}));

vi.mock('../../src/services/bankAdapters.js', () => ({
  getSupportedBanks: vi.fn(() => ['belfius', 'kbc', 'revolut']),
}));

vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { importCSVWithRawStorage } from '../../src/services/rawTransactionImportService.js';
import { getSupportedBanks } from '../../src/services/bankAdapters.js';
await import('../../src/routes/importRoutes.js');

describe('Import Routes', () => {
  beforeEach(() => vi.clearAllMocks());

  // ──────────────────────────────────────────
  // POST /api/import/csv
  // ──────────────────────────────────────────
  describe('POST /csv', () => {
    it('should return 400 when no file uploaded', async () => {
      const req = { file: null, query: { bank_name: 'belfius' }, body: {} };
      const res = mockResponse();
      await routeHandlers['post:/csv'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json.mock.calls[0][0].detail).toContain('No file uploaded');
    });

    it('should return 400 when bank_name missing', async () => {
      const req = { file: { path: '/tmp/test.csv', originalname: 'test.csv' }, query: {}, body: {} };
      const res = mockResponse();
      await routeHandlers['post:/csv'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json.mock.calls[0][0].detail).toContain('bank_name');
    });

    it('should return 201 on successful import', async () => {
      importCSVWithRawStorage.mockResolvedValue({
        total_processed: 5, imported: 4, duplicates: 1, errors: 0, status: 'completed',
      });

      const req = {
        file: { path: '/tmp/test.csv', originalname: 'test.csv' },
        query: { bank_name: 'belfius' },
        body: {},
      };
      const res = mockResponse();
      await routeHandlers['post:/csv'](req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      const data = res.json.mock.calls[0][0];
      expect(data.total_processed).toBe(5);
      expect(data.imported).toBe(4);
      expect(data.duplicates).toBe(1);
      expect(data.errors).toBe(0);
      expect(data.status).toBe('completed');
    });

    it('should return completed_with_errors status', async () => {
      importCSVWithRawStorage.mockResolvedValue({
        total_processed: 10, imported: 8, duplicates: 1, errors: 1,
      });

      const req = {
        file: { path: '/tmp/test.csv', originalname: 'test.csv' },
        query: { bank_name: 'kbc' },
        body: {},
      };
      const res = mockResponse();
      await routeHandlers['post:/csv'](req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      const data = res.json.mock.calls[0][0];
      expect(data.status).toBe('completed_with_errors');
    });

    it('should return 400 for invalid bank config', async () => {
      importCSVWithRawStorage.mockRejectedValue(new Error('No configuration found for bank'));

      const req = {
        file: { path: '/tmp/test.csv', originalname: 'test.csv' },
        query: { bank_name: 'UnknownBank' },
        body: {},
      };
      const res = mockResponse();
      await routeHandlers['post:/csv'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should return 500 on general import failure', async () => {
      importCSVWithRawStorage.mockRejectedValue(new Error('Parse error'));

      const req = {
        file: { path: '/tmp/test.csv', originalname: 'test.csv' },
        query: { bank_name: 'belfius' },
        body: {},
      };
      const res = mockResponse();
      await routeHandlers['post:/csv'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json.mock.calls[0][0].detail).toContain('Import failed');
    });
  });

  // ──────────────────────────────────────────
  // POST /api/import/csv/custom
  // ──────────────────────────────────────────
  describe('POST /csv/custom', () => {
    it('should return 400 when no file uploaded', async () => {
      const req = { file: null, query: {}, body: {} };
      const res = mockResponse();
      await routeHandlers['post:/csv/custom'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should return 400 for missing required params', async () => {
      const req = {
        file: { path: '/tmp/custom.csv', originalname: 'custom.csv' },
        query: { bank_name: 'Custom' },
        body: {},
      };
      const res = mockResponse();
      await routeHandlers['post:/csv/custom'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json.mock.calls[0][0].detail).toContain('Missing required parameters');
    });

    it('should return 400 for invalid separator', async () => {
      const req = {
        file: { path: '/tmp/custom.csv', originalname: 'custom.csv' },
        query: {
          bank_name: 'Custom', date_format: '%d/%m/%Y',
          date_column: 'Date', recipient_column: 'Desc',
          amount_column: 'Amount', separator: ';;',
        },
        body: {},
      };
      const res = mockResponse();
      await routeHandlers['post:/csv/custom'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json.mock.calls[0][0].detail).toContain('separator');
    });

    it('should return 201 on success', async () => {
      importCSVWithRawStorage.mockResolvedValue({
        total_processed: 1, imported: 1, duplicates: 0, errors: 0, status: 'completed',
      });

      const req = {
        file: { path: '/tmp/custom.csv', originalname: 'custom.csv' },
        query: {
          bank_name: 'Custom', date_format: '%d/%m/%Y',
          date_column: 'Date', recipient_column: 'Desc', amount_column: 'Amount',
        },
        body: {},
      };
      const res = mockResponse();
      await routeHandlers['post:/csv/custom'](req, res);

      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('should return 500 on error', async () => {
      importCSVWithRawStorage.mockRejectedValue(new Error('Import failed'));

      const req = {
        file: { path: '/tmp/custom.csv', originalname: 'custom.csv' },
        query: {
          bank_name: 'Custom', date_format: '%d/%m/%Y',
          date_column: 'Date', recipient_column: 'Desc', amount_column: 'Amount',
        },
        body: {},
      };
      const res = mockResponse();
      await routeHandlers['post:/csv/custom'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // ──────────────────────────────────────────
  // GET /api/import/supported-banks
  // ──────────────────────────────────────────
  describe('GET /supported-banks', () => {
    it('should return supported banks', async () => {
      const req = {};
      const res = mockResponse();
      await routeHandlers['get:/supported-banks'](req, res);

      const data = res.json.mock.calls[0][0];
      expect(data.banks).toBeDefined();
      expect(data.total).toBe(3);
      expect(data.banks).toContain('Belfius');
      expect(data.banks).toContain('Kbc');
      expect(data.banks).toContain('Revolut');
    });
  });
});

function mockResponse() {
  const res = { json: vi.fn(), status: vi.fn(), send: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}
