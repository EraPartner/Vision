/**
 * Investment route tests.
 * Tests all CRUD endpoints for investments and portfolio transactions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const routeHandlers = {};
const mockRouter = {
  get: vi.fn((path, ...args) => { routeHandlers[`get:${path}`] = args[args.length - 1]; }),
  post: vi.fn((path, ...args) => { routeHandlers[`post:${path}`] = args[args.length - 1]; }),
  patch: vi.fn((path, ...args) => { routeHandlers[`patch:${path}`] = args[args.length - 1]; }),
  delete: vi.fn((path, ...args) => { routeHandlers[`delete:${path}`] = args[args.length - 1]; }),
  use: vi.fn(),
};

vi.mock('express', () => ({
  default: { Router: () => mockRouter },
  Router: () => mockRouter,
}));

vi.mock('../../src/repositories/investmentRepository.js', () => ({
  default: {
    getAll: vi.fn(),
    getAllWithCount: vi.fn(),
    getCount: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updatePrice: vi.fn(),
    hardDelete: vi.fn(),
  },
}));

vi.mock('../../src/repositories/portfolioTransactionRepository.js', () => ({
  default: {
    getAll: vi.fn(),
    getAllByInvestmentIds: vi.fn(),
    getAllWithCount: vi.fn(),
    getCount: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    hardDelete: vi.fn(),
    getSummary: vi.fn(),
  },
}));

vi.mock('../../src/services/priceProviderService.js', () => ({
  fetchLivePricesDetailed: vi.fn(),
  fetchHistoricalPrices: vi.fn(),
  SUPPORTED_PROVIDERS: [
    { key: 'manual', name: 'Manual' },
    { key: 'binance', name: 'Binance' },
    { key: 'yahoo', name: 'Yahoo Finance' },
    { key: 'custom', name: 'Custom JSON' },
    { key: 'kinesis', name: 'Kinesis' },
  ],
}));

vi.mock('../../src/config/kinesisConfig.js', () => ({
  getKinesisAssetConfig: vi.fn((assetName) => {
    if (assetName === 'kaufen_gold') {
      return {
        symbol: 'KAU_USD',
        timeframe: 'daily',
        fromDate: '2020-01-01',
      };
    }
    return undefined;
  }),
}));

vi.mock('../../src/middleware/validation.js', () => ({
  validateIdParam: (req, res, next) => next(),
}));

vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import investmentRepository from '../../src/repositories/investmentRepository.js';
import portfolioTransactionRepository from '../../src/repositories/portfolioTransactionRepository.js';
import { fetchHistoricalPrices, fetchLivePricesDetailed } from '../../src/services/priceProviderService.js';
await import('../../src/routes/investments.js');

let nowSpy;

function mockResponse() {
  const res = { json: vi.fn(), status: vi.fn(), send: vi.fn(), end: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}

describe('Investment Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
  });

  afterEach(() => {
    nowSpy?.mockRestore();
  });

  describe('GET /transactions', () => {
    it('should cache and differentiate entries by limit parameter', async () => {
      const reqLimit10 = {
        query: {
          investment_ids: '1,2',
          per_investment_limit: '1000',
          limit: '10',
          offset: '0',
        },
      };
      const reqLimit20 = {
        query: {
          investment_ids: '1,2',
          per_investment_limit: '1000',
          limit: '20',
          offset: '0',
        },
      };

      const repoResultA = [{ id: 101, amount: 1 }];
      const repoResultB = [{ id: 202, amount: 2 }];

      portfolioTransactionRepository.getAllByInvestmentIds
        .mockResolvedValueOnce(repoResultA)
        .mockResolvedValueOnce(repoResultB);
      portfolioTransactionRepository.getCount.mockResolvedValue(2);

      const resA1 = mockResponse();
      await routeHandlers['get:/transactions'](reqLimit10, resA1);
      expect(resA1.json).toHaveBeenCalledWith(expect.objectContaining({ items: repoResultA, limit: 10 }));

      const resA2 = mockResponse();
      await routeHandlers['get:/transactions'](reqLimit10, resA2);
      expect(resA2.json).toHaveBeenCalledWith(expect.objectContaining({ items: repoResultA, limit: 10 }));

      const resB = mockResponse();
      await routeHandlers['get:/transactions'](reqLimit20, resB);
      expect(resB.json).toHaveBeenCalledWith(expect.objectContaining({ items: repoResultB, limit: 20 }));

      expect(portfolioTransactionRepository.getAllByInvestmentIds).toHaveBeenCalledTimes(2);
      expect(portfolioTransactionRepository.getAllByInvestmentIds).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ limit: 10 })
      );
      expect(portfolioTransactionRepository.getAllByInvestmentIds).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ limit: 20 })
      );
    });
  });

  // ── GET /api/investments ───────────────────────────────────
  describe('GET /', () => {
    it('should return investments list', async () => {
      investmentRepository.getAllWithCount.mockResolvedValue({
        rows: [{ id: 1, name: 'Bitcoin', asset_class: 'crypto' }],
        total: 1,
      });

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      const data = res.json.mock.calls[0][0];
      expect(data.items).toHaveLength(1);
      expect(data.total).toBe(1);
    });

    it('should return empty list', async () => {
      investmentRepository.getAllWithCount.mockResolvedValue({ rows: [], total: 0 });

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      expect(res.json.mock.calls[0][0].items).toEqual([]);
    });

    it('should respect pagination and filters', async () => {
      investmentRepository.getAllWithCount.mockResolvedValue({ rows: [], total: 0 });

      const req = { query: { limit: '10', offset: '5', asset_class: 'crypto', active: 'true' } };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      expect(investmentRepository.getAllWithCount).toHaveBeenCalledWith(expect.objectContaining({
        limit: 10, offset: 5, assetClass: 'crypto', active: true,
      }));
    });

    it('should handle errors with 500', async () => {
      investmentRepository.getAllWithCount.mockRejectedValue(new Error('DB error'));

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // ── POST /api/investments ──────────────────────────────────
  describe('POST /', () => {
    it('should create investment with 201', async () => {
      investmentRepository.create.mockResolvedValue({ id: 1, name: 'Bitcoin', asset_class: 'crypto' });

      const req = { body: { name: 'Bitcoin', asset_class: 'crypto', currency: 'EUR' } };
      const res = mockResponse();
      await routeHandlers['post:/'](req, res);

      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('should return 400 for missing required fields', async () => {
      const req = { body: { name: 'Bitcoin' } };
      const res = mockResponse();
      await routeHandlers['post:/'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should return 400 for missing name', async () => {
      const req = { body: { asset_class: 'crypto' } };
      const res = mockResponse();
      await routeHandlers['post:/'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should handle errors with 500', async () => {
      investmentRepository.create.mockRejectedValue(new Error('DB error'));

      const req = { body: { name: 'Bitcoin', asset_class: 'crypto' } };
      const res = mockResponse();
      await routeHandlers['post:/'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // ── GET /api/investments/providers ─────────────────────────
  describe('GET /providers', () => {
    it('should return supported providers', async () => {
      const req = {};
      const res = mockResponse();
      await routeHandlers['get:/providers'](req, res);

      const data = res.json.mock.calls[0][0];
      expect(data.providers).toBeDefined();
      expect(data.providers.length).toBeGreaterThan(0);
    });
  });

  // ── POST /api/investments/refresh-prices ───────────────────
  describe('POST /refresh-prices', () => {
    it('should refresh prices for investments with providers', async () => {
      investmentRepository.getAll.mockResolvedValue([
        { id: 1, price_provider: 'binance', price_provider_id: 'BTCUSDT' },
      ]);
      fetchLivePricesDetailed.mockResolvedValue({ 1: { price: 50000, source: 'live' } });
      investmentRepository.updatePrice.mockResolvedValue({});

      const req = { body: {} };
      const res = mockResponse();
      await routeHandlers['post:/refresh-prices'](req, res);

      const data = res.json.mock.calls[0][0];
      expect(data.updated).toBe(1);
      expect(data.priceSources).toEqual({ 1: 'live' });
      expect(investmentRepository.updatePrice).toHaveBeenCalledTimes(1);
    });

    it('should include cached source and skip DB update for cached fallback', async () => {
      investmentRepository.getAll.mockResolvedValue([
        { id: 1, current_price: 123.45, price_provider: 'yahoo', price_provider_id: 'AAPL' },
      ]);
      fetchLivePricesDetailed.mockResolvedValue({ 1: { price: 123.45, source: 'cached' } });

      const req = { body: {} };
      const res = mockResponse();
      await routeHandlers['post:/refresh-prices'](req, res);

      const data = res.json.mock.calls[0][0];
      expect(data.updated).toBe(0);
      expect(data.prices).toEqual({ 1: 123.45 });
      expect(data.priceSources).toEqual({ 1: 'cached' });
      expect(investmentRepository.updatePrice).not.toHaveBeenCalled();
    });

    it('should refresh yahoo investments when only symbol is configured', async () => {
      investmentRepository.getAll.mockResolvedValue([
        { id: 1, symbol: 'AAPL', price_provider: 'yahoo', price_provider_id: null },
      ]);
      fetchLivePricesDetailed.mockResolvedValue({ 1: { price: 188.4, source: 'live' } });
      investmentRepository.updatePrice.mockResolvedValue({});

      const req = { body: {} };
      const res = mockResponse();
      await routeHandlers['post:/refresh-prices'](req, res);

      const data = res.json.mock.calls[0][0];
      expect(data.total).toBe(1);
      expect(data.updated).toBe(1);
      expect(investmentRepository.updatePrice).toHaveBeenCalledTimes(1);
    });

    it('should refresh kinesis investments when configured by mapped asset name', async () => {
      investmentRepository.getAll.mockResolvedValue([
        { id: 1, name: 'kaufen_gold', price_provider: 'kinesis', price_provider_id: null },
      ]);
      fetchLivePricesDetailed.mockResolvedValue({ 1: { price: 101.25, source: 'live' } });
      investmentRepository.updatePrice.mockResolvedValue({});

      const req = { body: {} };
      const res = mockResponse();
      await routeHandlers['post:/refresh-prices'](req, res);

      const data = res.json.mock.calls[0][0];
      expect(data.total).toBe(1);
      expect(data.updated).toBe(1);
      expect(data.prices).toEqual({ 1: 101.25 });
      expect(data.priceSources).toEqual({ 1: 'live' });
      expect(investmentRepository.updatePrice).toHaveBeenCalledTimes(1);
    });

    it('should return 0 updated when no providers configured', async () => {
      investmentRepository.getAll.mockResolvedValue([
        { id: 1, price_provider: 'manual', price_provider_id: null },
      ]);

      const req = { body: {} };
      const res = mockResponse();
      await routeHandlers['post:/refresh-prices'](req, res);

      expect(res.json.mock.calls[0][0].updated).toBe(0);
    });

    it('should handle errors with 500', async () => {
      investmentRepository.getAll.mockRejectedValue(new Error('DB error'));

      const req = { body: {} };
      const res = mockResponse();
      await routeHandlers['post:/refresh-prices'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // ── GET /api/investments/:id ───────────────────────────────
  describe('GET /:id/price-history', () => {
    it('should return custom provider history', async () => {
      investmentRepository.getById.mockResolvedValue({ id: 12, price_provider: 'custom' });
      fetchHistoricalPrices.mockResolvedValue([
        { timestampMs: 1700000000000, price: 700 },
      ]);

      const req = { params: { id: '12' }, query: { from_ms: '1699999999999', to_ms: '1700000000001' } };
      const res = mockResponse();
      await routeHandlers['get:/:id/price-history'](req, res);

      expect(fetchHistoricalPrices).toHaveBeenCalledWith(
        { id: 12, price_provider: 'custom' },
        { fromMs: 1699999999999, toMs: 1700000000001, dbOnly: false }
      );
      expect(res.json).toHaveBeenCalledWith({
        investment_id: 12,
        provider: 'custom',
        points: [{ timestampMs: 1700000000000, price: 700 }],
      });
    });
  });

  // ── GET /api/investments/:id ───────────────────────────────
  describe('GET /:id', () => {
    it('should return investment by id', async () => {
      investmentRepository.getById.mockResolvedValue({ id: 1, name: 'Bitcoin' });

      const req = { params: { id: '1' } };
      const res = mockResponse();
      await routeHandlers['get:/:id'](req, res);

      expect(res.json.mock.calls[0][0].name).toBe('Bitcoin');
    });

    it('should return 404 for non-existent', async () => {
      investmentRepository.getById.mockResolvedValue(null);

      const req = { params: { id: '999' } };
      const res = mockResponse();
      await routeHandlers['get:/:id'](req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should handle errors with 500', async () => {
      investmentRepository.getById.mockRejectedValue(new Error('DB error'));

      const req = { params: { id: '1' } };
      const res = mockResponse();
      await routeHandlers['get:/:id'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // ── PATCH /api/investments/:id ─────────────────────────────
  describe('PATCH /:id', () => {
    it('should update investment', async () => {
      investmentRepository.update.mockResolvedValue({ id: 1, name: 'Updated' });

      const req = { params: { id: '1' }, body: { name: 'Updated' } };
      const res = mockResponse();
      await routeHandlers['patch:/:id'](req, res);

      expect(res.json.mock.calls[0][0].name).toBe('Updated');
    });

    it('should return 404 for non-existent', async () => {
      investmentRepository.update.mockResolvedValue(null);

      const req = { params: { id: '999' }, body: { name: 'Updated' } };
      const res = mockResponse();
      await routeHandlers['patch:/:id'](req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should handle errors with 500', async () => {
      investmentRepository.update.mockRejectedValue(new Error('DB error'));

      const req = { params: { id: '1' }, body: { name: 'Updated' } };
      const res = mockResponse();
      await routeHandlers['patch:/:id'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('should return 400 for validation errors', async () => {
      const err = new Error('symbol must be unique');
      err.code = 'VALIDATION_ERROR';
      investmentRepository.update.mockRejectedValue(err);

      const req = { params: { id: '1' }, body: { symbol: 'AAPL' } };
      const res = mockResponse();
      await routeHandlers['patch:/:id'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  // ── DELETE /api/investments/:id ────────────────────────────
  describe('DELETE /:id', () => {
    it('should delete and return 204', async () => {
      investmentRepository.hardDelete.mockResolvedValue(true);

      const req = { params: { id: '1' } };
      const res = mockResponse();
      await routeHandlers['delete:/:id'](req, res);

      expect(res.status).toHaveBeenCalledWith(204);
    });

    it('should return 404 for non-existent', async () => {
      investmentRepository.hardDelete.mockResolvedValue(false);

      const req = { params: { id: '999' } };
      const res = mockResponse();
      await routeHandlers['delete:/:id'](req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should handle errors with 500', async () => {
      investmentRepository.hardDelete.mockRejectedValue(new Error('DB error'));

      const req = { params: { id: '1' } };
      const res = mockResponse();
      await routeHandlers['delete:/:id'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // ── GET /api/investments/:id/transactions ──────────────────
  describe('GET /:id/transactions', () => {
    it('should return portfolio transactions', async () => {
      portfolioTransactionRepository.getAllWithCount.mockResolvedValue({
        rows: [{ id: 1, type: 'buy', amount: 1000 }],
        total: 1,
      });

      const req = { params: { id: '1' }, query: {} };
      const res = mockResponse();
      await routeHandlers['get:/:id/transactions'](req, res);

      const data = res.json.mock.calls[0][0];
      expect(data.items).toHaveLength(1);
      expect(data.total).toBe(1);
    });

    it('should filter by type', async () => {
      portfolioTransactionRepository.getAllWithCount.mockResolvedValue({ rows: [], total: 0 });

      const req = { params: { id: '1' }, query: { type: 'buy' } };
      const res = mockResponse();
      await routeHandlers['get:/:id/transactions'](req, res);

      expect(portfolioTransactionRepository.getAllWithCount).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'buy' })
      );
    });

    it('should handle errors with 500', async () => {
      portfolioTransactionRepository.getAllWithCount.mockRejectedValue(new Error('DB error'));

      const req = { params: { id: '1' }, query: {} };
      const res = mockResponse();
      await routeHandlers['get:/:id/transactions'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // ── POST /api/investments/:id/transactions ─────────────────
  describe('POST /:id/transactions', () => {
    it('should create portfolio transaction with 201', async () => {
      investmentRepository.getById.mockResolvedValue({ id: 1, currency: 'EUR' });
      portfolioTransactionRepository.create.mockResolvedValue({
        id: 1, type: 'buy', amount: 1000,
      });

      const req = { params: { id: '1' }, body: { type: 'buy', date: '2026-01-15', amount: 1000 } };
      const res = mockResponse();
      await routeHandlers['post:/:id/transactions'](req, res);

      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('should pass fx_rate_to_eur to repository create', async () => {
      investmentRepository.getById.mockResolvedValue({ id: 1, currency: 'USD' });
      portfolioTransactionRepository.create.mockResolvedValue({ id: 1, type: 'buy', amount: 1000, fx_rate_to_eur: 0.92 });

      const req = {
        params: { id: '1' },
        body: { type: 'buy', date: '2026-01-15', amount: 1000, fx_rate_to_eur: 0.92 },
      };
      const res = mockResponse();
      await routeHandlers['post:/:id/transactions'](req, res);

      expect(portfolioTransactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          investment_id: 1,
          fx_rate_to_eur: 0.92,
        })
      );
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('should return 404 if investment not found', async () => {
      investmentRepository.getById.mockResolvedValue(null);

      const req = { params: { id: '999' }, body: { type: 'buy', date: '2026-01-15', amount: 1000 } };
      const res = mockResponse();
      await routeHandlers['post:/:id/transactions'](req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should return 400 for missing required fields', async () => {
      investmentRepository.getById.mockResolvedValue({ id: 1, currency: 'EUR' });

      const req = { params: { id: '1' }, body: { type: 'buy' } };
      const res = mockResponse();
      await routeHandlers['post:/:id/transactions'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should return 400 when repository raises validation error', async () => {
      investmentRepository.getById.mockResolvedValue({ id: 1, currency: 'EUR' });
      const err = new Error('For buy/sell transactions, provide at least two of amount, units, and price_per_unit');
      err.code = 'VALIDATION_ERROR';
      portfolioTransactionRepository.create.mockRejectedValue(err);

      const req = { params: { id: '1' }, body: { type: 'buy', date: '2026-01-15' } };
      const res = mockResponse();
      await routeHandlers['post:/:id/transactions'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should handle errors with 500', async () => {
      investmentRepository.getById.mockResolvedValue({ id: 1, currency: 'EUR' });
      portfolioTransactionRepository.create.mockRejectedValue(new Error('DB error'));

      const req = { params: { id: '1' }, body: { type: 'buy', date: '2026-01-15', amount: 1000 } };
      const res = mockResponse();
      await routeHandlers['post:/:id/transactions'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // ── DELETE /api/investments/transactions/:txnId ────────────
  describe('DELETE /transactions/:txnId', () => {
    it('should delete portfolio transaction with 204', async () => {
      portfolioTransactionRepository.hardDelete.mockResolvedValue(true);

      const req = { params: { txnId: '1' } };
      const res = mockResponse();
      await routeHandlers['delete:/transactions/:txnId'](req, res);

      expect(res.status).toHaveBeenCalledWith(204);
    });

    it('should return 404 for non-existent', async () => {
      portfolioTransactionRepository.hardDelete.mockResolvedValue(false);

      const req = { params: { txnId: '999' } };
      const res = mockResponse();
      await routeHandlers['delete:/transactions/:txnId'](req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should return 400 for invalid ID', async () => {
      const req = { params: { txnId: 'abc' } };
      const res = mockResponse();
      await routeHandlers['delete:/transactions/:txnId'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should handle errors with 500', async () => {
      portfolioTransactionRepository.hardDelete.mockRejectedValue(new Error('DB error'));

      const req = { params: { txnId: '1' } };
      const res = mockResponse();
      await routeHandlers['delete:/transactions/:txnId'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // ── PATCH /api/investments/transactions/:txnId ────────────
  describe('PATCH /transactions/:txnId', () => {
    it('should update portfolio transaction', async () => {
      portfolioTransactionRepository.update.mockResolvedValue({ id: 1, amount: 1200 });

      const req = { params: { txnId: '1' }, body: { amount: 1200 } };
      const res = mockResponse();
      await routeHandlers['patch:/transactions/:txnId'](req, res);

      expect(portfolioTransactionRepository.update).toHaveBeenCalledWith(1, { amount: 1200 });
      expect(res.json).toHaveBeenCalledWith({ id: 1, amount: 1200 });
    });

    it('should return 404 for non-existent transaction', async () => {
      portfolioTransactionRepository.update.mockResolvedValue(null);

      const req = { params: { txnId: '999' }, body: { amount: 1200 } };
      const res = mockResponse();
      await routeHandlers['patch:/transactions/:txnId'](req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should return 400 for invalid ID', async () => {
      const req = { params: { txnId: 'abc' }, body: { amount: 1200 } };
      const res = mockResponse();
      await routeHandlers['patch:/transactions/:txnId'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should handle errors with 500', async () => {
      portfolioTransactionRepository.update.mockRejectedValue(new Error('DB error'));

      const req = { params: { txnId: '1' }, body: { amount: 1200 } };
      const res = mockResponse();
      await routeHandlers['patch:/transactions/:txnId'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('should return 400 for validation errors', async () => {
      const err = new Error('Validation failed');
      err.code = 'VALIDATION_ERROR';
      portfolioTransactionRepository.update.mockRejectedValue(err);

      const req = { params: { txnId: '1' }, body: { amount: 1200 } };
      const res = mockResponse();
      await routeHandlers['patch:/transactions/:txnId'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  // ── GET /api/investments/:id/summary ───────────────────────
  describe('GET /:id/summary', () => {
    it('should return investment summary', async () => {
      portfolioTransactionRepository.getSummary.mockResolvedValue([
        { type: 'buy', total_amount: 5000, count: 3 },
      ]);

      const req = { params: { id: '1' } };
      const res = mockResponse();
      await routeHandlers['get:/:id/summary'](req, res);

      const data = res.json.mock.calls[0][0];
      expect(data.investment_id).toBe(1);
      expect(data.breakdown).toHaveLength(1);
    });

    it('should handle errors with 500', async () => {
      portfolioTransactionRepository.getSummary.mockRejectedValue(new Error('DB error'));

      const req = { params: { id: '1' } };
      const res = mockResponse();
      await routeHandlers['get:/:id/summary'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });
});
