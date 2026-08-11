/**
 * Investment route tests.
 * Tests all CRUD endpoints for investments and portfolio transactions.
 *
 * Runs against the REAL router mounted on a throwaway Express app (see
 * tests/helpers/routeApp.js) — validateIdParam (routes/investments.js:35-41)
 * is no longer stubbed; it runs for real on every `/:id`-prefixed route. No
 * test here exercised an invalid id against one of those routes under the
 * old stub (all used valid numeric ids), so nothing was fake-passing —
 * validateIdParam is simply exercised for real now instead of bypassed.
 *
 * Mount path is /api/investments, behind investmentRateLimiter at the app
 * level (main.js:327) — a module-scoped per-IP counter deliberately NOT
 * reproduced here per the routeApp.js fidelity map.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockLogger } from '../helpers/mockLogger.js';
import { routeAgent, okEnvelope, errEnvelope } from '../helpers/routeApp.js';

vi.mock('../../src/repositories/investmentRepository.js', () => ({
  default: {
    getAll: vi.fn(),
    getAllWithCount: vi.fn(),
    getCount: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updatePrice: vi.fn(),
    updatePricesBulk: vi.fn(),
    hardDelete: vi.fn(),
  },
  pickInvestmentCreateFields: (body) => body,
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

vi.mock('../../src/services/quoteBackfillService.js', () => ({
  refreshQuotesForInvestment: vi.fn().mockResolvedValue(undefined),
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

vi.mock('../../src/config/logger.js', () => ({
  logger: mockLogger(),
}));

import investmentRepository from '../../src/repositories/investmentRepository.js';
import portfolioTransactionRepository from '../../src/repositories/portfolioTransactionRepository.js';
import { fetchHistoricalPrices, fetchLivePricesDetailed } from '../../src/services/priceProviderService.js';

const { default: investmentsRouter } = await import('../../src/routes/investments.js');

const BASE = '/api/investments';
const api = routeAgent(investmentsRouter, { mountPath: BASE });

let nowSpy;

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
      const repoResultA = [{ id: 101, amount: 1 }];
      const repoResultB = [{ id: 202, amount: 2 }];

      portfolioTransactionRepository.getAllByInvestmentIds
        .mockResolvedValueOnce(repoResultA)
        .mockResolvedValueOnce(repoResultB);
      portfolioTransactionRepository.getCount.mockResolvedValue(2);

      const query10 = { investment_ids: '1,2', per_investment_limit: '1000', limit: '10', offset: '0' };
      const query20 = { investment_ids: '1,2', per_investment_limit: '1000', limit: '20', offset: '0' };

      const resA1 = await api.get(`${BASE}/transactions`).query(query10).expect(200);
      expect(resA1.body).toEqual(okEnvelope(expect.objectContaining({ items: repoResultA, limit: 10 })));

      const resA2 = await api.get(`${BASE}/transactions`).query(query10).expect(200);
      expect(resA2.body).toEqual(okEnvelope(expect.objectContaining({ items: repoResultA, limit: 10 })));

      const resB = await api.get(`${BASE}/transactions`).query(query20).expect(200);
      expect(resB.body).toEqual(okEnvelope(expect.objectContaining({ items: repoResultB, limit: 20 })));

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

      const res = await api.get(`${BASE}/`).expect(200);

      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.total).toBe(1);
    });

    it('should return empty list', async () => {
      investmentRepository.getAllWithCount.mockResolvedValue({ rows: [], total: 0 });

      const res = await api.get(`${BASE}/`).expect(200);

      expect(res.body.data.items).toEqual([]);
    });

    it('should respect pagination and filters', async () => {
      investmentRepository.getAllWithCount.mockResolvedValue({ rows: [], total: 0 });

      await api.get(`${BASE}/`).query({ limit: '10', offset: '5', asset_class: 'crypto', active: 'true' }).expect(200);

      expect(investmentRepository.getAllWithCount).toHaveBeenCalledWith(expect.objectContaining({
        limit: 10, offset: 5, assetClass: 'crypto', active: true,
      }));
    });

    it('should handle errors', async () => {
      investmentRepository.getAllWithCount.mockRejectedValue(new Error('DB error'));

      const res = await api.get(`${BASE}/`).expect(500);
      expect(res.body).toEqual(errEnvelope({ code: 'INTERNAL_SERVER_ERROR', message: 'DB error' }));
    });
  });

  // ── POST /api/investments ──────────────────────────────────
  describe('POST /', () => {
    it('should create investment with 201', async () => {
      investmentRepository.create.mockResolvedValue({ id: 1, name: 'Bitcoin', asset_class: 'crypto' });

      await api.post(`${BASE}/`).send({ name: 'Bitcoin', asset_class: 'crypto', currency: 'EUR' }).expect(201);
    });

    it('should throw ValidationError for missing required fields', async () => {
      const res = await api.post(`${BASE}/`).send({ name: 'Bitcoin' }).expect(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
    });

    it('should throw ValidationError for missing name', async () => {
      const res = await api.post(`${BASE}/`).send({ asset_class: 'crypto' }).expect(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
    });

    it('should handle errors', async () => {
      investmentRepository.create.mockRejectedValue(new Error('DB error'));

      const res = await api.post(`${BASE}/`).send({ name: 'Bitcoin', asset_class: 'crypto' }).expect(500);
      expect(res.body).toEqual(errEnvelope({ code: 'INTERNAL_SERVER_ERROR', message: 'DB error' }));
    });
  });

  // ── GET /api/investments/providers ─────────────────────────
  describe('GET /providers', () => {
    it('should return supported providers', async () => {
      const res = await api.get(`${BASE}/providers`).expect(200);

      expect(res.body.data.providers).toBeDefined();
      expect(res.body.data.providers.length).toBeGreaterThan(0);
    });
  });

  // ── POST /api/investments/refresh-prices ───────────────────
  describe('POST /refresh-prices', () => {
    it('should refresh prices for investments with providers', async () => {
      investmentRepository.getAll.mockResolvedValue([
        { id: 1, price_provider: 'binance', price_provider_id: 'BTCUSDT' },
      ]);
      fetchLivePricesDetailed.mockResolvedValue({ 1: { price: 50000, source: 'live' } });
      // Faithful stand-in for the real bulk update: one statement, N rows.
      investmentRepository.updatePricesBulk.mockImplementation(async (updates) => updates.length);

      const res = await api.post(`${BASE}/refresh-prices`).send({}).expect(200);

      const data = res.body.data;
      expect(data.updated).toBe(1);
      expect(data.priceSources).toEqual({ 1: 'live' });
      expect(investmentRepository.updatePricesBulk).toHaveBeenCalledTimes(1);
      expect(investmentRepository.updatePricesBulk).toHaveBeenCalledWith([
        expect.objectContaining({ id: 1, current_price: 50000 }),
      ]);
    });

    it('should include cached source and skip DB update for cached fallback', async () => {
      investmentRepository.getAll.mockResolvedValue([
        { id: 1, current_price: 123.45, price_provider: 'yahoo', price_provider_id: 'AAPL' },
      ]);
      fetchLivePricesDetailed.mockResolvedValue({ 1: { price: 123.45, source: 'cached' } });
      investmentRepository.updatePricesBulk.mockImplementation(async (updates) => updates.length);

      const res = await api.post(`${BASE}/refresh-prices`).send({}).expect(200);

      const data = res.body.data;
      expect(data.updated).toBe(0);
      expect(data.prices).toEqual({ 1: 123.45 });
      expect(data.priceSources).toEqual({ 1: 'cached' });
      // Cached fallback rows must not reach the DB write.
      expect(investmentRepository.updatePricesBulk).toHaveBeenCalledWith([]);
    });

    it('should refresh yahoo investments when only symbol is configured', async () => {
      investmentRepository.getAll.mockResolvedValue([
        { id: 1, symbol: 'AAPL', price_provider: 'yahoo', price_provider_id: null },
      ]);
      fetchLivePricesDetailed.mockResolvedValue({ 1: { price: 188.4, source: 'live' } });
      investmentRepository.updatePricesBulk.mockImplementation(async (updates) => updates.length);

      const res = await api.post(`${BASE}/refresh-prices`).send({}).expect(200);

      const data = res.body.data;
      expect(data.total).toBe(1);
      expect(data.updated).toBe(1);
      expect(investmentRepository.updatePricesBulk).toHaveBeenCalledTimes(1);
    });

    it('should refresh kinesis investments when configured by mapped asset name', async () => {
      investmentRepository.getAll.mockResolvedValue([
        { id: 1, name: 'kaufen_gold', price_provider: 'kinesis', price_provider_id: null },
      ]);
      fetchLivePricesDetailed.mockResolvedValue({ 1: { price: 101.25, source: 'live' } });
      investmentRepository.updatePricesBulk.mockImplementation(async (updates) => updates.length);

      const res = await api.post(`${BASE}/refresh-prices`).send({}).expect(200);

      const data = res.body.data;
      expect(data.total).toBe(1);
      expect(data.updated).toBe(1);
      expect(data.prices).toEqual({ 1: 101.25 });
      expect(data.priceSources).toEqual({ 1: 'live' });
      expect(investmentRepository.updatePricesBulk).toHaveBeenCalledTimes(1);
    });

    it('should return 0 updated when no providers configured', async () => {
      investmentRepository.getAll.mockResolvedValue([
        { id: 1, price_provider: 'manual', price_provider_id: null },
      ]);

      const res = await api.post(`${BASE}/refresh-prices`).send({}).expect(200);

      expect(res.body.data.updated).toBe(0);
    });

    it('should handle errors', async () => {
      investmentRepository.getAll.mockRejectedValue(new Error('DB error'));

      const res = await api.post(`${BASE}/refresh-prices`).send({}).expect(500);
      expect(res.body).toEqual(errEnvelope({ code: 'INTERNAL_SERVER_ERROR', message: 'DB error' }));
    });
  });

  // ── GET /api/investments/:id/price-history ─────────────────
  describe('GET /:id/price-history', () => {
    it('should return custom provider history', async () => {
      investmentRepository.getById.mockResolvedValue({ id: 12, price_provider: 'custom' });
      fetchHistoricalPrices.mockResolvedValue([
        { timestampMs: 1700000000000, price: 700 },
      ]);

      const res = await api.get(`${BASE}/12/price-history`)
        .query({ from_ms: '1699999999999', to_ms: '1700000000001' })
        .expect(200);

      expect(fetchHistoricalPrices).toHaveBeenCalledWith(
        { id: 12, price_provider: 'custom' },
        { fromMs: 1699999999999, toMs: 1700000000001, dbOnly: true }
      );
      expect(res.body).toEqual(okEnvelope({
        investment_id: 12,
        provider: 'custom',
        points: [{ timestampMs: 1700000000000, price: 700 }],
      }));
    });
  });

  // ── GET /api/investments/:id ───────────────────────────────
  describe('GET /:id', () => {
    it('should return investment by id', async () => {
      investmentRepository.getById.mockResolvedValue({ id: 1, name: 'Bitcoin' });

      const res = await api.get(`${BASE}/1`).expect(200);

      expect(res.body.data.name).toBe('Bitcoin');
    });

    it('should throw NotFoundError for non-existent', async () => {
      investmentRepository.getById.mockResolvedValue(null);

      const res = await api.get(`${BASE}/999`).expect(404);
      expect(res.body).toEqual(errEnvelope({ code: 'NOT_FOUND' }));
    });

    it('should handle errors', async () => {
      investmentRepository.getById.mockRejectedValue(new Error('DB error'));

      const res = await api.get(`${BASE}/1`).expect(500);
      expect(res.body).toEqual(errEnvelope({ code: 'INTERNAL_SERVER_ERROR', message: 'DB error' }));
    });
  });

  // ── PATCH /api/investments/:id ─────────────────────────────
  describe('PATCH /:id', () => {
    it('should update investment', async () => {
      investmentRepository.update.mockResolvedValue({ id: 1, name: 'Updated' });

      const res = await api.patch(`${BASE}/1`).send({ name: 'Updated' }).expect(200);

      expect(res.body.data.name).toBe('Updated');
    });

    it('should throw NotFoundError for non-existent', async () => {
      investmentRepository.update.mockResolvedValue(null);

      const res = await api.patch(`${BASE}/999`).send({ name: 'Updated' }).expect(404);
      expect(res.body).toEqual(errEnvelope({ code: 'NOT_FOUND' }));
    });

    it('should handle errors', async () => {
      investmentRepository.update.mockRejectedValue(new Error('DB error'));

      const res = await api.patch(`${BASE}/1`).send({ name: 'Updated' }).expect(500);
      expect(res.body).toEqual(errEnvelope({ code: 'INTERNAL_SERVER_ERROR', message: 'DB error' }));
    });

    it('should throw ValidationError for validation errors', async () => {
      const err = new Error('symbol must be unique');
      err.code = 'VALIDATION_ERROR';
      investmentRepository.update.mockRejectedValue(err);

      const res = await api.patch(`${BASE}/1`).send({ symbol: 'AAPL' }).expect(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
    });
  });

  // ── DELETE /api/investments/:id ────────────────────────────
  describe('DELETE /:id', () => {
    it('should delete and return 204', async () => {
      investmentRepository.hardDelete.mockResolvedValue(true);

      await api.delete(`${BASE}/1`).expect(204);

      expect(investmentRepository.hardDelete).toHaveBeenCalledWith(1);
    });

    it('should throw NotFoundError for non-existent', async () => {
      investmentRepository.hardDelete.mockResolvedValue(false);

      const res = await api.delete(`${BASE}/999`).expect(404);
      expect(res.body).toEqual(errEnvelope({ code: 'NOT_FOUND' }));
    });

    it('should handle errors', async () => {
      investmentRepository.hardDelete.mockRejectedValue(new Error('DB error'));

      const res = await api.delete(`${BASE}/1`).expect(500);
      expect(res.body).toEqual(errEnvelope({ code: 'INTERNAL_SERVER_ERROR', message: 'DB error' }));
    });
  });

  // ── GET /api/investments/:id/transactions ──────────────────
  describe('GET /:id/transactions', () => {
    it('should return portfolio transactions', async () => {
      portfolioTransactionRepository.getAllWithCount.mockResolvedValue({
        rows: [{ id: 1, type: 'buy', amount: 1000 }],
        total: 1,
      });

      const res = await api.get(`${BASE}/1/transactions`).expect(200);

      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.total).toBe(1);
    });

    it('should filter by type', async () => {
      portfolioTransactionRepository.getAllWithCount.mockResolvedValue({ rows: [], total: 0 });

      await api.get(`${BASE}/1/transactions`).query({ type: 'buy' }).expect(200);

      expect(portfolioTransactionRepository.getAllWithCount).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'buy' })
      );
    });

    it('should handle errors', async () => {
      portfolioTransactionRepository.getAllWithCount.mockRejectedValue(new Error('DB error'));

      const res = await api.get(`${BASE}/1/transactions`).expect(500);
      expect(res.body).toEqual(errEnvelope({ code: 'INTERNAL_SERVER_ERROR', message: 'DB error' }));
    });
  });

  // ── POST /api/investments/:id/transactions ─────────────────
  describe('POST /:id/transactions', () => {
    it('should create portfolio transaction with 201', async () => {
      investmentRepository.getById.mockResolvedValue({ id: 1, currency: 'EUR' });
      portfolioTransactionRepository.create.mockResolvedValue({
        id: 1, type: 'buy', amount: 1000,
      });

      await api.post(`${BASE}/1/transactions`).send({ type: 'buy', date: '2026-01-15', amount: 1000 }).expect(201);
    });

    it('should pass fx_rate_to_eur to repository create', async () => {
      investmentRepository.getById.mockResolvedValue({ id: 1, currency: 'USD' });
      portfolioTransactionRepository.create.mockResolvedValue({ id: 1, type: 'buy', amount: 1000, fx_rate_to_eur: 0.92 });

      await api.post(`${BASE}/1/transactions`)
        .send({ type: 'buy', date: '2026-01-15', amount: 1000, fx_rate_to_eur: 0.92 })
        .expect(201);

      expect(portfolioTransactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          investment_id: 1,
          fx_rate_to_eur: 0.92,
        })
      );
    });

    it('should throw NotFoundError if investment not found', async () => {
      investmentRepository.getById.mockResolvedValue(null);

      const res = await api.post(`${BASE}/999/transactions`).send({ type: 'buy', date: '2026-01-15', amount: 1000 }).expect(404);
      expect(res.body).toEqual(errEnvelope({ code: 'NOT_FOUND' }));
    });

    it('should throw ValidationError for missing required fields', async () => {
      investmentRepository.getById.mockResolvedValue({ id: 1, currency: 'EUR' });

      const res = await api.post(`${BASE}/1/transactions`).send({ type: 'buy' }).expect(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
    });

    it('should throw ValidationError when repository raises validation error', async () => {
      investmentRepository.getById.mockResolvedValue({ id: 1, currency: 'EUR' });
      const err = new Error('For buy/sell transactions, provide at least two of amount, units, and price_per_unit');
      err.code = 'VALIDATION_ERROR';
      portfolioTransactionRepository.create.mockRejectedValue(err);

      const res = await api.post(`${BASE}/1/transactions`).send({ type: 'buy', date: '2026-01-15' }).expect(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
    });

    it('should handle errors', async () => {
      investmentRepository.getById.mockResolvedValue({ id: 1, currency: 'EUR' });
      portfolioTransactionRepository.create.mockRejectedValue(new Error('DB error'));

      const res = await api.post(`${BASE}/1/transactions`).send({ type: 'buy', date: '2026-01-15', amount: 1000 }).expect(500);
      expect(res.body).toEqual(errEnvelope({ code: 'INTERNAL_SERVER_ERROR', message: 'DB error' }));
    });
  });

  // ── DELETE /api/investments/transactions/:txnId ────────────
  describe('DELETE /transactions/:txnId', () => {
    it('should delete portfolio transaction with 204', async () => {
      portfolioTransactionRepository.getById.mockResolvedValue({ id: 1, investment_id: 10 });
      portfolioTransactionRepository.hardDelete.mockResolvedValue(true);

      await api.delete(`${BASE}/transactions/1`).expect(204);
    });

    it('should throw NotFoundError for non-existent', async () => {
      portfolioTransactionRepository.getById.mockResolvedValue(null);

      const res = await api.delete(`${BASE}/transactions/999`).expect(404);
      expect(res.body).toEqual(errEnvelope({ code: 'NOT_FOUND' }));
    });

    // 'abc' was the only value pinned, and it is the one the old isNaN guard
    // happened to catch. '12abc' is the 🔺 case: it hard-deleted transaction 12
    // and answered 204. Full matrix in investmentsIdValidation.test.js.
    it('should throw ValidationError for invalid ID', async () => {
      portfolioTransactionRepository.getById.mockResolvedValue({ id: 12, investment_id: 10 });
      portfolioTransactionRepository.hardDelete.mockResolvedValue(true);

      for (const id of ['abc', '12abc']) {
        const res = await api.delete(`${BASE}/transactions/${id}`).expect(400);
        expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
      }
      expect(portfolioTransactionRepository.hardDelete).not.toHaveBeenCalled();
    });

    it('should handle errors', async () => {
      portfolioTransactionRepository.getById.mockResolvedValue({ id: 1, investment_id: 10 });
      portfolioTransactionRepository.hardDelete.mockRejectedValue(new Error('DB error'));

      const res = await api.delete(`${BASE}/transactions/1`).expect(500);
      expect(res.body).toEqual(errEnvelope({ code: 'INTERNAL_SERVER_ERROR', message: 'DB error' }));
    });
  });

  // ── PATCH /api/investments/transactions/:txnId ────────────
  describe('PATCH /transactions/:txnId', () => {
    it('should update portfolio transaction', async () => {
      portfolioTransactionRepository.update.mockResolvedValue({ id: 1, amount: 1200 });

      const res = await api.patch(`${BASE}/transactions/1`).send({ amount: 1200 }).expect(200);

      expect(portfolioTransactionRepository.update).toHaveBeenCalledWith(1, { amount: 1200 });
      expect(res.body).toEqual(okEnvelope({ id: 1, amount: 1200 }));
    });

    it('should throw NotFoundError for non-existent transaction', async () => {
      portfolioTransactionRepository.update.mockResolvedValue(null);

      const res = await api.patch(`${BASE}/transactions/999`).send({ amount: 1200 }).expect(404);
      expect(res.body).toEqual(errEnvelope({ code: 'NOT_FOUND' }));
    });

    it('should throw ValidationError for invalid ID', async () => {
      for (const id of ['abc', '12abc']) {
        const res = await api.patch(`${BASE}/transactions/${id}`).send({ amount: 1200 }).expect(400);
        expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
      }
      expect(portfolioTransactionRepository.update).not.toHaveBeenCalled();
    });

    it('should handle errors', async () => {
      portfolioTransactionRepository.update.mockRejectedValue(new Error('DB error'));

      const res = await api.patch(`${BASE}/transactions/1`).send({ amount: 1200 }).expect(500);
      expect(res.body).toEqual(errEnvelope({ code: 'INTERNAL_SERVER_ERROR', message: 'DB error' }));
    });

    it('should throw ValidationError for validation errors', async () => {
      const err = new Error('Validation failed');
      err.code = 'VALIDATION_ERROR';
      portfolioTransactionRepository.update.mockRejectedValue(err);

      const res = await api.patch(`${BASE}/transactions/1`).send({ amount: 1200 }).expect(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
    });

    it('rejects a free-text or cleared currency and uppercases a valid one', async () => {
      // PATCH forwarded the raw value to the VARCHAR(10) column (create
      // validates): garbage stored, >10 chars 22001'd, null hit NOT NULL.
      for (const currency of ['euro', null, '']) {
        const res = await api.patch(`${BASE}/transactions/1`).send({ currency }).expect(400);
        expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
      }
      expect(portfolioTransactionRepository.update).not.toHaveBeenCalled();

      portfolioTransactionRepository.update.mockResolvedValue({ id: 1, investment_id: 10, currency: 'USD' });
      // fx_rate_to_eur supplied explicitly → the fx recompute path is skipped.
      await api.patch(`${BASE}/transactions/1`).send({ currency: 'usd', fx_rate_to_eur: 0.9 }).expect(200);
      expect(portfolioTransactionRepository.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ currency: 'USD' }),
      );
    });
  });

  // ── GET /api/investments/:id/summary ───────────────────────
  describe('GET /:id/summary', () => {
    it('should return investment summary', async () => {
      portfolioTransactionRepository.getSummary.mockResolvedValue([
        { type: 'buy', total_amount: 5000, count: 3 },
      ]);

      const res = await api.get(`${BASE}/1/summary`).expect(200);

      const data = res.body.data;
      expect(data.investment_id).toBe(1);
      expect(data.breakdown).toHaveLength(1);
    });

    it('should handle errors', async () => {
      portfolioTransactionRepository.getSummary.mockRejectedValue(new Error('DB error'));

      const res = await api.get(`${BASE}/1/summary`).expect(500);
      expect(res.body).toEqual(errEnvelope({ code: 'INTERNAL_SERVER_ERROR', message: 'DB error' }));
    });
  });
});
