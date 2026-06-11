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
import { ValidationError, NotFoundError } from '../../src/middleware/errorHandler.js';

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

      expect(res.json).toHaveBeenCalledWith({ ok: true, data: { app_settings: { defaultCurrency: 'EUR' } } });
    });

    it('propagates error when fetching all settings fails', async () => {
      settingsRepository.getAll.mockRejectedValue(new Error('boom'));

      const req = { params: {}, query: {} };
      const res = mockResponse();
      await expect(routeHandlers['get:/'](req, res)).rejects.toThrow('boom');
    });
  });

  describe('GET /:key', () => {
    it('returns stored setting value when present', async () => {
      settingsRepository.get.mockResolvedValue({ defaultCurrency: 'USD' });

      const req = { params: { key: 'app_settings' } };
      const res = mockResponse();
      await routeHandlers['get:/:key'](req, res);

      expect(res.json).toHaveBeenCalledWith({ ok: true, data: { key: 'app_settings', value: { defaultCurrency: 'USD' } } });
    });

    it('returns default for known key when missing', async () => {
      settingsRepository.get.mockResolvedValue(null);

      const req = { params: { key: 'onboarding_complete' } };
      const res = mockResponse();
      await routeHandlers['get:/:key'](req, res);

      expect(res.json).toHaveBeenCalledWith({ ok: true, data: { key: 'onboarding_complete', value: false } });
    });

    it('throws NotFoundError for unknown missing key', async () => {
      settingsRepository.get.mockResolvedValue(null);

      const req = { params: { key: 'unknown_key' } };
      const res = mockResponse();
      await expect(routeHandlers['get:/:key'](req, res)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('propagates error when fetching setting fails', async () => {
      settingsRepository.get.mockRejectedValue(new Error('boom'));

      const req = { params: { key: 'app_settings' } };
      const res = mockResponse();
      await expect(routeHandlers['get:/:key'](req, res)).rejects.toThrow('boom');
    });
  });

  describe('PUT /:key', () => {
    it('throws ValidationError when key length exceeds maximum', async () => {
      const req = { params: { key: 'k'.repeat(101) }, body: { value: true } };
      const res = mockResponse();

      await expect(routeHandlers['put:/:key'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('throws ValidationError when value is missing from request body', async () => {
      const req = { params: { key: 'dashboard_settings' }, body: {} };
      const res = mockResponse();

      await expect(routeHandlers['put:/:key'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('throws ValidationError for dashboard_settings with invalid exclusionScope', async () => {
      const req = {
        params: { key: 'dashboard_settings' },
        body: { value: { exclusionScope: 'invalid-scope' } },
      };
      const res = mockResponse();

      await expect(routeHandlers['put:/:key'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('throws ValidationError for dashboard_settings when excludedCategoryIds contains invalid value', async () => {
      const req = {
        params: { key: 'dashboard_settings' },
        body: { value: { excludedCategoryIds: [1, 'abc'] } },
      };
      const res = mockResponse();

      await expect(routeHandlers['put:/:key'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('saves setting when payload is valid', async () => {
      settingsRepository.set.mockResolvedValue({ key: 'theme_settings', value: { theme: 'dark' } });

      const req = { params: { key: 'theme_settings' }, body: { value: { theme: 'dark' } } };
      const res = mockResponse();
      await routeHandlers['put:/:key'](req, res);

      expect(settingsRepository.set).toHaveBeenCalledWith('theme_settings', { theme: 'dark' });
      expect(res.json).toHaveBeenCalledWith({ ok: true, data: { key: 'theme_settings', value: { theme: 'dark' } } });
    });

    it('throws ValidationError for theme_settings with unknown variant', async () => {
      const req = {
        params: { key: 'theme_settings' },
        body: { value: { variant: 'matrix-green' } },
      };
      const res = mockResponse();

      await expect(routeHandlers['put:/:key'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('throws ValidationError for theme_settings with unknown mode', async () => {
      const req = {
        params: { key: 'theme_settings' },
        body: { value: { mode: 'sepia' } },
      };
      const res = mockResponse();

      await expect(routeHandlers['put:/:key'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('throws ValidationError for theme_settings with malformed schedule time', async () => {
      const req = {
        params: { key: 'theme_settings' },
        body: { value: { schedule: { lightFrom: '25:00', darkFrom: '20:00' } } },
      };
      const res = mockResponse();

      await expect(routeHandlers['put:/:key'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('accepts theme_settings with known variant, mode, and schedule', async () => {
      settingsRepository.set.mockResolvedValue({
        key: 'theme_settings',
        value: { mode: 'schedule', schedule: { lightFrom: '07:00', darkFrom: '20:00' }, variant: 'dracula' },
      });

      const req = {
        params: { key: 'theme_settings' },
        body: {
          value: { mode: 'schedule', schedule: { lightFrom: '07:00', darkFrom: '20:00' }, variant: 'dracula' },
        },
      };
      const res = mockResponse();
      await routeHandlers['put:/:key'](req, res);

      expect(settingsRepository.set).toHaveBeenCalledWith('theme_settings', {
        mode: 'schedule',
        schedule: { lightFrom: '07:00', darkFrom: '20:00' },
        variant: 'dracula',
      });
    });

    it('propagates error when single setting save fails', async () => {
      settingsRepository.set.mockRejectedValue(new Error('boom'));

      const req = { params: { key: 'theme_settings' }, body: { value: { theme: 'dark' } } };
      const res = mockResponse();
      await expect(routeHandlers['put:/:key'](req, res)).rejects.toThrow('boom');
    });
  });

  describe('PUT /', () => {
    it('throws ValidationError when body is an array', async () => {
      const req = { body: [] };
      const res = mockResponse();

      await expect(routeHandlers['put:/'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('throws ValidationError when body is not an object', async () => {
      const req = { body: 'invalid' };
      const res = mockResponse();

      await expect(routeHandlers['put:/'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('throws ValidationError when a key exceeds max length', async () => {
      const longKey = 'x'.repeat(101);
      const req = { body: { [longKey]: true } };
      const res = mockResponse();

      await expect(routeHandlers['put:/'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('throws ValidationError when dashboard_settings payload is not an object', async () => {
      const req = { body: { dashboard_settings: 'invalid' } };
      const res = mockResponse();

      await expect(routeHandlers['put:/'](req, res)).rejects.toBeInstanceOf(ValidationError);
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
      expect(res.json).toHaveBeenCalledWith({ ok: true, data: { saved: 2 } });
    });

    it('propagates error when bulk save fails', async () => {
      settingsRepository.setMany.mockRejectedValue(new Error('boom'));

      const req = { body: { onboarding_complete: true } };
      const res = mockResponse();
      await expect(routeHandlers['put:/'](req, res)).rejects.toThrow('boom');
    });

    it('rejects an invalid cost_basis_method via bulk (no validation bypass)', async () => {
      const req = { body: { cost_basis_method: 'bogus' } };
      const res = mockResponse();
      await expect(routeHandlers['put:/'](req, res)).rejects.toBeInstanceOf(ValidationError);
      expect(settingsRepository.setMany).not.toHaveBeenCalled();
    });

    it('accepts a valid cost_basis_method via bulk', async () => {
      settingsRepository.setMany.mockResolvedValue(undefined);
      const req = { body: { cost_basis_method: 'fifo' } };
      const res = mockResponse();
      await routeHandlers['put:/'](req, res);
      expect(settingsRepository.setMany).toHaveBeenCalledWith({ cost_basis_method: 'fifo' });
    });
  });

  describe('DELETE /:key', () => {
    it('throws NotFoundError when setting does not exist', async () => {
      settingsRepository.delete.mockResolvedValue(false);

      const req = { params: { key: 'missing_key' } };
      const res = mockResponse();

      await expect(routeHandlers['delete:/:key'](req, res)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('returns deleted true when setting exists', async () => {
      settingsRepository.delete.mockResolvedValue(true);

      const req = { params: { key: 'theme_settings' } };
      const res = mockResponse();

      await routeHandlers['delete:/:key'](req, res);

      expect(res.json).toHaveBeenCalledWith({ ok: true, data: { deleted: true } });
    });

    it('propagates error when deleting setting fails', async () => {
      settingsRepository.delete.mockRejectedValue(new Error('boom'));

      const req = { params: { key: 'theme_settings' } };
      const res = mockResponse();

      await expect(routeHandlers['delete:/:key'](req, res)).rejects.toThrow('boom');
    });
  });
});

function mockResponse() {
  const res = { json: vi.fn(), status: vi.fn(), send: vi.fn() };
  res.status.mockReturnValue(res);
  res.ok = (data, meta) => {
    const body = { ok: true, data };
    if (meta) body.meta = meta;
    return res.json(body);
  };
  return res;
}
