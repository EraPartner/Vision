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

vi.mock('../../src/repositories/savedChartsRepository.js', () => ({
  default: {
    getAll: vi.fn(),
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

import savedChartsRepository from '../../src/repositories/savedChartsRepository.js';
import { ValidationError, NotFoundError } from '../../src/middleware/errorHandler.js';

await import('../../src/routes/savedCharts.js');

describe('Saved Charts Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /', () => {
    it('returns all saved charts', async () => {
      savedChartsRepository.getAll.mockResolvedValue([{ id: 1 }]);

      const req = {};
      const res = mockResponse();

      await routeHandlers['get:/'](req, res);

      expect(res.json).toHaveBeenCalledWith({ ok: true, data: [{ id: 1 }] });
    });

    it('propagates error when repository fails', async () => {
      savedChartsRepository.getAll.mockRejectedValue(new Error('db down'));

      const req = {};
      const res = mockResponse();

      await expect(routeHandlers['get:/'](req, res)).rejects.toThrow('db down');
    });
  });

  describe('POST /', () => {
    it('throws ValidationError when name is missing', async () => {
      const req = { body: { chartType: 'line', categoryIds: [1] } };
      const res = mockResponse();

      await expect(routeHandlers['post:/'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('throws ValidationError when chartType is invalid', async () => {
      const req = { body: { name: 'Main', chartType: 'pie', categoryIds: [1] } };
      const res = mockResponse();

      await expect(routeHandlers['post:/'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('throws ValidationError when categoryIds has invalid entries', async () => {
      const req = { body: { name: 'Main', chartType: 'line', categoryIds: [1, 'nope'] } };
      const res = mockResponse();

      await expect(routeHandlers['post:/'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('creates chart with trimmed name and default chart type', async () => {
      savedChartsRepository.create.mockResolvedValue({ id: 4, name: 'Main', chart_type: 'line', category_ids: [1, 2] });

      const req = { body: { name: '  Main  ', categoryIds: ['1', 2] } };
      const res = mockResponse();

      await routeHandlers['post:/'](req, res);

      expect(savedChartsRepository.create).toHaveBeenCalledWith({
        name: 'Main',
        chartType: 'line',
        categoryIds: [1, 2],
        recipientIds: undefined,
        chartVariant: 'default',
        timeBucket: 'monthly',
        dateRangeStart: undefined,
        dateRangeEnd: undefined,
      });
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({ ok: true, data: { id: 4, name: 'Main', chart_type: 'line', category_ids: [1, 2] } });
    });
  });

  describe('PATCH /:id', () => {
    it('throws ValidationError when id is not a number', async () => {
      const req = { params: { id: 'abc' }, body: {} };
      const res = mockResponse();

      await expect(routeHandlers['patch:/:id'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('throws ValidationError when name is blank after trimming', async () => {
      const req = { params: { id: '1' }, body: { name: '   ' } };
      const res = mockResponse();

      await expect(routeHandlers['patch:/:id'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('throws ValidationError when categoryIds is invalid', async () => {
      const req = { params: { id: '1' }, body: { categoryIds: [1, 'bad-id'] } };
      const res = mockResponse();

      await expect(routeHandlers['patch:/:id'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('throws NotFoundError when chart does not exist', async () => {
      savedChartsRepository.update.mockResolvedValue(null);

      const req = { params: { id: '9' }, body: { name: 'Updated' } };
      const res = mockResponse();

      await expect(routeHandlers['patch:/:id'](req, res)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('updates chart and normalizes categoryIds when provided', async () => {
      savedChartsRepository.update.mockResolvedValue({ id: 9, name: 'Updated' });

      const req = { params: { id: '9' }, body: { categoryIds: ['3', 4], chartType: 'bar' } };
      const res = mockResponse();

      await routeHandlers['patch:/:id'](req, res);

      expect(savedChartsRepository.update).toHaveBeenCalledWith(9, {
        name: undefined,
        chartType: 'bar',
        categoryIds: [3, 4],
      });
      expect(res.json).toHaveBeenCalledWith({ ok: true, data: { id: 9, name: 'Updated' } });
    });
  });

  describe('DELETE /:id', () => {
    it('throws ValidationError for invalid chart id', async () => {
      const req = { params: { id: 'bad' } };
      const res = mockResponse();

      await expect(routeHandlers['delete:/:id'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('throws NotFoundError when delete misses', async () => {
      savedChartsRepository.delete.mockResolvedValue(false);

      const req = { params: { id: '8' } };
      const res = mockResponse();

      await expect(routeHandlers['delete:/:id'](req, res)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('returns 204 when delete succeeds', async () => {
      savedChartsRepository.delete.mockResolvedValue(true);

      const req = { params: { id: '8' } };
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
  res.ok = (data, meta) => {
    const body = { ok: true, data };
    if (meta) body.meta = meta;
    return res.json(body);
  };
  return res;
}
