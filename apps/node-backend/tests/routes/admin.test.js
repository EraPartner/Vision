/**
 * Admin route tests.
 * Mirrors: apps/backend/tests/test_admin.py
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const routeHandlers = {};
const mockRouter = {
  get: vi.fn((path, handler) => { routeHandlers[`get:${path}`] = handler; }),
  post: vi.fn((path, handler) => { routeHandlers[`post:${path}`] = handler; }),
  patch: vi.fn((path, handler) => { routeHandlers[`patch:${path}`] = handler; }),
  use: vi.fn(),
};

vi.mock('express', () => ({
  default: { Router: () => mockRouter },
  Router: () => mockRouter,
}));

vi.mock('https', () => ({
  default: {
    get: vi.fn(),
  },
}));

vi.mock('../../src/database/connection.js', () => ({
  checkConnection: vi.fn(),
  getTableCount: vi.fn(),
  query: vi.fn(),
}));

vi.mock('../../src/config/config.js', () => ({
  getSettings: vi.fn(() => ({
    admin: { enableResetDb: false },
  })),
}));

vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/services/priceProviderService.js', () => ({
  sanitizePersistedKinesisHistory: vi.fn(),
}));

vi.mock('../../src/services/featureFlagService.js', () => ({
  listFeatureFlags: vi.fn(),
  getFeatureFlag: vi.fn(),
  setFeatureFlag: vi.fn(),
}));

import { checkConnection, getTableCount } from '../../src/database/connection.js';
import { getSettings } from '../../src/config/config.js';
import { sanitizePersistedKinesisHistory } from '../../src/services/priceProviderService.js';
import { listFeatureFlags, getFeatureFlag, setFeatureFlag } from '../../src/services/featureFlagService.js';
import https from 'https';
await import('../../src/routes/admin.js');

describe('Admin Routes', () => {
  const initialAppVersion = process.env.APP_VERSION;
  const initialAppImageTag = process.env.APP_IMAGE_TAG;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.APP_VERSION;
    delete process.env.APP_IMAGE_TAG;
  });

  afterEach(() => {
    if (initialAppVersion === undefined) {
      delete process.env.APP_VERSION;
    } else {
      process.env.APP_VERSION = initialAppVersion;
    }

    if (initialAppImageTag === undefined) {
      delete process.env.APP_IMAGE_TAG;
    } else {
      process.env.APP_IMAGE_TAG = initialAppImageTag;
    }
  });

  describe('GET /', () => {
    it('should return status when connected', async () => {
      checkConnection.mockResolvedValue(true);
      getTableCount.mockResolvedValue(5);

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      const result = res.json.mock.calls[0][0].data;
      expect(result.is_initialised).toBe(true);
      expect(result.table_count).toBe(5);
      expect(result.timestamp).toBeDefined();
    });

    it('should report uninitialised with no tables', async () => {
      checkConnection.mockResolvedValue(true);
      getTableCount.mockResolvedValue(0);

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      expect(res.json.mock.calls[0][0].data.is_initialised).toBe(false);
    });

    it('should report uninitialised when disconnected', async () => {
      checkConnection.mockResolvedValue(false);

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      expect(res.json.mock.calls[0][0].data.is_initialised).toBe(false);
      expect(res.json.mock.calls[0][0].data.table_count).toBe(0);
    });

    it('should propagate errors when connection fails', async () => {
      checkConnection.mockRejectedValue(new Error('Connection failed'));

      const req = { query: {} };
      const res = mockResponse();
      await expect(routeHandlers['get:/'](req, res)).rejects.toThrow('Connection failed');
    });
  });

  describe('POST /database/init', () => {
    it('should verify connection successfully', async () => {
      checkConnection.mockResolvedValue(true);

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['post:/database/init'](req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    });

    it('should throw AppError when cannot connect', async () => {
      const { AppError } = await import('../../src/middleware/errorHandler.js');
      checkConnection.mockResolvedValue(false);

      const req = { query: {} };
      const res = mockResponse();
      await expect(routeHandlers['post:/database/init'](req, res)).rejects.toBeInstanceOf(AppError);
    });

    it('should propagate errors when init check throws', async () => {
      checkConnection.mockRejectedValue(new Error('driver stack trace'));

      const req = { query: {} };
      const res = mockResponse();
      await expect(routeHandlers['post:/database/init'](req, res)).rejects.toThrow('driver stack trace');
    });
  });

  describe('POST /database/reset', () => {
    it('should throw NotFoundError when reset disabled', async () => {
      const { NotFoundError } = await import('../../src/middleware/errorHandler.js');
      getSettings.mockReturnValue({ admin: { enableResetDb: false } });

      const req = { query: {} };
      const res = mockResponse();
      await expect(routeHandlers['post:/database/reset'](req, res)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('should throw ValidationError without force parameter', async () => {
      const { ValidationError } = await import('../../src/middleware/errorHandler.js');
      getSettings.mockReturnValue({ admin: { enableResetDb: true } });

      const req = { query: {} };
      const res = mockResponse();
      await expect(routeHandlers['post:/database/reset'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('should accept force=true', async () => {
      getSettings.mockReturnValue({ admin: { enableResetDb: true } });

      const req = { query: { force: 'true' } };
      const res = mockResponse();
      await routeHandlers['post:/database/reset'](req, res);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    });
  });

  describe('GET /update/check', () => {
    it('should return update metadata when latest release exists', async () => {
      mockGitHubReleaseBody(JSON.stringify({
        tag_name: 'v1.2.3',
        published_at: '2026-04-01T12:00:00Z',
        body: 'Release notes',
        html_url: 'https://github.com/EraPartner/Vision/releases/tag/v1.2.3',
      }));

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/update/check'](req, res);

      const payload = res.json.mock.calls[0][0].data;
      expect(payload.latest_version).toBe('v1.2.3');
      expect(payload.published_at).toBe('2026-04-01T12:00:00Z');
      expect(payload.release_notes).toBe('Release notes');
      expect(payload.html_url).toBe('https://github.com/EraPartner/Vision/releases/tag/v1.2.3');
      expect(payload).toHaveProperty('up_to_date');
      expect(payload).toHaveProperty('current_version');
    });

    it('should include version metadata in update check response', async () => {
      mockGitHubReleaseBody(JSON.stringify({ tag_name: 'v2.1.0' }));

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/update/check'](req, res);

      const payload = res.json.mock.calls[0][0].data;
      expect(payload.latest_version).toBe('v2.1.0');
      expect(payload).toHaveProperty('current_version');
      expect(payload).toHaveProperty('up_to_date');
    });

    it('should return no-release payload when GitHub returns not found', async () => {
      mockGitHubReleaseBody(JSON.stringify({ message: 'Not Found' }));

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/update/check'](req, res);

      expect(res.json).toHaveBeenCalledWith({
        ok: true,
        data: {
          up_to_date: true,
          error: 'No published releases found',
          latest_version: null,
        },
      });
    });

    it('should propagate error when release payload is invalid json', async () => {
      mockGitHubReleaseBody('{ invalid-json');

      const req = { query: {} };
      const res = mockResponse();
      await expect(routeHandlers['get:/update/check'](req, res)).rejects.toThrow();
    });
  });

  describe('POST /update/apply', () => {
    it('should return update acknowledgement payload', async () => {
      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['post:/update/apply'](req, res);

      expect(res.json).toHaveBeenCalledWith({
        ok: true,
        data: {
          success: true,
          note: 'Updates are applied automatically by the desktop app. If an update is available, use the notification in the Vision app window to download and install it.',
        },
      });
    });
  });

  describe('POST /update/apply-and-restart', () => {
    it('should return backwards compatible update acknowledgement payload', async () => {
      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['post:/update/apply-and-restart'](req, res);

      expect(res.json).toHaveBeenCalledWith({
        ok: true,
        data: {
          success: true,
          note: 'Updates are managed by the Vision desktop app via Docker image pulls and the desktop shell updater. No manual action is required.',
        },
      });
    });
  });

  describe('POST /investments/kinesis/sanitize-history', () => {
    it('should sanitize persisted kinesis history and return summary', async () => {
      sanitizePersistedKinesisHistory.mockResolvedValue({
        processed: 3,
        updated: 2,
        correctedPoints: 4,
        failed: 0,
      });

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['post:/investments/kinesis/sanitize-history'](req, res);

      expect(res.json).toHaveBeenCalledWith({
        ok: true,
        data: {
          message: 'Kinesis historical spikes sanitization completed',
          processed: 3,
          updated: 2,
          correctedPoints: 4,
          failed: 0,
        },
      });
    });

    it('should propagate error when sanitization fails', async () => {
      sanitizePersistedKinesisHistory.mockRejectedValue(new Error('boom'));

      const req = { query: {} };
      const res = mockResponse();
      await expect(routeHandlers['post:/investments/kinesis/sanitize-history'](req, res)).rejects.toThrow('boom');
    });
  });

  describe('GET /feature-flags', () => {
    it('returns list of all feature flags', async () => {
      const flags = [
        { id: 1, key: 'ai_chat', enabled: false, description: 'AI chat' },
        { id: 2, key: 'aggregations_v2', enabled: true, description: 'Agg v2' },
      ];
      listFeatureFlags.mockResolvedValue(flags);

      const req = {};
      const res = mockResponse();
      await routeHandlers['get:/feature-flags'](req, res);

      expect(res.json).toHaveBeenCalledWith({ ok: true, data: flags });
    });
  });

  describe('GET /feature-flags/:key', () => {
    it('returns single flag by key', async () => {
      const flag = { id: 1, key: 'ai_chat', enabled: false, description: 'AI chat' };
      getFeatureFlag.mockResolvedValue(flag);

      const req = { params: { key: 'ai_chat' } };
      const res = mockResponse();
      await routeHandlers['get:/feature-flags/:key'](req, res);

      expect(getFeatureFlag).toHaveBeenCalledWith('ai_chat');
      expect(res.json).toHaveBeenCalledWith({ ok: true, data: flag });
    });

    it('propagates NotFoundError for unknown flag', async () => {
      const { NotFoundError } = await import('../../src/middleware/errorHandler.js');
      getFeatureFlag.mockRejectedValue(new NotFoundError("Feature flag 'ghost' not found"));

      const req = { params: { key: 'ghost' } };
      const res = mockResponse();
      await expect(routeHandlers['get:/feature-flags/:key'](req, res)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('PATCH /feature-flags/:key', () => {
    it('enables a flag and returns updated row', async () => {
      const updated = { id: 1, key: 'ai_chat', enabled: true, description: 'AI chat' };
      setFeatureFlag.mockResolvedValue(updated);

      const req = { params: { key: 'ai_chat' }, body: { enabled: true } };
      const res = mockResponse();
      await routeHandlers['patch:/feature-flags/:key'](req, res);

      expect(setFeatureFlag).toHaveBeenCalledWith('ai_chat', true);
      expect(res.json).toHaveBeenCalledWith({ ok: true, data: updated });
    });

    it('throws ValidationError when enabled is missing from body', async () => {
      const { ValidationError } = await import('../../src/middleware/errorHandler.js');

      const req = { params: { key: 'ai_chat' }, body: {} };
      const res = mockResponse();
      await expect(routeHandlers['patch:/feature-flags/:key'](req, res)).rejects.toBeInstanceOf(ValidationError);
      expect(setFeatureFlag).not.toHaveBeenCalled();
    });
  });
});

function mockGitHubReleaseBody(body) {
  const httpsGet = /** @type {import('vitest').Mock} */ (https.get);
  httpsGet.mockImplementation((url, options, callback) => {
    expect(url).toContain('/releases/latest');
    expect(options).toMatchObject({
      headers: {
        'User-Agent': 'Vision-backend',
      },
    });

    const response = {
      on: vi.fn(),
    };

    response.on.mockImplementation((event, handler) => {
      if (event === 'data') {
        handler(body);
      }
      if (event === 'end') {
        handler();
      }
      return response;
    });

    callback(response);

    const request = { on: vi.fn() };
    request.on.mockImplementation(() => request);
    return request;
  });
}

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
