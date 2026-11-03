/**
 * Centralized environment schema (ADR-030 / Phase 1).
 *
 * All node-backend env reads flow through this module. Zod validates + coerces
 * on import; misconfiguration fails fast with an aggregated error. Modules
 * MUST import `env` from here rather than reading `process.env` directly.
 *
 * `config/logger.ts` is an intentional exception: it must be usable before
 * env parsing completes, so it keeps minimal direct `process.env` reads.
 */

import "./loadDotenv.ts";
import { z } from "zod";

// Development-only default for the SQLite database file (ADR-263). Outside
// development and test the path must be set explicitly, so a packaged or
// misconfigured backend never writes a database somewhere unexpected — see
// enforceDatabasePathPolicy().
const DEFAULT_DATABASE_PATH = "./data/vision.sqlite3";

const booleanEnv = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value === "") return defaultValue;
      return value.trim().toLowerCase() === "true";
    });

const intEnv = (defaultValue: number) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value === "") return defaultValue;
      const parsed = parseInt(value, 10);
      if (!Number.isFinite(parsed)) {
        ctx.addIssue({
          code: "custom",
          message: `Expected integer, got: ${value}`,
        });
        return z.NEVER;
      }
      return parsed;
    });

const optionalIntEnv = intEnv(Number.NaN).transform((value) =>
  Number.isNaN(value) ? undefined : value,
);

const stringEnv = (defaultValue: string) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined) return defaultValue;
      const trimmed = value.trim();
      return trimmed === "" ? defaultValue : trimmed;
    });

const optionalStringEnv = z
  .string()
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  });

const envSchema = z
  .object({
    SERVER_HOST: optionalStringEnv,
    PORT: intEnv(3002),
    ENVIRONMENT: optionalStringEnv,
    NODE_ENV: optionalStringEnv,

    VISION_DATABASE_PATH: stringEnv(DEFAULT_DATABASE_PATH),
    // How long a write waits for the single writer connection before failing
    // with SQLSTATE 55P03 (database/connection.ts).
    VISION_DB_LOCK_TIMEOUT_MS: intEnv(60_000),
    DB_ECHO: booleanEnv(false),

    // Explicit opt-in for the dev-only rate-limit bypass.
    // Unset/default is fail-safe: bypasses stay OFF even when ENVIRONMENT is
    // 'development', so a misconfigured deploy is never silently permissive.
    VISION_DEV: booleanEnv(false),

    // Baseline app-wide rate-limit ceiling for the data plane (per IP per window).
    // A DoS backstop above normal single-user bursts; stricter per-route limiters
    // sit on top of it.
    RATE_LIMIT_GLOBAL_MAX: intEnv(1000),
    RATE_LIMIT_GLOBAL_WINDOW_MS: intEnv(60_000),

    ENABLE_RESET_DB: booleanEnv(false),

    OLLAMA_URL: optionalStringEnv,
    OLLAMA_DEFAULT_MODEL: stringEnv("llama3.1:8b"),
    OLLAMA_REQUEST_TIMEOUT_MS: intEnv(600000),
    OLLAMA_HEALTH_TIMEOUT_MS: intEnv(3000),
    // Streaming inactivity window: abort only when no chunk arrives for this
    // long. OLLAMA_REQUEST_TIMEOUT_MS still bounds connect + prompt-eval
    // (time to FIRST chunk); total generation time is unbounded by design.
    OLLAMA_STREAM_IDLE_TIMEOUT_MS: intEnv(120000),
    // Unset: Vision sizes the window per request (integrations/ollama/tuning.ts).
    OLLAMA_NUM_CTX: optionalIntEnv,
    OLLAMA_EMBEDDING_MODEL: optionalStringEnv,

    AI_CHAT_ENABLED: booleanEnv(true),
    AI_CHAT_RATE_LIMIT: intEnv(30),
    AI_CHAT_MAX_HISTORY: intEnv(30),
    AI_CHAT_CONTEXT_BUDGET_CHARS: intEnv(24000),
    AI_CHAT_MAX_TOOL_RESULT_CHARS: intEnv(6000),
    AI_CHAT_MAX_TOOL_ROWS: intEnv(500),

    AI_WEB_RESEARCH_ENABLED: booleanEnv(false),
    AI_WEB_RESEARCH_MAX_SEARCHES: intEnv(3),
    AI_WEB_RESEARCH_MAX_PAGES: intEnv(5),
    BRAVE_SEARCH_API_KEY: optionalStringEnv,

    APP_TIMEZONE: stringEnv("Europe/Brussels"),

    APP_VERSION: optionalStringEnv,

    KINESIS_BASE_URL: stringEnv(
      "https://api.kinesis.money/api/market-data/trendlines",
    ),
    KINESIS_DEFAULT_TIMEFRAME: intEnv(60),
    KINESIS_DEFAULT_FROM_DATE: stringEnv("2019-01-01T08:47:55.843Z"),

    ATTACHMENTS_DIR: stringEnv("./data/attachments"),
    ATTACHMENT_MAX_SIZE_MB: intEnv(10),

    // ── Declared for discoverability (ADR-030) ───────────────────────────────
    // These are read at their own call sites (logger, boot-trace, packaged
    // runtime) rather than via `env`, but are listed here so every env var the
    // app reads is documented and validated in one place. Kept as loose strings —
    // the reading sites own their parsing/defaults.
    LOG_LEVEL: optionalStringEnv, // config/logger.ts
    ENABLE_LOGGING: optionalStringEnv, // config/logger.ts
    VISION_BOOT_TRACE: optionalStringEnv, // main.ts (disabled when '0')
    VISION_RUNTIME_ROOT: optionalStringEnv, // packaged native runtime resources
    VISION_NATIVE_ENV_FILE: optionalStringEnv, // packaged private runtime environment
    VISION_DIST_DIR: optionalStringEnv, // packaged production frontend
  })
  .loose();

function parseEnv() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map(
        (issue) => `  - ${issue.path.join(".") || "<root>"}: ${issue.message}`,
      )
      .join("\n");
    throw new Error(`[env] Invalid environment configuration:\n${issues}`);
  }
  enforceDatabasePathPolicy(result.data);
  return result.data;
}

/**
 * VISION_DATABASE_PATH is required outside development and test: the desktop
 * runtime always passes the file inside the application data directory, and
 * any other deployment must say where its database lives instead of silently
 * creating one under the working directory.
 */
function enforceDatabasePathPolicy(data: z.infer<typeof envSchema>) {
  const explicitlySet = Boolean(process.env.VISION_DATABASE_PATH?.trim());
  if (explicitlySet) return;
  const environment = (data.ENVIRONMENT || data.NODE_ENV || "development").toLowerCase();
  if (environment !== "development" && environment !== "test") {
    throw new Error(
      "[env] VISION_DATABASE_PATH is not set. Refusing to create a database at the " +
        "development default outside development; set VISION_DATABASE_PATH explicitly " +
        "(see .env.example).",
    );
  }
}

export const env = Object.freeze(parseEnv());
