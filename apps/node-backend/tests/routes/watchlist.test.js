import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockLogger } from '../helpers/mockLogger.js';
import { createMockRouter, createMockResponse } from '../helpers/routeHarness.js';

const { router: mockRouter, handlers: routeHandlers } = createMockRouter();

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
  logger: mockLogger(),
}));

import { watchlistRepository } from '../../src/repositories/watchlistRepository.js';
import { ValidationError, NotFoundError } from '../../src/middleware/errorHandler.js';

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
      expect(res.json).toHaveBeenCalledWith({
        ok: true,
        data: { items: [{ id: 1 }], total: 1, limit: 5000, offset: 0 },
      });
    });

    it('propagates error when repository throws', async () => {
      watchlistRepository.getAllWithCount.mockRejectedValue(new Error('db exploded'));

      const req = { query: {} };
      const res = mockResponse();

      await expect(routeHandlers['get:/'](req, res)).rejects.toThrow('db exploded');
    });
  });

  describe('GET /:id', () => {
    it('throws NotFoundError for missing watchlist item', async () => {
      watchlistRepository.getById.mockResolvedValue(null);

      const req = { params: { id: '7' } };
      const res = mockResponse();

      await expect(routeHandlers['get:/:id'](req, res)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('POST /', () => {
    it('throws ValidationError when required fields are missing', async () => {
      const req = { body: { name: 'ETF' } };
      const res = mockResponse();

      await expect(routeHandlers['post:/'](req, res)).rejects.toBeInstanceOf(ValidationError);
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
      expect(res.json).toHaveBeenCalledWith({ ok: true, data: { id: 9, name: 'ETF Idea' } });
    });
  });

  describe('POST / field validation', () => {
    const validBody = {
      name: 'NVIDIA', symbol: 'NVDA', asset_class: 'stock', target_price: 100, currency: 'USD',
    };

    it('rejects non-numeric target_price with ValidationError (not a DB 500)', async () => {
      const req = { body: { ...validBody, target_price: 'abc' } };
      await expect(routeHandlers['post:/'](req, mockResponse())).rejects.toBeInstanceOf(ValidationError);
      expect(watchlistRepository.create).not.toHaveBeenCalled();
    });

    it('rejects negative target_price', async () => {
      const req = { body: { ...validBody, target_price: -5 } };
      await expect(routeHandlers['post:/'](req, mockResponse())).rejects.toBeInstanceOf(ValidationError);
    });

    it('rejects a zero target_price (meaningless for the at-or-below alert)', async () => {
      const req = { body: { ...validBody, target_price: 0 } };
      await expect(routeHandlers['post:/'](req, mockResponse())).rejects.toBeInstanceOf(ValidationError);
      expect(watchlistRepository.create).not.toHaveBeenCalled();
    });

    it('rejects target_price beyond the NUMERIC(18,6) cap (was a DB overflow 500)', async () => {
      const req = { body: { ...validBody, target_price: 1e15 } };
      await expect(routeHandlers['post:/'](req, mockResponse())).rejects.toBeInstanceOf(ValidationError);
      expect(watchlistRepository.create).not.toHaveBeenCalled();
    });

    it('rejects Infinity target_price', async () => {
      const req = { body: { ...validBody, target_price: Infinity } };
      await expect(routeHandlers['post:/'](req, mockResponse())).rejects.toBeInstanceOf(ValidationError);
    });

    it('rejects added_price beyond the NUMERIC(18,6) cap', async () => {
      const req = { body: { ...validBody, added_price: 1e15 } };
      await expect(routeHandlers['post:/'](req, mockResponse())).rejects.toBeInstanceOf(ValidationError);
    });

    it('rejects an over-length name (VARCHAR(200)) before the DB 22001', async () => {
      const req = { body: { ...validBody, name: 'x'.repeat(201) } };
      await expect(routeHandlers['post:/'](req, mockResponse())).rejects.toBeInstanceOf(ValidationError);
      expect(watchlistRepository.create).not.toHaveBeenCalled();
    });

    it('rejects an over-length symbol (VARCHAR(20))', async () => {
      const req = { body: { ...validBody, symbol: 'A'.repeat(21) } };
      await expect(routeHandlers['post:/'](req, mockResponse())).rejects.toBeInstanceOf(ValidationError);
      expect(watchlistRepository.create).not.toHaveBeenCalled();
    });

    it('rejects unknown asset_class', async () => {
      const req = { body: { ...validBody, asset_class: 'beanie-babies' } };
      await expect(routeHandlers['post:/'](req, mockResponse())).rejects.toBeInstanceOf(ValidationError);
    });

    it('rejects malformed currency', async () => {
      const req = { body: { ...validBody, currency: 'EURO' } };
      await expect(routeHandlers['post:/'](req, mockResponse())).rejects.toBeInstanceOf(ValidationError);
    });

    it('normalises a lower-case currency to uppercase before the repository', async () => {
      watchlistRepository.create.mockResolvedValue({ id: 1 });
      const req = { body: { ...validBody, currency: 'usd' } };
      await routeHandlers['post:/'](req, mockResponse());
      expect(watchlistRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ currency: 'USD' }),
      );
    });

    it('rejects a whitespace-only name (truthy, so the POST presence check let it through)', async () => {
      const req = { body: { ...validBody, name: '   ' } };
      await expect(routeHandlers['post:/'](req, mockResponse())).rejects.toBeInstanceOf(ValidationError);
      expect(watchlistRepository.create).not.toHaveBeenCalled();
    });

    it('coerces numeric-string target_price before reaching the repository', async () => {
      watchlistRepository.create.mockResolvedValue({ id: 1 });
      const req = { body: { ...validBody, target_price: '123.45' } };
      await routeHandlers['post:/'](req, mockResponse());
      expect(watchlistRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ target_price: 123.45 }),
      );
    });

    it('accepts boundary-length name (200) and symbol (20)', async () => {
      watchlistRepository.create.mockResolvedValue({ id: 1 });
      const name = 'n'.repeat(200);
      const symbol = 'S'.repeat(20);
      const req = { body: { ...validBody, name, symbol } };
      await routeHandlers['post:/'](req, mockResponse());
      expect(watchlistRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ name, symbol }),
      );
    });

    it('accepts target_price at the exact NUMERIC(18,6) cap and rejects one past it', async () => {
      watchlistRepository.create.mockResolvedValue({ id: 1 });
      const MAX_PRICE = 999_999_999_999;

      await routeHandlers['post:/']({ body: { ...validBody, target_price: MAX_PRICE } }, mockResponse());
      expect(watchlistRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ target_price: MAX_PRICE }),
      );

      await expect(
        routeHandlers['post:/']({ body: { ...validBody, target_price: MAX_PRICE + 1 } }, mockResponse()),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('rejects an over-length price_provider_id (VARCHAR(200))', async () => {
      const req = { body: { ...validBody, price_provider_id: 'p'.repeat(201) } };
      await expect(routeHandlers['post:/'](req, mockResponse())).rejects.toBeInstanceOf(ValidationError);
    });

    it('trims and uppercases a padded lower-case currency', async () => {
      watchlistRepository.create.mockResolvedValue({ id: 1 });
      const req = { body: { ...validBody, currency: ' usd ' } };
      await routeHandlers['post:/'](req, mockResponse());
      expect(watchlistRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ currency: 'USD' }),
      );
    });

    it('rejects an empty-string currency (explicit key must carry a real code)', async () => {
      const req = { body: { ...validBody, currency: '' } };
      await expect(routeHandlers['post:/'](req, mockResponse())).rejects.toBeInstanceOf(ValidationError);
    });

    it('accepts the metals asset_class', async () => {
      watchlistRepository.create.mockResolvedValue({ id: 1 });
      const req = { body: { ...validBody, asset_class: 'metals' } };
      await routeHandlers['post:/'](req, mockResponse());
      expect(watchlistRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ asset_class: 'metals' }),
      );
    });

    it('accepts a zero added_price (only target_price has the >0 rule) and coerces strings', async () => {
      watchlistRepository.create.mockResolvedValue({ id: 1 });

      await routeHandlers['post:/']({ body: { ...validBody, added_price: 0 } }, mockResponse());
      expect(watchlistRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ added_price: 0 }),
      );

      await routeHandlers['post:/']({ body: { ...validBody, added_price: '12.5' } }, mockResponse());
      expect(watchlistRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ added_price: 12.5 }),
      );
    });

    it('rejects a non-numeric added_price', async () => {
      const req = { body: { ...validBody, added_price: 'soon' } };
      await expect(routeHandlers['post:/'](req, mockResponse())).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe('PATCH /:id field validation', () => {
    it('rejects non-numeric target_price before hitting the repository', async () => {
      const req = { params: { id: '1' }, body: { target_price: 'abc' } };
      await expect(routeHandlers['patch:/:id'](req, mockResponse())).rejects.toBeInstanceOf(ValidationError);
      expect(watchlistRepository.update).not.toHaveBeenCalled();
    });

    it('rejects unknown asset_class on partial update', async () => {
      const req = { params: { id: '1' }, body: { asset_class: 'nft' } };
      await expect(routeHandlers['patch:/:id'](req, mockResponse())).rejects.toBeInstanceOf(ValidationError);
    });

    it('allows partial updates that omit typed fields', async () => {
      watchlistRepository.update.mockResolvedValue({ id: 1, notes: 'watch earnings' });
      const req = { params: { id: '1' }, body: { notes: 'watch earnings' } };
      await routeHandlers['patch:/:id'](req, mockResponse());
      expect(watchlistRepository.update).toHaveBeenCalledWith(1, { notes: 'watch earnings' });
    });

    it('rejects an empty name on PATCH (400, not a persisted blank label)', async () => {
      const req = { params: { id: '1' }, body: { name: '' } };
      await expect(routeHandlers['patch:/:id'](req, mockResponse())).rejects.toBeInstanceOf(ValidationError);
      expect(watchlistRepository.update).not.toHaveBeenCalled();
    });

    it('rejects a whitespace-only name on PATCH', async () => {
      const req = { params: { id: '1' }, body: { name: '   ' } };
      await expect(routeHandlers['patch:/:id'](req, mockResponse())).rejects.toBeInstanceOf(ValidationError);
      expect(watchlistRepository.update).not.toHaveBeenCalled();
    });

    it('rejects a null name on PATCH', async () => {
      const req = { params: { id: '1' }, body: { name: null } };
      await expect(routeHandlers['patch:/:id'](req, mockResponse())).rejects.toBeInstanceOf(ValidationError);
    });

    it('coerces a numeric-string target_price on PATCH', async () => {
      watchlistRepository.update.mockResolvedValue({ id: 1 });
      const req = { params: { id: '1' }, body: { target_price: '50.5' } };
      await routeHandlers['patch:/:id'](req, mockResponse());
      expect(watchlistRepository.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ target_price: 50.5 }),
      );
    });

    it('rejects a zero target_price on PATCH', async () => {
      const req = { params: { id: '1' }, body: { target_price: 0 } };
      await expect(routeHandlers['patch:/:id'](req, mockResponse())).rejects.toBeInstanceOf(ValidationError);
    });

    it('uppercases currency on PATCH', async () => {
      watchlistRepository.update.mockResolvedValue({ id: 1 });
      const req = { params: { id: '1' }, body: { currency: 'gbp' } };
      await routeHandlers['patch:/:id'](req, mockResponse());
      expect(watchlistRepository.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ currency: 'GBP' }),
      );
    });

    it('passes a null currency through untouched on PATCH', async () => {
      watchlistRepository.update.mockResolvedValue({ id: 1 });
      const req = { params: { id: '1' }, body: { currency: null } };
      await routeHandlers['patch:/:id'](req, mockResponse());
      expect(watchlistRepository.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ currency: null }),
      );
    });

    it('rejects an over-length symbol on PATCH', async () => {
      const req = { params: { id: '1' }, body: { symbol: 'A'.repeat(21) } };
      await expect(routeHandlers['patch:/:id'](req, mockResponse())).rejects.toBeInstanceOf(ValidationError);
    });

    it('passes unvalidated fields through to the repository untouched', async () => {
      // The repository allow-list (not the route) is what drops unknown keys —
      // the route must forward them so notes/other allow-listed columns update.
      watchlistRepository.update.mockResolvedValue({ id: 1 });
      const req = { params: { id: '1' }, body: { notes: 'hold', unknown_field: 'kept' } };
      await routeHandlers['patch:/:id'](req, mockResponse());
      expect(watchlistRepository.update).toHaveBeenCalledWith(
        1,
        { notes: 'hold', unknown_field: 'kept' },
      );
    });

    it('allows an explicit null added_price on PATCH (only non-null values are frozen)', async () => {
      watchlistRepository.update.mockResolvedValue({ id: 1 });
      const req = { params: { id: '1' }, body: { added_price: null } };
      await routeHandlers['patch:/:id'](req, mockResponse());
      expect(watchlistRepository.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ added_price: null }),
      );
    });

    it('rejects added_price on PATCH instead of silently accepting-then-dropping it', async () => {
      // added_price is an add-time snapshot: the repository update allow-list omits
      // it, so before the fix a valid value validated fine yet never persisted (a
      // no-op). It must now surface a 400 rather than the silent no-op.
      const req = { params: { id: '1' }, body: { added_price: 123.45 } };
      await expect(routeHandlers['patch:/:id'](req, mockResponse())).rejects.toBeInstanceOf(ValidationError);
      expect(watchlistRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /:id', () => {
    it('throws NotFoundError when updating a missing item', async () => {
      watchlistRepository.update.mockResolvedValue(null);

      const req = { params: { id: '99' }, body: { notes: 'updated' } };
      const res = mockResponse();

      await expect(routeHandlers['patch:/:id'](req, res)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('DELETE /:id', () => {
    it('throws NotFoundError when delete returns false', async () => {
      watchlistRepository.delete.mockResolvedValue(false);

      const req = { params: { id: '33' } };
      const res = mockResponse();

      await expect(routeHandlers['delete:/:id'](req, res)).rejects.toBeInstanceOf(NotFoundError);
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
  return createMockResponse();
}
