/**
 * Configuration tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const ENV_KEYS = [
  'DEBUG',
  'SERVER_HOST',
  'HOSTNAME',
  'PORT',
  'ENVIRONMENT',
  'NODE_ENV',
  'DATABASE_URL',
  'DB_ECHO',
  'DB_POOL_SIZE',
  'DB_MAX_OVERFLOW',
  'CORS_ORIGINS',
  'ENABLE_RESET_DB',
];

const originalEnv = process.env;

function clearManagedEnv() {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

async function importConfigFresh() {
  vi.resetModules();
  return import('../src/config/config.js');
}

describe('Configuration Management', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    clearManagedEnv();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('Default Settings', () => {
    it('should have default server settings', async () => {
      const { getSettings } = await importConfigFresh();
      const settings = getSettings();
      expect(settings.server.host).toBe('localhost');
      expect(settings.server.port).toBe(3002);
      expect(settings.server.environment).toBe('development');
    });

    it('should have default database settings', async () => {
      const { getSettings } = await importConfigFresh();
      const settings = getSettings();
      expect(settings.database.url).toBe('postgresql://ftm_user@localhost:5433/financial_transactions');
      expect(settings.database.echo).toBe(false);
      expect(settings.database.poolSize).toBe(5);
      expect(settings.database.maxOverflow).toBe(10);
    });

    it('should have default API settings', async () => {
      const { getSettings } = await importConfigFresh();
      const settings = getSettings();
      expect(settings.api.title).toBe('Financial Transaction Manager');
      expect(settings.api.version).toBe('1.0.0');
      expect(settings.api.description).toBe('Import and manage financial transactions from various banks');
      expect(settings.api.corsOrigins).toEqual(['http://localhost:8080', 'http://localhost:5174']);
    });

    it('should have default admin settings', async () => {
      const { getSettings } = await importConfigFresh();
      const settings = getSettings();
      expect(settings.admin.enableResetDb).toBe(false);
    });

    it('should have debug enabled by default', async () => {
      const { getSettings } = await importConfigFresh();
      const settings = getSettings();
      expect(settings.debug).toBe(true);
    });
  });

  describe('Environment Overrides', () => {
    it('should override server host from env', async () => {
      process.env.SERVER_HOST = '0.0.0.0';
      const { getSettings } = await importConfigFresh();
      expect(getSettings().server.host).toBe('0.0.0.0');
    });

    it('should override server port from env', async () => {
      process.env.PORT = '8080';
      const { getSettings } = await importConfigFresh();
      expect(getSettings().server.port).toBe(8080);
    });

    it('should override server environment from env', async () => {
      process.env.ENVIRONMENT = 'production';
      const { getSettings } = await importConfigFresh();
      const settings = getSettings();
      expect(settings.server.environment).toBe('production');
      expect(settings.isProduction()).toBe(true);
      expect(settings.isDevelopment()).toBe(false);
    });

    it('should override database URL from env', async () => {
      process.env.DATABASE_URL = 'postgresql://user:pass@host:5432/db';
      const { getSettings } = await importConfigFresh();
      expect(getSettings().database.url).toBe('postgresql://user:pass@host:5432/db');
    });

    it('should override database echo from env', async () => {
      process.env.DB_ECHO = 'true';
      const { getSettings } = await importConfigFresh();
      expect(getSettings().database.echo).toBe(true);
    });

    it('should override database pool size from env', async () => {
      process.env.DB_POOL_SIZE = '10';
      const { getSettings } = await importConfigFresh();
      expect(getSettings().database.poolSize).toBe(10);
    });

    it('should override CORS origins from env', async () => {
      process.env.CORS_ORIGINS = 'https://example.com,https://app.example.com';
      const { getSettings } = await importConfigFresh();
      expect(getSettings().api.corsOrigins).toEqual(['https://example.com', 'https://app.example.com']);
    });

    it('should override admin reset db from env', async () => {
      process.env.ENABLE_RESET_DB = 'true';
      const { getSettings } = await importConfigFresh();
      expect(getSettings().admin.enableResetDb).toBe(true);
    });

    it('should override debug from env', async () => {
      process.env.DEBUG = 'false';
      const { getSettings } = await importConfigFresh();
      expect(getSettings().debug).toBe(false);
    });
  });

  describe('Environment Priority', () => {
    it('should prioritize SERVER_HOST over HOSTNAME', async () => {
      process.env.SERVER_HOST = 'server-host';
      process.env.HOSTNAME = 'hostname';
      const { getSettings } = await importConfigFresh();
      expect(getSettings().server.host).toBe('server-host');
    });

    it('should fall back to HOSTNAME when SERVER_HOST not set', async () => {
      process.env.HOSTNAME = 'hostname';
      const { getSettings } = await importConfigFresh();
      expect(getSettings().server.host).toBe('hostname');
    });

    it('should prioritize ENVIRONMENT over NODE_ENV', async () => {
      process.env.ENVIRONMENT = 'staging';
      process.env.NODE_ENV = 'production';
      const { getSettings } = await importConfigFresh();
      expect(getSettings().server.environment).toBe('staging');
    });

    it('should fall back to NODE_ENV when ENVIRONMENT not set', async () => {
      process.env.NODE_ENV = 'production';
      const { getSettings } = await importConfigFresh();
      expect(getSettings().server.environment).toBe('production');
    });
  });

  describe('Immutability', () => {
    it('should return the same settings object on multiple calls', async () => {
      const { getSettings } = await importConfigFresh();
      const settings1 = getSettings();
      const settings2 = getSettings();
      expect(settings1).toBe(settings2);
    });

    it('should not allow modification of nested settings', async () => {
      const { getSettings } = await importConfigFresh();
      const settings = getSettings();
      const originalTitle = settings.api.title;

      expect(() => {
        settings.api.title = 'Modified Title';
      }).toThrow(TypeError);

      expect(getSettings().api.title).toBe(originalTitle);
    });
  });
});
