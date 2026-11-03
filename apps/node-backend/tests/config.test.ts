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
  'VISION_DATABASE_PATH',
  'VISION_DB_LOCK_TIMEOUT_MS',
  'DB_ECHO',
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
      expect(settings.database.path).toBe('./data/vision.sqlite3');
      expect(settings.database.echo).toBe(false);
      expect(settings.database.lockTimeoutMs).toBe(60_000);
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
      process.env.VISION_DATABASE_PATH = '/data/vision.sqlite3'; // required outside development
      const { default: settings } = await importConfigFresh();
      expect(settings.server.environment).toBe('production');
      expect(settings.isProduction()).toBe(true);
      expect(settings.isDevelopment()).toBe(false);
    });

    it('should override the database path from env', async () => {
      process.env.VISION_DATABASE_PATH = '/data/vision.sqlite3';
      const { default: settings } = await importConfigFresh();
      expect(settings.database.path).toBe('/data/vision.sqlite3');
    });

    it('should override database echo from env', async () => {
      process.env.DB_ECHO = 'true';
      const { default: settings } = await importConfigFresh();
      expect(settings.database.echo).toBe(true);
    });

    it('should override the write-lock timeout from env', async () => {
      process.env.VISION_DB_LOCK_TIMEOUT_MS = '1500';
      const { default: settings } = await importConfigFresh();
      expect(settings.database.lockTimeoutMs).toBe(1500);
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
      process.env.VISION_DATABASE_PATH = '/data/vision.sqlite3'; // required outside development
      const { default: settings } = await importConfigFresh();
      expect(settings.server.environment).toBe('staging');
    });

    it('should fall back to NODE_ENV when ENVIRONMENT not set', async () => {
      process.env.NODE_ENV = 'production';
      process.env.VISION_DATABASE_PATH = '/data/vision.sqlite3'; // required outside development
      const { default: settings } = await importConfigFresh();
      expect(settings.server.environment).toBe('production');
    });
  });

  describe('VISION_DATABASE_PATH fail-closed policy', () => {
    it('refuses to start without VISION_DATABASE_PATH outside development', async () => {
      process.env.ENVIRONMENT = 'production';
      await expect(importConfigFresh()).rejects.toThrow(/VISION_DATABASE_PATH is not set/);
    });

    it('honours an explicit VISION_DATABASE_PATH in production', async () => {
      process.env.ENVIRONMENT = 'production';
      process.env.VISION_DATABASE_PATH = '/data/vision.sqlite3';
      const { default: settings } = await importConfigFresh();
      expect(settings.database.path).toBe('/data/vision.sqlite3');
    });

    it('falls back to the built-in default in development (unset VISION_DATABASE_PATH)', async () => {
      process.env.ENVIRONMENT = 'development';
      const { default: settings } = await importConfigFresh();
      expect(settings.database.path).toBe('./data/vision.sqlite3');
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
