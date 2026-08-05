'use strict';

const { app, BrowserWindow, dialog, Menu, Notification, screen, shell, ipcMain, session, systemPreferences } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { isBundleEncrypted } = require('./backup/bundle');
const composeMod = require('./compose');
const {
  dockerEnv, run, checkDocker, readComposeProjectName, isComposeAppRunning,
  composeArgs, composeStartOrUp, stopContainers, pullLatestImage, restartAppContainer,
} = composeMod;
const backupCrypto = require('./backup/crypto');
const {
  getDefaultICloudBackupDir, resolveBackupSettingsWithDefaults,
  getBackupPassphraseStatus, setBackupPassphrase, isEncryptedBackupFile,
} = backupCrypto;
const backupRestore = require('./backup/restore');
const { runBundleBackup, runBundleRestore, runRestore } = backupRestore;
const updater = require('./updater');
const {
  GITHUB_OWNER, GITHUB_REPO, getUpdateMode, checkForShellUpdate, resolveReleaseImageDigest,
  installPreparedShellUpdate, setupManualShellUpdater,
} = updater;
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

function t(key, vars, fallback) {
  let txt = i18n[key] || fallback || key;
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

// Persist main-process logs to a rotating file in userData. A double-clicked
// .app discards stderr, so packaged-app startup failures (the migration below,
// boot-phase timings, corrupt-settings quarantine, port selection, the startup
// error dialogs) leave no trail to attach to a bug report. Installed here —
// right after the single-instance lock, before the first console.* of module
// eval — so migration/startup logs are captured. Best-effort: any failure
// leaves console untouched and never blocks boot. Gated on the lock so a
// second (about-to-quit) instance doesn't contend on the same file.
if (gotSingleInstanceLock) (function initFileLogger() {
  try {
    const logDir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'main.log');
    // Rotate once the live log passes ~2 MB so it can't grow unbounded across
    // sessions; keep exactly one previous generation.
    try {
      if (fs.statSync(logPath).size > 2 * 1024 * 1024) {
        try { fs.renameSync(logPath, `${logPath}.1`); } catch { /* best effort */ }
      }
    } catch { /* no existing log — first run */ }
    const stream = fs.createWriteStream(logPath, { flags: 'a' });
    stream.on('error', () => { /* never let a log write crash the app */ });
    const serialize = (a) => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    };
    const write = (level, args) => {
      try { stream.write(`${new Date().toISOString()} [${level}] ${args.map(serialize).join(' ')}\n`); }
      catch { /* best effort */ }
    };
    for (const level of ['log', 'warn', 'error']) {
      const orig = console[level].bind(console);
      console[level] = (...args) => { write(level, args); orig(...args); };
    }
    write('log', [`main-process logger started (pid ${process.pid})`]);
  } catch { /* logging is best-effort; never block boot */ }
})();

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

