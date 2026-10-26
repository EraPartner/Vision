/**
 * Configuration tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockLogger } from './helpers/mockLogger.ts';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
  };
});

vi.mock('../src/config/logger.ts', () => ({
  logger: mockLogger(),
}));

const ENV_KEYS = [
  'SERVER_HOST',
  'PORT',
  'ENVIRONMENT',
  'NODE_ENV',
  'DATABASE_URL',
  'DB_ECHO',
  'DB_POOL_SIZE',
  'DB_MAX_OVERFLOW',
  'ENABLE_RESET_DB',
];

const originalEnv = process.env;

function clearManagedEnv() {
  for (const key of ENV_KEYS) {
    Reflect.deleteProperty(process.env, key);
  }
}

async function importConfigFresh() {
  vi.resetModules();
  return import('../src/config/config.ts');
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
      const { default: settings } = await importConfigFresh();
      expect(settings.server.host).toBe('localhost');
      expect(settings.server.port).toBe(3002);
      expect(settings.server.environment).toBe('development');
    });

    it('should have default database settings', async () => {
      const { default: settings } = await importConfigFresh();
      expect(settings.database.url).toBe('postgresql://ftm_user:ftm_password@localhost:5432/financial_transactions');
      expect(settings.database.echo).toBe(false);
      expect(settings.database.poolSize).toBe(5);
      expect(settings.database.maxOverflow).toBe(10);
    });

    it('should have default API settings', async () => {
      const { default: settings } = await importConfigFresh();
      expect(settings.api.title).toBe('Financial Transaction Manager');
      expect(settings.api.version).toBe('1.0.0');
      expect(settings.api.description).toBe('Import and manage financial transactions from various banks');
    });

    it('should have default admin settings', async () => {
      const { default: settings } = await importConfigFresh();
      expect(settings.admin.enableResetDb).toBe(false);
    });

  });

  describe('Environment Overrides', () => {
    it('should override server host from env', async () => {
      process.env.SERVER_HOST = '0.0.0.0';
      const { default: settings } = await importConfigFresh();
      expect(settings.server.host).toBe('0.0.0.0');
    });

    it('should override server port from env', async () => {
      process.env.PORT = '8080';
      const { default: settings } = await importConfigFresh();
      expect(settings.server.port).toBe(8080);
    });

    it('should override server environment from env', async () => {
      process.env.ENVIRONMENT = 'production';
      process.env.DATABASE_URL = 'postgresql://user:pass@host:5432/db'; // required outside development
      const { default: settings } = await importConfigFresh();
      expect(settings.server.environment).toBe('production');
      expect(settings.isProduction()).toBe(true);
      expect(settings.isDevelopment()).toBe(false);
    });

    it('should override database URL from env', async () => {
      process.env.DATABASE_URL = 'postgresql://user:pass@host:5432/db';
      const { default: settings } = await importConfigFresh();
      expect(settings.database.url).toBe('postgresql://user:pass@host:5432/db');
    });

    it('should override database echo from env', async () => {
      process.env.DB_ECHO = 'true';
      const { default: settings } = await importConfigFresh();
      expect(settings.database.echo).toBe(true);
    });

    it('should override database pool size from env', async () => {
      process.env.DB_POOL_SIZE = '10';
      const { default: settings } = await importConfigFresh();
      expect(settings.database.poolSize).toBe(10);
    });

    it('should override admin reset db from env', async () => {
      process.env.ENABLE_RESET_DB = 'true';
      const { default: settings } = await importConfigFresh();
      expect(settings.admin.enableResetDb).toBe(true);
    });

  });

  describe('Environment Priority', () => {
    it('does not bind to the HOSTNAME a container runtime exports', async () => {
      process.env.HOSTNAME = 'container-hostname';
      const { default: settings } = await importConfigFresh();
      expect(settings.server.host).toBe('localhost');
    });

    it('should prioritize ENVIRONMENT over NODE_ENV', async () => {
      process.env.ENVIRONMENT = 'staging';
      process.env.NODE_ENV = 'production';
      process.env.DATABASE_URL = 'postgresql://user:pass@host:5432/db'; // required outside development
      const { default: settings } = await importConfigFresh();
      expect(settings.server.environment).toBe('staging');
    });

    it('should fall back to NODE_ENV when ENVIRONMENT not set', async () => {
      process.env.NODE_ENV = 'production';
      process.env.DATABASE_URL = 'postgresql://user:pass@host:5432/db'; // required outside development
      const { default: settings } = await importConfigFresh();
      expect(settings.server.environment).toBe('production');
    });
  });

  describe('DATABASE_URL fail-closed policy', () => {
    it('refuses to start without DATABASE_URL outside development', async () => {
      process.env.ENVIRONMENT = 'production';
      await expect(importConfigFresh()).rejects.toThrow(/DATABASE_URL is not set/);
    });

    it('honours an explicit DATABASE_URL in production', async () => {
      process.env.ENVIRONMENT = 'production';
      process.env.DATABASE_URL = 'postgresql://user:pass@host:5432/db';
      const { default: settings } = await importConfigFresh();
      expect(settings.database.url).toBe('postgresql://user:pass@host:5432/db');
    });

    it('falls back to the built-in default in development (unset DATABASE_URL)', async () => {
      process.env.ENVIRONMENT = 'development';
      const { default: settings } = await importConfigFresh();
      expect(settings.database.url).toBe('postgresql://ftm_user:ftm_password@localhost:5432/financial_transactions');
    });
  });

  describe('Immutability', () => {
    it('exports one default settings singleton and no legacy named accessor', async () => {
      const module = await importConfigFresh();
      const cachedModule = await import('../src/config/config.ts');
      expect(module.default).toBe(cachedModule.default);
      expect(module).not.toHaveProperty('getSettings');
    });

    it('should not allow modification of nested settings', async () => {
      const { default: settings } = await importConfigFresh();
      const originalTitle = settings.api.title;

      expect(() => {
        settings.api.title = 'Modified Title';
      }).toThrow(TypeError);

      expect(settings.api.title).toBe(originalTitle);
    });
  });
});
