/**
 * Investment route tests.
 * Tests all CRUD endpoints for investments and portfolio transactions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    getCount: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    hardDelete: vi.fn(),
  },
}));

vi.mock('../../src/repositories/portfolioTransactionRepository.js', () => ({
  default: {
    getAll: vi.fn(),
    getCount: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    hardDelete: vi.fn(),
    getSummary: vi.fn(),
  },
}));

vi.mock('../../src/services/priceProviderService.js', () => ({
  fetchLivePrices: vi.fn(),
  SUPPORTED_PROVIDERS: [
    { key: 'manual', name: 'Manual' },
    { key: 'coingecko', name: 'CoinGecko' },
    { key: 'yahoo', name: 'Yahoo Finance' },
  ],
}));

vi.mock('../../src/middleware/validation.js', () => ({
  validateIdParam: (req, res, next) => next(),
}));

vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import investmentRepository from '../../src/repositories/investmentRepository.js';
import portfolioTransactionRepository from '../../src/repositories/portfolioTransactionRepository.js';
import { fetchLivePrices } from '../../src/services/priceProviderService.js';
await import('../../src/routes/investments.js');

function mockResponse() {
  const res = { json: vi.fn(), status: vi.fn(), send: vi.fn(), end: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}

describe('Investment Routes', () => {
  beforeEach(() => vi.clearAllMocks());

  // ── GET /api/investments ───────────────────────────────────
  describe('GET /', () => {
    it('should return investments list', async () => {
      investmentRepository.getAll.mockResolvedValue([
        { id: 1, name: 'Bitcoin', asset_class: 'crypto' },
      ]);
      investmentRepository.getCount.mockResolvedValue(1);

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      const data = res.json.mock.calls[0][0];
      expect(data.items).toHaveLength(1);
      expect(data.total).toBe(1);
    });

    it('should return empty list', async () => {
      investmentRepository.getAll.mockResolvedValue([]);
      investmentRepository.getCount.mockResolvedValue(0);

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      expect(res.json.mock.calls[0][0].items).toEqual([]);
    });

    it('should respect pagination and filters', async () => {
      investmentRepository.getAll.mockResolvedValue([]);
      investmentRepository.getCount.mockResolvedValue(0);

      const req = { query: { limit: '10', offset: '5', asset_class: 'crypto', active: 'true' } };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      expect(investmentRepository.getAll).toHaveBeenCalledWith(expect.objectContaining({
        limit: 10, offset: 5, assetClass: 'crypto', active: true,
      }));
    });

    it('should handle errors with 500', async () => {
      investmentRepository.getAll.mockRejectedValue(new Error('DB error'));

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
        { id: 1, price_provider: 'coingecko', price_provider_id: 'bitcoin' },
      ]);
      fetchLivePrices.mockResolvedValue({ 1: 50000 });
      investmentRepository.update.mockResolvedValue({});

      const req = { body: {} };
      const res = mockResponse();
      await routeHandlers['post:/refresh-prices'](req, res);

      const data = res.json.mock.calls[0][0];
      expect(data.updated).toBe(1);
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
      portfolioTransactionRepository.getAll.mockResolvedValue([
        { id: 1, type: 'buy', amount: 1000 },
      ]);
      portfolioTransactionRepository.getCount.mockResolvedValue(1);

      const req = { params: { id: '1' }, query: {} };
      const res = mockResponse();
      await routeHandlers['get:/:id/transactions'](req, res);

      const data = res.json.mock.calls[0][0];
      expect(data.items).toHaveLength(1);
      expect(data.total).toBe(1);
    });

    it('should filter by type', async () => {
      portfolioTransactionRepository.getAll.mockResolvedValue([]);
      portfolioTransactionRepository.getCount.mockResolvedValue(0);

      const req = { params: { id: '1' }, query: { type: 'buy' } };
      const res = mockResponse();
      await routeHandlers['get:/:id/transactions'](req, res);

      expect(portfolioTransactionRepository.getAll).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'buy' })
      );
    });

    it('should handle errors with 500', async () => {
      portfolioTransactionRepository.getAll.mockRejectedValue(new Error('DB error'));

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
