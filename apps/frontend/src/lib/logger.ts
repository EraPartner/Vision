/**
 * Frontend logger with configurable log level.
 *
 * Control via apps/frontend/.env.local:
 *   VITE_LOG_LEVEL=debug|info|warn|error|silent  (default: debug in dev, warn in production)
 *   VITE_ENABLE_LOGGING=true|false               (default: true)
 *
 * Mirrors: apps/node-backend/src/config/logger.js
 */

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 } as const;
type LogLevel = keyof typeof LOG_LEVELS;

function getLogLevel(): number {
    if (import.meta.env.VITE_ENABLE_LOGGING?.toLowerCase() === 'false') return LOG_LEVELS.silent;
    const level = (import.meta.env.VITE_LOG_LEVEL || '').toLowerCase() as LogLevel;
    if (level in LOG_LEVELS) return LOG_LEVELS[level];
    return import.meta.env.DEV ? LOG_LEVELS.debug : LOG_LEVELS.warn;
}

function formatMessage(level: string, message: string): string {
    return `[${level}] ${message}`;
}

export const logger = {
    debug(message: string, ...args: unknown[]): void {
        if (getLogLevel() <= LOG_LEVELS.debug) console.debug(formatMessage('DEBUG', message), ...args);
    },
    info(message: string, ...args: unknown[]): void {
        if (getLogLevel() <= LOG_LEVELS.info) console.info(formatMessage('INFO', message), ...args);
    },
    warn(message: string, ...args: unknown[]): void {
        if (getLogLevel() <= LOG_LEVELS.warn) console.warn(formatMessage('WARN', message), ...args);
    },
    error(message: string, ...args: unknown[]): void {
        if (getLogLevel() <= LOG_LEVELS.error) console.error(formatMessage('ERROR', message), ...args);
    },
};

export default logger;
