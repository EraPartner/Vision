import { beforeEach, describe, expect, it, vi } from 'vitest';

const routeHandlers = {};
const mockRouter = {
  get: vi.fn((path, ...handlers) => { routeHandlers[`get:${path}`] = handlers[handlers.length - 1]; }),
  post: vi.fn((path, ...handlers) => { routeHandlers[`post:${path}`] = handlers[handlers.length - 1]; }),
  patch: vi.fn((path, ...handlers) => { routeHandlers[`patch:${path}`] = handlers[handlers.length - 1]; }),
  delete: vi.fn((path, ...handlers) => { routeHandlers[`delete:${path}`] = handlers[handlers.length - 1]; }),
  use: vi.fn(),
};

vi.mock('express', () => ({
  default: { Router: () => mockRouter },
  Router: () => mockRouter,
}));

vi.mock('../../src/repositories/watchlistRepository.js', () => ({
  watchlistRepository: {
    getAllWithCount: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../../src/config/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import { watchlistRepository } from '../../src/repositories/watchlistRepository.js';

await import('../../src/routes/watchlist.js');

describe('Watchlist Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /', () => {
    it('clamps pagination and forwards asset class filter', async () => {
      watchlistRepository.getAllWithCount.mockResolvedValue({ rows: [{ id: 1 }], total: 1 });

      const req = { query: { limit: '10000', offset: '-15', asset_class: 'stocks' } };
      const res = mockResponse();

      await routeHandlers['get:/'](req, res);

      expect(watchlistRepository.getAllWithCount).toHaveBeenCalledWith({
        limit: 5000,
        offset: 0,
        assetClass: 'stocks',
      });
      expect(res.json).toHaveBeenCalledWith({ items: [{ id: 1 }], total: 1, limit: 5000, offset: 0 });
    });

    it('returns 500 when repository throws', async () => {
      watchlistRepository.getAllWithCount.mockRejectedValue(new Error('db exploded'));

      const req = { query: {} };
      const res = mockResponse();

      await routeHandlers['get:/'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Failed to list watchlist items' });
    });
  });

  describe('GET /:id', () => {
    it('returns 404 for missing watchlist item', async () => {
      watchlistRepository.getById.mockResolvedValue(null);

      const req = { params: { id: '7' } };
      const res = mockResponse();

      await routeHandlers['get:/:id'](req, res);

      expect(watchlistRepository.getById).toHaveBeenCalledWith(7);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Watchlist item not found' });
    });
  });

  describe('POST /', () => {
    it('returns 400 when required fields are missing', async () => {
      const req = { body: { name: 'ETF' } };
      const res = mockResponse();

      await routeHandlers['post:/'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ detail: 'name, asset_class, and target_price are required' });
      expect(watchlistRepository.create).not.toHaveBeenCalled();
    });

    it('creates watchlist item', async () => {
      watchlistRepository.create.mockResolvedValue({ id: 9, name: 'ETF Idea' });

      const req = {
        body: {
          name: 'ETF Idea',
          symbol: 'VUSA.AS',
          asset_class: 'etf',
          target_price: 100,
          currency: 'EUR',
          notes: 'watch this',
          price_provider_id: 'yahoo',
        },
      };
      const res = mockResponse();

      await routeHandlers['post:/'](req, res);

      expect(watchlistRepository.create).toHaveBeenCalledWith(req.body);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({ id: 9, name: 'ETF Idea' });
    });
  });

  describe('PATCH /:id', () => {
    it('returns 404 when updating a missing item', async () => {
      watchlistRepository.update.mockResolvedValue(null);

      const req = { params: { id: '99' }, body: { notes: 'updated' } };
      const res = mockResponse();

      await routeHandlers['patch:/:id'](req, res);

      expect(watchlistRepository.update).toHaveBeenCalledWith(99, { notes: 'updated' });
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Watchlist item not found' });
    });
  });

  describe('DELETE /:id', () => {
    it('returns 404 when delete returns false', async () => {
      watchlistRepository.delete.mockResolvedValue(false);

      const req = { params: { id: '33' } };
      const res = mockResponse();

      await routeHandlers['delete:/:id'](req, res);

      expect(watchlistRepository.delete).toHaveBeenCalledWith(33);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Watchlist item not found' });
    });

    it('returns 204 on successful delete', async () => {
      watchlistRepository.delete.mockResolvedValue(true);

      const req = { params: { id: '33' } };
      const res = mockResponse();

      await routeHandlers['delete:/:id'](req, res);

      expect(res.status).toHaveBeenCalledWith(204);
      expect(res.send).toHaveBeenCalled();
    });
  });
});

function mockResponse() {
  const res = {
    json: vi.fn(),
    send: vi.fn(),
    status: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
}
