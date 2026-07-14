'use strict';

const { app, BrowserWindow, dialog, Menu, Notification, screen, shell, ipcMain, safeStorage, session, systemPreferences } = require('electron');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const http = require('http');
const https = require('https');
const { createBundle, encryptBundle, openBundle, isBundleEncrypted } = require('./backup/bundle');
// Async i18n loader for main process dialogs. Populated during launch() before
// any t() use. Until then, t() falls back to the key itself — which only
// happens if a dialog fires before initI18n() resolves (startup error paths).
let i18n = {};

async function loadI18nAsync() {
  const locale = (app && app.getLocale && typeof app.getLocale === 'function') ? app.getLocale() : 'en';
  const lang = locale && locale.startsWith('nl') ? 'nl' : 'en';

  // Prefer i18n shipped in the app resources (packaged .app).
  const resourceI18nDir = path.join(process.resourcesPath || '', 'i18n');
  const fallbackI18nDir = path.join(__dirname, 'i18n');

  const tryLoad = async (dir, file) => {
    try {
      const p = path.join(dir, file);
      const raw = await fs.promises.readFile(p, 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };

  const localeFile = `${lang}.json`;
  const byResources = resourceI18nDir && await tryLoad(resourceI18nDir, localeFile);
  if (byResources) return byResources;

  const byFallback = await tryLoad(fallbackI18nDir, localeFile);
  if (byFallback) return byFallback;

  // Last resort: try English in resources then fallback dir
  const enRes = await tryLoad(resourceI18nDir, 'en.json');
  if (enRes) return enRes;
  const enFb = await tryLoad(fallbackI18nDir, 'en.json');
  if (enFb) return enFb;

  return {};
}

async function initI18n() {
  i18n = await loadI18nAsync();
}

function t(key, vars) {
  let txt = i18n[key] || key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) txt = txt.replace(`{${k}}`, v);
  }
  return txt;
}

// ── App identity ──────────────────────────────────────────────────────────────
// Force Electron's runtime name to match CFBundleName ("Vision") so
// `app.getPath('userData')` resolves to ~/Library/Application Support/Vision/
// instead of the package.json `name` field ("vision-desktop"). Without this:
//   1. macOS Sonoma+ TCC fires the "Vision would like to access data from
//      other apps" prompt, because Vision.app reads/writes a userData folder
//      whose name doesn't match its bundle.
//   2. Each rename/reinstall lands in a different userData dir, generating a
//      fresh .env with a new POSTGRES_PASSWORD while the docker volume
//      `embedded_compose_db_data` (project name = basename of workDir =
//      "embedded_compose") is shared and keeps the OLD password — backend
//      auth fails, frontend loads empty.
// MUST run before any `app.getPath('userData')` (e.g. settingsPath below).
//
// Demo builds ship a `resources/DEMO` marker (electron-builder-demo.json). When
// present, the app runs as a fully separate "Vision Demo" — its own userData dir,
// its own embedded stack/volumes — and can never reach the real app's data.
const __IS_DEMO = (() => {
  try { return fs.existsSync(path.join(process.resourcesPath || '', 'resources', 'DEMO')); }
  catch { return false; }
})();
app.setName(__IS_DEMO ? 'Vision Demo' : 'Vision');

// Acquire the single-instance lock as early as possible — immediately after
// setName (the lock lives in userData, so it must run after that) and BEFORE the
// legacy-userData migration and the rest of module eval. This means a second
// launch quits here instead of evaluating the whole module first, and two
// simultaneous first launches can't both enter the migration's renameSync.
// The primary instance registers its second-instance/activate/launch handlers
// at the bottom of the module, still gated on this same flag.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

// One-shot migration from the legacy "vision-desktop" userData dir to the
// canonical "Vision" dir. Preserves existing settings.json + embedded_compose
// (and its .env with the original POSTGRES_PASSWORD) so the shared docker
// volume keeps authenticating after the rename. Skipped for a second instance
// (it doesn't hold the lock and is about to quit).
if (gotSingleInstanceLock) (function migrateLegacyUserData() {
  try {
    if (__IS_DEMO) return; // demo build never adopts the real app's legacy data
    const target = app.getPath('userData');
    const legacy = path.join(path.dirname(target), 'vision-desktop');
    if (legacy === target) return;
    if (!fs.existsSync(legacy)) return;
    const targetExists = fs.existsSync(target);
    const targetEmpty = targetExists
      ? fs.readdirSync(target).filter(n => n !== '.DS_Store').length === 0
      : false;
    if (!targetExists || targetEmpty) {
      if (targetExists) fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(legacy, target);
      console.error('[migrate] Moved legacy userData "vision-desktop" → "Vision"');
    } else {
      const archived = `${legacy}.legacy-${Date.now()}`;
      fs.renameSync(legacy, archived);
      console.error(`[migrate] "Vision" userData already populated; archived legacy dir to ${archived}`);
    }
  } catch (err) {
    console.warn('[migrate] userData migration failed (non-fatal):', err && err.message ? err.message : err);
  }
})();

// ── Constants ─────────────────────────────────────────────────────────────────
const APP_NAME = __IS_DEMO ? 'Vision Demo' : 'Vision';
// Last-resort fallback only. The real port is a truly-random free port chosen
// once per app and persisted (settings.appPort) — see resolveAppPort(). Random
// per-app ports mean the demo and the real app never fight over a fixed port.
const DEFAULT_APP_PORT = 3002;
const HEALTH_POLL_ATTEMPTS = Number(process.env.VISION_HEALTH_POLL_ATTEMPTS) || 200;  // 200 × 300ms = 60s max
const HEALTH_POLL_INTERVAL_MS = Number(process.env.VISION_HEALTH_POLL_INTERVAL_MS) || 300;
// After a cold/dev build the image finishes building, then the backend still has to
// boot from scratch (deps + migrations + server) — that routinely overshoots the
// warm-boot budget above. Give the post-build poll a much larger budget so a first
// launch or `docker:dev:rebuild` doesn't trip the slow-start warning. 600 × 300ms ≈ 3 min.
const HEALTH_POLL_BUILD_ATTEMPTS = Number(process.env.VISION_HEALTH_POLL_BUILD_ATTEMPTS) || 600;
const HEALTH_WATCHDOG_INTERVAL_MS = 10_000;
const HEALTH_WATCHDOG_FAILURE_THRESHOLD = 3;

// Repo paths that affect the Docker image. Changes to these trigger a rebuild;
// changes to everything else (docs, packaging/electron, etc.) do not.
const DOCKER_PATHS = [
  'Dockerfile', 'package.json', 'bun.lock',
  'apps/node-backend/src/', 'apps/frontend/src/',
  'apps/frontend/public/', 'apps/frontend/index.html',
  'packages/', 'i18n/', 'scripts/generate-locales.js',
];

// ── Startup instrumentation ───────────────────────────────────────────────────
// Phase 1 of startup-speedup plan. Emits structured JSON marks to stderr so
// boot timings are easy to grep/chart. Cheap (<1ms per mark); leave on by
// default. Disable with VISION_BOOT_TRACE=0.
const BOOT_TRACE_ENABLED = process.env.VISION_BOOT_TRACE !== '0';
const _bootT0 = Date.now();
const _bootMarks = [];
function bootMark(phase) {
  const t0 = Date.now();
  return () => {
    const ms = Date.now() - t0;
    _bootMarks.push({ phase, ms });
    if (BOOT_TRACE_ENABLED) {
      console.error(`[startup] ${JSON.stringify({ phase, ms })}`);
    }
    return ms;
  };
}
function bootSummary(extraPhase = 'launch_total') {
  const total = Date.now() - _bootT0;
  if (BOOT_TRACE_ENABLED) {
    console.error(`[startup] ${JSON.stringify({ phase: extraPhase, ms: total, marks: _bootMarks })}`);
  }
}
const MANUAL_UPDATE_CHECK_DELAY_MS = 30_000;
const BACKUP_ENC_MAGIC = Buffer.from('VISIONENC1');
const BACKUP_ENC_MAGIC_V2 = Buffer.from('VISIONENC2');
const BACKUP_ENC_IV_BYTES = 16;
const BACKUP_ENC_V2_SALT_BYTES = 16;
const BACKUP_ENC_V2_IV_BYTES = 12;
const BACKUP_ENC_V2_TAG_BYTES = 16;
const BACKUP_KDF_N = 1 << 15;
const BACKUP_KDF_R = 8;
const BACKUP_KDF_P = 1;
const BACKUP_RETENTION_KEEP = 7;
const BACKUP_RETENTION_GRACE_MS = 10 * 60 * 1000;
const UPDATE_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

// Prod-only CSP. Dev leaves Vite HMR unrestricted (app.isPackaged gate below).
// 'unsafe-inline' on style-src kept — Tailwind/inline styles still in use.
const CSP_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  `connect-src 'self' http://localhost:*`,
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

function registerSecurityHeaders() {
  if (!app.isPackaged) return;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP_POLICY],
        'X-Content-Type-Options': ['nosniff'],
        'X-Frame-Options': ['DENY'],
        'Referrer-Policy': ['strict-origin-when-cross-origin'],
      },
    });
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
}

// Resolved at launch by resolveAppPort() — a persisted random free port.
let appPort = DEFAULT_APP_PORT;
let APP_URL = `http://localhost:${appPort}`;
let HEALTH_URL = `http://localhost:${appPort}/health`;
const GITHUB_OWNER = 'EraPartner';
const GITHUB_REPO = 'Vision';

// ── Settings (persisted across launches) ─────────────────────────────────────
const settingsPath = path.join(app.getPath('userData'), 'settings.json');

async function loadSettings() {
  let raw;
  try {
    raw = await fs.promises.readFile(settingsPath, 'utf8');
  } catch {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    try {
      const corruptPath = `${settingsPath}.corrupt-${Date.now()}`;
      await fs.promises.rename(settingsPath, corruptPath);
      console.warn(`[settings] Corrupt settings.json renamed to ${corruptPath}: ${err && err.message ? err.message : err}`);
    } catch (renameErr) {
      console.warn('[settings] Failed to quarantine corrupt settings.json:', renameErr && renameErr.message ? renameErr.message : renameErr);
    }
    return {};
  }
}

// Serialize every settings write through one promise chain so concurrent
// callers can neither interleave a read-modify-write (silently dropping each
// other's keys) nor observe a half-written file. Each write lands in a temp
// file that is atomically renamed into place — a crash mid-write leaves the
// previous good settings.json intact instead of corrupting it.
let settingsWriteChain = Promise.resolve();

async function writeSettingsAtomic(data) {
  await fs.promises.mkdir(path.dirname(settingsPath), { recursive: true });
  const tmpPath = `${settingsPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.promises.writeFile(tmpPath, JSON.stringify(data, null, 2));
    await fs.promises.rename(tmpPath, settingsPath);
  } catch (err) {
    try { await fs.promises.unlink(tmpPath); } catch { /* best effort */ }
    throw err;
  }
}

// Overwrite settings.json with `data`. Serialized + atomic. Prefer
// updateSettings() when the new value depends on the current one.
function saveSettings(data) {
  const run = settingsWriteChain.then(() => writeSettingsAtomic(data));
  // Keep the chain alive even if this write rejects, so later writes still run.
  settingsWriteChain = run.catch(() => {});
  return run;
}

// Atomic read-modify-write: load current settings, apply `mutate` to a copy,
// then persist — all inside the shared write chain, so two concurrent updaters
// can't clobber each other's keys. `mutate` may mutate the passed copy in place
// (return nothing) or return a replacement object. Replaces the racy
// `saveSettings({ ...(await loadSettings()), ... })` pattern.
function updateSettings(mutate) {
  const run = settingsWriteChain.then(async () => {
    const current = await loadSettings();
    const draft = { ...current };
    const result = await mutate(draft);
    const next = result !== undefined ? result : draft;
    await writeSettingsAtomic(next);
    return next;
  });
  settingsWriteChain = run.catch(() => {});
  return run;
}

// ── Backend host-port resolution ───────────────────────────────────────────────
// The backend container always listens on 3002 internally; we publish it on a
// host port that Electron both maps (PORT injected into compose) and polls
// (APP_URL/HEALTH_URL). Those two MUST agree or the splash hangs on "Almost
// ready…" forever. We pick a truly-random free port ONCE per app and persist it
// (settings.appPort): random so the demo and the real app never collide on a
// shared default; persisted so every relaunch reuses the same port, keeping the
// running container's published port valid (and the warm `compose start` fast
// path correct). composeStartOrUp() recreates the container if its published
// port ever drifts from this value.

// Resolve true if `port` can be bound on loopback right now (i.e. nothing else
// holds it). A port held by our own *running* container reads as not-free, which
// is fine: we never re-pick a persisted port, only validate freshly-chosen ones.
function isPortFree(port) {
  return new Promise((resolve) => {
    const net = require('net');
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

// Pick a random free host port in a stable, non-ephemeral range (avoids the OS
// ephemeral range used for outbound sockets). Falls back to DEFAULT_APP_PORT if,
// improbably, no candidate is free after several tries.
async function pickRandomFreePort(attempts = 64) {
  for (let i = 0; i < attempts; i++) {
    const candidate = 20000 + Math.floor(Math.random() * 40000); // 20000–59999
    if (await isPortFree(candidate)) return candidate;
  }
  return DEFAULT_APP_PORT;
}

// The persisted random port if present, else a freshly-picked one (persisted for
// next time). Stable across relaunches for a given app/userData.
async function resolveAppPort() {
  const s = await loadSettings();
  const persisted = Number(s.appPort);
  if (Number.isInteger(persisted) && persisted >= 1024 && persisted <= 65535) {
    return persisted;
  }
  const port = await pickRandomFreePort();
  try { await updateSettings((cur) => { cur.appPort = port; }); }
  catch (err) { console.warn('[port] failed to persist appPort:', err && err.message ? err.message : err); }
  return port;
}

// A persisted appPort is reused unconditionally (so the running container's
// published port stays valid). But if an unrelated process bound that port
// while Vision was down, `compose up`/`start` can't publish the app container
// on it and fails with a host-port collision — which, unrecovered, bricks every
// relaunch until the user hand-edits settings.json. Detect that specific failure
// so the caller can pick a fresh port and recreate. The message wording varies
// by platform/daemon, hence the several alternatives. run() rejects with the
// raw stderr string, so match against that.
function isPortConflictError(err) {
  const msg = String(err && err.message ? err.message : err).toLowerCase();
  return /already allocated|address already in use|bind for [^\n]*failed|ports are not available|failed to bind host port/.test(msg);
}

// Pick a fresh free port, persist it, and re-derive the URLs polled during boot.
// Used to self-heal after a foreign process squats the persisted appPort.
async function repickAppPort() {
  const port = await pickRandomFreePort();
  appPort = port;
  APP_URL = `http://localhost:${appPort}`;
  HEALTH_URL = `http://localhost:${appPort}/health`;
  try { await updateSettings((cur) => { cur.appPort = port; }); }
  catch (err) { console.warn('[port] failed to persist re-picked appPort:', err && err.message ? err.message : err); }
  return port;
}

// Extract the host port an existing compose `app` service is published on, from
// a `docker compose ps --format json` service object. The container's internal
// target port is always 3002. Returns undefined when not published/parseable.
function publishedHostPort(service) {
  const pubs = service?.Publishers || service?.publishers || [];
  for (const p of Array.isArray(pubs) ? pubs : []) {
    const target = Number(p.TargetPort ?? p.targetPort);
    const published = Number(p.PublishedPort ?? p.publishedPort);
    if (target === 3002 && Number.isInteger(published) && published > 0) return published;
  }
  return undefined;
}

// ── Repo/workDir resolution ───────────────────────────────────────────────────
// In dev (electron . from packaging/electron/): resolve two levels up.
// In packaged .app with repoPath setting: use the local clone (repo mode).
// In packaged .app without repoPath: uses embedded docker-compose.yml shipped in app resources.
async function resolveWorkDir() {
  if (!app.isPackaged) {
    return path.resolve(__dirname, '..', '..');
  }

  const settings = await loadSettings();

  // Repo mode: if settings.repoPath points to a valid clone, use it and build
  // from local source exactly like dev mode — no GHCR image needed.
  if (settings.repoPath && typeof settings.repoPath === 'string') {
    let canonicalRepoPath = null;
    try {
      // Resolve to absolute, then canonicalise to defeat ../ traversal and
      // symlink shenanigans before trusting the directory.
      const resolved = path.resolve(settings.repoPath);
      canonicalRepoPath = await fs.promises.realpath(resolved);
    } catch {
      canonicalRepoPath = null;
    }
    if (canonicalRepoPath) {
      const repoCompose = path.join(canonicalRepoPath, 'docker-compose.yml');
      const valid = await fs.promises.access(repoCompose).then(() => true).catch(() => false);
      if (valid) {
        useRepoMode = true;
        return canonicalRepoPath;
      }
    }
  }

  // Ensure the generated i18n is present in the packaged app resources
  try {
    const packagedI18n = path.join(process.resourcesPath, 'i18n');
    const packagedI18nExists = await fs.promises.access(packagedI18n).then(() => true).catch(() => false);
    if (!packagedI18nExists) {
      // If it's missing, attempt to copy from the repo i18n/source (best effort)
      const repoI18n = path.join(__dirname, '..', 'i18n');
      const repoI18nExists = await fs.promises.access(repoI18n).then(() => true).catch(() => false);
      if (repoI18nExists) {
        await fs.promises.mkdir(packagedI18n, { recursive: true });
        const files = await fs.promises.readdir(repoI18n);
        await Promise.all(files.map(async (f) => {
          const src = path.join(repoI18n, f);
          const dst = path.join(packagedI18n, f);
          try { await fs.promises.copyFile(src, dst); } catch (e) { /* ignore */ }
        }));
      }
    }
  } catch (e) {
    // Non-fatal — packaged app should include i18n via build step. If not,
    // dialogs will fallback to internal defaults.
  }

  const embeddedSrc = path.join(process.resourcesPath, 'resources', 'docker-compose.yml');

  // If we've already set up the embedded compose, reuse it — but refresh the
  // compose file from the packaged resources first. Without this, a compose
  // change shipped in a new app version (new named volume, healthcheck,
  // security opt) never reaches upgraded installs, only fresh ones — the
  // v1.0.2 data-loss channel. .env stays untouched: it carries the install's
  // generated secrets.
  const embeddedCompose = settings.embeddedDir && path.join(settings.embeddedDir, 'docker-compose.yml');
  const hasEmbedded = embeddedCompose && await fs.promises.access(embeddedCompose).then(() => true).catch(() => false);
  if (hasEmbedded) {
    try {
      const [current, packaged] = await Promise.all([
        fs.promises.readFile(embeddedCompose, 'utf8'),
        fs.promises.readFile(embeddedSrc, 'utf8'),
      ]);
      if (current !== packaged) {
        await fs.promises.copyFile(embeddedSrc, embeddedCompose);
      }
    } catch (err) {
      // Non-fatal: a launch with the existing (stale) compose beats no launch.
      console.warn('Embedded compose refresh failed (non-fatal):', err?.message || err);
    }
    return settings.embeddedDir;
  }

  // Copy embedded compose from resources to a writable app data folder.
  const embeddedDir = path.join(app.getPath('userData'), 'embedded_compose');
  try {
    await fs.promises.mkdir(embeddedDir, { recursive: true });
    const dest = path.join(embeddedDir, 'docker-compose.yml');
    // Overwrite if exists to allow updates on new app versions
    await fs.promises.copyFile(embeddedSrc, dest);
    await updateSettings((cur) => { cur.embeddedDir = embeddedDir; });
    return embeddedDir;
  } catch (err) {
    await dialog.showMessageBox({
      type: 'error',
      buttons: [t('common.ok')],
      title: APP_NAME,
      message: t('app.failedPrepareEmbedded'),
      detail: String(err),
    });
    app.quit();
    return null;
  }
}

