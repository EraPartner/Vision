/**
 * Centralized environment schema (ADR-030 / Phase 1).
 *
 * All node-backend env reads flow through this module. Zod validates + coerces
 * on import; misconfiguration fails fast with an aggregated error. Modules
 * MUST import `env` from here rather than reading `process.env` directly.
 *
 * `config/logger.js` is an intentional exception: it must be usable before
 * env parsing completes, so it keeps minimal direct `process.env` reads.
 */

import './loadDotenv.js';
import { z } from 'zod';
import { logger } from './logger.js';

// Development-only convenience fallback matching the documented Docker flow.
// Outside development the backend must fail closed rather than silently
// connect with a guessable password — see enforceDatabaseUrlPolicy().
const DEFAULT_DATABASE_URL = 'postgresql://ftm_user:ftm_password@localhost:5432/financial_transactions';

const booleanEnv = (defaultValue) =>
  z.string().optional().transform((value) => {
    if (value === undefined || value === '') return defaultValue;
    return value.trim().toLowerCase() === 'true';
  });

const intEnv = (defaultValue) =>
  z.string().optional().transform((value, ctx) => {
    if (value === undefined || value === '') return defaultValue;
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Expected integer, got: ${value}` });
      return z.NEVER;
    }
    return parsed;
  });

const stringEnv = (defaultValue) =>
  z.string().optional().transform((value) => {
    if (value === undefined) return defaultValue;
    const trimmed = value.trim();
    return trimmed === '' ? defaultValue : trimmed;
  });

const optionalStringEnv = z.string().optional().transform((value) => {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
});

const csvEnv = (defaultValue) =>
  z.string().optional().transform((value) => {
    const raw = value && value.trim() ? value : defaultValue;
    return raw.split(',').map((entry) => entry.trim()).filter(Boolean);
  });

const envSchema = z.object({
  DEBUG: booleanEnv(true),

  SERVER_HOST: optionalStringEnv,
  HOSTNAME: optionalStringEnv,
  PORT: intEnv(3002),
  ENVIRONMENT: optionalStringEnv,
  NODE_ENV: optionalStringEnv,

  DATABASE_URL: stringEnv(DEFAULT_DATABASE_URL),
  DB_ECHO: booleanEnv(false),
  DB_POOL_SIZE: intEnv(5),
  DB_MAX_OVERFLOW: intEnv(10),

  CORS_ORIGINS: csvEnv('http://localhost:5174,http://localhost:8080'),

  // Explicit opt-in for dev-only bypasses (rate-limit skip, wildcard CORS).
  // Unset/default is fail-safe: bypasses stay OFF even when ENVIRONMENT is
  // 'development', so a misconfigured deploy is never silently permissive.
  VISION_DEV: booleanEnv(false),

  // Reverse-proxy IPs/CIDRs whose X-Forwarded-For we trust to identify the real
  // client (for rate-limit keying). Empty = trust nothing → key on socket addr.
  TRUSTED_PROXIES: csvEnv(''),

  // Baseline app-wide rate-limit ceiling for the data plane (per IP per window).
  // A DoS backstop above normal single-user bursts; stricter per-route limiters
  // sit on top of it.
  RATE_LIMIT_GLOBAL_MAX: intEnv(1000),
  RATE_LIMIT_GLOBAL_WINDOW_MS: intEnv(60_000),

  ENABLE_RESET_DB: booleanEnv(false),
  ADMIN_AUTH_TOKEN: stringEnv(''),
  // Explicit acknowledgment that /api/admin/* may run without a token on a
  // non-loopback bind because an OUTER layer restricts access (the documented
  // compose flow binds 0.0.0.0 inside the container but publishes the port on
  // host loopback only). Without this, a tokenless non-loopback bind refuses
  // to start instead of logging a warning nobody reads.
  ADMIN_ALLOW_TOKENLESS_NONLOOPBACK: booleanEnv(false),

  OLLAMA_URL: optionalStringEnv,
  OLLAMA_DEFAULT_MODEL: stringEnv('llama3.1:8b'),
  OLLAMA_REQUEST_TIMEOUT_MS: intEnv(600000),
  OLLAMA_HEALTH_TIMEOUT_MS: intEnv(3000),
  // Streaming inactivity window: abort only when no chunk arrives for this
  // long. OLLAMA_REQUEST_TIMEOUT_MS still bounds connect + prompt-eval
  // (time to FIRST chunk); total generation time is unbounded by design.
  OLLAMA_STREAM_IDLE_TIMEOUT_MS: intEnv(120000),

  AI_CHAT_ENABLED: booleanEnv(true),
  AI_CHAT_RATE_LIMIT: intEnv(30),
  AI_CHAT_MAX_HISTORY: intEnv(30),
  AI_CHAT_MAX_TOOL_ROWS: intEnv(500),

  APP_TIMEZONE: stringEnv('Europe/Brussels'),

  APP_VERSION: optionalStringEnv,
  APP_IMAGE_TAG: optionalStringEnv,

  KINESIS_BASE_URL: stringEnv('https://api.kinesis.money/api/market-data/trendlines'),
  KINESIS_DEFAULT_TIMEFRAME: intEnv(60),
  KINESIS_DEFAULT_FROM_DATE: stringEnv('2019-01-01T08:47:55.843Z'),

  IMPORT_PIPELINE_V2: booleanEnv(true),

  ATTACHMENTS_DIR: stringEnv('./data/attachments'),
  ATTACHMENT_MAX_SIZE_MB: intEnv(10),
}).passthrough();

function parseEnv() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('\n');
    throw new Error(`[env] Invalid environment configuration:\n${issues}`);
  }
  enforceDatabaseUrlPolicy(result.data);
  return result.data;
}

/**
 * DATABASE_URL is required (no fallback) outside development: the default
 * carries a well-known password, so an unset variable in production must fail
 * fast instead of silently connecting with guessable credentials. An
 * explicitly set value is always honoured (the operator made a choice); the
 * development fallback stays, but with a visible warning.
 */
function enforceDatabaseUrlPolicy(data) {
  const explicitlySet = Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.trim());
  if (explicitlySet) return;
  const environment = (data.ENVIRONMENT || data.NODE_ENV || 'development').toLowerCase();
  if (environment !== 'development' && environment !== 'test') {
    throw new Error(
      '[env] DATABASE_URL is not set. Refusing to fall back to the built-in '
      + 'development credentials outside development — set DATABASE_URL explicitly '
      + '(see .env.example).',
    );
  }
  if (environment === 'test') return; // unit tests never open a real connection
  logger.warn(
    '[env] DATABASE_URL is not set — falling back to the built-in development '
    + 'default (ftm_user/ftm_password@localhost). Never use this outside local development.',
  );
}

export const env = Object.freeze(parseEnv());

export default env;
