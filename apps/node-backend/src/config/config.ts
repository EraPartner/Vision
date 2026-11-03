/**
 * Configuration management for the Financial Transaction Manager.
 *
 * Derives from the validated `env` module (ADR-030 / Phase 1). This module
 * composes higher-level values (Ollama URL, precedence chains)
 * and exposes the frozen `settings` object consumed across the backend.
 */

import { env } from "./env.ts";

function deepFreeze<T extends object>(object: T): T {
  Object.freeze(object);
  for (const key of Object.getOwnPropertyNames(object)) {
    const value: unknown = Reflect.get(object, key);
    if (
      value &&
      (typeof value === "object" || typeof value === "function") &&
      !Object.isFrozen(value)
    ) {
      deepFreeze(value);
    }
  }
  return object;
}

function defaultOllamaUrl() {
  // 127.0.0.1 over `localhost` — Node's DNS resolves `localhost` to IPv6 `::1`
  // first, but Ollama binds only to IPv4 127.0.0.1 by default.
  return "http://127.0.0.1:11434";
}

const settings = deepFreeze({
  server: {
    host: env.SERVER_HOST || "localhost",
    port: env.PORT,
    environment: env.ENVIRONMENT || env.NODE_ENV || "development",
  },

  database: {
    // SQLite database file (ADR-263). The desktop runtime passes a path inside
    // the application data directory.
    path: env.VISION_DATABASE_PATH,
    lockTimeoutMs: env.VISION_DB_LOCK_TIMEOUT_MS,
    echo: env.DB_ECHO,
  },

  api: {
    title: "Financial Transaction Manager",
    version: "1.0.0",
    description: "Import and manage financial transactions from various banks",
  },

  admin: {
    enableResetDb: env.ENABLE_RESET_DB,
  },

  security: {
    // Explicit opt-in for dev-only bypasses (fail-safe when unset — see env.js).
    devBypass: env.VISION_DEV,
  },

  rateLimit: {
    globalMax: env.RATE_LIMIT_GLOBAL_MAX,
    globalWindowMs: env.RATE_LIMIT_GLOBAL_WINDOW_MS,
  },

  ollama: {
    url: (env.OLLAMA_URL || defaultOllamaUrl()).replace(/\/+$/, ""),
    defaultModel: env.OLLAMA_DEFAULT_MODEL,
    requestTimeoutMs: env.OLLAMA_REQUEST_TIMEOUT_MS,
    healthTimeoutMs: env.OLLAMA_HEALTH_TIMEOUT_MS,
    streamIdleTimeoutMs: env.OLLAMA_STREAM_IDLE_TIMEOUT_MS,
    numCtx: env.OLLAMA_NUM_CTX,
    embeddingModel: env.OLLAMA_EMBEDDING_MODEL,
  },

  aiChat: {
    enabled: env.AI_CHAT_ENABLED,
    rateLimit: env.AI_CHAT_RATE_LIMIT,
    maxHistoryMessages: env.AI_CHAT_MAX_HISTORY,
    contextBudgetChars: env.AI_CHAT_CONTEXT_BUDGET_CHARS,
    maxToolResultChars: env.AI_CHAT_MAX_TOOL_RESULT_CHARS,
    maxToolRows: env.AI_CHAT_MAX_TOOL_ROWS,
  },

  aiResearch: {
    web: {
      enabled: env.AI_WEB_RESEARCH_ENABLED,
      maxSearches: env.AI_WEB_RESEARCH_MAX_SEARCHES,
      maxPages: env.AI_WEB_RESEARCH_MAX_PAGES,
      braveApiKey: env.BRAVE_SEARCH_API_KEY,
    },
  },

  isProduction() {
    return this.server.environment.toLowerCase() === "production";
  },

  isDevelopment() {
    return this.server.environment.toLowerCase() === "development";
  },
});

export default settings;
