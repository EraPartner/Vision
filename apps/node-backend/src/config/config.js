/**
 * Configuration management for the Financial Transaction Manager.
 *
 * Derives from the validated `env` module (ADR-030 / Phase 1). This module
 * composes higher-level values (container-aware Ollama URL, precedence chains)
 * and exposes the frozen `settings` object consumed across the backend.
 */

import { readFileSync, existsSync } from 'fs';
import { env } from './env.js';

function deepFreeze(object) {
  Object.freeze(object);
  for (const key of Object.getOwnPropertyNames(object)) {
    const value = object[key];
    if (
      value
      && (typeof value === 'object' || typeof value === 'function')
      && !Object.isFrozen(value)
    ) {
      deepFreeze(value);
    }
  }
  return object;
}

/**
 * Detect whether the Node process is running inside a Linux container
 * (Docker, containerd, Podman). Inside a container, `localhost` resolves to
 * the container itself — Ollama runs on the host and is reachable via
 * `host.docker.internal` (Docker Desktop macOS/Windows auto-maps this; on
 * Linux the compose file adds an `extra_hosts` entry mapped to host-gateway).
 */
function isRunningInContainer() {
  try {
    if (existsSync('/.dockerenv')) return true;
    if (existsSync('/run/.containerenv')) return true;
    const cgroup = readFileSync('/proc/1/cgroup', 'utf-8');
    return /docker|containerd|kubepods|podman/.test(cgroup);
  } catch {
    return false;
  }
}

function defaultOllamaUrl() {
  // 127.0.0.1 over `localhost` — Node's DNS resolves `localhost` to IPv6 `::1`
  // first, but Ollama binds only to IPv4 127.0.0.1 by default.
  return isRunningInContainer()
    ? 'http://host.docker.internal:11434'
    : 'http://127.0.0.1:11434';
}

/** @type {import('./types').Settings} */
const settings = deepFreeze({
  debug: env.DEBUG,

  server: {
    host: env.SERVER_HOST || env.HOSTNAME || 'localhost',
    port: env.PORT,
    environment: env.ENVIRONMENT || env.NODE_ENV || 'development',
  },

  database: {
    url: env.DATABASE_URL,
    echo: env.DB_ECHO,
    poolSize: env.DB_POOL_SIZE,
    maxOverflow: env.DB_MAX_OVERFLOW,
  },

  api: {
    title: 'Financial Transaction Manager',
    version: '1.0.0',
    description: 'Import and manage financial transactions from various banks',
    corsOrigins: env.CORS_ORIGINS,
  },

  admin: {
    enableResetDb: env.ENABLE_RESET_DB,
    authToken: env.ADMIN_AUTH_TOKEN,
  },

  features: {
    aggregationsV2Enabled: env.AGGREGATIONS_V2_ENABLED,
    aggregationShadowEnabled: env.AGGREGATION_SHADOW_ENABLED,
  },

  ollama: {
    url: (env.OLLAMA_URL || defaultOllamaUrl()).replace(/\/+$/, ''),
    defaultModel: env.OLLAMA_DEFAULT_MODEL,
    requestTimeoutMs: env.OLLAMA_REQUEST_TIMEOUT_MS,
    healthTimeoutMs: env.OLLAMA_HEALTH_TIMEOUT_MS,
  },

  aiChat: {
    enabled: env.AI_CHAT_ENABLED,
    rateLimit: env.AI_CHAT_RATE_LIMIT,
    maxHistoryMessages: env.AI_CHAT_MAX_HISTORY,
    maxToolRows: env.AI_CHAT_MAX_TOOL_ROWS,
  },

  isProduction() {
    return this.server.environment.toLowerCase() === 'production';
  },

  isDevelopment() {
    return this.server.environment.toLowerCase() === 'development';
  },
});

export function getSettings() {
  return settings;
}

export default settings;