// ── .env generation ───────────────────────────────────────────────────────────
// Canonical .env lives in the userData embedded_compose dir. Both packaged
// Vision.app (workDir = embeddedDir) and electron:dev (workDir = repo root)
// mirror from this single file, so POSTGRES_PASSWORD stays in sync across
// stacks. Without this, dev's repo .env and Vision.app's embeddedDir/.env
// drift, and whichever stack didn't initialize the postgres volume hits
// "password authentication failed" on connect.
function canonicalEnvPath() {
  return path.join(app.getPath('userData'), 'embedded_compose', '.env');
}

function generateFreshEnvContents() {
  const pgPass = crypto.randomBytes(32).toString('hex');
  return [
    '# Auto-generated by Vision on first launch. Do not commit this file.',
    `POSTGRES_PASSWORD=${pgPass}`,
    `DATABASE_URL=postgresql://ftm_user:${pgPass}@db:5432/financial_transactions`,
  ].join('\n') + '\n';
}

// Research provider API keys (ADR-079) are not part of the generated baseline, but
// the embedded stack (Vision.app) should pick up the same keys configured for dev
// or Docker (which live in the repo-root .env per ADR-080). These helpers merge any
// such keys into the canonical .env so `env_file: .env` injects them into the app
// container — without that, the desktop app's keyed providers stay unconfigured.
// MUST stay in sync with ENV_VAR_BY_PROVIDER in
// apps/node-backend/src/services/research/providerKeys.js. A key missing here is
// not merged into the canonical .env AND is stripped from the repo-root .env on
// the write-back below — so an unlisted key silently disappears on every launch.
const PROVIDER_KEY_VARS = [
  'TWELVE_DATA_API_KEY', 'FINNHUB_API_KEY', 'FMP_API_KEY', 'ALPHA_VANTAGE_API_KEY',
  'FRED_API_KEY', // macro vertical (ADR-082)
];

function parseEnvKeys(contents) {
  const map = new Map();
  for (const line of (contents || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    map.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  return map;
}

// Append provider keys present in `workContents` (e.g. the repo-root .env) or, as a
// fallback, process.env — but only those not already in `truth`. Existing values are
// never overwritten, so a key set in the canonical .env is stable across launches.
function mergeProviderKeys(truth, workContents) {
  const present = parseEnvKeys(truth);
  const fromWork = parseEnvKeys(workContents);
  const additions = [];
  for (const key of PROVIDER_KEY_VARS) {
    if (present.has(key)) continue;
    const value = fromWork.get(key) ?? process.env[key];
    if (value !== undefined && value !== '') additions.push(`${key}=${value}`);
  }
  if (additions.length === 0) return truth;
  return `${truth}${truth.endsWith('\n') ? '' : '\n'}${additions.join('\n')}\n`;
}

async function ensureEnv(workDir) {
  const canonicalEnv = canonicalEnvPath();
  const workEnv = path.join(workDir, '.env');
  await fs.promises.mkdir(path.dirname(canonicalEnv), { recursive: true });

  const canonicalContents = await fs.promises.readFile(canonicalEnv, 'utf8').catch(() => null);
  const workContents = await fs.promises.readFile(workEnv, 'utf8').catch(() => null);

  // Pick the source of truth: prefer canonical; if missing, promote workEnv;
  // if neither exists, generate a fresh one. This handles first-run in any
  // mode and migration from pre-canonical setups where only the repo .env
  // existed.
  let truth = canonicalContents;
  if (truth === null && workContents !== null) {
    truth = workContents;
  }
  if (truth === null) {
    truth = generateFreshEnvContents();
  }

  // Carry research provider API keys (ADR-079/080) into the embedded stack so the
  // desktop app gets the same keys as dev/Docker. Merged from the work .env (dev's
  // repo-root .env) or process.env; never overwrites values already in the .env.
  truth = mergeProviderKeys(truth, workContents);

  if (canonicalContents !== truth) {
    await fs.promises.writeFile(canonicalEnv, truth, { encoding: 'utf8', mode: 0o600 });
  }
  if (path.resolve(workEnv) !== path.resolve(canonicalEnv) && workContents !== truth) {
    await fs.promises.writeFile(workEnv, truth, { encoding: 'utf8', mode: 0o600 });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
// Extend PATH so the docker CLI is found when launched as a macOS .app.
// Whitelist only the env vars that docker/psql/bun actually need — inheriting
// all of process.env leaks secrets (API keys, tokens, etc.) into every
// spawned subprocess.
const DOCKER_ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TEMP', 'TMP',
  'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY',
  'XDG_RUNTIME_DIR', 'SSH_AUTH_SOCK',
];
const dockerEnv = (() => {
  const env = {};
  for (const key of DOCKER_ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.PATH = [process.env.PATH, '/usr/local/bin', '/opt/homebrew/bin'].filter(Boolean).join(':');
  return env;
})();

/**
 * Write `PGPASSWORD=<password>` to a mode-0600 temp file, invoke callback(envFilePath),
 * then delete the file. Prevents PGPASSWORD from appearing in `ps` / `docker inspect`.
 */
async function withPgPassEnvFile(password, callback) {
  const envFilePath = path.join(app.getPath('temp'), `pgpass_${Date.now()}_${process.pid}.env`);
  await fs.promises.writeFile(envFilePath, `PGPASSWORD=${password}\n`, { mode: 0o600 });
  try {
    return await callback(envFilePath);
  } finally {
    try { fs.unlinkSync(envFilePath); } catch (_) {}
  }
}

function run(bin, args, cwd, opts = {}) {
  const { env: envOverride, ...rest } = opts;
  const env = envOverride || dockerEnv;
  return new Promise((resolve, reject) => {
    // pg_dump bypasses run() and uses spawn() with stream-to-file — no in-memory
    // buffering. 10 MB is ample for all docker compose command outputs here.
    const maxBuffer = rest.maxBuffer ?? 10 * 1024 * 1024;
    execFile(bin, args, { env, cwd, ...rest, maxBuffer }, (err, stdout, stderr) => {
      if (err) return reject(stderr?.trim() || err.message || String(err));
      resolve(stdout);
    });
  });
}

function notify(body) {
  if (Notification.isSupported()) {
    new Notification({ title: APP_NAME, body }).show();
  }
}

// Validate a PostgreSQL identifier (username or database name).
// Restricts to safe characters so values can never break SQL strings or identifiers.
function validateIdentifier(name, label) {
  if (!/^[a-zA-Z0-9_]{1,63}$/.test(name)) {
    throw new Error(`Invalid ${label} in DATABASE_URL: "${name}". Only alphanumeric characters and underscores are allowed.`);
  }
}

// Parse DATABASE_URL from .env file contents and validate extracted identifiers.
// Returns { dbUser, dbPass, dbName } or throws on invalid/missing URL.
function parseDatabaseUrlFromEnv(envContents) {
  const lineMatch = envContents.match(/^DATABASE_URL=(.+)$/m);
  const rawUrl = lineMatch ? lineMatch[1].trim() : null;

  let dbUser = 'ftm_user';
  let dbPass = '';
  let dbName = 'financial_transactions';

  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      dbUser = decodeURIComponent(parsed.username) || dbUser;
      dbPass = decodeURIComponent(parsed.password) || dbPass;
      dbName = parsed.pathname.replace(/^\//, '') || dbName;
    } catch {
      // Keep defaults if URL is malformed
    }
  }

  validateIdentifier(dbUser, 'username');
  validateIdentifier(dbName, 'database name');
  return { dbUser, dbPass, dbName };
}

function getDefaultICloudBackupDir() {
  const root = path.join(app.getPath('home'), 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
  if (!fs.existsSync(root)) return '';
  return path.join(root, APP_NAME, 'Backups');
}

function resolveBackupSettingsWithDefaults(raw = {}) {
  const configuredDir = typeof raw.backupDir === 'string' ? raw.backupDir.trim() : '';
  const fallbackDir = getDefaultICloudBackupDir();
  const backupDir = configuredDir || fallbackDir || '';
  const backupOnQuit = configuredDir
    ? raw.backupOnQuit === true
    : Boolean(fallbackDir);
  return { backupDir, backupOnQuit };
}

async function getBackupDeviceId() {
  const settings = await loadSettings();
  if (typeof settings.backupDeviceId === 'string' && settings.backupDeviceId) {
    return settings.backupDeviceId;
  }
  const machineToken = [
    process.platform,
    process.arch,
    require('os').hostname(),
    app.getPath('userData'),
  ].join('|');
  const backupDeviceId = crypto.createHash('sha1').update(machineToken).digest('hex').slice(0, 8);
  await updateSettings((cur) => { cur.backupDeviceId = backupDeviceId; });
  return backupDeviceId;
}

async function getBackupPassphrase() {
  const envPassphrase = process.env.VISION_BACKUP_PASSPHRASE;
  if (envPassphrase) return envPassphrase;
  // Read the stored blob BEFORE touching safeStorage. On an unsigned/ad-hoc macOS
  // build every safeStorage call hits the keychain and triggers a password prompt,
  // so we never reach for it unless an encrypted passphrase actually exists.
  const settings = await loadSettings();
  const encoded = settings.backupPassphraseEncrypted;
  if (!encoded || typeof encoded !== 'string') return null;
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function' || !safeStorage.isEncryptionAvailable()) {
    return null;
  }
  try {
    const raw = Buffer.from(encoded, 'base64');
    return safeStorage.decryptString(raw);
  } catch {
    return null;
  }
}

async function setBackupPassphrase(passphrase) {
  if (!passphrase) {
    await updateSettings((cur) => { delete cur.backupPassphraseEncrypted; });
    return { success: true, available: true };
  }
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function' || !safeStorage.isEncryptionAvailable()) {
    return { success: false, available: false, error: 'OS secure storage is not available on this device.' };
  }
  try {
    const encrypted = safeStorage.encryptString(passphrase);
    const encoded = encrypted.toString('base64');
    await updateSettings((cur) => { cur.backupPassphraseEncrypted = encoded; });
    return { success: true, available: true };
  } catch (err) {
    return { success: false, available: true, error: String(err) };
  }
}

async function getBackupPassphraseStatus() {
  const settings = await loadSettings();
  const hasStoredPassphrase = typeof settings.backupPassphraseEncrypted === 'string' && settings.backupPassphraseEncrypted.length > 0;
  // Only probe isEncryptionAvailable() — which can trigger a keychain prompt on an
  // unsigned macOS build — when a passphrase is already stored (we need the key to
  // decrypt it anyway). With nothing stored, report availability from the API's mere
  // presence; setBackupPassphrase runs the real check when the user actually opts in.
  const hasSafeStorageApi = Boolean(safeStorage && typeof safeStorage.isEncryptionAvailable === 'function');
  const secureStorageAvailable = hasStoredPassphrase
    ? hasSafeStorageApi && safeStorage.isEncryptionAvailable()
    : hasSafeStorageApi;
  return {
    hasEnvPassphrase: Boolean(process.env.VISION_BACKUP_PASSPHRASE),
    hasStoredPassphrase,
    secureStorageAvailable,
  };
}

function deriveBackupKeyFromPassphrase(passphrase) {
  if (!passphrase || typeof passphrase !== 'string') return null;
  // Legacy v1: static salt, default scrypt params. Kept solely for decrypting
  // pre-existing v1 backups. Do not use for new encryptions — see deriveBackupKeyV2.
  return crypto.scryptSync(passphrase, `${APP_NAME.toLowerCase()}-backup-v1`, 32);
}

function deriveBackupKeyV2(passphrase, salt) {
  if (!passphrase || typeof passphrase !== 'string') return null;
  if (!Buffer.isBuffer(salt) || salt.length !== BACKUP_ENC_V2_SALT_BYTES) {
    throw new Error('deriveBackupKeyV2 requires a 16-byte salt');
  }
  return crypto.scryptSync(passphrase, salt, 32, {
    N: BACKUP_KDF_N,
    r: BACKUP_KDF_R,
    p: BACKUP_KDF_P,
    maxmem: 128 * BACKUP_KDF_N * BACKUP_KDF_R * 2,
  });
}

async function getBackupEncryptionKey() {
  const passphrase = await getBackupPassphrase();
  return deriveBackupKeyFromPassphrase(passphrase);
}

// Sentinel error messages used to drive UI passphrase prompts. The renderer
// recognises these strings to (re-)open the passphrase modal rather than
// surfacing a generic restore failure.
const ERR_PASSPHRASE_REQUIRED = 'PASSPHRASE_REQUIRED';
const ERR_INVALID_PASSPHRASE = 'INVALID_PASSPHRASE';

async function cleanupOldBackups(destDir, deviceId, keep = BACKUP_RETENTION_KEEP, graceMs = BACKUP_RETENTION_GRACE_MS) {
  const prefix = `vision_backup_${deviceId}_`;
  const now = Date.now();
  let names = [];
  try {
    names = await fs.promises.readdir(destDir);
  } catch {
    return { removed: 0 };
  }

  const files = await Promise.all(names
    .filter((name) => name.startsWith(prefix) && (
      name.endsWith('.sql') || name.endsWith('.sql.enc') ||
      name.endsWith('.visionbak') || name.endsWith('.visionbak.enc')
    ))
    .map(async (name) => {
      const fullPath = path.join(destDir, name);
      try {
        const stat = await fs.promises.stat(fullPath);
        return { fullPath, mtimeMs: stat.mtimeMs };
      } catch {
        return null;
      }
    }));

  const ordered = files.filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const stale = ordered.slice(keep).filter((f) => (now - f.mtimeMs) > graceMs);

  // Orphaned `*.partial` bundles are truncated writes from an interrupted
  // backup (createBundle renames partial → canonical only on clean finalize).
  // They never count toward retention; delete any older than the grace window
  // so an in-progress write is never yanked out from under the backup.
  const partials = names
    .filter((name) => name.startsWith(prefix) && name.endsWith('.partial'))
    .map((name) => path.join(destDir, name));

  let removed = 0;
  for (const file of stale) {
    try {
      await fs.promises.unlink(file.fullPath);
      removed += 1;
    } catch {
      // ignore individual file deletion errors
    }
  }
  for (const partialPath of partials) {
    try {
      const stat = await fs.promises.stat(partialPath);
      if ((now - stat.mtimeMs) > graceMs) {
        await fs.promises.unlink(partialPath);
        removed += 1;
      }
    } catch {
      // ignore individual file deletion errors
    }
  }
  return { removed };
}

async function isEncryptedBackupFile(filePath) {
  let handle;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const magic = Buffer.alloc(BACKUP_ENC_MAGIC.length);
    const { bytesRead } = await handle.read(magic, 0, magic.length, 0);
    if (bytesRead !== BACKUP_ENC_MAGIC.length) return false;
    return magic.equals(BACKUP_ENC_MAGIC) || magic.equals(BACKUP_ENC_MAGIC_V2);
  } catch {
    return false;
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* ignore */ }
    }
  }
}

async function encryptBackupFile(sqlFilePath) {
  const passphrase = await getBackupPassphrase();
  if (!passphrase) {
    return { file: sqlFilePath, encrypted: false, warning: 'Backup encryption skipped: VISION_BACKUP_PASSPHRASE is not set.' };
  }

  const encPath = `${sqlFilePath}.enc`;
  const salt = crypto.randomBytes(BACKUP_ENC_V2_SALT_BYTES);
  const iv = crypto.randomBytes(BACKUP_ENC_V2_IV_BYTES);
  const key = deriveBackupKeyV2(passphrase, salt);

  try {
    await new Promise((resolve, reject) => {
      const input = fs.createReadStream(sqlFilePath);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const output = fs.createWriteStream(encPath);

      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        input.destroy();
        cipher.destroy();
        output.destroy();
        fs.unlink(encPath, () => {});
        reject(err);
      };

      input.on('error', fail);
      cipher.on('error', fail);
      output.on('error', fail);

      output.write(BACKUP_ENC_MAGIC_V2);
      output.write(salt);
      output.write(iv);

      input.pipe(cipher);
      cipher.on('data', (chunk) => output.write(chunk));
      cipher.on('end', () => {
        try {
          const tag = cipher.getAuthTag();
          output.end(tag);
        } catch (err) {
          fail(err);
        }
      });

      output.on('finish', () => {
        if (settled) return;
        settled = true;
        resolve();
      });
    });
  } finally {
    if (Buffer.isBuffer(key)) key.fill(0);
  }

  fs.unlink(sqlFilePath, () => {});
  return { file: encPath, encrypted: true };
}

async function decryptBackupFileToTemp(encryptedFilePath, keyOrPassphrase) {
  if (!keyOrPassphrase) {
    throw new Error(ERR_PASSPHRASE_REQUIRED);
  }

  // Read magic to determine version.
  const magicLen = BACKUP_ENC_MAGIC.length;
  const magicBuf = Buffer.alloc(magicLen);
  let handle;
  try {
    handle = await fs.promises.open(encryptedFilePath, 'r');
    const { bytesRead } = await handle.read(magicBuf, 0, magicLen, 0);
    if (bytesRead !== magicLen) {
      throw new Error('Invalid encrypted backup header.');
    }
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* ignore */ }
    }
  }

  if (magicBuf.equals(BACKUP_ENC_MAGIC_V2)) {
    return decryptBackupV2(encryptedFilePath, keyOrPassphrase);
  }
  if (magicBuf.equals(BACKUP_ENC_MAGIC)) {
    return decryptBackupV1(encryptedFilePath, keyOrPassphrase);
  }
  throw new Error('Backup is not in a supported encrypted format.');
}

async function decryptBackupV1(encryptedFilePath, keyOrPassphrase) {
  const key = Buffer.isBuffer(keyOrPassphrase)
    ? keyOrPassphrase
    : deriveBackupKeyFromPassphrase(keyOrPassphrase);
  if (!key) throw new Error(ERR_PASSPHRASE_REQUIRED);

  const headerLen = BACKUP_ENC_MAGIC.length + BACKUP_ENC_IV_BYTES;
  const header = Buffer.alloc(headerLen);
  let handle;
  try {
    handle = await fs.promises.open(encryptedFilePath, 'r');
    const { bytesRead } = await handle.read(header, 0, headerLen, 0);
    if (bytesRead !== headerLen) throw new Error('Invalid encrypted backup header.');
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* ignore */ }
    }
  }

  const iv = header.subarray(BACKUP_ENC_MAGIC.length, headerLen);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const tempSqlPath = path.join(app.getPath('temp'), `vision_restore_${Date.now()}_${process.pid}.sql`);

  try {
    await new Promise((resolve, reject) => {
      const input = fs.createReadStream(encryptedFilePath, { start: headerLen });
      const output = fs.createWriteStream(tempSqlPath);
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        input.destroy(); decipher.destroy(); output.destroy();
        fs.unlink(tempSqlPath, () => {});
        reject(err);
      };
      input.on('error', fail);
      decipher.on('error', fail);
      output.on('error', fail);
      input.pipe(decipher).pipe(output);
      output.on('finish', () => { if (!settled) { settled = true; resolve(); } });
    });
  } catch (err) {
    const msg = err && err.message ? String(err.message) : '';
    if (/bad decrypt/i.test(msg) || /wrong final block/i.test(msg) || (err && err.code === 'ERR_OSSL_BAD_DECRYPT')) {
      throw new Error(ERR_INVALID_PASSPHRASE);
    }
    throw err;
  } finally {
    if (typeof keyOrPassphrase === 'string' && Buffer.isBuffer(key)) key.fill(0);
  }

  return tempSqlPath;
}

