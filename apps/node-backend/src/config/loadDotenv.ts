/**
 * Loads backend env files into process.env on import, layered (ADR-080):
 *   1. apps/node-backend/.env.local  — local-dev OVERRIDES (localhost DB URL, CORS, ports)
 *   2. <repo-root>/.env              — shared SECRETS base (provider API keys, …)
 *
 * Precedence: a real process.env value always wins; among files, the dev-local
 * file wins over the shared root file (it is applied first, and applyDotenvFile
 * only sets keys not already present). This lets context-INDEPENDENT secrets
 * (e.g. provider API keys) live ONCE in the root `.env`, while context-SPECIFIC
 * dev config (localhost DB, CORS) stays in apps/node-backend/.env.local.
 *
 * Caveat: a dev run relies on apps/node-backend/.env.local defining its own
 * DATABASE_URL; otherwise a root `.env` database URL could leak into dev.
 * The .env.local.example ships that override.
 *
 * Pure side-effect module — no deps on logger or env schema (it must run before
 * either of those can evaluate). Never uses null (undefined per repo convention).
 */

import { readFileSync, existsSync } from "fs";
import { dotenvPaths, applyDotenvContent } from "./dotenvLayers.ts";

function applyDotenvFile(filePath: string): string | undefined {
  if (!existsSync(filePath)) return undefined;
  const content = readFileSync(filePath, "utf-8");
  applyDotenvContent(content, process.env);
  return filePath;
}

// Dev-local first (wins), then the shared root secrets base.
const skipFiles =
  process.env.VISION_SKIP_DOTENV === "1" ||
  process.env.NODE_ENV === "test" ||
  Boolean(process.env.VISION_NATIVE_ENV_FILE);
export const dotenvLoadedFrom = (skipFiles ? [] : dotenvPaths(import.meta.url))
  .map(applyDotenvFile)
  .filter(Boolean);
