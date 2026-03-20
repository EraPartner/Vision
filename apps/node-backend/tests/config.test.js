/**
 * Configuration tests.
 * Mirrors: apps/backend/tests/test_config.py
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs to prevent loading .env.local
vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
}));

// Mock logger to prevent actual logging
vi.mock('../src/config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

let getSettingsModule;

// Reset module cache before each test to get fresh config
const resetConfigModule = () => {
  vi.resetModules();
  // Re-import after reset
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const config = require('../src/config/config.js');
  getSettingsModule = config.getSettings;
};

describe('Configuration Management', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset all environment variables
    process.env = {};
    // Get fresh settings with clean environment
    resetConfigModule();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('Default Settings', () => {
    it('should have default server settings', () => {
      const settings = getSettingsModule();
      expect(settings.server.host).toBe('localhost');
      expect(settings.server.port).toBe(3002);
      // In Vitest, NODE_ENV is set to 'test' by default, so default environment is 'test'
      expect(settings.server.environment).toBe('test');
    });

    it('should have default database settings', () => {
      const settings = getSettingsModule();
      expect(settings.database.url).toBe('postgresql://ftm_user@localhost:5433/financial_transactions');
      expect(settings.database.echo).toBe(false);
      expect(settings.database.poolSize).toBe(5);
      expect(settings.database.maxOverflow).toBe(10);
    });

    it('should have default API settings', () => {
      const settings = getSettingsModule();
      expect(settings.api.title).toBe('Financial Transaction Manager');
      expect(settings.api.version).toBe('1.0.0');
      expect(settings.api.description).toBe('Import and manage financial transactions from various banks');
      expect(settings.api.corsOrigins).toEqual([]); // Empty array when CORS_ORIGINS not set
    });

    it('should have default admin settings', () => {
      const settings = getSettingsModule();
      expect(settings.admin.enableResetDb).toBe(false);
    });

    it('should have debug enabled by default', () => {
      const settings = getSettingsModule();
      // With DEBUG not set, defaults to 'true' -> debug = true
      expect(settings.debug).toBe(true);
    });
  });

  describe('Environment Overrides', () => {
    it('should override server host from env', () => {
      process.env.SERVER_HOST = '0.0.0.0';
      const settings = getSettingsModule();
      expect(settings.server.host).toBe('0.0.0.0');
    });

    it('should override server port from env', () => {
      process.env.PORT = '8080';
      const settings = getSettingsModule();
      expect(settings.server.port).toBe(8080);
    });

    it('should override server environment from env', () => {
      process.env.ENVIRONMENT = 'production';
      const settings = getSettingsModule();
      expect(settings.server.environment).toBe('production');
      expect(settings.isProduction()).toBe(true);
      expect(settings.isDevelopment()).toBe(false);
    });

    it('should override database URL from env', () => {
      process.env.DATABASE_URL = 'postgresql://user:pass@host:5432/db';
      const settings = getSettingsModule();
      expect(settings.database.url).toBe('postgresql://user:pass@host:5432/db');
    });

    it('should override database echo from env', () => {
      process.env.DB_ECHO = 'true';
      const settings = getSettingsModule();
      expect(settings.database.echo).toBe(true);
    });

    it('should override database pool size from env', () => {
      process.env.DB_POOL_SIZE = '10';
      const settings = getSettingsModule();
      expect(settings.database.poolSize).toBe(10);
    });

    it('should override CORS origins from env', () => {
      process.env.CORS_ORIGINS = 'https://example.com,https://app.example.com';
      const settings = getSettingsModule();
      expect(settings.api.corsOrigins).toEqual(['https://example.com', 'https://app.example.com']);
    });

    it('should override admin reset db from env', () => {
      process.env.ENABLE_RESET_DB = 'true';
      const settings = getSettingsModule();
      expect(settings.admin.enableResetDb).toBe(true);
    });

    it('should override debug from env', () => {
      process.env.DEBUG = 'false';
      const settings = getSettingsModule();
      expect(settings.debug).toBe(false);
    });
  });

  describe('Environment Priority', () => {
    it('should prioritize SERVER_HOST over HOSTNAME', () => {
      process.env.SERVER_HOST = 'server-host';
      process.env.HOSTNAME = 'hostname';
      const settings = getSettingsModule();
      expect(settings.server.host).toBe('server-host');
    });

    it('should fall back to HOSTNAME when SERVER_HOST not set', () => {
      delete process.env.SERVER_HOST;
      process.env.HOSTNAME = 'hostname';
      const settings = getSettingsModule();
      expect(settings.server.host).toBe('hostname');
    });

    it('should prioritize ENVIRONMENT over NODE_ENV', () => {
      process.env.ENVIRONMENT = 'staging';
      process.env.NODE_ENV = 'production';
      const settings = getSettingsModule();
      expect(settings.server.environment).toBe('staging');
    });

    it('should fall back to NODE_ENV when ENVIRONMENT not set', () => {
      delete process.env.ENVIRONMENT;
      process.env.NODE_ENV = 'production';
      const settings = getSettingsModule();
      expect(settings.server.environment).toBe('production');
    });
  });

  describe('Helper Methods', () => {
    it('should correctly identify production environment', () => {
      process.env.ENVIRONMENT = 'production';
      const settings = getSettingsModule();
      expect(settings.isProduction()).toBe(true);
      expect(settings.isDevelopment()).toBe(false);
    });

    it('should correctly identify development environment', () => {
      process.env.ENVIRONMENT = 'development';
      const settings = getSettingsModule();
      expect(settings.isProduction()).toBe(false);
      expect(settings.isDevelopment()).toBe(true);
    });

    it('should return false for both helpers in other environments', () => {
      process.env.ENVIRONMENT = 'staging';
      const settings = getSettingsModule();
      expect(settings.isProduction()).toBe(false);
      expect(settings.isDevelopment()).toBe(false);
    });
  });

  describe('Immutability', () => {
    it('should return the same settings object on multiple calls', () => {
      const settings1 = getSettingsModule();
      const settings2 = getSettingsModule();
      expect(settings1).toBe(settings2);
    });

    it('should not allow modification of returned settings', () => {
      const settings = getSettingsModule();
      // This should not affect the original settings
      const originalTitle = settings.api.title;
      settings.api.title = 'Modified Title';
      expect(getSettingsModule().api.title).toBe(originalTitle);
    });
  });
});