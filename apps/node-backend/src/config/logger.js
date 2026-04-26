/**
 * Simple structured logger with configurable log level.
 *
 * Control via .env.local:
 *   LOG_LEVEL=debug|info|warn|error  (default: info in production, debug in development)
 *   ENABLE_LOGGING=true|false        (default: true)
 *
 * Mirrors: apps/backend/config/logging_config.py
 */

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };

function getLogLevel() {
  if (process.env.ENABLE_LOGGING?.toLowerCase() === 'false') return LOG_LEVELS.silent;
  const level = (process.env.LOG_LEVEL || '').toLowerCase();
  if (level in LOG_LEVELS) return LOG_LEVELS[level];
  // Default: debug in development, info in production
  const env = (process.env.ENVIRONMENT || process.env.NODE_ENV || 'development').toLowerCase();
  return env === 'production' ? LOG_LEVELS.info : LOG_LEVELS.debug;
}

function formatMessage(level, ...args) {
  const timestamp = new Date().toISOString();
  let message, extra;
  if (typeof args[0] === 'object' && args[0] !== null && typeof args[1] === 'string') {
    // pino-style: logger.info({ key: val }, 'message')
    extra = args[0];
    message = args[1];
  } else {
    message = args[0];
    extra = (typeof args[1] === 'object' && args[1] !== null) ? args[1] : {};
  }
  const extraStr = Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : '';
  return `${timestamp} [${level}] ${message}${extraStr}`;
}

export const logger = {
  debug(...args) {
    if (getLogLevel() <= LOG_LEVELS.debug) console.debug(formatMessage('DEBUG', ...args));
  },
  info(...args) {
    if (getLogLevel() <= LOG_LEVELS.info) console.log(formatMessage('INFO', ...args));
  },
  warn(...args) {
    if (getLogLevel() <= LOG_LEVELS.warn) console.warn(formatMessage('WARN', ...args));
  },
  error(...args) {
    if (getLogLevel() <= LOG_LEVELS.error) console.error(formatMessage('ERROR', ...args));
  },
};

export default logger;
