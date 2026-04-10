import { beforeEach, describe, expect, it, vi } from 'vitest';

const routeHandlers = {};
const mockRouter = {
  get: vi.fn((path, ...handlers) => { routeHandlers[`get:${path}`] = handlers[handlers.length - 1]; }),
  put: vi.fn((path, ...handlers) => { routeHandlers[`put:${path}`] = handlers[handlers.length - 1]; }),
  delete: vi.fn((path, ...handlers) => { routeHandlers[`delete:${path}`] = handlers[handlers.length - 1]; }),
  use: vi.fn(),
};

vi.mock('express', () => ({
  default: { Router: () => mockRouter },
  Router: () => mockRouter,
}));

vi.mock('../../src/repositories/settingsRepository.js', () => ({
  default: {
    getAll: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
    setMany: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import settingsRepository from '../../src/repositories/settingsRepository.js';

await import('../../src/routes/settings.js');

describe('Settings Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('PUT /:key', () => {
    it('returns 400 when key length exceeds maximum', async () => {
      const req = { params: { key: 'k'.repeat(101) }, body: { value: true } };
      const res = mockResponse();

      await routeHandlers['put:/:key'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Setting key too long (max 100 chars)' });
    });

    it('returns 400 when value is missing from request body', async () => {
      const req = { params: { key: 'dashboard_settings' }, body: {} };
      const res = mockResponse();

      await routeHandlers['put:/:key'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Missing "value" in request body' });
    });

    it('returns 400 for dashboard_settings with invalid exclusionScope', async () => {
      const req = {
        params: { key: 'dashboard_settings' },
        body: { value: { exclusionScope: 'invalid-scope' } },
      };
      const res = mockResponse();

      await routeHandlers['put:/:key'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Invalid exclusionScope' });
    });

    it('returns 400 for dashboard_settings when excludedCategoryIds contains invalid value', async () => {
      const req = {
        params: { key: 'dashboard_settings' },
        body: { value: { excludedCategoryIds: [1, 'abc'] } },
      };
      const res = mockResponse();

      await routeHandlers['put:/:key'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ detail: 'excludedCategoryIds contains invalid value: abc' });
    });
  });

  describe('PUT /', () => {
    it('returns 400 when body is an array', async () => {
      const req = { body: [] };
      const res = mockResponse();

      await routeHandlers['put:/'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Body must be a JSON object of key→value pairs' });
    });

    it('returns 400 when body is not an object', async () => {
      const req = { body: 'invalid' };
      const res = mockResponse();

      await routeHandlers['put:/'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Body must be a JSON object of key→value pairs' });
    });

    it('returns 400 when a key exceeds max length and includes key name in detail', async () => {
      const longKey = 'x'.repeat(101);
      const req = { body: { [longKey]: true } };
      const res = mockResponse();

      await routeHandlers['put:/'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ detail: `Setting key '${longKey}' too long (max 100 chars)` });
    });
  });

  describe('DELETE /:key', () => {
    it('returns 404 when setting does not exist', async () => {
      settingsRepository.delete.mockResolvedValue(false);

      const req = { params: { key: 'missing_key' } };
      const res = mockResponse();

      await routeHandlers['delete:/:key'](req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ detail: "Setting 'missing_key' not found" });
    });
  });
});

function mockResponse() {
  const res = { json: vi.fn(), status: vi.fn(), send: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}
