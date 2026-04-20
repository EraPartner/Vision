/**
 * Configuration management for the Financial Transaction Manager
 *
 * Mirrors: apps/backend/config/config.py
 * Handles environment-based settings and configuration validation.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

// Load .env.local if present
const envLocalPath = join(__dirname, '..', '..', '.env.local');
if (existsSync(envLocalPath)) {
  logger.debug(`[config] Loading .env.local from ${envLocalPath}`);
  const content = readFileSync(envLocalPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
  logger.debug(`[config] LOG_LEVEL=${process.env.LOG_LEVEL}, ENABLE_LOGGING=${process.env.ENABLE_LOGGING}`);
} else {
  logger.debug(`[config] No .env.local found at ${envLocalPath}`);
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
  debug: (process.env.DEBUG || 'true').toLowerCase() === 'true',

  server: {
    host: process.env.SERVER_HOST || process.env.HOSTNAME || 'localhost',
    port: parseInt(process.env.PORT || '3002', 10),
    environment: process.env.ENVIRONMENT || process.env.NODE_ENV || 'development',
  },

  database: {
    url: process.env.DATABASE_URL || 'postgresql://ftm_user:ftm_password@localhost:5432/financial_transactions',
    echo: (process.env.DB_ECHO || 'false').toLowerCase() === 'true',
    poolSize: parseInt(process.env.DB_POOL_SIZE || '5', 10),
    maxOverflow: parseInt(process.env.DB_MAX_OVERFLOW || '10', 10),
  },

  api: {
    title: 'Financial Transaction Manager',
    version: '1.0.0',
    description: 'Import and manage financial transactions from various banks',
    corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5174,http://localhost:8080').split(',').map(s => s.trim()),
  },

  admin: {
    enableResetDb: (process.env.ENABLE_RESET_DB || 'false').toLowerCase() === 'true',
    authToken: (process.env.ADMIN_AUTH_TOKEN || '').trim(),
  },

  features: {
    aggregationsV2Enabled: (process.env.AGGREGATIONS_V2_ENABLED || 'true').toLowerCase() === 'true',
  },

  ollama: {
    url: (process.env.OLLAMA_URL || defaultOllamaUrl()).replace(/\/+$/, ''),
    defaultModel: process.env.OLLAMA_DEFAULT_MODEL || 'llama3.1:8b',
    requestTimeoutMs: parseInt(process.env.OLLAMA_REQUEST_TIMEOUT_MS || '60000', 10),
    healthTimeoutMs: parseInt(process.env.OLLAMA_HEALTH_TIMEOUT_MS || '3000', 10),
  },

  aiChat: {
    enabled: (process.env.AI_CHAT_ENABLED || 'true').toLowerCase() === 'true',
    rateLimit: parseInt(process.env.AI_CHAT_RATE_LIMIT || '30', 10),
    maxHistoryMessages: parseInt(process.env.AI_CHAT_MAX_HISTORY || '30', 10),
    maxToolRows: parseInt(process.env.AI_CHAT_MAX_TOOL_ROWS || '500', 10),
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
