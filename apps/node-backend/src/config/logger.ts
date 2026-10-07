/**
 * Simple structured logger with configurable log level.
 *
 * Control via .env.local:
 *   LOG_LEVEL=debug|info|warn|error  (default: info in production, debug in development)
 *   ENABLE_LOGGING=true|false        (default: true)
 *
 */

import { getRequestContext } from "../lib/requestContext.ts";

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };

function isLogLevelName(level: string): level is keyof typeof LOG_LEVELS {
  return level in LOG_LEVELS;
}

function getLogLevel() {
  if (process.env.ENABLE_LOGGING?.toLowerCase() === "false")
    return LOG_LEVELS.silent;
  const level = (process.env.LOG_LEVEL || "").toLowerCase();
  if (isLogLevelName(level)) return LOG_LEVELS[level];
  // Default: debug in development, info in production
  const env = (
    process.env.ENVIRONMENT ||
    process.env.NODE_ENV ||
    "development"
  ).toLowerCase();
  return env === "production" ? LOG_LEVELS.info : LOG_LEVELS.debug;
}

// Resolve the level ONCE at module load rather than re-parsing process.env on
// every logger call (invoked per request and per DB query). The level is fixed
// for a process lifetime; env changes require a restart anyway.
const CURRENT_LOG_LEVEL = getLogLevel();

function formatMessage(level: string, ...args: unknown[]): string {
  const timestamp = new Date().toISOString();
  let message: unknown;
  let extra: object;
  if (
    typeof args[0] === "object" &&
    args[0] !== null &&
    typeof args[1] === "string"
  ) {
    // pino-style: logger.info({ key: val }, 'message')
    extra = args[0];
    message = args[1];
  } else {
    message = args[0];
    extra = typeof args[1] === "object" && args[1] !== null ? args[1] : {};
  }
  const ambientRequestId = getRequestContext()?.requestId;
  const hasConcreteRequestId =
    Object.prototype.hasOwnProperty.call(extra, "requestId") &&
    "requestId" in extra &&
    extra.requestId !== undefined;
  const contextualExtra =
    ambientRequestId !== undefined && !hasConcreteRequestId
      ? {
          requestId: ambientRequestId,
          ...Object.fromEntries(
            Object.entries(extra).filter(([key]) => key !== "requestId"),
          ),
        }
      : extra;
  const extraStr =
    Object.keys(contextualExtra).length > 0
      ? ` ${JSON.stringify(contextualExtra)}`
      : "";
  // Strip CR/LF (and unicode line separators) from the free-text message so a
  // value that reaches a log call can't forge extra log lines (log injection).
  // `extra` is already newline-safe via JSON.stringify.
  const safeMessage =
    typeof message === "string"
      ? message.replace(/[\r\n\u2028\u2029]+/g, " ")
      : message;
  return `${timestamp} [${level}] ${safeMessage}${extraStr}`;
}

export const logger = {
  debug(...args: unknown[]) {
    if (CURRENT_LOG_LEVEL <= LOG_LEVELS.debug)
      console.debug(formatMessage("DEBUG", ...args));
  },
  info(...args: unknown[]) {
    if (CURRENT_LOG_LEVEL <= LOG_LEVELS.info)
      console.log(formatMessage("INFO", ...args));
  },
  warn(...args: unknown[]) {
    if (CURRENT_LOG_LEVEL <= LOG_LEVELS.warn)
      console.warn(formatMessage("WARN", ...args));
  },
  error(...args: unknown[]) {
    if (CURRENT_LOG_LEVEL <= LOG_LEVELS.error)
      console.error(formatMessage("ERROR", ...args));
  },
};

export default logger;
