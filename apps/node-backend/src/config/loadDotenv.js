/**
 * Loads apps/node-backend/.env.local into process.env on import.
 *
 * Pure side-effect module — no deps on logger or env schema (it must run
 * before either of those can evaluate). Existing process.env keys win.
 */

import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envLocalPath = join(__dirname, '..', '..', '.env.local');

function applyDotenvFile(filePath) {
  if (!existsSync(filePath)) return null;
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

export const dotenvLoadedFrom = applyDotenvFile(envLocalPath);
