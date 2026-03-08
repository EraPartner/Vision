/**
 * Configuration management for the Financial Transaction Manager
 *
 * Mirrors: apps/backend/config/config.py
 * Handles environment-based settings and configuration validation.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env.local if present
const envLocalPath = join(__dirname, '..', '..', '.env.local');
if (existsSync(envLocalPath)) {
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
}

/** @type {import('./types').Settings} */
const settings = {
  debug: (process.env.DEBUG || 'true').toLowerCase() === 'true',

  server: {
    host: process.env.HOSTNAME || 'localhost',
    port: parseInt(process.env.PORT || '3002', 10),
    environment: process.env.ENVIRONMENT || 'development',
  },

  database: {
    url: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/financial_transactions',
    echo: (process.env.DB_ECHO || 'false').toLowerCase() === 'true',
    poolSize: parseInt(process.env.DB_POOL_SIZE || '5', 10),
    maxOverflow: parseInt(process.env.DB_MAX_OVERFLOW || '10', 10),
  },

  api: {
    title: 'Financial Transaction Manager',
    version: '1.0.0',
    description: 'Import and manage financial transactions from various banks',
    corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5174').split(',').map(s => s.trim()),
  },

  admin: {
    enableResetDb: (process.env.ENABLE_RESET_DB || 'false').toLowerCase() === 'true',
  },

  isProduction() {
    return this.server.environment.toLowerCase() === 'production';
  },

  isDevelopment() {
    return this.server.environment.toLowerCase() === 'development';
  },
};

export function getSettings() {
  return settings;
}

export default settings;