async function decryptBackupV2(encryptedFilePath, keyOrPassphrase) {
  const headerLen = BACKUP_ENC_MAGIC_V2.length + BACKUP_ENC_V2_SALT_BYTES + BACKUP_ENC_V2_IV_BYTES;
  const header = Buffer.alloc(headerLen);
  const stat = await fs.promises.stat(encryptedFilePath);
  if (stat.size < headerLen + BACKUP_ENC_V2_TAG_BYTES) {
    throw new Error('Invalid encrypted backup: file too small.');
  }
  const tagOffset = stat.size - BACKUP_ENC_V2_TAG_BYTES;
  const tag = Buffer.alloc(BACKUP_ENC_V2_TAG_BYTES);
  let handle;
  try {
    handle = await fs.promises.open(encryptedFilePath, 'r');
    const h = await handle.read(header, 0, headerLen, 0);
    if (h.bytesRead !== headerLen) throw new Error('Invalid encrypted backup header.');
    const t = await handle.read(tag, 0, BACKUP_ENC_V2_TAG_BYTES, tagOffset);
    if (t.bytesRead !== BACKUP_ENC_V2_TAG_BYTES) throw new Error('Invalid encrypted backup auth tag.');
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* ignore */ }
    }
  }

  const salt = header.subarray(BACKUP_ENC_MAGIC_V2.length, BACKUP_ENC_MAGIC_V2.length + BACKUP_ENC_V2_SALT_BYTES);
  const iv = header.subarray(BACKUP_ENC_MAGIC_V2.length + BACKUP_ENC_V2_SALT_BYTES, headerLen);

  let key;
  if (Buffer.isBuffer(keyOrPassphrase)) {
    key = keyOrPassphrase;
  } else {
    key = deriveBackupKeyV2(keyOrPassphrase, salt);
  }
  if (!key) throw new Error(ERR_PASSPHRASE_REQUIRED);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const tempSqlPath = path.join(app.getPath('temp'), `vision_restore_${Date.now()}_${process.pid}.sql`);

  const cipherTextLen = stat.size - headerLen - BACKUP_ENC_V2_TAG_BYTES;
  try {
    await new Promise((resolve, reject) => {
      const input = fs.createReadStream(encryptedFilePath, { start: headerLen, end: headerLen + cipherTextLen - 1 });
      const output = fs.createWriteStream(tempSqlPath);
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        input.destroy(); decipher.destroy(); output.destroy();
        fs.unlink(tempSqlPath, () => {});
        reject(err);
      };
      input.on('error', fail);
      decipher.on('error', fail);
      output.on('error', fail);
      input.pipe(decipher).pipe(output);
      output.on('finish', () => { if (!settled) { settled = true; resolve(); } });
    });
  } catch (err) {
    const msg = err && err.message ? String(err.message) : '';
    if (
      /unable to authenticate/i.test(msg)
      || /bad decrypt/i.test(msg)
      || /unsupported state/i.test(msg)
      || (err && err.code === 'ERR_OSSL_BAD_DECRYPT')
      || (err && err.code === 'ERR_CRYPTO_INVALID_AUTH_TAG')
    ) {
      throw new Error(ERR_INVALID_PASSPHRASE);
    }
    throw err;
  } finally {
    if (typeof keyOrPassphrase === 'string' && Buffer.isBuffer(key)) key.fill(0);
  }

  return tempSqlPath;
}

// Reused keep-alive agent so successive /health probes share a TCP socket
// instead of paying handshake cost per attempt.
const healthAgent = new http.Agent({ keepAlive: true, maxSockets: 1, keepAliveMsecs: 1000 });

// Single /health request — resolves true when 2xx/3xx, false otherwise.
function pingHealth(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(HEALTH_URL, { agent: healthAgent }, (res) => {
      const ok = res.statusCode >= 200 && res.statusCode < 400;
      res.resume();
      resolve(ok);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
  });
}

// Poll /health until success or timeout. Tight cadence for the first ~2s
// (when the backend usually comes up on warm boots), then back off to the
// standard interval. Total budget unchanged.
const HEALTH_POLL_FAST_INTERVAL_MS = 100;
const HEALTH_POLL_FAST_ATTEMPTS = 20;
function pollHealth(maxAttempts = HEALTH_POLL_ATTEMPTS) {
  return new Promise((resolve, reject) => {
    let tries = 0;
    const attempt = async () => {
      if (await pingHealth()) return resolve();
      tries += 1;
      if (tries >= maxAttempts) return reject(new Error('timeout'));
      const interval = tries < HEALTH_POLL_FAST_ATTEMPTS
        ? HEALTH_POLL_FAST_INTERVAL_MS
        : HEALTH_POLL_INTERVAL_MS;
      setTimeout(attempt, interval);
    };
    attempt();
  });
}

// Single /health/detailed probe used to gate the FIRST navigation on warmup
// readiness — the plain /health (above) flips to 200 the moment Express listens,
// which is before the dashboard's materialized views are refreshed, so navigating
// on it paints an empty dashboard on cold starts. Resolves { ready } when the
// dashboard-relevant data is populated, or undefined when the server isn't up yet.
// Falls back to ready on a missing endpoint (older backend) or unparseable 2xx so
// we never block longer than the liveness check would have.
function pingReady(timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(`${APP_URL}/health/detailed`, { agent: healthAgent }, (res) => {
      const code = res.statusCode;
      if (code === 404) { res.resume(); return resolve({ ready: true }); }
      if (code < 200 || code >= 400) { res.resume(); return resolve(undefined); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const d = JSON.parse(body);
          // `materializedViews` backs the dashboard aggregations; gate on it rather
          // than full `ready` so a slow/offline network warmup can't stall startup.
          resolve({ ready: d.status === 'ready' || d?.caches?.materializedViews === true });
        } catch {
          resolve({ ready: true });
        }
      });
    });
    req.on('error', () => resolve(undefined));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(undefined); });
  });
}

// Same cadence/budget as pollHealth, but waits for warmup readiness, not just
// liveness. Used only for the initial navigation; restart/update flows keep using
// the lighter pollHealth liveness probe.
function pollReady(maxAttempts = HEALTH_POLL_ATTEMPTS) {
  return new Promise((resolve, reject) => {
    let tries = 0;
    const attempt = async () => {
      const status = await pingReady();
      if (status && status.ready) return resolve();
      tries += 1;
      if (tries >= maxAttempts) return reject(new Error('timeout'));
      const interval = tries < HEALTH_POLL_FAST_ATTEMPTS
        ? HEALTH_POLL_FAST_INTERVAL_MS
        : HEALTH_POLL_INTERVAL_MS;
      setTimeout(attempt, interval);
    };
    attempt();
  });
}

// Load the error.html shell with localized strings + returns URL the window
// should present.
function loadErrorPage() {
  if (!mainWindow) return;
  const params = new URLSearchParams({
    title: t('app.errorPageTitle'),
    msg: t('app.errorPageMessage'),
    retry: t('app.errorPageRetry'),
    logs: t('app.errorPageOpenLogs'),
  });
  const pageUrl = `file://${path.join(__dirname, 'assets', 'error.html')}?${params.toString()}`;
  mainWindow.loadURL(pageUrl);
}

// Drive health polling → app load with watchdog once healthy. Safe to call
// more than once (e.g. from the retry button).
let healthWatchdogTimer = null;
let watchdogFailureCount = 0;
let backendReportedLost = false;

function stopHealthWatchdog() {
  if (healthWatchdogTimer) {
    clearInterval(healthWatchdogTimer);
    healthWatchdogTimer = null;
  }
  watchdogFailureCount = 0;
  backendReportedLost = false;
}

function startHealthWatchdog() {
  stopHealthWatchdog();
  healthWatchdogTimer = setInterval(async () => {
    const healthy = await pingHealth(3000);
    if (healthy) {
      if (backendReportedLost && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('backend:restored');
      }
      watchdogFailureCount = 0;
      backendReportedLost = false;
      return;
    }
    watchdogFailureCount += 1;
    if (
      !backendReportedLost &&
      watchdogFailureCount >= HEALTH_WATCHDOG_FAILURE_THRESHOLD &&
      mainWindow &&
      !mainWindow.isDestroyed()
    ) {
      backendReportedLost = true;
      mainWindow.webContents.send('backend:lost', { message: t('app.backendLost') });
    }
  }, HEALTH_WATCHDOG_INTERVAL_MS);
}

// When the initial boot poll times out onto the error page, keep probing in the
// background so a genuinely slow start — e.g. a long alembic migration after a
// packaged image update, which can outlast even the extended poll budget — still
// lands the user on the app once the backend finally answers, instead of
// stranding them on the error page until they press Retry. Bounded, and self-
// cancels the moment the window leaves the error page (manual Retry, or nav).
let renavTimer = null;
function stopRenavigateWhenReady() {
  if (renavTimer) { clearTimeout(renavTimer); renavTimer = null; }
}
function renavigateWhenReady(maxAttempts = HEALTH_POLL_BUILD_ATTEMPTS) {
  stopRenavigateWhenReady();
  let tries = 0;
  const tick = async () => {
    renavTimer = null;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    // Give up as soon as we're no longer on the error page — a successful Retry
    // (or any other navigation) has taken over.
    let url = '';
    try { url = mainWindow.webContents.getURL(); } catch { return; }
    if (!url.includes('error.html')) return;
    const status = await pingReady();
    if (status && status.ready) {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(APP_URL);
      notify(t('app.running'));
      startHealthWatchdog();
      return;
    }
    tries += 1;
    if (tries >= maxAttempts) return;
    renavTimer = setTimeout(tick, HEALTH_POLL_INTERVAL_MS);
  };
  renavTimer = setTimeout(tick, HEALTH_POLL_INTERVAL_MS);
}

function pollAndLoad({ building = false } = {}) {
  const endPollHealth = bootMark('poll_ready');
  // A fresh boot poll supersedes any background re-navigation loop still running
  // from a previous timeout.
  stopRenavigateWhenReady();
  pollReady(building ? HEALTH_POLL_BUILD_ATTEMPTS : HEALTH_POLL_ATTEMPTS)
    .then(() => {
      endPollHealth();
      if (mainWindow) mainWindow.loadURL(APP_URL);
      notify(t('app.running'));
      startHealthWatchdog();
      bootSummary('launch_total');
    })
    .catch(() => {
      endPollHealth();
      loadErrorPage();
      // Keep polling in the background so a still-running migration that finishes
      // after the budget elapses re-navigates to the app on its own.
      renavigateWhenReady();
      // A cold build already got the longer budget that covers backend boot; if it
      // still isn't up, drop to the error page (with Retry) but skip the blocking
      // "taking longer than expected" modal — that warning is meant for warm boots
      // where a slow start is genuinely unexpected, not a first/dev rebuild.
      if (building) return;
      dialog.showMessageBox({
        type: 'warning',
        buttons: [t('common.ok')],
        title: APP_NAME,
        message: t('app.startSlow'),
        detail: t('app.startSlowDetail', { url: APP_URL }),
      });
    });
}

// ── Docker checks ─────────────────────────────────────────────────────────────
// A single `docker info` call tells us both: if docker isn't on PATH it throws
// ENOENT (not installed); if Docker Desktop isn't running it exits non-zero.
// Returns 'ok' | 'not-installed' | 'not-running'
// Ping the Docker daemon via its Unix socket /_ping endpoint — much faster
// than `docker info` (no CLI spawn overhead, no daemon serialization of full
// engine state). Returns a promise that resolves on HTTP 200 or rejects.
function pingDockerSocket(socketPath) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { socketPath, path: '/_ping', timeout: 2000 },
      (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else reject(new Error(`/_ping status ${res.statusCode}`));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('socket timeout')); });
  });
}

// Candidate Docker Unix-socket paths, most-specific first. Shared by the daemon
// ping and the container-state probe below.
function dockerSocketCandidates() {
  const homeDir = process.env.HOME || '';
  return [
    process.env.DOCKER_HOST?.replace(/^unix:\/\//, ''),
    path.join(homeDir, '.docker', 'run', 'docker.sock'),
    path.join(homeDir, '.docker', 'desktop', 'docker.sock'),
    '/var/run/docker.sock',
  ].filter(Boolean);
}

// GET a JSON body from the Docker Engine socket. Resolves the parsed body on 200,
// rejects otherwise (or on timeout). Same lightweight pattern as pingDockerSocket.
function dockerSocketGetJson(socketPath, urlPath, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.get({ socketPath, path: urlPath, timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`status ${res.statusCode}`)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('socket timeout')); });
  });
}

// True when the compose `app` service container is already running, checked via
// the Docker socket (~15–20ms) instead of a `docker compose images` CLI spawn
// (~150–250ms). Used to skip the pre-pull image-presence check on warm boots,
// where the image is necessarily present. `projectName` (the compose `name:`)
// scopes the match to THIS install so a sibling demo/app can't answer for us.
// Any failure resolves false → the caller falls back to the CLI check, so a
// wrong answer can only cost the spawn we hoped to save, never correctness
// (a running container guarantees its image is present).
async function isComposeAppRunning(projectName) {
  // The request itself is scoped only by the fixed compose service label — the
  // project name (read from the compose file on disk) is deliberately NOT put
  // into the outbound request; it only filters the returned list in memory, so
  // no file-derived data reaches the network sink.
  const filters = encodeURIComponent(JSON.stringify({
    label: ['com.docker.compose.service=app'],
    status: ['running'],
  }));
  const urlPath = `/containers/json?filters=${filters}`;
  for (const socketPath of dockerSocketCandidates()) {
    try {
      await fs.promises.access(socketPath);
      const list = await dockerSocketGetJson(socketPath, urlPath);
      if (Array.isArray(list) && list.some((c) => !projectName
        || (c && c.Labels && c.Labels['com.docker.compose.project'] === projectName))) {
        return true;
      }
    } catch { /* try next candidate */ }
  }
  return false;
}

// The compose project name is declared via the `name:` top-level key in the
// shipped compose file; Docker labels running containers with it. Read it once,
// synchronously, so isComposeAppRunning() can scope its match. Undefined on any
// read/parse miss (probe then matches by service label alone).
function readComposeProjectName(cwd) {
  try {
    const txt = fs.readFileSync(path.join(cwd, 'docker-compose.yml'), 'utf8');
    const m = txt.match(/^name:\s*(\S+)\s*$/m);
    if (m) return m[1];
  } catch { /* fall through */ }
  return undefined;
}

async function checkDocker(cwd) {
  // Fast path: hit the Docker socket directly — avoids spawning docker CLI
  // and serialising `docker info` output (~6s → <50ms on warm macOS).
  const socketCandidates = dockerSocketCandidates();

  // Race all socket candidates in parallel instead of probing them serially: a
  // dead candidate (missing socket, or the daemon still waking from resource-
  // saver idle) no longer stacks its full 2s timeout ahead of the live one, so
  // the wake path is bounded by the single slowest probe rather than their sum.
  try {
    await Promise.any(socketCandidates.map(async (socketPath) => {
      await fs.promises.access(socketPath);
      await pingDockerSocket(socketPath);
    }));
    return 'ok';
  } catch {
    // No candidate answered (all sockets missing / daemon not responding) —
    // fall through to the docker CLI probe below.
  }

  // Fallback: docker info (distinguishes "not installed" from "not running")
  try {
    await run('docker', ['info'], cwd, { timeout: 5000 });
    return 'ok';
  } catch (err) {
    if (/ENOENT|not found|no such file/i.test(String(err))) return 'not-installed';
    return 'not-running';
  }
}

