import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const originalEnv = process.env;

async function importLoggerFresh() {
  vi.resetModules();
  return import('../src/config/logger.js');
}

describe('logger', () => {
  let debugSpy;
  let logSpy;
  let warnSpy;
  let errorSpy;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.ENABLE_LOGGING;
    delete process.env.LOG_LEVEL;
    delete process.env.NODE_ENV;
    delete process.env.ENVIRONMENT;

    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    debugSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    process.env = originalEnv;
  });

  it('forces silent mode when ENABLE_LOGGING=false', async () => {
    process.env.ENABLE_LOGGING = 'false';
    process.env.LOG_LEVEL = 'debug';
    process.env.NODE_ENV = 'development';
    const { logger } = await importLoggerFresh();

    logger.debug('debug message');
    logger.info('info message');
    logger.warn('warn message');
    logger.error('error message');

    expect(debugSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('defaults to debug level in development when LOG_LEVEL is missing', async () => {
    process.env.NODE_ENV = 'development';
    const { logger } = await importLoggerFresh();

    logger.debug('debug message');
    logger.info('info message');

    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it('defaults to info level in production when LOG_LEVEL is unknown', async () => {
    process.env.NODE_ENV = 'production';
    process.env.LOG_LEVEL = 'unknown-level';
    const { logger } = await importLoggerFresh();

    logger.debug('debug message');
    logger.info('info message');

    expect(debugSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it('logs only warn and error when LOG_LEVEL=warn', async () => {
    process.env.LOG_LEVEL = 'warn';
    const { logger } = await importLoggerFresh();

    logger.debug('debug message');
    logger.info('info message');
    logger.warn('warn message');
    logger.error('error message');

    expect(debugSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('logs nothing when LOG_LEVEL=silent', async () => {
    process.env.LOG_LEVEL = 'silent';
    const { logger } = await importLoggerFresh();

    logger.debug('debug message');
    logger.info('info message');
    logger.warn('warn message');
    logger.error('error message');

    expect(debugSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('formats message with level tag and extra payload when provided', async () => {
    process.env.LOG_LEVEL = 'info';
    const { logger } = await importLoggerFresh();

    logger.info('hello world', { requestId: 'abc123', status: 200 });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const [formattedMessage] = logSpy.mock.calls[0];
    expect(formattedMessage).toMatch(/^\d{4}-\d{2}-\d{2}T.* \[INFO\] hello world \{"requestId":"abc123","status":200\}$/);
  });

  it('formats message without extra payload when not provided', async () => {
    process.env.LOG_LEVEL = 'error';
    const { logger } = await importLoggerFresh();

    logger.error('plain error');

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [formattedMessage] = errorSpy.mock.calls[0];
    expect(formattedMessage).toMatch(/^\d{4}-\d{2}-\d{2}T.* \[ERROR\] plain error$/);
  });
});
