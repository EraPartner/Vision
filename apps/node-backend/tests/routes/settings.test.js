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

  describe('GET /', () => {
    it('returns all settings', async () => {
      settingsRepository.getAll.mockResolvedValue({ app_settings: { defaultCurrency: 'EUR' } });

      const req = { params: {}, query: {} };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      expect(res.json).toHaveBeenCalledWith({ app_settings: { defaultCurrency: 'EUR' } });
    });

    it('returns 500 when fetching all settings fails', async () => {
      settingsRepository.getAll.mockRejectedValue(new Error('boom'));

      const req = { params: {}, query: {} };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Failed to fetch settings' });
    });
  });

  describe('GET /:key', () => {
    it('returns stored setting value when present', async () => {
      settingsRepository.get.mockResolvedValue({ defaultCurrency: 'USD' });

      const req = { params: { key: 'app_settings' } };
      const res = mockResponse();
      await routeHandlers['get:/:key'](req, res);

      expect(res.json).toHaveBeenCalledWith({ key: 'app_settings', value: { defaultCurrency: 'USD' } });
    });

    it('returns default for known key when missing', async () => {
      settingsRepository.get.mockResolvedValue(null);

      const req = { params: { key: 'onboarding_complete' } };
      const res = mockResponse();
      await routeHandlers['get:/:key'](req, res);

      expect(res.json).toHaveBeenCalledWith({ key: 'onboarding_complete', value: false });
    });

    it('returns 404 for unknown missing key', async () => {
      settingsRepository.get.mockResolvedValue(null);

      const req = { params: { key: 'unknown_key' } };
      const res = mockResponse();
      await routeHandlers['get:/:key'](req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ detail: "Setting 'unknown_key' not found" });
    });

    it('returns 500 when fetching setting fails', async () => {
      settingsRepository.get.mockRejectedValue(new Error('boom'));

      const req = { params: { key: 'app_settings' } };
      const res = mockResponse();
      await routeHandlers['get:/:key'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Failed to fetch setting' });
    });
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

    it('saves setting when payload is valid', async () => {
      settingsRepository.set.mockResolvedValue({ key: 'theme_settings', value: { theme: 'dark' } });

      const req = { params: { key: 'theme_settings' }, body: { value: { theme: 'dark' } } };
      const res = mockResponse();
      await routeHandlers['put:/:key'](req, res);

      expect(settingsRepository.set).toHaveBeenCalledWith('theme_settings', { theme: 'dark' });
      expect(res.json).toHaveBeenCalledWith({ key: 'theme_settings', value: { theme: 'dark' } });
    });

    it('returns 500 when single setting save fails', async () => {
      settingsRepository.set.mockRejectedValue(new Error('boom'));

      const req = { params: { key: 'theme_settings' }, body: { value: { theme: 'dark' } } };
      const res = mockResponse();
      await routeHandlers['put:/:key'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Failed to save setting' });
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

    it('returns 400 when dashboard_settings payload is not an object', async () => {
      const req = { body: { dashboard_settings: 'invalid' } };
      const res = mockResponse();

      await routeHandlers['put:/'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ detail: 'dashboard_settings must be an object' });
    });

    it('bulk saves settings when payload is valid', async () => {
      settingsRepository.setMany.mockResolvedValue(undefined);

      const req = {
        body: {
          onboarding_complete: true,
          dashboard_settings: { excludedCategoryIds: [1, 2] },
        },
      };
      const res = mockResponse();

      await routeHandlers['put:/'](req, res);

      expect(settingsRepository.setMany).toHaveBeenCalledWith({
        onboarding_complete: true,
        dashboard_settings: { excludedCategoryIds: [1, 2] },
      });
      expect(res.json).toHaveBeenCalledWith({ saved: 2 });
    });

    it('returns 500 when bulk save fails', async () => {
      settingsRepository.setMany.mockRejectedValue(new Error('boom'));

      const req = { body: { onboarding_complete: true } };
      const res = mockResponse();
      await routeHandlers['put:/'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Failed to save settings' });
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

    it('returns deleted true when setting exists', async () => {
      settingsRepository.delete.mockResolvedValue(true);

      const req = { params: { key: 'theme_settings' } };
      const res = mockResponse();

      await routeHandlers['delete:/:key'](req, res);

      expect(res.json).toHaveBeenCalledWith({ deleted: true });
    });

    it('returns 500 when deleting setting fails', async () => {
      settingsRepository.delete.mockRejectedValue(new Error('boom'));

      const req = { params: { key: 'theme_settings' } };
      const res = mockResponse();

      await routeHandlers['delete:/:key'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Failed to delete setting' });
    });
  });
});

function mockResponse() {
  const res = { json: vi.fn(), status: vi.fn(), send: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}