// After opening Docker Desktop, poll the daemon until it answers. Docker rarely
// autostarts after a reboot and takes ~20–45s to come up cold, so rather than
// quitting and making the user relaunch (and risk hitting the same dialog if
// they relaunch too early), we keep the splash up and wait. Resolves 'ok' as
// soon as the daemon responds, or 'not-running' after the budget elapses. The
// user can still abort with ⌘Q, which reaches the will-quit handler.
async function waitForDockerDaemon(cwd, { budgetMs = 90000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (mainWindow && mainWindow.isDestroyed()) return 'not-running';
    if ((await checkDocker(cwd)) === 'ok') return 'ok';
    if (Date.now() >= deadline) return 'not-running';
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ── Docker Compose actions ────────────────────────────────────────────────────
function composeArgs(cwd, extraFiles = []) {
  // Build -f flags: always start with the base docker-compose.yml, then any overrides.
  const files = [
    path.join(cwd, 'docker-compose.yml'),
    ...extraFiles,
  ];
  return files.flatMap(f => ['-f', f]);
}

function startContainers(cwd, extraFiles = [], skipBuild = false) {
  const args = [
    'compose', ...composeArgs(cwd, extraFiles),
    'up', '-d',
    ...((app.isPackaged && !useRepoMode) || skipBuild ? [] : ['--build']),
  ];
  // Inject the resolved port so docker-compose.yml's ${PORT:-3002} interpolation
  // maps the correct host port → container 3002.
  const env = { ...dockerEnv, PORT: String(appPort) };
  return run('docker', args, cwd, { timeout: 300000, env });
}

// `docker compose ps --format json` emits NDJSON in newer compose versions
// and a JSON array in older ones — handle both.
function parseComposePsOutput(out) {
  if (!out) return [];
  const trimmed = out.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try { return JSON.parse(trimmed); } catch { return []; }
  }
  return trimmed.split('\n')
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

// Warm-boot fast path: skip or minimise compose invocation when containers
// already exist. Priority order:
//   1. All running → return immediately (works in all modes)
//   2. All stopped (exited/created) + not a dev rebuild → `compose start`
//   3. Fallback → `compose up [-d [--build]]`
//
// Returns { built: true } when `up --build` actually ran, { built: false } otherwise.
async function composeStartOrUp(cwd, extraFiles = [], skipBuild = false) {
  try {
    const psOut = await run(
      'docker',
      ['compose', ...composeArgs(cwd, extraFiles), 'ps', '--all', '--format', 'json'],
      cwd,
      { timeout: 15000 }
    );
    const services = parseComposePsOutput(psOut);
    if (services.length > 0) {
      const getState = s => String(s?.State || s?.state || '').toLowerCase();
      // The `start` fast paths reuse the existing container AS-IS, and
      // `docker compose start` cannot remap a published port. If the existing app
      // container is published on a different host port than the one we resolved
      // (and will poll), reusing it would leave Electron polling a dead port and
      // hanging on "Almost ready…". Only take a fast path when the ports agree;
      // otherwise fall through to `up`, which recreates the container on appPort.
      const appSvc = services.find(s => (s.Service || s.service) === 'app');
      const portMatches = !appSvc || publishedHostPort(appSvc) === appPort;
      // All already running — skip if packaged (no build possible) or if the
      // skip-build cache confirmed the running image matches the current source.
      // In dev mode without a cache hit, fall through so `compose up --build`
      // can detect whether the running containers have stale code.
      if (portMatches && services.every(s => getState(s) === 'running') && ((app.isPackaged && !useRepoMode) || skipBuild)) return { built: false };
      // All in a known stopped state + not a forced dev rebuild → compose start.
      const knownStates = new Set(['running', 'exited', 'created', 'paused']);
      const canUseStart = (app.isPackaged && !useRepoMode) || skipBuild;
      if (portMatches && canUseStart && services.every(s => knownStates.has(getState(s)))) {
        const env = { ...dockerEnv, PORT: String(appPort) };
        await run(
          'docker',
          ['compose', ...composeArgs(cwd, extraFiles), 'start'],
          cwd,
          { timeout: 60000, env }
        );
        return { built: false };
      }
    }
  } catch (err) {
    console.warn('composeStartOrUp probe failed; falling back to up:', err);
  }
  await startContainers(cwd, extraFiles, skipBuild);
  return { built: !skipBuild && (!app.isPackaged || useRepoMode) };
}

// `stop`, not `down`: keeping the stopped containers + network around is what
// lets composeStartOrUp()'s `compose start` fast path fire on the next launch
// (a `down` here forced full container/network recreation on every boot).
// The clean-run flow does its own `down --volumes` at launch, and
// `restart: unless-stopped` treats user-stopped containers as stopped, so
// nothing auto-revives them when the Docker daemon restarts.
function stopContainers(cwd, extraFiles = []) {
  const args = ['compose', ...composeArgs(cwd, extraFiles), 'stop'];
  return run('docker', args, cwd, { timeout: 60000 });
}

// Pull the latest Docker image tag for the app service without stopping the DB.
// Returns true if a new image was pulled, false if already up to date.
async function pullLatestImage(cwd, extraFiles = []) {
  try {
    const output = await run('docker', ['compose', ...composeArgs(cwd, extraFiles), 'pull', 'app'], cwd, { timeout: 120000 });
    // docker compose pull outputs "Pulled" when a new layer was downloaded
    return /pulled/i.test(output);
  } catch (err) {
    console.warn('docker compose pull failed (non-fatal):', err);
    return false;
  }
}

// Restart only the app container (not the db) to pick up the new image.
async function restartAppContainer(cwd, extraFiles = []) {
  const args = ['compose', ...composeArgs(cwd, extraFiles), 'up', '-d', '--no-deps', 'app'];
  // Same PORT injection as every other compose start path: `up` recreates the
  // container, and without it compose falls back to ${PORT:-3002} — republishing
  // on 3002 (wrong CORS too) while Electron keeps polling the persisted appPort.
  const env = { ...dockerEnv, PORT: String(appPort) };
  await run('docker', args, cwd, { timeout: 120000, env });
}

// ── Main window ───────────────────────────────────────────────────────────────
let mainWindow = null;

// ── Boot splash ───────────────────────────────────────────────────────────────
// Localized, theme-aware splash shown before any Docker I/O. The renderer mirrors
// the active palette's primary colors into settings.json (theme:persist-splash),
// so the splash paints in the chosen theme (emerald on default, purple on
// dracula, …). Falls back to neutral slate (light/dark via prefers-color-scheme)
// when nothing has been persisted yet — e.g. the very first launch.
// setSplashStatus() narrates the slow boot phases (image pull, service start).
const SPLASH_THEME_KEY = 'splashTheme';

// HSL component strings only ("158 64% 52%"): digits, spaces, %, dots. The value
// is interpolated into the splash HTML/CSS, so this guards against CSS/HTML
// injection — anything outside the pattern is rejected and the slate fallback wins.
const HSL_COMPONENTS_RE = /^\d{1,3}(?:\.\d+)?\s+\d{1,3}(?:\.\d+)?%\s+\d{1,3}(?:\.\d+)?%$/;
function isValidHslComponents(value) {
  return typeof value === 'string' && value.length <= 32 && HSL_COMPONENTS_RE.test(value);
}

function readSplashTheme() {
  try {
    const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const theme = data?.[SPLASH_THEME_KEY];
    if (!theme || !isValidHslComponents(theme.background) || !isValidHslComponents(theme.foreground)) {
      return undefined;
    }
    return { background: theme.background, foreground: theme.foreground };
  } catch {
    return undefined;
  }
}

// Derive the splash colors from the persisted primary (e.g. "158 64% 52%").
// The raw primary is a vivid accent — full-screen it reads as a neon block — so
// instead we mirror the app's own backdrop: a near-black base carrying just the
// primary's hue, lifted by a soft radial glow of the bright accent behind the
// logo ("pretty much black with a light emerald shine"). The persisted
// `foreground` (primary-foreground, meant for ink *on* the bright accent) is
// intentionally ignored — on a near-black fill we want light text.
function deriveSplashPalette(primary) {
  const m = /^(\d{1,3}(?:\.\d+)?)\s+(\d{1,3}(?:\.\d+)?)%\s+\d{1,3}(?:\.\d+)?%$/.exec(primary);
  if (!m) return undefined;
  const hue = m[1];
  const sat = Number(m[2]);
  return {
    base: `${hue} ${Math.round(Math.min(sat, 45))}% 6%`,   // near-black, faintly hued
    glow: primary,                                          // bright accent → the "shine"
    foreground: `${hue} ${Math.round(Math.min(sat, 24))}% 88%`,
  };
}

function splashDataUrl() {
  const theme = readSplashTheme();
  const derived = theme ? deriveSplashPalette(theme.background) : undefined;
  const palette = derived
    ? `body {
    background:
      radial-gradient(85% 60% at 50% 38%, hsl(${derived.glow} / 0.16), transparent 70%),
      hsl(${derived.base});
    color: hsl(${derived.foreground} / 0.82);
  }
  .name { color: hsl(${derived.foreground}); }`
    : `body { background: #0f172a; color: #94a3b8; }
  .name { color: #e2e8f0; }
  @media (prefers-color-scheme: light) {
    body { background: #f8fafc; color: #475569; }
    .name { color: #1e293b; }
  }`;
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; height: 100vh; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 14px;
    font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    -webkit-font-smoothing: antialiased; user-select: none; cursor: default;
  }
  ${palette}
  .spinner {
    width: 26px; height: 26px; border-radius: 50%;
    border: 2.5px solid currentColor; border-top-color: transparent;
    opacity: 0.55; animation: spin 0.9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { display: none; } }
  .name { font-size: 15px; font-weight: 600; letter-spacing: 0.01em; }
  .status { font-size: 13px; font-variant-numeric: tabular-nums; }
</style></head><body>
  <div class="spinner"></div>
  <div class="name">${APP_NAME}</div>
  <div class="status" id="splash-status">${t('splash.starting')}</div>
</body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function setSplashStatus(key) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // Only while the splash is still showing — never poke the real app.
  if (!mainWindow.webContents.getURL().startsWith('data:')) return;
  mainWindow.webContents
    .executeJavaScript(
      `(() => { const el = document.getElementById('splash-status'); if (el) el.textContent = ${JSON.stringify(t(key))}; })()`,
      true,
    )
    .catch(() => { /* splash already navigated away */ });
}

// The compose `up`/`start` phase is the dominant span of a warm boot, and
// "Starting services…" would otherwise sit frozen through all of it. Advance the
// splash to the next honest, already-localized status ("Almost ready…") once the
// phase has run long enough that it's fair, so the line visibly progresses
// instead of freezing. Pure setSplashStatus work — its data:-URL guard keeps it
// safe once the splash navigates away — and uses existing i18n keys only.
let splashProgressTimer = null;
function startComposeSplashProgress() {
  stopComposeSplashProgress();
  splashProgressTimer = setTimeout(() => {
    splashProgressTimer = null;
    setSplashStatus('splash.waitingApp');
  }, 6000);
  if (splashProgressTimer && splashProgressTimer.unref) splashProgressTimer.unref();
}
function stopComposeSplashProgress() {
  if (splashProgressTimer) { clearTimeout(splashProgressTimer); splashProgressTimer = null; }
}

// ── Window-state persistence ──────────────────────────────────────────────────
// Restore frame across launches (baseline macOS behavior). Bounds live in the
// existing settings.json mirror under `windowBounds`; saved debounced on
// resize/move, restored clamped to the matching display's workArea so an
// unplugged monitor can't strand the window off-screen.
const WINDOW_BOUNDS_KEY = 'windowBounds';
const WINDOW_MIN_WIDTH = 800;
const WINDOW_MIN_HEIGHT = 600;
const WINDOW_BOUNDS_SAVE_DEBOUNCE_MS = 500;

// Sync read: createWindow() runs once, before any window exists, and the
// splash must not wait on async settings I/O ordering.
function readSavedWindowBounds() {
  try {
    const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const b = data?.[WINDOW_BOUNDS_KEY];
    if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return undefined;
    return b;
  } catch {
    return undefined;
  }
}

function clampBoundsToWorkArea(bounds) {
  const wa = (screen.getDisplayMatching(bounds) || screen.getPrimaryDisplay()).workArea;
  const width = Math.max(WINDOW_MIN_WIDTH, Math.min(bounds.width, wa.width));
  const height = Math.max(WINDOW_MIN_HEIGHT, Math.min(bounds.height, wa.height));
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  return {
    width,
    height,
    x: clamp(bounds.x, wa.x, wa.x + wa.width - width),
    y: clamp(bounds.y, wa.y, wa.y + wa.height - height),
  };
}

// Hex equivalent of the splash's base fill, used for the BrowserWindow
// backgroundColor so frame 1 matches the splash instead of flashing the default
// backdrop (white / vibrancy material) before the data-URL splash HTML paints —
// visible in dark mode, and on Windows/Linux reload/navigation where the
// darwin-only vibrancy mask doesn't apply. Falls back to the same slate the
// splash uses when no theme is persisted.
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const color = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function splashBackgroundColor() {
  try {
    const theme = readSplashTheme();
    const derived = theme ? deriveSplashPalette(theme.background) : undefined;
    if (derived) {
      const m = /^(\d{1,3}(?:\.\d+)?)\s+(\d{1,3}(?:\.\d+)?)%\s+(\d{1,3}(?:\.\d+)?)%$/.exec(derived.base);
      if (m) return hslToHex(Number(m[1]), Number(m[2]), Number(m[3]));
    }
  } catch { /* fall through to slate */ }
  return '#0f172a';
}

let windowBoundsSaveTimer = null;
function scheduleWindowBoundsSave(win) {
  if (windowBoundsSaveTimer) clearTimeout(windowBoundsSaveTimer);
  windowBoundsSaveTimer = setTimeout(async () => {
    windowBoundsSaveTimer = null;
    if (!win || win.isDestroyed()) return;
    try {
      // getNormalBounds: a maximized/fullscreen window records its restored
      // frame, not the screen size.
      const bounds = win.getNormalBounds();
      await updateSettings((cur) => { cur[WINDOW_BOUNDS_KEY] = bounds; });
    } catch (err) {
      console.warn('window-bounds save failed (non-fatal):', err.message || err);
    }
  }, WINDOW_BOUNDS_SAVE_DEBOUNCE_MS);
}

function createWindow() {
  const savedBounds = readSavedWindowBounds();
  mainWindow = new BrowserWindow({
    ...(savedBounds
      ? clampBoundsToWorkArea(savedBounds)
      : { width: 1280, height: 800 }),
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    title: APP_NAME,
    // Paint the very first frame in the splash's base color so there's no
    // white/vibrancy flash before the splash HTML (or a reloaded document) paints.
    backgroundColor: splashBackgroundColor(),
    // macOS-native chrome: frameless content with inset traffic lights. The
    // renderer adds a drag region + left inset to its topbar when it detects
    // electronAPI.platform === 'darwin' (see ElectronBridge in the frontend).
    // Vibrancy is a no-op while the page paints opaque backgrounds — the
    // renderer only goes translucent behind the enhancedEffects toggle.
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 20, y: 20 },
      vibrancy: 'under-window',
      visualEffectState: 'followWindow',
    } : {}),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // Preload exposes a minimal update API to the renderer
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  // Renderer drops the traffic-light inset while in native fullscreen
  // (the lights auto-hide there).
  mainWindow.on('enter-full-screen', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('window:fullscreen', true);
  });
  mainWindow.on('leave-full-screen', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('window:fullscreen', false);
  });
  // Block all new-window spawns (target="_blank", window.open, etc.)
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Block navigation to any URL that isn't localhost/127.0.0.1 or a local file.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const parsed = new URL(url);
      const allowed =
        parsed.protocol === 'file:' ||
        parsed.hostname === 'localhost' ||
        parsed.hostname === '127.0.0.1';
      if (!allowed) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });

  // Menu accelerators with click handlers (⌘1-9, ⌘N, ⇧⌘I, ⌃⌘S) are matched
  // here instead of relying on AppKit key-equivalent dispatch: with the
  // sandboxed renderer focused, the unhandled-keystroke → menu redispatch is
  // unreliable, so accelerator-only items silently do nothing from the
  // keyboard (menu *clicks* were always fine). before-input-event sees every
  // real keystroke first, and preventDefault() suppresses any late menu
  // dispatch, so an item can never fire twice. Roles (reload, zoom, copy…)
  // stay on the native path.
  mainWindow.webContents.on('before-input-event', handleMenuAccelerator);

  // Renderer readiness is per-document: a real navigation/reload invalidates
  // the previous document's app:renderer-ready signal. This must NOT listen to
  // did-start-loading — that also fires for same-document navigations (React
  // Router pushState), and since the renderer only calls ready() once per
  // document, resetting there permanently jams sendToApp()'s queue after the
  // first client-side route change (menu, dock and CSV actions all go silent).
  mainWindow.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) rendererReady = false;
  });

  // Persist the window frame across launches (debounced).
  mainWindow.on('resize', () => scheduleWindowBoundsSave(mainWindow));
  mainWindow.on('move', () => scheduleWindowBoundsSave(mainWindow));

  // macOS convention: the red close button HIDES the window instead of
  // destroying it, keeping the fully-booted renderer (route + scroll state) and
  // the warm backend/containers resident so reopening is ~instant. A real quit
  // (⌘Q / menu Quit → before-quit sets isAppQuitting) closes for real. Only
  // darwin hides — elsewhere close must destroy so window-all-closed → app.quit()
  // still fires. `activate`/`second-instance` show() the hidden window.
  mainWindow.on('close', (e) => {
    if (process.platform === 'darwin' && !isAppQuitting && mainWindow && !mainWindow.isDestroyed()) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  // Caller is responsible for loading the initial URL.
  mainWindow.on('closed', () => { mainWindow = null; rendererReady = false; });
}

// ── Manual shell updater (.zip-only, no blockmaps) ───────────────────────────
// We intentionally avoid electron-updater metadata (latest-mac.yml / blockmaps)
// and install from the unsigned GitHub release ZIP.

let shellUpdateCheckInFlight = false;
let pendingShellUpdate = null;

function normalizeVersionTag(version) {
  if (!version) return '';
  const s = String(version).trim();
  return s.startsWith('v') ? s : `v${s}`;
}

function compareVersions(a, b) {
  // Split off pre-release suffix (e.g. "1.2.3-rc.1" → ["1.2.3", "rc.1"])
  const splitPre = (v) => {
    const s = String(v || '').replace(/^v/, '');
    const dash = s.indexOf('-');
    if (dash === -1) return { core: s, pre: null };
    return { core: s.slice(0, dash), pre: s.slice(dash + 1) };
  };
  const { core: ca, pre: prea } = splitPre(a);
  const { core: cb, pre: preb } = splitPre(b);
  const pa = ca.split('.').map(n => parseInt(n, 10) || 0);
  const pb = cb.split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  // Equal numeric cores: pre-release < release (semver §9)
  if (prea && !preb) return -1;
  if (!prea && preb) return 1;
  if (prea && preb) return comparePreRelease(prea, preb);
  return 0;
}

// Semver §11 pre-release precedence: compare dot-separated identifiers left to
// right — numeric identifiers compare numerically (so rc.10 > rc.2, which a
// plain string compare got backwards), numeric < alphanumeric, and when all
// shared identifiers are equal the shorter set has lower precedence.
function comparePreRelease(prea, preb) {
  const idsA = prea.split('.');
  const idsB = preb.split('.');
  const len = Math.max(idsA.length, idsB.length);
  for (let i = 0; i < len; i += 1) {
    const x = idsA[i];
    const y = idsB[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const dx = parseInt(x, 10);
      const dy = parseInt(y, 10);
      if (dx !== dy) return dx < dy ? -1 : 1;
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function getCurrentVersionTag() {
  // Read from the Electron package.json (accurate in dev and packaged modes).
  // workDir is the Docker/compose root — its package.json is the monorepo root,
  // not the Electron app, so we must not use it for version detection.
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    if (typeof pkg.version === 'string' && pkg.version.trim()) {
      return normalizeVersionTag(pkg.version.trim());
    }
  } catch {
    // fall through
  }

  return normalizeVersionTag(app.getVersion());
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function getUpdateMode() {
  if (!app.isPackaged) return 'dev';
  if (useRepoMode) return 'source';
  return 'docker';
}

function writeInstallerScript({ scriptPath, sourceRootPath, sourceLaunchPath, destRootPath, hostPid }) {
  const script = [
    '#!/bin/bash',
    'set -euo pipefail',
    `SRC_ROOT=${shellEscape(sourceRootPath)}`,
    `SRC_LAUNCH=${shellEscape(sourceLaunchPath || '')}`,
    `DEST_ROOT=${shellEscape(destRootPath)}`,
    `HOST_PID=${hostPid}`,
    'BAK_DIR="$(dirname "$DEST_ROOT")/.vision_update_bak_$$"',
    '',
    '# Wait until the running app exits before replacing source files.',
    'for i in {1..120}; do',
    '  if ! kill -0 "$HOST_PID" 2>/dev/null; then break; fi',
    '  sleep 0.5',
    'done',
    '',
    'mkdir -p "$DEST_ROOT"',
    '',
    '# Snapshot current install for rollback on failure.',
    'rsync -a --exclude ".git" --exclude "node_modules" --exclude "postgres_data" "$DEST_ROOT/" "$BAK_DIR/"',
    '',
    '# Install update — roll back automatically on any error.',
    'rsync_ok=0',
    'rsync -a --delete --exclude ".env" --exclude "postgres_data" --exclude ".git" --exclude "node_modules" "$SRC_ROOT/" "$DEST_ROOT/" && rsync_ok=1',
    'if [ "$rsync_ok" -ne 1 ]; then',
    '  echo "ERROR: rsync failed — rolling back from backup" >&2',
    '  rsync -a --delete --exclude ".env" --exclude "postgres_data" --exclude ".git" --exclude "node_modules" "$BAK_DIR/" "$DEST_ROOT/" || true',
    '  rm -rf "$BAK_DIR" 2>/dev/null || true',
    '  exit 1',
    'fi',
    'rm -rf "$BAK_DIR" 2>/dev/null || true',
    '',
    '# Strip macOS quarantine from the updated source tree so launch.command',
    '# can be opened without Gatekeeper blocking it (macOS 12+).',
    'xattr -rd com.apple.quarantine "$DEST_ROOT" 2>/dev/null || true',
    '',
    '# Install bun if missing (non-interactive).',
    'if ! command -v bun >/dev/null 2>&1; then',
    '  export BUN_INSTALL="$HOME/.bun"',
    '  curl -fsSL https://bun.sh/install | bash',
    '  export PATH="$BUN_INSTALL/bin:$PATH"',
    'fi',
    '',
    'cd "$DEST_ROOT"',
    'bun install --ignore-scripts',
    '',
    'if [ -n "$SRC_LAUNCH" ] && [ -f "$SRC_LAUNCH" ]; then',
    '  cp "$SRC_LAUNCH" "$DEST_ROOT/launch.command" 2>/dev/null || true',
    '  chmod +x "$DEST_ROOT/launch.command" 2>/dev/null || true',
    'fi',
    '',
    '# Strip quarantine from the launcher scripts specifically before opening.',
    'xattr -d com.apple.quarantine "$DEST_ROOT/packaging/electron/unsigned/launch.command" 2>/dev/null || true',
    'xattr -d com.apple.quarantine "$DEST_ROOT/launch.command" 2>/dev/null || true',
    '',
    'if [ -f "$DEST_ROOT/packaging/electron/unsigned/launch.command" ]; then',
    '  open "$DEST_ROOT/packaging/electron/unsigned/launch.command"',
    '  exit 0',
    'fi',
    '',
    'if [ -f "$DEST_ROOT/launch.command" ]; then',
    '  open "$DEST_ROOT/launch.command"',
    '  exit 0',
    'fi',
    '',
    'cd "$DEST_ROOT"',
    'exec bun run electron:prod',
  ].join('\n');

  fs.writeFileSync(scriptPath, `${script}\n`, { mode: 0o755 });
}

function readGitHubRelease() {
  return new Promise((resolve, reject) => {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
    const opts = {
      headers: {
        'User-Agent': `${APP_NAME}-desktop/${app.getVersion()}`,
        'Accept': 'application/vnd.github+json',
      },
    };
    https.get(url, opts, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function pickSourceLauncherZip(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  return assets.find((a) => /vision-source-launcher-.*-arm64\.zip$/i.test(a?.name || '')) || null;
}

function pickChecksumAsset(release, zipName) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const wanted = `${zipName}.sha256`.toLowerCase();
  return assets.find((a) => (a?.name || '').toLowerCase() === wanted) || null;
}

function fetchUrlBody(url) {
  return new Promise((resolve, reject) => {
    const opts = { headers: { 'User-Agent': `${APP_NAME}-desktop/${app.getVersion()}` } };
    const handle = (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchUrlBody(res.headers.location).then(resolve, reject);
        res.resume();
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
      res.on('error', reject);
    };
    https.get(url, opts, handle).on('error', reject);
  });
}

function computeFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function parseSha256Body(body) {
  const match = String(body || '').trim().match(/\b([a-fA-F0-9]{64})\b/);
  return match ? match[1].toLowerCase() : null;
}

async function prepareShellUpdateInstaller() {
  const release = await readGitHubRelease();
  const latestVersion = normalizeVersionTag(release?.tag_name);
  const currentVersion = getCurrentVersionTag();
  const sourceLauncherAsset = pickSourceLauncherZip(release);

  if (!latestVersion || !sourceLauncherAsset?.browser_download_url) {
    return { up_to_date: true, error: 'No compatible source launcher update asset found.' };
  }

  if (compareVersions(latestVersion, currentVersion) <= 0) {
    return {
      up_to_date: true,
      current_version: currentVersion,
      latest_version: latestVersion,
      html_url: release?.html_url,
      release_notes: release?.body || '',
      published_at: release?.published_at,
      source_launcher_available: Boolean(sourceLauncherAsset?.browser_download_url),
    };
  }

  const tempRoot = path.join(app.getPath('temp'), `vision_shell_update_${Date.now()}_${process.pid}`);
  const zipPath = path.join(tempRoot, sourceLauncherAsset.name);
  const extractDir = path.join(tempRoot, 'extract');
  fs.mkdirSync(extractDir, { recursive: true });

  try {
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(zipPath);
      const req = https.get(sourceLauncherAsset.browser_download_url, {
        headers: { 'User-Agent': `${APP_NAME}-desktop/${app.getVersion()}` },
      }, (res) => {
        if (res.statusCode !== 200) {
          file.close(() => {});
          reject(new Error(`Download failed (${res.statusCode})`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      });
      req.setTimeout(UPDATE_DOWNLOAD_TIMEOUT_MS, () => {
        req.destroy(new Error('Update download timed out'));
      });
      req.on('error', (err) => { file.close(() => {}); reject(err); });
      file.on('error', (err) => { req.destroy(err); reject(err); });
    });

    const checksumAsset = pickChecksumAsset(release, sourceLauncherAsset.name);
    if (!checksumAsset?.browser_download_url) {
      throw new Error('No checksum asset found for this release — aborting update to prevent running an unverified installer');
    }
    const body = await fetchUrlBody(checksumAsset.browser_download_url);
    const expected = parseSha256Body(body);
    if (!expected) {
      throw new Error('Checksum file present but could not parse SHA256 hash');
    }
    const actual = await computeFileSha256(zipPath);
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      throw new Error('Checksum mismatch — downloaded file may be corrupted or tampered with');
    }

    // Validate ZIP entry paths before extraction to prevent path traversal attacks.
    // zipinfo -1 lists one path per line; any entry escaping extractDir is rejected.
    const zipEntries = await run('zipinfo', ['-1', zipPath], tempRoot, { env: dockerEnv }).catch(() => '');
    for (const entry of zipEntries.split('\n')) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const normalized = path.normalize(trimmed);
      if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
        throw new Error(`Unsafe path in update ZIP: ${trimmed}`);
      }
    }

    await run('ditto', ['-x', '-k', zipPath, extractDir], tempRoot, { env: dockerEnv });

    const sourceDir = path.join(extractDir, 'unsigned', 'Vision');
    const sourceLaunchPath = path.join(extractDir, 'unsigned', 'launch.command');
    const sourcePackageJson = path.join(sourceDir, 'package.json');
    if (!fs.existsSync(sourcePackageJson)) {
      throw new Error('Downloaded update ZIP does not contain Vision source files');
    }

    const destRootPath = workDir || path.resolve(__dirname, '..', '..');
    const installerPath = path.join(tempRoot, 'install-update.command');
    writeInstallerScript({
      scriptPath: installerPath,
      sourceRootPath: sourceDir,
      sourceLaunchPath: fs.existsSync(sourceLaunchPath) ? sourceLaunchPath : '',
      destRootPath,
      hostPid: process.pid,
    });

    return {
      up_to_date: false,
      current_version: currentVersion,
      latest_version: latestVersion,
      html_url: release?.html_url,
      release_notes: release?.body || '',
      published_at: release?.published_at,
      source_launcher_available: Boolean(sourceLauncherAsset?.browser_download_url),
      installerPath,
    };
  } catch (err) {
    // Clean up temp dir on any error — on success tempRoot is intentionally kept
    // because installerPath lives inside it and must remain until the user runs it.
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch (_) {}
    throw err;
  }
}

async function checkForShellUpdate() {
  const release = await readGitHubRelease();
  const latestVersion = normalizeVersionTag(release?.tag_name);
  const currentVersion = getCurrentVersionTag();
  const sourceLauncherAsset = pickSourceLauncherZip(release);
  const mode = getUpdateMode();

  if (!latestVersion) {
    return { up_to_date: true, current_version: currentVersion, latest_version: null, update_mode: mode, error: 'Could not determine latest release version.' };
  }

  return {
    up_to_date: compareVersions(latestVersion, currentVersion) <= 0,
    current_version: currentVersion,
    latest_version: latestVersion,
    html_url: release?.html_url,
    release_notes: release?.body || '',
    published_at: release?.published_at,
    source_launcher_available: Boolean(sourceLauncherAsset?.browser_download_url),
    update_mode: mode,
  };
}

async function installPreparedShellUpdate() {
  if (!pendingShellUpdate?.installerPath) {
    if (shellUpdateCheckInFlight) {
      return { success: false, error: 'An update download is already in progress.' };
    }
    shellUpdateCheckInFlight = true;
    try {
      const prepared = await prepareShellUpdateInstaller();
      if (prepared.up_to_date || !prepared.installerPath) {
        return { success: false, error: 'No newer shell update is currently available.' };
      }
      pendingShellUpdate = prepared;
    } catch (err) {
      return { success: false, error: err && err.message ? err.message : String(err) };
    } finally {
      shellUpdateCheckInFlight = false;
    }
  }

  try {
    const installerPath = pendingShellUpdate.installerPath;
    const latestVersion = pendingShellUpdate.latest_version || '';
    // Revalidate before committing to quit: the bundle may have been prepared
    // arbitrarily long ago. If the OS purged the temp dir, the old flow set
    // isQuitting and quit anyway — the spawn failed silently and the app
    // exited with no update and no error.
    if (!fs.existsSync(installerPath)) {
      pendingShellUpdate = null;
      return { success: false, error: 'The downloaded update is no longer available. Please check for updates again.' };
    }
    // Best-effort recheck: don't install a stale bundle when a newer release
    // shipped since it was prepared. Offline recheck failures fall through —
    // the existing (verified-present) bundle still installs.
    try {
      const recheck = await checkForShellUpdate();
      if (recheck?.latest_version && compareVersions(recheck.latest_version, latestVersion) > 0) {
        pendingShellUpdate = null;
        return { success: false, error: `A newer version (${recheck.latest_version}) is available. Please check for updates again.` };
      }
    } catch (_) { /* offline — proceed with the prepared bundle */ }
    spawn('open', [installerPath], { detached: true, stdio: 'ignore' }).unref();
    isQuitting = true;
    setImmediate(() => app.quit());
    return { success: true, version: latestVersion };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

function setupManualShellUpdater() {
  setTimeout(async () => {
    try {
      const update = await checkForShellUpdate();
      if (update.up_to_date || !update.latest_version) return;

      const { response } = await dialog.showMessageBox({
        type: 'info',
        buttons: [t('update.download'), t('update.later')],
        defaultId: 0,
        cancelId: 1,
        title: t('update.availableTitle', { app: APP_NAME }),
        message: t('update.versionAvailable', { version: update.latest_version }),
        detail: t('update.detailDownload'),
      });

      if (response !== 0) return;

      notify(t('update.downloading'));
      const prepared = await prepareShellUpdateInstaller();
      if (prepared.up_to_date || !prepared.installerPath) return;
      pendingShellUpdate = prepared;

      const { response: restartNow } = await dialog.showMessageBox({
        type: 'info',
        buttons: [t('update.restartNow'), t('update.later')],
        defaultId: 0,
        cancelId: 1,
        title: t('update.readyTitle', { app: APP_NAME }),
        message: t('update.versionDownloaded', { version: prepared.latest_version }),
        detail: t('update.detailRestart'),
      });

      if (restartNow === 0) {
        await installPreparedShellUpdate();
      }
    } catch (err) {
      console.warn('Manual shell updater failed (non-fatal):', err?.message || err);
    }
  }, MANUAL_UPDATE_CHECK_DELAY_MS);
}

// ── Docker image update (called after new Electron version detected) ──────────
async function applyDockerImageUpdate(cwd, extraFiles = []) {
  try {
    notify(t('app.pullingLatestImage'));
    const wasNew = await pullLatestImage(cwd, extraFiles);
    if (wasNew) {
      await restartAppContainer(cwd, extraFiles);
      await pollHealth().catch(() => {});
      notify(t('app.imageUpdated'));
    }
  } catch (err) {
    console.warn('Docker image update failed (non-fatal):', err);
  }
}

// ── HTTP helpers (main-process API calls) ─────────────────────────────────────
// Lightweight wrappers around Node's built-in `http` module so the main process
// can talk to the running backend without importing a heavy fetch polyfill.

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { 'Content-Type': 'application/json' } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy(new Error('httpGet timed out after 10 s'));
    });
  });
}

function httpPut(url, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.pathname,
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { resolve(body); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── Backup helpers ────────────────────────────────────────────────────────────
// Streams pg_dump output directly from the db container to a file on the host
// using spawn() + piped stdout — no in-memory buffering, handles any DB size.
async function runBackup(destDir) {
  if (!destDir) throw new Error('No backup directory configured');

  let dbUser = 'ftm_user';
  let dbName = 'financial_transactions';
  try {
    const envContents = await fs.promises.readFile(path.join(workDir, '.env'), 'utf8');
    ({ dbUser, dbName } = parseDatabaseUrlFromEnv(envContents));
  } catch { /* use defaults */ }

  const deviceId = await getBackupDeviceId();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const filename = `vision_backup_${deviceId}_${timestamp}.sql`;
  const sqlFile = path.join(destDir, filename);

  await fs.promises.mkdir(destDir, { recursive: true });

  const composeFileArgs = composeArgs(workDir, overrideFiles);
  const args = [
    'compose', ...composeFileArgs,
    'exec', '-T', 'db',
    'pg_dump', '-U', dbUser, '-d', dbName, '--no-owner', '--no-acl',
  ];

  await new Promise((resolve, reject) => {
    const child = spawn('docker', args, { env: dockerEnv, cwd: workDir });
    const out = fs.createWriteStream(sqlFile);

    child.stdout.pipe(out);

    const stderr = [];
    child.stderr.on('data', (chunk) => stderr.push(chunk));

    child.on('error', (err) => {
      out.destroy();
      fs.unlink(sqlFile, () => {});
      reject(err);
    });

    child.on('close', (code) => {
      if (code === 0) {
        out.end(() => resolve());
      } else {
        out.destroy();
        fs.unlink(sqlFile, () => {});
        reject(new Error(Buffer.concat(stderr).toString().trim() || `pg_dump exited with code ${code}`));
      }
    });
  });

  const encryptedResult = await encryptBackupFile(sqlFile);
  const cleanup = await cleanupOldBackups(destDir, deviceId);
  return {
    success: true,
    file: encryptedResult.file,
    encrypted: encryptedResult.encrypted,
    warning: encryptedResult.warning,
    cleanupRemoved: cleanup.removed,
  };
}

// ── Bundle backup/restore helpers ────────────────────────────────────────────

/** Zero-padded numeric prefix of a Vision alembic revision id, or null. */
function revisionNumericPrefix(rev) {
  const m = /^(\d+)/.exec(String(rev || ''));
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Query the running DB for the current alembic revision.
 * Returns empty string if unavailable (e.g. DB not yet initialised).
 *
 * Fetches ALL alembic_version rows: under the known multi-head drift the old
 * `LIMIT 1` returned an arbitrary row, making the newer-schema guard
 * nondeterministic. Deterministically pick the highest numeric-prefixed
 * revision (the guard compares numeric prefixes).
 */
async function getSchemaHead(composeFileArgs, dbUser, dbName) {
  try {
    const result = await run('docker', [
      'compose', ...composeFileArgs, 'exec', '-T', 'db',
      'psql', '-U', dbUser, '-d', dbName, '-t', '-A', '-c',
      'SELECT version_num FROM alembic_version;',
    ], workDir, { timeout: 10000 });
    const rows = result.split('\n').map(s => s.trim()).filter(Boolean);
    if (rows.length === 0) return '';
    let best = rows[0];
    for (const row of rows.slice(1)) {
      const a = revisionNumericPrefix(row);
      const b = revisionNumericPrefix(best);
      if (a != null && (b == null || a > b)) best = row;
    }
    return best;
  } catch {
    return '';
  }
}

/**
 * Newest revision in the LOCAL alembic/versions directory (by numeric
 * prefix; filenames match revision ids). Fail-safe fallback for the
 * newer-schema guard: when the DB's head is unreadable (fresh DB, container
 * down), an empty currentHead used to skip the guard entirely — but a bundle
 * from a newer install still crash-loops boot-time `alembic upgrade head`
 * regardless of DB state, because the CODE's migration chain doesn't know the
 * bundle's revision. Comparing against the local chain head catches that.
 */
function getLocalMigrationChainHead() {
  try {
    const versionsDir = path.join(workDir || path.resolve(__dirname, '..', '..'), 'alembic', 'versions');
    let best = '';
    for (const f of fs.readdirSync(versionsDir)) {
      if (!f.endsWith('.py') || f.startsWith('_')) continue;
      const rev = f.slice(0, -3);
      const a = revisionNumericPrefix(rev);
      if (a == null) continue;
      const b = revisionNumericPrefix(best);
      if (b == null || a > b) best = rev;
    }
    return best;
  } catch {
    return '';
  }
}

/**
 * Extract the alembic revision recorded inside a plain-SQL pg_dump file.
 * pg_dump emits the alembic_version row either as a COPY block
 * (`COPY public.alembic_version (version_num) FROM stdin;` + data line)
 * or, with --inserts, as an INSERT statement. Streams the file and stops
 * at the first match, so arbitrarily large dumps stay cheap.
 * Returns '' when no revision is found (not a Vision dump, empty table, …).
 */
function readDumpSchemaHead(sqlPath) {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(sqlPath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let inCopyBlock = false;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
      rl.close();
      stream.destroy();
    };
    rl.on('line', (line) => {
      if (inCopyBlock) {
        const value = line.trim();
        finish(value === '\\.' ? '' : value);
        return;
      }
      if (/^COPY\s+(?:"?[\w$]+"?\.)?"?alembic_version"?\s*\("?version_num"?\)\s+FROM\s+stdin;/i.test(line)) {
        inCopyBlock = true;
        return;
      }
      const insert = line.match(
        /^INSERT INTO\s+(?:"?[\w$]+"?\.)?"?alembic_version"?\s*(?:\("?version_num"?\)\s*)?VALUES\s*\('([^']+)'\)/i,
      );
      if (insert) finish(insert[1]);
    });
    rl.on('close', () => finish(''));
    stream.on('error', () => finish(''));
  });
}

/**
 * True only when `candidate` is provably a newer alembic revision than
 * `current`. Vision revisions carry a zero-padded numeric prefix
 * ("0071_planned_recurrence_bounds"); compare those numerically — the old
 * lexicographic `>` silently misorders any future hash-style id. When either
 * id has no numeric prefix (or `current` is unknown), skip the guard rather
 * than block a restore on an uncomparable pair.
 */
function isSchemaRevisionNewer(candidate, current) {
  const a = revisionNumericPrefix(candidate);
  const b = revisionNumericPrefix(current);
  if (a == null || b == null) return false;
  return a > b;
}

/**
 * Create a .visionbak bundle in destDir, optionally encrypted.
 * frontendStateJson may be null (e.g. when called at quit time).
 */
async function runBundleBackup(destDir, frontendStateJson = null) {
  if (!destDir) throw new Error('No backup directory configured');

  let dbUser = 'ftm_user';
  let dbName = 'financial_transactions';
  try {
    const envContents = await fs.promises.readFile(path.join(workDir, '.env'), 'utf8');
    ({ dbUser, dbName } = parseDatabaseUrlFromEnv(envContents));
  } catch { /* use defaults */ }

  const composeFileArgs = composeArgs(workDir, overrideFiles);
  const deviceId = await getBackupDeviceId();
  const appVersion = app.getVersion ? app.getVersion() : 'unknown';
  const schemaHead = await getSchemaHead(composeFileArgs, dbUser, dbName);

  // Temp dir for SQL dump and attachments staging
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vision_bak_'));
  const dbSqlPath = path.join(tmpDir, 'db.sql');
  let attachmentsDir = null;

  try {
    // 1. pg_dump to temp file
    await new Promise((resolve, reject) => {
      const args = [
        'compose', ...composeFileArgs,
        'exec', '-T', 'db',
        'pg_dump', '-U', dbUser, '-d', dbName, '--no-owner', '--no-acl',
      ];
      const child = spawn('docker', args, { env: dockerEnv, cwd: workDir });
      const out = fs.createWriteStream(dbSqlPath);
      child.stdout.pipe(out);
      const stderr = [];
      child.stderr.on('data', (chunk) => stderr.push(chunk));
      child.on('error', (err) => { out.destroy(); reject(err); });
      child.on('close', (code) => {
        if (code === 0) { out.end(() => resolve()); }
        else { out.destroy(); reject(new Error(Buffer.concat(stderr).toString().trim() || `pg_dump exited with code ${code}`)); }
      });
    });

    // 2. Copy attachments out of running container (optional — fails gracefully)
    const attachmentsTmp = path.join(tmpDir, 'attachments');
    try {
      await run('docker', [
        'compose', ...composeFileArgs,
        'cp', `app:/app/data/attachments`, attachmentsTmp,
      ], workDir, { timeout: 120000 });
      // docker compose cp creates attachments/ as the target directory
      attachmentsDir = attachmentsTmp;
    } catch {
      // No attachments in container — bundle proceeds without them
    }

    // 3. Parse frontendState
    let frontendState = null;
    if (frontendStateJson) {
      try { frontendState = typeof frontendStateJson === 'string' ? JSON.parse(frontendStateJson) : frontendStateJson; }
      catch { /* non-fatal */ }
    }

    // 4. Assemble bundle zip
    const { bundlePath } = await createBundle({
      destDir,
      deviceId,
      schemaHead,
      appVersion,
      dbSqlPath,
      attachmentsDir,
      frontendState,
    });

    // 5. Encrypt if passphrase configured (v2: per-bundle salt + GCM)
    const passphrase = await getBackupPassphrase();
    let finalFile = bundlePath;
    let encrypted = false;
    let warning;
    if (passphrase) {
      const { encPath } = await encryptBundle(bundlePath, passphrase);
      finalFile = encPath;
      encrypted = true;
    } else {
      warning = 'Backup encryption skipped: no passphrase configured.';
    }

    // 6. Rotate old bundles
    const cleanup = await cleanupOldBackups(destDir, deviceId);
    return { success: true, file: finalFile, encrypted, warning, cleanupRemoved: cleanup.removed };

  } finally {
    // Always clean up temp SQL dump (bundle has its own copy)
    fs.rm(tmpDir, { recursive: true, force: true }, () => {});
  }
}

/**
 * Restore a .visionbak (or .visionbak.enc) bundle.
 * Returns { success, file, frontendState } on success.
 * frontendState is the parsed { keys: { … } } object or null.
 */
async function runBundleRestore(bundlePath, { passphrase } = {}) {
  if (!bundlePath) throw new Error('No backup file specified');
  if (!fs.existsSync(bundlePath)) throw new Error(`File not found: ${bundlePath}`);

  const isEncrypted = await isBundleEncrypted(bundlePath);
  let effectivePassphrase = null;
  if (isEncrypted) {
    effectivePassphrase = passphrase || (await getBackupPassphrase());
    if (!effectivePassphrase) throw new Error(ERR_PASSPHRASE_REQUIRED);
  }

  // Open bundle — decrypt + extract to temp dir. openBundle throws on bad
  // decrypt; convert to a sentinel so the UI can re-prompt for the passphrase.
  let metadata, dbSqlPath, attachmentsDir, frontendState, cleanup;
  try {
    ({ metadata, dbSqlPath, attachmentsDir, frontendState, cleanup } = await openBundle(bundlePath, { passphrase: effectivePassphrase }));
  } catch (err) {
    if (isEncrypted) {
      const msg = err && err.message ? String(err.message) : '';
      if (
        /bad decrypt/i.test(msg) ||
        /wrong final block/i.test(msg) ||
        /unable to authenticate/i.test(msg) ||
        /missing metadata\.json/i.test(msg) ||
        /missing db\.sql/i.test(msg) ||
        /end of central directory/i.test(msg) ||
        /not a zip file/i.test(msg) ||
        (err && err.code === 'ERR_OSSL_BAD_DECRYPT') ||
        (err && err.code === 'ERR_CRYPTO_INVALID_AUTH_TAG')
      ) {
        throw new Error(ERR_INVALID_PASSPHRASE);
      }
    }
    throw err;
  }

  let dbUser = 'ftm_user';
  let dbPass = '';
  let dbName = 'financial_transactions';
  try {
    const envContents = await fs.promises.readFile(path.join(workDir, '.env'), 'utf8');
    ({ dbUser, dbPass, dbName } = parseDatabaseUrlFromEnv(envContents));
  } catch { /* use defaults */ }

  const composeFileArgs = composeArgs(workDir, overrideFiles);

  // Schema version check: block restore if bundle is from a newer schema.
  // When the DB head is unreadable (fresh DB, container down), fall back to
  // the local migration chain head instead of skipping the guard — a
  // newer-schema bundle crash-loops boot regardless of current DB state.
  if (metadata.schemaHead) {
    const currentHead = await getSchemaHead(composeFileArgs, dbUser, dbName)
      || getLocalMigrationChainHead();
    if (isSchemaRevisionNewer(metadata.schemaHead, currentHead)) {
      cleanup();
      throw new Error(
        `BUNDLE_SCHEMA_NEWER: This bundle was created on schema revision "${metadata.schemaHead}" ` +
        `but this Vision install is at "${currentHead}". ` +
        `Update Vision to a newer version and retry.`
      );
    }
  }

  // 1. Stop app container
  await run('docker', ['compose', ...composeFileArgs, 'stop', 'app'], workDir, { timeout: 60000 });

  try {
    // 2a. Terminate remaining DB connections
    await run('docker', [
      'compose', ...composeFileArgs, 'exec', '-T', 'db',
      'psql', '-U', dbUser, '-d', 'postgres',
      '-c', `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid();`,
    ], workDir, { timeout: 30000 });

    // 2b. Drop and recreate the database
    await run('docker', [
      'compose', ...composeFileArgs, 'exec', '-T', 'db',
      'psql', '-U', dbUser, '-d', 'postgres',
      '-c', `DROP DATABASE IF EXISTS "${dbName}";`,
    ], workDir, { timeout: 30000 });

    await run('docker', [
      'compose', ...composeFileArgs, 'exec', '-T', 'db',
      'psql', '-U', dbUser, '-d', 'postgres',
      '-c', `CREATE DATABASE "${dbName}" OWNER "${dbUser}";`,
    ], workDir, { timeout: 30000 });

    // 3. Restore SQL via throwaway container (same pattern as runRestore)
    const dbContainerName = await run('docker', [
      'compose', ...composeFileArgs, 'ps', '-q', 'db',
    ], workDir, { timeout: 10000 }).then(s => s.trim()).catch(() => '');

    let pgImageTag = 'postgres:16';
    if (dbContainerName) {
      pgImageTag = await run('docker', [
        'inspect', '--format', '{{.Config.Image}}', dbContainerName,
      ], workDir, { timeout: 10000 }).then(s => s.trim()).catch(() => 'postgres:16');
    }

    const networkName = await run('docker', [
      'inspect', '--format', '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}', dbContainerName,
    ], workDir, { timeout: 10000 }).then(s => s.trim().split('\n')[0]).catch(() => '');

    const hostDir = path.dirname(dbSqlPath);
    const sqlFilename = path.basename(dbSqlPath);

    await withPgPassEnvFile(dbPass, (envFile) => new Promise((resolve, reject) => {
      const child = spawn('docker', [
        'run', '--rm',
        '-v', `${hostDir}:/restore:ro`,
        ...(networkName ? ['--network', networkName] : []),
        '--env-file', envFile,
        pgImageTag,
        // ON_ERROR_STOP: psql's default is continue-on-error + exit 0, so a
        // truncated/corrupt dump restored PARTIALLY and reported success —
        // after the original DB was already dropped. Exit 3 on first error
        // (the nonzero-exit rejection below fires) and --single-transaction
        // so a failed restore leaves an empty DB, not a half-restored one.
        'psql', '-h', 'db', '-U', dbUser, '-d', dbName,
        '-v', 'ON_ERROR_STOP=1',
        '--single-transaction',
        '-f', `/restore/${sqlFilename}`,
      ], { env: dockerEnv, cwd: workDir });

      const stderr = [];
      child.stderr.on('data', (chunk) => stderr.push(chunk));
      child.stdout.resume();
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(Buffer.concat(stderr).toString().trim() || `psql exited with code ${code}`));
      });
    }));

    // 4. Copy attachments into stopped app container (docker cp works on stopped containers).
    //    Uses staging + atomic swap inside the container's filesystem.
    if (attachmentsDir) {
      const appContainerId = await run('docker', [
        'compose', ...composeFileArgs, 'ps', '-q', 'app',
      ], workDir, { timeout: 10000 }).then(s => s.trim()).catch(() => '');

      if (appContainerId) {
        // Copy bundle attachments into a staging directory
        await run('docker', [
          'cp', `${attachmentsDir}/.`, `${appContainerId}:/app/data/attachments.staging`,
        ], workDir, { timeout: 120000 });
      }
    }

  } finally {
    cleanup();
    // 5. Always restart app container (runs alembic upgrade head on startup)
    const env = { ...dockerEnv, PORT: String(appPort) };
    await run('docker', [
      'compose', ...composeFileArgs, 'start', 'app',
    ], workDir, { timeout: 120000, env }).catch((err) => {
      console.error('Failed to restart app container after bundle restore:', err);
    });

    // 6. Atomically swap attachments.staging → attachments once container is up.
    //    Awaited so a swap failure surfaces to the caller instead of being silently dropped.
    if (attachmentsDir) {
      // A restore boot runs `alembic upgrade head`, which on a large DB can
      // exceed the normal liveness budget. A pollHealth() timeout here must NOT
      // skip the swap (that would strand the restored attachments in .staging
      // forever), so use the larger build budget and swallow a timeout — the
      // swap only needs the container process to be up, not fully migrated.
      try {
        await pollHealth(HEALTH_POLL_BUILD_ATTEMPTS);
      } catch (err) {
        console.warn('post-restore health poll did not confirm readiness in time; attempting attachments swap anyway:', err && err.message ? err.message : err);
      }
      const composeArgs_ = composeArgs(workDir, overrideFiles);
      await run('docker', [
        'compose', ...composeArgs_, 'exec', '-T', 'app',
        'sh', '-c',
        // Guard the whole swap on the staging dir existing: only demote the live
        // attachments once the replacement is actually present. Without this, a
        // missing/failed staging copy would move live attachments to .old and
        // then fail to replace them — destroying the attachments dir.
        'if [ -d /app/data/attachments.staging ]; then ' +
        'rm -rf /app/data/attachments.old && ' +
        'mv /app/data/attachments /app/data/attachments.old 2>/dev/null; ' +
        'mv /app/data/attachments.staging /app/data/attachments && ' +
        'rm -rf /app/data/attachments.old; ' +
        'fi',
      ], workDir, { timeout: 30000 });
    }
  }

  return { success: true, file: bundlePath, frontendState };
}

