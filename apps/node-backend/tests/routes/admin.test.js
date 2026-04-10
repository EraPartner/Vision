/**
 * Admin route tests.
 * Mirrors: apps/backend/tests/test_admin.py
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const routeHandlers = {};
const mockRouter = {
  get: vi.fn((path, handler) => { routeHandlers[`get:${path}`] = handler; }),
  post: vi.fn((path, handler) => { routeHandlers[`post:${path}`] = handler; }),
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

import { checkConnection, getTableCount } from '../../src/database/connection.js';
import { getSettings } from '../../src/config/config.js';
import { sanitizePersistedKinesisHistory } from '../../src/services/priceProviderService.js';
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

      const result = res.json.mock.calls[0][0];
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

      expect(res.json.mock.calls[0][0].is_initialised).toBe(false);
    });

    it('should report uninitialised when disconnected', async () => {
      checkConnection.mockResolvedValue(false);

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      expect(res.json.mock.calls[0][0].is_initialised).toBe(false);
      expect(res.json.mock.calls[0][0].table_count).toBe(0);
    });

    it('should handle errors with 500', async () => {
      checkConnection.mockRejectedValue(new Error('Connection failed'));

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('POST /database/init', () => {
    it('should verify connection successfully', async () => {
      checkConnection.mockResolvedValue(true);

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['post:/database/init'](req, res);

      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('should return 500 when cannot connect', async () => {
      checkConnection.mockResolvedValue(false);

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['post:/database/init'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('should sanitize internal errors when init check throws', async () => {
      checkConnection.mockRejectedValue(new Error('driver stack trace'));

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['post:/database/init'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Administrative operation failed' });
    });
  });

  describe('POST /database/reset', () => {
    it('should return 404 when reset disabled', async () => {
      getSettings.mockReturnValue({ admin: { enableResetDb: false } });

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['post:/database/reset'](req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should require force parameter', async () => {
      getSettings.mockReturnValue({ admin: { enableResetDb: true } });

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['post:/database/reset'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should accept force=true', async () => {
      getSettings.mockReturnValue({ admin: { enableResetDb: true } });

      const req = { query: { force: 'true' } };
      const res = mockResponse();
      await routeHandlers['post:/database/reset'](req, res);

      expect(res.json).toHaveBeenCalled();
    });
  });

  describe('GET /update/check', () => {
    it('should return update metadata when latest release exists', async () => {
      process.env.APP_VERSION = '1.2.3';
      mockGitHubReleaseBody(JSON.stringify({
        tag_name: 'v1.2.3',
        published_at: '2026-04-01T12:00:00Z',
        body: 'Release notes',
        html_url: 'https://github.com/EraPartner/Vision/releases/tag/v1.2.3',
      }));

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/update/check'](req, res);

      expect(res.json).toHaveBeenCalledWith({
        up_to_date: true,
        current_version: '1.2.3',
        latest_version: 'v1.2.3',
        published_at: '2026-04-01T12:00:00Z',
        release_notes: 'Release notes',
        html_url: 'https://github.com/EraPartner/Vision/releases/tag/v1.2.3',
      });
    });

    it('should fall back to APP_IMAGE_TAG when APP_VERSION is not set', async () => {
      process.env.APP_IMAGE_TAG = '2.0.0';
      mockGitHubReleaseBody(JSON.stringify({ tag_name: 'v2.1.0' }));

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/update/check'](req, res);

      const payload = res.json.mock.calls[0][0];
      expect(payload.current_version).toBe('2.0.0');
      expect(payload.latest_version).toBe('v2.1.0');
      expect(payload.up_to_date).toBe(false);
    });

    it('should return no-release payload when GitHub returns not found', async () => {
      mockGitHubReleaseBody(JSON.stringify({ message: 'Not Found' }));

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/update/check'](req, res);

      expect(res.json).toHaveBeenCalledWith({
        up_to_date: true,
        error: 'No published releases found',
        latest_version: null,
      });
    });

    it('should return 500 with sanitized error when release payload is invalid json', async () => {
      mockGitHubReleaseBody('{ invalid-json');

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/update/check'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Administrative operation failed' });
    });
  });

  describe('POST /update/apply', () => {
    it('should return update acknowledgement payload', async () => {
      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['post:/update/apply'](req, res);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        note: 'Updates are applied automatically by the desktop app. If an update is available, use the notification in the Vision app window to download and install it.',
      });
    });
  });

  describe('POST /update/apply-and-restart', () => {
    it('should return backwards compatible update acknowledgement payload', async () => {
      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['post:/update/apply-and-restart'](req, res);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        note: 'Updates are managed by the Vision desktop app via Docker image pulls and the desktop shell updater. No manual action is required.',
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
        message: 'Kinesis historical spikes sanitization completed',
        processed: 3,
        updated: 2,
        correctedPoints: 4,
        failed: 0,
      });
    });

    it('should return 500 when sanitization fails', async () => {
      sanitizePersistedKinesisHistory.mockRejectedValue(new Error('boom'));

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['post:/investments/kinesis/sanitize-history'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
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
  return res;
}