// ── Extracted-module wiring ──────────────────────────────────────────────────
// Threads main.js globals/singletons into the extracted modules (compose.js,
// backup/crypto.js, backup/restore.js, updater.js). Mutable state (appPort,
// workDir, overrideFiles, useRepoMode, isQuitting) is passed as getters/
// callbacks so the modules always observe the live value at call time, exactly
// as the code did when it lived in this file.
composeMod.init({
  appPort: () => appPort,
  useRepoMode: () => useRepoMode,
});
backupCrypto.init({
  APP_NAME,
  loadSettings,
  updateSettings,
});
backupRestore.init({
  workDir: () => workDir,
  overrideFiles: () => overrideFiles,
  appPort: () => appPort,
  repoRootFallback: path.resolve(__dirname, '..', '..'),
  pollHealth,
  HEALTH_POLL_BUILD_ATTEMPTS,
});
updater.init({
  APP_NAME,
  IS_DEMO: __IS_DEMO,
  t,
  notify,
  workDir: () => workDir,
  useRepoMode: () => useRepoMode,
  markQuitting: () => { isQuitting = true; },
});

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
      // If it's missing, attempt to copy from the repo i18n/source (best effort).
      // __dirname is packaging/electron, so the repo masters live two levels up
      // under i18n/source — the previous `../i18n` (packaging/i18n) never existed,
      // making this whole branch dead code.
      const repoI18n = path.join(__dirname, '..', '..', 'i18n', 'source');
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
  // Least-privilege by default (three-variable setup, see .env.example):
  // the runtime pool connects as the non-superuser ftm_app role, while the
  // Postgres bootstrap superuser ftm_user is kept for Alembic DDL only
  // (DATABASE_URL_MIGRATIONS). The backend creates ftm_app itself on first
  // boot (src/database/roleBootstrap.js) — the packaged compose has no
  // postgres-init mount, and this also covers volumes initialised before the
  // role existed. Both secrets are hex (no URL/SQL-hostile characters) and
  // live only in this 0o600 .env, matching the existing POSTGRES_PASSWORD
  // handling.
  const pgPass = crypto.randomBytes(32).toString('hex');
  const appPass = crypto.randomBytes(32).toString('hex');
  return [
    '# Auto-generated by Vision on first launch. Do not commit this file.',
    `POSTGRES_PASSWORD=${pgPass}`,
    `POSTGRES_APP_PASSWORD=${appPass}`,
    `DATABASE_URL=postgresql://ftm_app:${appPass}@db:5432/financial_transactions`,
    `DATABASE_URL_MIGRATIONS=postgresql://ftm_user:${pgPass}@db:5432/financial_transactions`,
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

// Write (or replace) a single key in an .env body, preserving every other line
// and the file's ordering. Unlike mergeProviderKeys this DOES overwrite: the
// image reference is meant to move when a newer digest is resolved.
function upsertEnvKey(contents, key, value) {
  const line = `${key}=${value}`;
  const lines = (contents || '').split('\n');
  let replaced = false;
  const next = lines.map((raw) => {
    const trimmed = raw.trim();
    if (trimmed.startsWith('#')) return raw;
    const eq = trimmed.indexOf('=');
    if (eq === -1 || trimmed.slice(0, eq).trim() !== key) return raw;
    replaced = true;
    return line;
  });
  if (replaced) return next.join('\n');
  const body = contents || '';
  return `${body}${body.endsWith('\n') || body === '' ? '' : '\n'}${line}\n`;
}

const HEX_DIGITS = '0123456789abcdef';
const DIGEST_HEX_LENGTH = 64;

/**
 * Rebuild a hex string from a trusted alphabet.
 *
 * Every character of the result is taken from `HEX_DIGITS`, a module-level
 * literal; the input is used only to pick an index. So the returned string
 * shares no data with the caller's — which is the point, because this value
 * ends up in a file and then in the compose `image:` reference. A regex test
 * would prove the same thing to a human but not to static analysis, which
 * reported the write as network-data-to-file-system; this is the same
 * lookup-through-a-trusted-source indirection dbEditor uses for SQL
 * identifiers, and it makes the guarantee structural rather than incidental.
 *
 * @param {string} value
 * @returns {string|null} null if any character is not a lowercase hex digit
 */
function rebuildHex(value) {
  let out = '';
  for (const char of value) {
    const index = HEX_DIGITS.indexOf(char);
    if (index === -1) return null;
    out += HEX_DIGITS[index];
  }
  return out;
}

/**
 * Pin the app image to `digest` by writing APP_IMAGE_REF into the .env files
 * compose reads. Both copies are updated so the canonical .env and the work-dir
 * .env cannot disagree about which image the stack runs.
 *
 * The value is validated here as well as at the source: it is interpolated
 * straight into the compose `image:` reference, so nothing but an exact sha256
 * digest may reach it.
 *
 * @param {string} workDir
 * @param {string} digest e.g. `sha256:abc…`
 * @returns {Promise<boolean>} true when the pin was written
 */
async function pinImageDigest(workDir, digest) {
  const match = /^sha256:([0-9a-f]{64})$/.exec(String(digest || ''));
  if (!match) return false;
  const hex = rebuildHex(match[1]);
  if (hex === null || hex.length !== DIGEST_HEX_LENGTH) return false;
  const reference = `@sha256:${hex}`;
  const targets = [canonicalEnvPath(), path.join(workDir, '.env')];
  const seen = new Set();
  let wrote = false;
  for (const file of targets) {
    const resolved = path.resolve(file);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const current = await fs.promises.readFile(resolved, 'utf8').catch(() => null);
    if (current === null) continue;
    const updated = upsertEnvKey(current, 'APP_IMAGE_REF', reference);
    if (updated === current) { wrote = true; continue; }
    // codeql[js/http-to-file-access]: retained as documentation, not as the
    // control — rebuildHex above is what actually severs the flow. The digest
    // comes from the GitHub release API, is matched against
    // ^sha256:[0-9a-f]{64}$, and is then rebuilt character-by-character from a
    // literal alphabet, so the bytes written share no data with the response.
    // The target is the app's own 0600 .env.
    await fs.promises.writeFile(resolved, updated, { encoding: 'utf8', mode: 0o600 });
    wrote = true;
  }
  return wrote;
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

  // EXISTING installs deliberately stay single-role: their .env already works,
  // and rewriting DATABASE_URL to ftm_app here would gamble the boot on the
  // running app image containing the runtime role bootstrap (pull_policy:
  // missing keeps old images around; updates go through the manual shell
  // updater). Least surprise: leave the working setup alone and log a pointer.
  // Fresh installs (generateFreshEnvContents above) default to least-privilege.
  if (!parseEnvKeys(truth).has('DATABASE_URL_MIGRATIONS')) {
    console.log(
      '[env] single-role database setup detected (no DATABASE_URL_MIGRATIONS) — kept as-is. '
      + 'See .env.example for the opt-in least-privilege (ftm_app) upgrade.'
    );
  }

  if (canonicalContents !== truth) {
    await fs.promises.writeFile(canonicalEnv, truth, { encoding: 'utf8', mode: 0o600 });
  }
  if (path.resolve(workEnv) !== path.resolve(canonicalEnv) && workContents !== truth) {
    await fs.promises.writeFile(workEnv, truth, { encoding: 'utf8', mode: 0o600 });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function notify(body) {
  if (Notification.isSupported()) {
    new Notification({ title: APP_NAME, body }).show();
  }
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
  /* The brand mark, in currentColor so it follows the derived palette like the
     rest of the splash (emerald on default, purple on dracula, …) rather than
     stamping a fixed emerald on a themed backdrop. Same glyph as the app's
     <VisionMark /> and the packaged icon. */
  .mark { width: 44px; height: 44px; color: currentColor; }
  .name { font-size: 15px; font-weight: 600; letter-spacing: 0.01em; }
  .status { font-size: 13px; font-variant-numeric: tabular-nums; }
</style></head><body>
  <svg class="mark" viewBox="262 296 500 500" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M 268 300 L 512 792 L 756 300 L 656 300 L 512 596 L 368 300 Z" fill="currentColor"/>
    <circle cx="512" cy="444" r="40" fill="currentColor"/>
  </svg>
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

  // Native right-click menu for text: without this, plain inputs (search boxes,
  // the AI-chat composer, the dbEditor cell/WHERE editors) get no copy/paste/
  // select-all, and Electron's default-on spellcheck underlines misspellings
  // with no way to reach the suggestions. Cut/Copy/Paste/SelectAll roles carry
  // OS-native (already-localized) labels; the dictionary label uses t().
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const wc = mainWindow.webContents;
    const items = [];
    const suggestions = Array.isArray(params.dictionarySuggestions) ? params.dictionarySuggestions : [];
    for (const suggestion of suggestions) {
      items.push({ label: suggestion, click: () => wc.replaceMisspelling(suggestion) });
    }
    if (params.misspelledWord) {
      if (items.length) items.push({ type: 'separator' });
      items.push({
        label: t('menu.addToDictionary', null, 'Add to Dictionary'),
        click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      });
    }
    const flags = params.editFlags || {};
    const roleItems = [];
    if (params.isEditable) roleItems.push({ role: 'cut', enabled: !!flags.canCut });
    if (params.isEditable || params.selectionText) roleItems.push({ role: 'copy', enabled: !!flags.canCopy });
    if (params.isEditable) roleItems.push({ role: 'paste', enabled: !!flags.canPaste });
    if (params.isEditable) roleItems.push({ role: 'selectAll' });
    if (roleItems.length) {
      if (items.length) items.push({ type: 'separator' });
      items.push(...roleItems);
    }
    if (!items.length) return;
    Menu.buildFromTemplate(items).popup({ window: mainWindow });
  });

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

// ── IPC handler registration ─────────────────────────────────────────────────
// EVERY channel registers through this wrapper — never call ipcMain.handle()
// directly. The sender check is applied by DEFAULT and must be opted *out* of
// explicitly (`allowAnySender: true`, with a comment saying why), so a new
// handler is guarded by omission rather than by the author remembering.
//   • sender guard — reject calls that don't originate from the main window's
//     webContents. `senderFailure` is the exact value returned on rejection;
//     the shapes differ per channel and are load-bearing for the renderer
//     bridge (electron.ts), so divergent channels pass their own. Channels
//     whose contract has no failure shape (pure reads) pass REJECT_SENDER,
//     which rejects the invoke promise instead of inventing a return value.
//   • requireWorkDir — precondition for handlers that shell out to Docker.
//   • wrapErrors — uniform catch → { success: false, error: String(err) }.
// Nothing currently opts out: the app has exactly one BrowserWindow, new
// windows are denied (setWindowOpenHandler), and the splash + error pages load
// into that same window — so the recovery channels reached from error.html do
// come from mainWindow.webContents like every other channel.
const REJECT_SENDER = Symbol('reject-unauthorized-sender');

function registerHandler(channel, fn, {
  allowAnySender = false,
  senderFailure = { success: false, error: 'Unauthorized sender' },
  requireWorkDir = false,
  wrapErrors = false,
} = {}) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!allowAnySender && (!mainWindow || event.sender !== mainWindow.webContents)) {
      if (senderFailure === REJECT_SENDER) {
        throw new Error(`Unauthorized sender for ${channel}`);
      }
      return senderFailure;
    }
    if (requireWorkDir && !workDir) return { success: false, error: 'workDir not set' };
    if (!wrapErrors) return fn(event, ...args);
    try {
      return await fn(event, ...args);
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
}

// ── IPC: renderer can request a Docker image update ──────────────────────────
registerHandler('update:pull-image', async () => {
  // Pin to the digest the release published BEFORE pulling, so the pull fetches
  // immutable content rather than whatever the tag currently points at. A failed
  // lookup returns null and leaves the previous reference in place, so the update
  // proceeds exactly as it did before rather than being blocked on GitHub.
  const digest = await resolveReleaseImageDigest();
  if (digest) {
    const pinned = await pinImageDigest(workDir, digest);
    console.log(pinned
      ? `[update] pinned app image to ${digest}`
      : `[update] could not write image pin for ${digest} — continuing with the existing reference`);
  }
  const wasNew = await pullLatestImage(workDir);
  if (wasNew) {
    await restartAppContainer(workDir, overrideFiles);
    await pollHealth().catch(() => {});
  }
  return { success: true, wasNew };
}, {
  requireWorkDir: true,
  wrapErrors: true,
  senderFailure: { success: false, wasNew: false, error: 'Unauthorized sender' },
});

registerHandler('update:check-github', async () => {
  try {
    return await checkForShellUpdate();
  } catch (err) {
    return { error: String(err), update_mode: getUpdateMode() };
  }
}, { senderFailure: REJECT_SENDER });

registerHandler('update:install-shell', async () => {
  if (app.isPackaged && !useRepoMode) {
    return { success: false, error: 'Shell update not available in embedded mode — use Docker image update instead.' };
  }
  return await installPreparedShellUpdate();
}, { wrapErrors: true });

registerHandler('update:get-mode', () => ({
  mode: getUpdateMode(),
  is_packaged: app.isPackaged,
  use_repo_mode: useRepoMode,
}), { senderFailure: REJECT_SENDER });

registerHandler('update:pre-update-backup', async () => {
  try {
    const backupDir = path.join(app.getPath('userData'), 'pre-update-backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const result = await runBundleBackup(backupDir, null);
    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: err?.message || String(err) };
  }
});

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

registerHandler('backup:select-file', async () => {
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
}, { senderFailure: null });

registerHandler('backup:is-encrypted', async (_event, filePath) => {
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
}, { senderFailure: REJECT_SENDER });

registerHandler('backup:restore', async (event, filePath, opts) => {
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
    // Route the one destructive dialog through the same main-process t() loader
    // every other Electron dialog uses (reusing existing settings.restore.* keys),
    // so it follows the app language instead of being hardcoded English.
    buttons: [t('settings.restore.runNow', null, 'Restore'), t('settings.restore.cancelButton', null, 'Cancel')],
    defaultId: 1,
    cancelId: 1,
    title: t('settings.restore.title', null, 'Restore Backup'),
    message: t('settings.restore.warning', null, 'This will permanently replace all current data and cannot be undone.'),
    detail: path.basename(resolved),
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
}, { requireWorkDir: true });

// ── IPC: backup:run ───────────────────────────────────────────────────────────
// frontendStateJson is the serialised { keys: { … } } localStorage snapshot,
// collected by the renderer before invoking this handler.  Optional — when null
// (e.g. automated backup on quit) the bundle is created without frontend-state.json.
let backupInFlight = false;
registerHandler('backup:run', async (event, destDir, frontendStateJson = null) => {
  const destError = validateBackupDest(destDir);
  if (destError) return { success: false, error: destError };
  const resolvedDest = path.resolve(destDir);
  if (backupInFlight) return { success: false, error: 'A backup is already in progress' };
  backupInFlight = true;
  try {
    return await runBundleBackup(resolvedDest, frontendStateJson);
  } finally {
    backupInFlight = false;
  }
}, { requireWorkDir: true, wrapErrors: true });

registerHandler('backup:select-dir', async () => {
  const defaultPath = getDefaultICloudBackupDir() || app.getPath('documents');
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select Backup Directory',
    buttonLabel: 'Choose',
    defaultPath,
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
}, { senderFailure: null });

// Sender check matters here like on backup:restore — a compromised non-main
// frame must not be able to repoint where the quit-time backup writes.
registerHandler('backup:save-settings', async (event, { backupDir, backupOnQuit }) => {
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

registerHandler('backup:get-encryption-status', async () => {
  return { success: true, ...(await getBackupPassphraseStatus()) };
}, { senderFailure: REJECT_SENDER });

registerHandler('backup:set-passphrase', async (_event, passphrase) => {
  const value = typeof passphrase === 'string' ? passphrase : '';
  return await setBackupPassphrase(value.trim());
}, { senderFailure: { success: false, available: false, error: 'Unauthorized sender' } });

registerHandler('backup:load-settings', async () => {
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
}, { senderFailure: REJECT_SENDER });

// ── Services (keep-running-on-quit) settings ─────────────────────────────────
// Opt-in toggle: when enabled, quit leaves the Docker containers running so the
// next launch takes the hot path (S1-measured 0.6-1.1s) instead of a warm
// restart (~2-2.5s). Same dual DB + settings.json mirror as backup settings
// above — the will-quit handler needs a value even if the backend already
// stopped responding.
registerHandler('services:save-settings', async (event, { keepServicesOnQuit } = {}) => {
  const payload = { keepServicesOnQuit: !!keepServicesOnQuit };
  await updateSettings((cur) => {
    cur.keepServicesOnQuit = payload.keepServicesOnQuit;
  });
  try {
    await httpPut(`http://localhost:${appPort}/api/settings/services_settings`, { value: payload });
  } catch (err) {
    console.warn('services:save-settings: could not persist to DB, kept in local settings.json', err.message);
  }
  return { success: true };
});

registerHandler('services:load-settings', async () => {
  try {
    // The API wraps responses as { ok, data: { key, value } } (ADR-026).
    const body = await httpGet(`http://localhost:${appPort}/api/settings/services_settings`);
    const stored = body && body.data ? body.data.value : undefined;
    if (stored && typeof stored === 'object') {
      const keepServicesOnQuit = stored.keepServicesOnQuit === true;
      // Mirror back to settings.json so the will-quit fallback matches the DB.
      await updateSettings((cur) => { cur.keepServicesOnQuit = keepServicesOnQuit; });
      return { keepServicesOnQuit };
    }
  } catch (err) {
    console.warn('services:load-settings: could not read from DB, falling back to settings.json', err.message);
  }
  const s = await loadSettings();
  return { keepServicesOnQuit: s.keepServicesOnQuit === true };
}, { senderFailure: REJECT_SENDER });

// ── Recovery (error page) ────────────────────────────────────────────────────
registerHandler('recovery:retry', () => {
  pollAndLoad();
  return { success: true };
});

registerHandler('recovery:open-logs', async () => {
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

registerHandler('app:renderer-ready', () => {
  rendererReady = true;
  while (pendingAppMessages.length > 0) {
    const [channel, payload] = pendingAppMessages.shift();
    mainWindow.webContents.send(channel, payload);
  }
  return { success: true };
}, { senderFailure: { success: false } });

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
  // Populate the native About panel ({ role: 'about' } below) — otherwise it
  // shows only the bare app name with no version, copyright, or license. macOS
  // and Linux honour these; Windows has no native About panel.
  if (process.platform === 'darwin' || process.platform === 'linux') {
    try {
      app.setAboutPanelOptions({
        applicationName: APP_NAME,
        applicationVersion: app.getVersion ? app.getVersion() : '',
        copyright: `© ${new Date().getFullYear()} Vision · AGPL-3.0`,
        website: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`,
      });
    } catch { /* non-fatal — cosmetic */ }
  }

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
registerHandler('app:set-badge', (event, count) => {
  if (process.platform !== 'darwin' || !app.dock) return { success: false };
  const n = Number(count);
  if (!Number.isFinite(n)) return { success: false };
  const clamped = Math.max(0, Math.min(999, Math.floor(n)));
  app.dock.setBadge(clamped > 0 ? String(clamped) : '');
  return { success: true };
}, { senderFailure: { success: false } });

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

registerHandler('app:get-accent-color', () => {
  return readSystemAccentColor();
}, { senderFailure: null });

// Renderer mirrors the active theme's primary colors here so the next boot
// splash matches the chosen palette (see splashDataUrl / readSplashTheme).
// Validated on write and again on read — the values land in splash HTML/CSS.
registerHandler('theme:persist-splash', async (event, colors) => {
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
}, { senderFailure: { success: false } });

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
              ['compose', ...composeArgs(workDir, overrideFiles), 'pull', '--quiet', 'app', 'db'],
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

  // Opt-in "keep services running on quit": leave the containers up so the
  // next launch takes the hot path instead of a warm restart. Same dual
  // DB + settings.json read as resolveBackupSettings above (the backend may
  // already be shutting down by the time this runs). compose's
  // `restart: unless-stopped` policy governs reboot behaviour.
  async function resolveKeepServicesOnQuit() {
    try {
      const body = await httpGet(`http://localhost:${appPort}/api/settings/services_settings`);
      const stored = body && body.data ? body.data.value : undefined;
      if (stored && typeof stored === 'object') return stored.keepServicesOnQuit === true;
    } catch { /* backend may already be down, use local mirror */ }
    try {
      return (await loadSettings()).keepServicesOnQuit === true;
    } catch {
      return false;
    }
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
        const keepServices = await resolveKeepServicesOnQuit();
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