// ── IPC: renderer can request a Docker image update ──────────────────────────
ipcMain.handle('update:pull-image', async () => {
  if (!workDir) return { success: false, error: 'workDir not set' };
  try {
    const wasNew = await pullLatestImage(workDir);
    if (wasNew) {
      await restartAppContainer(workDir, overrideFiles);
      await pollHealth().catch(() => {});
    }
    return { success: true, wasNew };
  } catch (err) {
    return { success: false, error: String(err) };
  }
});

ipcMain.handle('update:check-github', async () => {
  try {
    return await checkForShellUpdate();
  } catch (err) {
    return { error: String(err), update_mode: getUpdateMode() };
  }
});

ipcMain.handle('update:install-shell', async () => {
  if (app.isPackaged && !useRepoMode) {
    return { success: false, error: 'Shell update not available in embedded mode — use Docker image update instead.' };
  }
  try {
    return await installPreparedShellUpdate();
  } catch (err) {
    return { success: false, error: String(err) };
  }
});

ipcMain.handle('update:get-mode', () => ({
  mode: getUpdateMode(),
  is_packaged: app.isPackaged,
  use_repo_mode: useRepoMode,
}));

ipcMain.handle('update:pre-update-backup', async () => {
  try {
    const backupDir = path.join(app.getPath('userData'), 'pre-update-backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const result = await runBundleBackup(backupDir, null);
    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: err?.message || String(err) };
  }
});

