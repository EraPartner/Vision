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

  DATABASE_URL: stringEnv('postgresql://ftm_user:ftm_password@localhost:5432/financial_transactions'),
  DB_ECHO: booleanEnv(false),
  DB_POOL_SIZE: intEnv(5),
  DB_MAX_OVERFLOW: intEnv(10),

  CORS_ORIGINS: csvEnv('http://localhost:5174,http://localhost:8080'),

  ENABLE_RESET_DB: booleanEnv(false),
  ADMIN_AUTH_TOKEN: stringEnv(''),

  OLLAMA_URL: optionalStringEnv,
  OLLAMA_DEFAULT_MODEL: stringEnv('llama3.1:8b'),
  OLLAMA_REQUEST_TIMEOUT_MS: intEnv(60000),
  OLLAMA_HEALTH_TIMEOUT_MS: intEnv(3000),

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
  return result.data;
}

export const env = Object.freeze(parseEnv());

export default env;
