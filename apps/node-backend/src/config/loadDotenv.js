/**
 * Loads backend env files into process.env on import, layered (ADR-080):
 *   1. apps/node-backend/.env.local  — local-dev OVERRIDES (localhost DB URL, CORS, ports)
 *   2. <repo-root>/.env              — shared SECRETS base (provider API keys, …)
 *
 * Precedence: a real process.env value always wins; among files, the dev-local
 * file wins over the shared root file (it is applied first, and applyDotenvFile
 * only sets keys not already present). This lets context-INDEPENDENT secrets
 * (e.g. provider API keys) live ONCE in the root `.env` — the very file Docker
 * reads via `env_file: .env` — while context-SPECIFIC dev config (localhost DB,
 * CORS) stays in apps/node-backend/.env.local.
 *
 * In Docker, compose injects the root `.env` into process.env before this module
 * runs, and apps/node-backend/.env.local does not exist in the image, so the
 * "existing keys win" rule makes this loader a no-op there.
 *
 * Caveat: a dev run relies on apps/node-backend/.env.local defining its own
 * DATABASE_URL; otherwise the root `.env`'s Docker DB URL would leak into dev.
 * The .env.local.example ships that override.
 *
 * Pure side-effect module — no deps on logger or env schema (it must run before
 * either of those can evaluate). Never uses null (undefined per repo convention).
 */

import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const devLocalPath = join(__dirname, '..', '..', '.env.local'); // apps/node-backend/.env.local
const sharedRootPath = join(__dirname, '..', '..', '..', '.env'); // <repo-root>/.env

function applyDotenvFile(filePath) {
  if (!existsSync(filePath)) return undefined;
  const content = readFileSync(filePath, 'utf-8');
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
  return filePath;
}

// Dev-local first (wins), then the shared root secrets base.
export const dotenvLoadedFrom = [devLocalPath, sharedRootPath]
  .map(applyDotenvFile)
  .filter(Boolean);