// ── Restore helpers ───────────────────────────────────────────────────────────
// Restores a plain-SQL pg_dump file into the running PostgreSQL container.
//
// The backup file is accessed via a bind-mount — it is never copied into the
// container, so there is no size limit and no extra disk usage.
//
// Sequence:
//   1. Stop the app container (disconnect all clients from the DB)
//   2. Terminate remaining DB connections, drop & recreate the database
//   3. Restore via `docker run --rm -v <dir>:/restore <pg-image> psql -f /restore/<file>`
//      — a temporary throwaway container that has direct access to the host file
//   4. Restart the app container (backend reconnects + alembic upgrade head runs)
async function runRestore(sqlFilePath, { passphrase } = {}) {
  if (!sqlFilePath) throw new Error('No backup file specified');
  if (!fs.existsSync(sqlFilePath)) throw new Error(`File not found: ${sqlFilePath}`);

  let restoreSource = sqlFilePath;
  let cleanupRestoreSource = () => {};
  if (await isEncryptedBackupFile(sqlFilePath)) {
    const effectivePassphrase = passphrase || (await getBackupPassphrase());
    if (!effectivePassphrase) throw new Error(ERR_PASSPHRASE_REQUIRED);
    restoreSource = await decryptBackupFileToTemp(sqlFilePath, effectivePassphrase);
    cleanupRestoreSource = () => fs.unlink(restoreSource, () => {});
  }

  let dbUser = 'ftm_user';
  let dbPass = '';
  let dbName = 'financial_transactions';
  try {
    const envContents = await fs.promises.readFile(path.join(workDir, '.env'), 'utf8');
    ({ dbUser, dbPass, dbName } = parseDatabaseUrlFromEnv(envContents));
  } catch { /* use defaults */ }

  const composeFileArgs = composeArgs(workDir, overrideFiles);

  // Newer-schema guard (parity with the bundle path): a plain dump taken on a
  // newer install restores cleanly at the psql level, then boot-time
  // `alembic upgrade head` hits the unknown revision and the backend
  // crash-loops with no user-facing message. Refuse before anything is
  // stopped or dropped.
  const dumpHead = await readDumpSchemaHead(restoreSource);
  if (dumpHead) {
    // Same fail-safe as the bundle path: unknown DB head → compare against
    // the local migration chain head rather than skipping the guard.
    const currentHead = await getSchemaHead(composeFileArgs, dbUser, dbName)
      || getLocalMigrationChainHead();
    if (isSchemaRevisionNewer(dumpHead, currentHead)) {
      cleanupRestoreSource();
      throw new Error(
        `BUNDLE_SCHEMA_NEWER: This backup was created on schema revision "${dumpHead}" ` +
        `but this Vision install is at "${currentHead}". ` +
        `Update Vision to a newer version and retry.`
      );
    }
  }

  // 1. Stop the app container (release DB connections)
  await run('docker', [
    'compose', ...composeFileArgs, 'stop', 'app',
  ], workDir, { timeout: 60000 });

  try {
    // 2a. Terminate any remaining connections
    await run('docker', [
      'compose', ...composeFileArgs, 'exec', '-T', 'db',
      'psql', '-U', dbUser, '-d', 'postgres',
      '-c', `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid();`,
    ], workDir, { timeout: 30000 });

    // 2b. Drop and recreate the database
    await run('docker', [
      'compose', ...composeFileArgs, 'exec', '-T', 'db',
      'psql', '-U', dbUser, '-d', 'postgres',
      '-c', `DROP DATABASE IF EXISTS "${dbName}";`,
    ], workDir, { timeout: 30000 });

    await run('docker', [
      'compose', ...composeFileArgs, 'exec', '-T', 'db',
      'psql', '-U', dbUser, '-d', 'postgres',
      '-c', `CREATE DATABASE "${dbName}" OWNER "${dbUser}";`,
    ], workDir, { timeout: 30000 });

    // 3. Restore using a throwaway container that bind-mounts the backup directory.
    //    This avoids any `docker cp` and works for arbitrarily large files.
    //    We need the postgres image name used by the db service.
    const pgImage = await run('docker', [
      'compose', ...composeFileArgs, 'images', '--quiet', 'db',
    ], workDir, { timeout: 15000 }).then(s => s.trim()).catch(() => 'postgres:16');

    // Resolve the actual image name (images --quiet gives the ID, we need the tag).
    // Fall back to inspecting the running container.
    const dbContainerName = await run('docker', [
      'compose', ...composeFileArgs, 'ps', '-q', 'db',
    ], workDir, { timeout: 10000 }).then(s => s.trim()).catch(() => '');

    let pgImageTag = 'postgres:16';
    if (dbContainerName) {
      pgImageTag = await run('docker', [
        'inspect', '--format', '{{.Config.Image}}', dbContainerName,
      ], workDir, { timeout: 10000 }).then(s => s.trim()).catch(() => 'postgres:16');
    }

    // Get the internal Docker network so the throwaway container can reach the db service.
    const networkName = await run('docker', [
      'inspect', '--format', '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}', dbContainerName,
    ], workDir, { timeout: 10000 }).then(s => s.trim().split('\n')[0]).catch(() => '');

    const hostDir = path.dirname(restoreSource);
    const sqlFilename = path.basename(restoreSource);

    // Stream psql output — no buffering, works for any file size
    await withPgPassEnvFile(dbPass, (envFile) => new Promise((resolve, reject) => {
      const child = spawn('docker', [
        'run', '--rm',
        '-v', `${hostDir}:/restore:ro`,
        ...(networkName ? ['--network', networkName] : []),
        '--env-file', envFile,
        pgImageTag,
        'psql',
        '-h', 'db',
        '-U', dbUser,
        '-d', dbName,
        // Fail fast + all-or-nothing: without ON_ERROR_STOP a partial/corrupt
        // dump restored partially and exited 0 (silent partial financial DB,
        // original already dropped). --single-transaction leaves an empty DB
        // on failure instead of a half-restored one.
        '-v', 'ON_ERROR_STOP=1',
        '--single-transaction',
        '-f', `/restore/${sqlFilename}`,
      ], { env: dockerEnv, cwd: workDir });

      const stderr = [];
      child.stderr.on('data', (chunk) => stderr.push(chunk));
      // psql outputs progress to stdout — discard it (we don't need it in memory)
      child.stdout.resume();

      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(Buffer.concat(stderr).toString().trim() || `psql exited with code ${code}`));
      });
    }));

  } finally {
    cleanupRestoreSource();
    // 4. Always restart the app container
    const env = { ...dockerEnv, PORT: String(appPort) };
    await run('docker', [
      'compose', ...composeFileArgs, 'start', 'app',
    ], workDir, { timeout: 120000, env }).catch((err) => {
      console.error('Failed to restart app container after restore:', err);
    });
  }

  return { success: true, file: sqlFilePath };
}

// ── IPC: restore ──────────────────────────────────────────────────────────────
// Paths blessed by a user-driven file-picker dialog. Only these can be passed
// to `backup:restore` — prevents a compromised renderer from passing an
// arbitrary filesystem path (e.g. /etc/passwd, malicious .sql) for restore.
const ALLOWED_RESTORE_PATHS = new Set();

