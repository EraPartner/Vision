/**
 * Simple structured logger.
 *
 * Mirrors: apps/backend/config/logging_config.py
 */

function formatMessage(level, message, extra = {}) {
  const timestamp = new Date().toISOString();
  const extraStr = Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : '';
  return `${timestamp} [${level}] ${message}${extraStr}`;
}

export const logger = {
  info(message, extra = {}) {
    console.log(formatMessage('INFO', message, extra));
  },
  warn(message, extra = {}) {
    console.warn(formatMessage('WARN', message, extra));
  },
  error(message, extra = {}) {
    console.error(formatMessage('ERROR', message, extra));
  },
  debug(message, extra = {}) {
    console.debug(formatMessage('DEBUG', message, extra));
  },
};

export default logger;
