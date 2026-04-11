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

      expect(res.json).toHaveBeenCalledWith([{ id: 1 }]);
    });

    it('returns 500 when repository fails', async () => {
      savedChartsRepository.getAll.mockRejectedValue(new Error('db down'));

      const req = {};
      const res = mockResponse();

      await routeHandlers['get:/'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Failed to fetch saved charts' });
    });
  });

  describe('POST /', () => {
    it('returns 400 when name is missing', async () => {
      const req = { body: { chartType: 'line', categoryIds: [1] } };
      const res = mockResponse();

      await routeHandlers['post:/'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Missing or invalid "name"' });
    });

    it('returns 400 when chartType is invalid', async () => {
      const req = { body: { name: 'Main', chartType: 'pie', categoryIds: [1] } };
      const res = mockResponse();

      await routeHandlers['post:/'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ detail: '"chartType" must be one of: line, bar, area' });
    });

    it('returns 400 when categoryIds has invalid entries', async () => {
      const req = { body: { name: 'Main', chartType: 'line', categoryIds: [1, 'nope'] } };
      const res = mockResponse();

      await routeHandlers['post:/'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ detail: 'categoryIds contains invalid value: nope' });
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
      });
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({ id: 4, name: 'Main', chart_type: 'line', category_ids: [1, 2] });
    });
  });

  describe('PATCH /:id', () => {
    it('returns 400 when id is not a number', async () => {
      const req = { params: { id: 'abc' }, body: {} };
      const res = mockResponse();

      await routeHandlers['patch:/:id'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Invalid chart id' });
    });

    it('returns 400 when name is blank after trimming', async () => {
      const req = { params: { id: '1' }, body: { name: '   ' } };
      const res = mockResponse();

      await routeHandlers['patch:/:id'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Invalid "name"' });
    });

    it('returns 400 when categoryIds is invalid', async () => {
      const req = { params: { id: '1' }, body: { categoryIds: [1, 'bad-id'] } };
      const res = mockResponse();

      await routeHandlers['patch:/:id'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ detail: 'categoryIds contains invalid value: bad-id' });
    });

    it('returns 404 when chart does not exist', async () => {
      savedChartsRepository.update.mockResolvedValue(null);

      const req = { params: { id: '9' }, body: { name: 'Updated' } };
      const res = mockResponse();

      await routeHandlers['patch:/:id'](req, res);

      expect(savedChartsRepository.update).toHaveBeenCalledWith(9, {
        name: 'Updated',
        chartType: undefined,
        categoryIds: undefined,
      });
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Saved chart not found' });
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
      expect(res.json).toHaveBeenCalledWith({ id: 9, name: 'Updated' });
    });
  });

  describe('DELETE /:id', () => {
    it('returns 400 for invalid chart id', async () => {
      const req = { params: { id: 'bad' } };
      const res = mockResponse();

      await routeHandlers['delete:/:id'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Invalid chart id' });
    });

    it('returns 404 when delete misses', async () => {
      savedChartsRepository.delete.mockResolvedValue(false);

      const req = { params: { id: '8' } };
      const res = mockResponse();

      await routeHandlers['delete:/:id'](req, res);

      expect(savedChartsRepository.delete).toHaveBeenCalledWith(8);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Saved chart not found' });
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
  return res;
}