// macOS system directories that must never be used as a backup destination.
// '/Library' is the SYSTEM-level library (a previous entry listed the
// nonexistent '/Library/System'); per-user backups live under
// /Users/<name>/Library (e.g. iCloud Drive), which this does not match.
const BLOCKED_BACKUP_PREFIXES = [
  '/System', '/usr', '/bin', '/sbin', '/etc',
  '/private/etc', '/private/var/db', '/Library',
];

// Shared destination validation for every path that can set or use a backup
// directory (backup:run, backup:save-settings → quit-time backup). Returns an
// error string, or null when the destination is acceptable.
function validateBackupDest(dir) {
  if (typeof dir !== 'string' || !dir) return 'Invalid backup directory';
  const resolved = path.resolve(dir);
  if (!path.isAbsolute(resolved)) return 'Backup directory must be an absolute path';
  if (BLOCKED_BACKUP_PREFIXES.some(p => resolved === p || resolved.startsWith(p + '/'))) {
    return 'Backup to system directories is not allowed';
  }
  return null;
}

const ALLOWED_RESTORE_EXTS = new Set(['.visionbak', '.enc', '.sql']);
function hasAllowedRestoreExt(p) {
  const lower = String(p).toLowerCase();
  if (lower.endsWith('.visionbak.enc')) return true;
  for (const ext of ALLOWED_RESTORE_EXTS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

ipcMain.handle('backup:select-file', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    title: 'Select Backup File to Restore',
    buttonLabel: 'Restore',
    filters: [
      { name: 'Vision Backup Files', extensions: ['visionbak', 'visionbak.enc', 'sql', 'enc'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const chosen = path.resolve(result.filePaths[0]);
  ALLOWED_RESTORE_PATHS.add(chosen);
  return chosen;
});

ipcMain.handle('backup:is-encrypted', async (_event, filePath) => {
  try {
    if (typeof filePath !== 'string' || !filePath) return false;
    const resolved = path.resolve(filePath);
    if (!ALLOWED_RESTORE_PATHS.has(resolved)) return false;
    if (!fs.existsSync(resolved)) return false;
    if (resolved.endsWith('.visionbak') || resolved.endsWith('.visionbak.enc')) {
      return await isBundleEncrypted(resolved);
    }
    return await isEncryptedBackupFile(resolved);
  } catch {
    return false;
  }
});

ipcMain.handle('backup:restore', async (event, filePath, opts) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    return { success: false, error: 'Unauthorized sender' };
  }
  if (!workDir) return { success: false, error: 'workDir not set' };
  if (typeof filePath !== 'string' || !filePath) {
    return { success: false, error: 'Invalid restore path' };
  }
  const resolved = path.resolve(filePath);
  if (!ALLOWED_RESTORE_PATHS.has(resolved)) {
    return { success: false, error: 'Restore path was not selected via the file picker' };
  }
  if (!hasAllowedRestoreExt(resolved)) {
    return { success: false, error: 'Unsupported backup file extension' };
  }
  if (!fs.existsSync(resolved)) {
    return { success: false, error: 'Backup file not found' };
  }

  // Require explicit user confirmation before overwriting live data.
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Restore', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Restore Backup',
    message: 'This will permanently replace all current data and cannot be undone.',
    detail: `Restore from: ${path.basename(resolved)}`,
  });
  if (response !== 0) return { success: false, error: 'Restore cancelled by user' };

  const passphrase = opts && typeof opts === 'object' ? opts.passphrase : undefined;

  // Pause the health watchdog so it cannot restart containers while the restore
  // is in progress (stop + drop + recreate DB).
  stopHealthWatchdog();
  try {
    // Route .visionbak / .visionbak.enc through the new bundle restore path;
    // legacy .sql / .enc files fall through to the original runRestore.
    const lower = resolved.toLowerCase();
    const isBundle = lower.endsWith('.visionbak') || lower.endsWith('.visionbak.enc');
    const result = isBundle
      ? await runBundleRestore(resolved, { passphrase })
      : await runRestore(resolved, { passphrase });
    return result;
  } catch (err) {
    // Ensure app container is back up even after an error
    const composeFileArgs = composeArgs(workDir, overrideFiles);
    const env = { ...dockerEnv, PORT: String(appPort) };
    run('docker', [
      'compose', ...composeFileArgs,
      'start', 'app',
    ], workDir, { timeout: 120000, env }).catch(() => {});
    return { success: false, error: String(err) };
  } finally {
    startHealthWatchdog();
  }
});

// ── IPC: backup:run ───────────────────────────────────────────────────────────
// frontendStateJson is the serialised { keys: { … } } localStorage snapshot,
// collected by the renderer before invoking this handler.  Optional — when null
// (e.g. automated backup on quit) the bundle is created without frontend-state.json.
let backupInFlight = false;
ipcMain.handle('backup:run', async (event, destDir, frontendStateJson = null) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    return { success: false, error: 'Unauthorized sender' };
  }
  if (!workDir) return { success: false, error: 'workDir not set' };
  const destError = validateBackupDest(destDir);
  if (destError) return { success: false, error: destError };
  const resolvedDest = path.resolve(destDir);
  if (backupInFlight) return { success: false, error: 'A backup is already in progress' };
  backupInFlight = true;
  try {
    const result = await runBundleBackup(resolvedDest, frontendStateJson);
    return result;
  } catch (err) {
    return { success: false, error: String(err) };
  } finally {
    backupInFlight = false;
  }
});

ipcMain.handle('backup:select-dir', async () => {
  const defaultPath = getDefaultICloudBackupDir() || app.getPath('documents');
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select Backup Directory',
    buttonLabel: 'Choose',
    defaultPath,
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('backup:save-settings', async (event, { backupDir, backupOnQuit }) => {
  // Same sender check as backup:restore — a compromised non-main frame must
  // not be able to repoint where the quit-time backup writes.
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    return { success: false, error: 'Unauthorized sender' };
  }
  // Validate the destination NOW: the quit-time backup (will-quit handler)
  // writes wherever this setting points, with no further checks.
  if (backupDir) {
    const destError = validateBackupDest(backupDir);
    if (destError) return { success: false, error: destError };
  }
  // Persist to database via the running backend API (source of truth).
  // Also mirror to local settings.json as a fallback for the will-quit handler
  // in case the backend is already shutting down.
  const payload = { backupDir: backupDir || '', backupOnQuit: !!backupOnQuit };
  await updateSettings((cur) => {
    cur.backupDir = payload.backupDir;
    cur.backupOnQuit = payload.backupOnQuit;
  });
  try {
    await httpPut(`http://localhost:${appPort}/api/settings/backup_settings`, { value: payload });
  } catch (err) {
    console.warn('backup:save-settings: could not persist to DB, kept in local settings.json', err.message);
  }
  return { success: true };
});

ipcMain.handle('backup:get-encryption-status', async () => {
  return { success: true, ...(await getBackupPassphraseStatus()) };
});

ipcMain.handle('backup:set-passphrase', async (_event, passphrase) => {
  const value = typeof passphrase === 'string' ? passphrase : '';
  return await setBackupPassphrase(value.trim());
});

ipcMain.handle('backup:load-settings', async () => {
  // Prefer reading from the database; fall back to settings.json if the backend
  // is not yet available (e.g. during very early startup).
  try {
    // The API wraps responses as { ok, data: { key, value } } (ADR-026).
    const body = await httpGet(`http://localhost:${appPort}/api/settings/backup_settings`);
    const stored = body && body.data ? body.data.value : undefined;
    if (stored && typeof stored === 'object') {
      // Mirror the RAW stored value (not the default-resolved one) back to
      // settings.json so the will-quit fallback matches the DB instead of
      // baking display defaults into the stored config.
      await updateSettings((cur) => {
        cur.backupDir = typeof stored.backupDir === 'string' ? stored.backupDir : '';
        cur.backupOnQuit = stored.backupOnQuit === true;
      });
      const v = resolveBackupSettingsWithDefaults(stored);
      return { backupDir: v.backupDir || '', backupOnQuit: v.backupOnQuit === true };
    }
  } catch (err) {
    console.warn('backup:load-settings: could not read from DB, falling back to settings.json', err.message);
  }
  const s = resolveBackupSettingsWithDefaults(await loadSettings());
  return { backupDir: s.backupDir || '', backupOnQuit: s.backupOnQuit === true };
});

// ── Services (keep-running-on-quit) settings ─────────────────────────────────
// Opt-in toggle: when enabled, quit leaves the Docker containers running so the
// next launch takes the hot path. Persisted to the Electron settings.json mirror
// (read by the will-quit handler, which must work even after the backend is
// down). Same authenticated-sender guard as backup:save-settings.
ipcMain.handle('services:save-settings', async (event, { keepServicesOnQuit } = {}) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    return { success: false, error: 'Unauthorized sender' };
  }
  await updateSettings((cur) => { cur.keepServicesOnQuit = !!keepServicesOnQuit; });
  return { success: true };
});

ipcMain.handle('services:load-settings', async () => {
  const s = await loadSettings();
  return { keepServicesOnQuit: s.keepServicesOnQuit === true };
});

// ── Recovery (error page) ────────────────────────────────────────────────────
ipcMain.handle('recovery:retry', () => {
  pollAndLoad();
  return { success: true };
});

ipcMain.handle('recovery:open-logs', async () => {
  try {
    const logsDir = app.getPath('logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const err = await shell.openPath(logsDir);
    if (err) return { success: false, error: err };
    return { success: true, path: logsDir };
  } catch (err) {
    return { success: false, error: err && err.message ? err.message : String(err) };
  }
});

// ── macOS-native integration (menu bar, dock, open-file, accent color) ───────
// All renderer-bound messages funnel through sendToApp() so actions fired
// before React mounts (dock menu on a closed window, Finder open-file at
// launch) are queued and flushed when the renderer signals readiness via
// app:renderer-ready. The renderer side lives in ElectronBridge.

let rendererReady = false;
const pendingAppMessages = [];

function sendToApp(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    pendingAppMessages.push([channel, payload]);
    createWindow();
    // Same reopen-from-destroyed path as `activate`: show the splash and re-poll
    // readiness rather than a bare loadURL(APP_URL), so a backend that died while
    // the window was closed surfaces the error page instead of a blank/broken
    // window. The queued message flushes once the renderer signals ready.
    mainWindow.loadURL(splashDataUrl());
    pollAndLoad();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (rendererReady) {
    mainWindow.webContents.send(channel, payload);
  } else {
    pendingAppMessages.push([channel, payload]);
  }
}

ipcMain.handle('app:renderer-ready', (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return { success: false };
  rendererReady = true;
  while (pendingAppMessages.length > 0) {
    const [channel, payload] = pendingAppMessages.shift();
    mainWindow.webContents.send(channel, payload);
  }
  return { success: true };
});

function menuAction(action, payload) {
  sendToApp('menu:action', { action, payload });
}

// Mirrors GO_TO_ROUTES in apps/frontend/src/hooks/useGoToShortcuts.ts — keep
// both lists in sync when adding a destination.
const GO_MENU_ROUTES = [
  { url: '/', titleKey: 'nav.dashboard' },
  { url: '/transactions', titleKey: 'nav.transactions' },
  { url: '/statistics', titleKey: 'nav.statistics' },
  { url: '/categories', titleKey: 'nav.categories' },
  { url: '/recipients', titleKey: 'nav.recipients' },
  { url: '/import', titleKey: 'nav.importExport' },
  { url: '/portfolio', titleKey: 'nav.portfolio' },
  { url: '/portfolio/net-worth', titleKey: 'nav.netWorth' },
  { url: '/ai-chat', titleKey: 'nav.aiChat' },
];

// Keyboard matcher for the accelerator-only menu items (see the
// before-input-event comment in createWindow). Mirrors the accelerators
// declared in setupApplicationMenu() — keep both in sync. Digits match on
// input.code (physical key) so ⌘1-9 stay positional on non-QWERTY layouts
// (AZERTY digits would otherwise need Shift); letters match on input.key.
function handleMenuAccelerator(event, input) {
  if (input.type !== 'keyDown' || input.isAutoRepeat) return;
  const isMac = process.platform === 'darwin';
  const primary = isMac ? input.meta : input.control;   // CmdOrCtrl
  const crossMod = isMac ? input.control : input.meta;  // the other platform's primary
  if (!primary) return;

  // Go menu: ⌘1 … ⌘9
  const digit = /^Digit([1-9])$/.exec(input.code || '');
  if (digit && !input.shift && !input.alt && !crossMod) {
    const route = GO_MENU_ROUTES[Number(digit[1]) - 1];
    if (!route) return;
    event.preventDefault();
    menuAction('navigate', route.url);
    return;
  }

  const key = typeof input.key === 'string' ? input.key.toLowerCase() : '';
  // File → New Transaction: ⌘N
  if (key === 'n' && !input.shift && !input.alt && !crossMod) {
    event.preventDefault();
    menuAction('new-transaction');
    return;
  }
  // File → Import CSV…: ⇧⌘I
  if (key === 'i' && input.shift && !input.alt && !crossMod) {
    event.preventDefault();
    menuAction('navigate', '/import');
    return;
  }
  // View → Toggle Sidebar: ⌃⌘S on macOS, Ctrl+Shift+S elsewhere
  const sidebarChord = isMac
    ? (key === 's' && input.control && !input.shift && !input.alt)
    : (key === 's' && input.shift && !input.alt && !input.meta);
  if (sidebarChord) {
    event.preventDefault();
    menuAction('toggle-sidebar');
  }
}

function setupApplicationMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{
      label: APP_NAME,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: t('menu.settings'),
          accelerator: 'CmdOrCtrl+,',
          click: () => menuAction('open-settings'),
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: t('menu.file'),
      submenu: [
        {
          label: t('menu.newTransaction'),
          accelerator: 'CmdOrCtrl+N',
          click: () => menuAction('new-transaction'),
        },
        {
          label: t('menu.importCsv'),
          accelerator: 'Shift+CmdOrCtrl+I',
          click: () => menuAction('navigate', '/import'),
        },
        { type: 'separator' },
        { role: process.platform === 'darwin' ? 'close' : 'quit' },
      ],
    },
    {
      label: t('menu.edit'),
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: t('menu.view'),
      submenu: [
        {
          label: t('menu.toggleSidebar'),
          // ⌃⌘S mirrors Finder/Mail "Show/Hide Sidebar" on macOS.
          accelerator: process.platform === 'darwin' ? 'Ctrl+Cmd+S' : 'Ctrl+Shift+S',
          click: () => menuAction('toggle-sidebar'),
        },
        { type: 'separator' },
        { role: 'reload' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }]),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: t('menu.go'),
      submenu: GO_MENU_ROUTES.map((route, i) => ({
        label: t(route.titleKey),
        accelerator: `CmdOrCtrl+${i + 1}`,
        click: () => menuAction('navigate', route.url),
      })),
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: t('menu.keyboardShortcuts'),
          click: () => menuAction('open-shortcuts'),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function setupDockMenu() {
  if (process.platform !== 'darwin' || !app.dock) return;
  app.dock.setMenu(Menu.buildFromTemplate([
    {
      label: t('menu.newTransaction'),
      click: () => menuAction('new-transaction'),
    },
    {
      label: t('nav.dashboard'),
      click: () => menuAction('navigate', '/'),
    },
  ]));
}

// Dock badge — count of planned payments due, pushed by the renderer (it owns
// the query + the user's dismissals). Input is clamped server-side so a
// compromised renderer can at most show a number.
ipcMain.handle('app:set-badge', (event, count) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return { success: false };
  if (process.platform !== 'darwin' || !app.dock) return { success: false };
  const n = Number(count);
  if (!Number.isFinite(n)) return { success: false };
  const clamped = Math.max(0, Math.min(999, Math.floor(n)));
  app.dock.setBadge(clamped > 0 ? String(clamped) : '');
  return { success: true };
});

// System accent color — RRGGBBAA hex from macOS, or null when unavailable.
function readSystemAccentColor() {
  if (process.platform !== 'darwin') return null;
  try {
    const color = systemPreferences.getAccentColor();
    return typeof color === 'string' && color ? color : null;
  } catch {
    return null;
  }
}

ipcMain.handle('app:get-accent-color', (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return null;
  return readSystemAccentColor();
});

// Renderer mirrors the active theme's primary colors here so the next boot
// splash matches the chosen palette (see splashDataUrl / readSplashTheme).
// Validated on write and again on read — the values land in splash HTML/CSS.
ipcMain.handle('theme:persist-splash', async (event, colors) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return { success: false };
  if (!colors || !isValidHslComponents(colors.background) || !isValidHslComponents(colors.foreground)) {
    return { success: false };
  }
  try {
    await updateSettings((cur) => {
      cur[SPLASH_THEME_KEY] = { background: colors.background, foreground: colors.foreground };
    });
    return { success: true };
  } catch (err) {
    console.warn('theme:persist-splash failed (non-fatal):', err && err.message ? err.message : err);
    return { success: false };
  }
});

function subscribeAccentColorChanges() {
  if (process.platform !== 'darwin') return;
  try {
    systemPreferences.subscribeNotification('AppleColorPreferencesChangedNotification', () => {
      if (mainWindow && !mainWindow.isDestroyed() && rendererReady) {
        mainWindow.webContents.send('app:accent-color-changed', readSystemAccentColor());
      }
    });
  } catch (err) {
    console.warn('accent-color subscription failed (non-fatal):', err && err.message ? err.message : err);
  }
}

// Finder/dock "open with Vision" for CSVs → forwarded to the renderer as file
// contents (the sandboxed renderer cannot read arbitrary paths, and we do not
// widen its filesystem access for this). Extension + size checked here; the
// import flow re-validates and previews before anything is written.
const CSV_OPEN_MAX_BYTES = 25 * 1024 * 1024;

async function forwardCsvOpen(filePath) {
  try {
    if (!/\.csv$/i.test(filePath)) return;
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile() || stat.size > CSV_OPEN_MAX_BYTES) return;
    const content = await fs.promises.readFile(filePath, 'utf8');
    sendToApp('app:csv-opened', { name: path.basename(filePath), content });
  } catch (err) {
    console.warn('open-file forward failed (non-fatal):', err && err.message ? err.message : err);
  }
}

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (app.isReady()) {
    forwardCsvOpen(filePath);
  } else {
    app.whenReady().then(() => forwardCsvOpen(filePath));
  }
});

// ── Compose override (dev modes) ─────────────────────────────────────────────
// Set VISION_COMPOSE_OVERRIDE to a filename (relative to workDir) to layer an
// additional compose file on top of the base — e.g. docker-compose.dev.yml.
// Used by the electron:dev and electron:clean root package.json scripts.
function resolveOverrideFiles(workDir) {
  const override = process.env.VISION_COMPOSE_OVERRIDE;
  if (!override || (app.isPackaged && !useRepoMode)) return [];
  // Accept absolute paths too, but the common case is a repo-root filename.
  const resolved = path.isAbsolute(override) ? override : path.join(workDir, override);
  return fs.existsSync(resolved) ? [resolved] : [];
}

// ── Launch flow ───────────────────────────────────────────────────────────────
let workDir = null;
let overrideFiles = [];
// True when packaged .app is using a local repo clone instead of GHCR image.
// Set by resolveWorkDir() when settings.repoPath points to a valid repo.
let useRepoMode = false;

async function launch() {
  const endLaunch = bootMark('launch');

  // 0. Register prod CSP + security headers before any window loads.
  registerSecurityHeaders();

  // 0a. Load i18n asynchronously so dialog strings resolve. If this fails,
  //     t() falls back to the key itself — survivable for startup paths.
  const endI18n = bootMark('init_i18n');
  await initI18n();
  endI18n();

  // 0a-bis. Native menu bar + dock menu need localized labels, so they follow
  // initI18n. Accent-color push subscription is darwin-only and inert otherwise.
  setupApplicationMenu();
  setupDockMenu();
  subscribeAccentColorChanges();

  // 0b. Open the loading window IMMEDIATELY so the user sees something straight
  //    away — before any Docker I/O, which can take seconds or even minutes on
  //    a cold start. The window will navigate to APP_URL once the backend is ready.
  const endWindow = bootMark('create_window');
  createWindow();
  mainWindow.loadURL(splashDataUrl());
  endWindow();

  // 1. Resolve project folder
  const endWorkDir = bootMark('resolve_work_dir');
  workDir = await resolveWorkDir();
  endWorkDir();
  if (!workDir) return;

  // 1b. Resolve any compose override requested via env var (dev flows only)
  overrideFiles = resolveOverrideFiles(workDir);

  // 1c–2. Find a free port, generate .env, check Docker health, and (in dev) check
  //        if the app image already exists — all are independent so run in parallel.
  let skipBuild = false;
  let dockerStatus = 'ok';
  // Set when the pre-pull step actually downloaded the app image (first run, or
  // an updated tag) — such a boot then runs alembic migrations before /health
  // goes green, so it earns the extended poll budget (see pollAndLoad below).
  let imageWasPulled = false;
  const composeProject = readComposeProjectName(workDir);
  setSplashStatus('splash.checkingDocker');
  const endParallelInit = bootMark('parallel_init');
  await Promise.all([
    // Resolve the backend host port: a random free port chosen once per app and
    // persisted, so the demo and real app never fight over a shared default.
    (() => {
      const end = bootMark('find_free_port');
      return resolveAppPort().then(port => {
        appPort = port;
        APP_URL = `http://localhost:${appPort}`;
        HEALTH_URL = `http://localhost:${appPort}/health`;
        end();
      });
    })(),

    // First run: generate .env if missing
    (() => {
      const end = bootMark('ensure_env');
      return ensureEnv(workDir).then(end);
    })(),

    // Check Docker is installed and running — overlaps with port scan and env init
    (() => {
      const end = bootMark('check_docker');
      return checkDocker(workDir).then(status => { dockerStatus = status; end(); });
    })(),

    // Packaged mode: pre-pull the app image ONLY if it's missing locally.
    // Without this, compose's `pull_policy: missing` pulls inline during `up`,
    // blocking the entire startup behind a ~2GB download on first launch.
    // Pulling here moves that download into parallel_init so it overlaps with
    // port/env/docker checks. We deliberately skip pull when the image is
    // already present — the manual shell updater (setupManualShellUpdater)
    // owns the upgrade path; we don't want silent :latest churn on every boot.
    // Failures are non-fatal — `up` falls back to inline pull.
    (app.isPackaged && !useRepoMode)
      ? (async () => {
          const end = bootMark('pre_pull_image');
          try {
            // Warm boot: if the app container is already running its image is
            // present, so skip the `docker compose images` CLI spawn entirely
            // (the slowest member of this phase) via a cheap Docker-socket probe.
            if (await isComposeAppRunning(composeProject)) { return; }
            const ids = await run(
              'docker',
              ['compose', ...composeArgs(workDir, overrideFiles), 'images', '-q', 'app'],
              workDir,
              { timeout: 10000, env: dockerEnv }
            ).then(r => r.trim()).catch(() => '');
            if (ids) { return; }
            setSplashStatus('splash.downloading');
            await run(
              'docker',
              ['compose', ...composeArgs(workDir, overrideFiles), 'pull', '--quiet', 'app'],
              workDir,
              { timeout: 600000, env: dockerEnv }
            );
            imageWasPulled = true;
          } catch (err) {
            console.warn('pre-pull failed (non-fatal, compose up will retry):', err.message || err);
          } finally {
            end();
          }
        })()
      : Promise.resolve(),

    // In dev, decide whether to skip --build. Strategy:
    //   1. Get current image ID from compose.
    //   2. Load .vision-cache/docker-build.json written after the last build.
    //   3. If imageId matches AND git status of Docker-relevant paths matches
    //      the cached snapshot AND no new commits touched those paths since the
    //      cache was written → skip. Otherwise rebuild and write a fresh cache.
    //
    // Checking only Docker-relevant paths (not the whole repo) means edits to
    // packaging/electron/, docs/, etc. never trigger a needless image rebuild.
    (!app.isPackaged || useRepoMode)
      ? (async () => {
          const end = bootMark('decide_skip_build');
          const dockerSkipCacheFile = path.join(workDir, '.vision-cache', 'docker-build.json');
          try {
            // Phase A: image ID + cache read + docker-path porcelain — all independent.
            const [imageIds, cacheRaw, porcelain] = await Promise.all([
              run('docker', ['compose', ...composeArgs(workDir, overrideFiles), 'images', '-q', 'app'], workDir, { timeout: 10000 }).then(r => r.trim()).catch(() => ''),
              fs.promises.readFile(dockerSkipCacheFile, 'utf8').catch(() => null),
              run('git', ['status', '--porcelain', '--', ...DOCKER_PATHS], workDir).then(r => r.trim()).catch(() => null),
            ]);
            if (!imageIds) { skipBuild = false; return; }
            if (porcelain === null) { skipBuild = false; return; }
            const imageId = imageIds.split(/\s+/)[0];
            if (cacheRaw) {
              const cache = JSON.parse(cacheRaw);
              if (cache.imageId === imageId && cache.porcelain === porcelain) {
                // Cache hit on image + worktree state. Also verify no new commits
                // touched docker paths since the cache was written.
                const newCommits = (await run('git', [
                  'log', `--since=${cache.writtenAt}`, '--oneline', '--', ...DOCKER_PATHS,
                ], workDir).catch(() => 'x')).trim();
                if (!newCommits) { skipBuild = true; return; }
              }
            }
            skipBuild = false;
          } catch {
            skipBuild = false;
          } finally {
            end();
          }
        })()
      : Promise.resolve(),
  ]);
  endParallelInit();

  // 3. Handle Docker not being available
  if (dockerStatus === 'not-installed') {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: [t('app.openDockerSite'), t('common.cancel')],
      defaultId: 0,
      title: APP_NAME,
      message: t('app.dockerRequired'),
      detail: t('app.dockerRequiredDetail'),
    });
    if (response === 0) shell.openExternal('https://www.docker.com/products/docker-desktop/');
    app.quit();
    return;
  }
  if (dockerStatus === 'not-running') {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: [t('app.openDockerApp'), t('common.cancel')],
      defaultId: 0,
      title: APP_NAME,
      message: t('app.dockerNotRunning'),
      detail: t('app.dockerNotRunningDetail'),
    });
    if (response !== 0) {
      app.quit();
      return;
    }
    // User chose to open Docker: launch Docker Desktop and wait for the daemon
    // to come up, then continue launch() automatically instead of quitting and
    // forcing a manual relaunch. The splash stays up during the wait.
    shell.openPath('/Applications/Docker.app');
    setSplashStatus('splash.checkingDocker');
    dockerStatus = await waitForDockerDaemon(workDir);
    if (dockerStatus !== 'ok') {
      await dialog.showMessageBox({
        type: 'warning',
        buttons: [t('common.ok')],
        title: APP_NAME,
        message: t('app.dockerNotRunning'),
        detail: t('app.dockerNotRunningDetail'),
      });
      app.quit();
      return;
    }
    // Daemon is up — fall through and continue the normal launch path.
  }

  // 5. If running in clean mode, wipe the clean volume so every run starts fresh.
  const isCleanRun = overrideFiles.some(f => path.basename(f) === 'docker-compose.clean.yml');
  if (isCleanRun) {
    // Bring down any leftover containers from a previous clean run first,
    // then remove the volume — Docker won't delete a volume that's still in use.
    await run('docker', ['compose', ...composeArgs(workDir, overrideFiles), 'down', '--volumes'],
      workDir, { timeout: 60000 }).catch(() => {});
  }

  // 7. docker compose start (fast path) or up (cold/dev rebuild)
  setSplashStatus('splash.startingServices');
  // Progress the otherwise-frozen status line through this dominant phase.
  startComposeSplashProgress();
  const endComposeUp = bootMark('compose_up');
  let composeDidBuild = false;
  try {
    let result;
    try {
      result = await composeStartOrUp(workDir, overrideFiles, skipBuild);
    } catch (err) {
      // A foreign process squatting the persisted appPort makes compose fail to
      // publish the app container. Re-pick a fresh port and recreate once —
      // `up` republishes on the new port, self-healing what would otherwise be
      // a permanent "port is already allocated" brick on every relaunch.
      if (isPortConflictError(err)) {
        console.warn(`[port] appPort ${appPort} is held by another process; picking a fresh port and recreating`);
        await repickAppPort();
        result = await composeStartOrUp(workDir, overrideFiles, skipBuild);
      } else {
        throw err;
      }
    }
    composeDidBuild = result.built;
    stopComposeSplashProgress();
    endComposeUp();
  } catch (err) {
    stopComposeSplashProgress();
    endComposeUp();
    await dialog.showMessageBox({
      type: 'error',
      buttons: [t('common.ok')],
      title: APP_NAME,
      message: t('app.failedStart'),
      detail: `${t('app.checkDockerLogs')}\n\n${String(err)}`,
    });
    app.quit();
    return;
  }

  // After a dev build, snapshot the image ID + docker-path porcelain so the
  // NEXT launch can skip the rebuild if nothing relevant has changed.
  if (composeDidBuild) {
    const dockerSkipCacheFile = path.join(workDir, '.vision-cache', 'docker-build.json');
    (async () => {
      try {
        const [imageIds, porcelain] = await Promise.all([
          run('docker', ['compose', ...composeArgs(workDir, overrideFiles), 'images', '-q', 'app'], workDir, { timeout: 10000 }).then(r => r.trim()).catch(() => ''),
          run('git', ['status', '--porcelain', '--', ...DOCKER_PATHS], workDir).then(r => r.trim()).catch(() => null),
        ]);
        if (!imageIds || porcelain === null) return;
        const imageId = imageIds.split(/\s+/)[0];
        await fs.promises.mkdir(path.dirname(dockerSkipCacheFile), { recursive: true });
        await fs.promises.writeFile(dockerSkipCacheFile, JSON.stringify({
          imageId, porcelain, writtenAt: new Date().toISOString(),
        }) + '\n');
      } catch (e) {
        console.warn('docker-build cache write failed (non-fatal):', e.message);
      }
    })();
  }

  // 8. Backend is being polled — poll /health in the background; navigate once ready.
  //    A cold/dev build (composeDidBuild) gets the extended budget and skips the
  //    slow-start modal, since first-launch boot is expected to be slow.
  setSplashStatus('splash.waitingApp');
  // A cold build OR a freshly-pulled packaged image both run migrations before
  // the backend listens, so both need the extended poll budget — otherwise a
  // long alembic migration trips the 60s timeout mid-migration and drops to the
  // error page. (renavigateWhenReady() then covers migrations that outlast even
  // this budget.)
  pollAndLoad({ building: composeDidBuild || imageWasPulled });

  // 10. Set up manual shell updater (source/dev mode only — not in embedded .app mode)
  if (!app.isPackaged || useRepoMode) {
    setupManualShellUpdater();
  }

  // Dev-mode: watch source files and trigger a docker rebuild+restart when
  // local sources change. This ensures the electron dev wrapper picks up
  // code edits without requiring manual docker-compose rebuilds.
  if ((!app.isPackaged || useRepoMode) && overrideFiles.length > 0) {
    try {
      let fileChangeTimer = null;
      let activeBuildChild = null;
      // Keep in sync with DOCKER_PATHS: anything that triggers a rebuild on the
      // next launch should also hot-rebuild while the dev shell is running.
      const watchTargets = ['apps/frontend', 'apps/node-backend', 'packages', 'i18n/source', 'package.json', 'bun.lock', 'bun.lockb'];

      // Paths whose churn is not source changes: dependency installs, build
      // output, VCS/dot dirs. Without this, any `bun install` fires a rebuild.
      const isIgnoredWatchPath = (fname) =>
        fname.split(path.sep).some((seg) =>
          seg === 'node_modules' || seg === 'dist' || seg.startsWith('.'));

      const runCancellableBuild = () => new Promise((resolve, reject) => {
        const args = ['compose', ...composeArgs(workDir, overrideFiles), 'build', 'app'];
        const child = spawn('docker', args, { cwd: workDir, env: dockerEnv });
        activeBuildChild = child;
        let stderrBuf = '';
        if (child.stderr) child.stderr.on('data', (d) => { stderrBuf += d.toString(); });
        child.on('error', (err) => {
          if (activeBuildChild === child) activeBuildChild = null;
          reject(err);
        });
        child.on('exit', (code, signal) => {
          if (activeBuildChild === child) activeBuildChild = null;
          if (signal === 'SIGTERM' || signal === 'SIGKILL') {
            const cancelErr = new Error('build_cancelled');
            cancelErr.cancelled = true;
            return reject(cancelErr);
          }
          if (code === 0) return resolve();
          const err = new Error(stderrBuf.trim() || `docker build exited ${code}`);
          reject(err);
        });
      });

      const scheduleRebuild = () => {
        if (fileChangeTimer) clearTimeout(fileChangeTimer);
        if (activeBuildChild) {
          try { activeBuildChild.kill('SIGTERM'); } catch (_) {}
        }
        fileChangeTimer = setTimeout(async () => {
          fileChangeTimer = null;
          notify('Rebuilding app image (dev)...');
          try {
            await runCancellableBuild();
            await restartAppContainer(workDir, overrideFiles);
            await pollHealth().catch(() => {});
            notify('Rebuild complete');
          } catch (err) {
            if (err && err.cancelled) {
              // Expected cancellation — a newer edit superseded this build.
              return;
            }
            console.warn('Dev rebuild failed:', err);
            notify('Rebuild failed — check logs');
          }
        }, 1500);
      };

      watchTargets.forEach((p) => {
        const full = path.join(workDir, p);
        if (!fs.existsSync(full)) return;
        try {
          const w = fs.watch(full, { recursive: true }, (evt, fname) => {
            // Ignore temporary editor swap files
            if (fname && /(~$|\.swp$|\.swx$)/.test(fname)) return;
            // Ignore dependency/build/dot-dir churn (covers nested paths,
            // which the old `^\.` anchor missed).
            if (fname && isIgnoredWatchPath(fname)) return;
            scheduleRebuild();
          });
          // Do not keep the watcher references — they live for the app lifetime
        } catch (e) {
          // fs.watch may throw on some filesystems; ignore and continue
        }
      });
    } catch (e) {
      console.warn('Failed to set up dev rebuild watcher:', e);
    }
  }

  // Launch orchestration is complete: the window is up, background health
  // polling is running, and dev watchers (if any) are registered. Close the
  // top-level launch mark. Reached only on the success path — every failure
  // branch above returns after app.quit() without closing this mark.
  endLaunch();
}

// ── Shutdown flow ─────────────────────────────────────────────────────────────
let isQuitting = false;

// Distinct from isQuitting (will-quit's re-entrancy guard): this flips on the
// FIRST quit signal (⌘Q, menu Quit, app.quit()), before any window 'close'
// fires, so the hide-on-close handler knows a red-button close from a real quit.
// The shell-updater path (which sets isQuitting directly then calls app.quit())
// also routes through before-quit, so windows there destroy rather than hide.
let isAppQuitting = false;
app.on('before-quit', () => { isAppQuitting = true; });

app.on('will-quit', (e) => {
  if (isQuitting || !workDir) return;
  e.preventDefault();
  isQuitting = true;

  // Hard-kill safeguard: if backup + docker compose down haven't finished in
  // 45 seconds, force-exit so the app never hangs forever on quit.
  const forceQuitTimer = setTimeout(() => {
    console.warn('will-quit: hard timeout reached — forcing exit');
    app.exit(0);
  }, 45_000);
  forceQuitTimer.unref(); // don't prevent Node from exiting if nothing else is running

  // Run backup-on-quit if the user has configured a backup directory.
  // Prefer reading from the database (more up-to-date); fall back to the local
  // settings.json mirror that is kept in sync by backup:save-settings / backup:load-settings.
  async function resolveBackupSettings() {
    try {
      // The API wraps responses as { ok, data: { key, value } } (ADR-026).
      const body = await httpGet(`http://localhost:${appPort}/api/settings/backup_settings`);
      const stored = body && body.data ? body.data.value : undefined;
      if (stored && typeof stored === 'object') return stored;
    } catch { /* backend may already be down, use local mirror */ }
    return loadSettings();
  }

  resolveBackupSettings().then((s) => {
    const effective = resolveBackupSettingsWithDefaults(s);
    const backupOnQuit = effective.backupOnQuit === true;
    const backupDir = effective.backupDir || '';

    const doBackup = backupOnQuit && backupDir
      ? runBundleBackup(backupDir, null)  // frontendState unavailable at quit time
          .then((result) => {
            if (result && result.warning) console.warn(result.warning);
            notify(t('backup.done'));
          })
          .catch((err) => {
            console.error('Backup on quit failed:', err);
            notify(t('backup.failed'));
          })
      : Promise.resolve();

    doBackup
      .then(async () => {
        // Drop the watchdog's idle keep-alive socket so the backend's
        // graceful shutdown isn't held open waiting on it.
        stopHealthWatchdog();
        try { healthAgent.destroy(); } catch { /* already gone */ }
        // Opt-in "keep services running on quit": leave the containers up so the
        // next launch takes the hot path instead of a warm restart. Read from the
        // local settings.json mirror (the backend may already be shutting down).
        // compose's `restart: unless-stopped` policy governs reboot behaviour.
        let keepServices = false;
        try { keepServices = (await loadSettings()).keepServicesOnQuit === true; }
        catch { /* default: stop containers */ }
        if (keepServices) return;
        return stopContainers(workDir, overrideFiles);
      })
      .catch((err) => console.error('docker compose down failed:', err))
      .finally(() => {
        clearTimeout(forceQuitTimer);
        notify(t('app.stopped'));
        app.exit(0);
      });
  });
});

// ── App lifecycle ─────────────────────────────────────────────────────────────
// The single-instance lock is acquired early (just after app.setName). A second
// instance already called app.quit() up there; only the primary registers here.
if (gotSingleInstanceLock) {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(launch);

  app.on('activate', () => {
    // Hide-on-close keeps the window alive but hidden on darwin: just re-show it,
    // preserving the booted renderer's route/scroll state (reopen is ~instant).
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      return;
    }
    // Window was actually destroyed (non-darwin, or a first-run edge): the app +
    // containers may still be warm, but the SPA has to boot from scratch. Show the
    // splash and re-poll readiness (reusing the boot handoff) instead of a bare
    // loadURL(APP_URL) that would paint a blank window — or a connection error if
    // the backend isn't answering yet.
    if (mainWindow === null) {
      createWindow();
      mainWindow.loadURL(splashDataUrl());
      pollAndLoad();
    }
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
