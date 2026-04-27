'use strict';

const { app, BrowserWindow, dialog, Notification, shell, ipcMain, safeStorage, session } = require('electron');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
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

// ── Constants ─────────────────────────────────────────────────────────────────
const APP_NAME = 'Vision';
const DEFAULT_APP_PORT = 3002;
const HEALTH_POLL_ATTEMPTS = Number(process.env.VISION_HEALTH_POLL_ATTEMPTS) || 200;  // 200 × 300ms = 60s max
const HEALTH_POLL_INTERVAL_MS = Number(process.env.VISION_HEALTH_POLL_INTERVAL_MS) || 300;
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
const BACKUP_ENC_IV_BYTES = 16;
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
}

// Resolved at launch — see findFreePort() below
let appPort = DEFAULT_APP_PORT;
let APP_URL = `http://localhost:${appPort}`;
let HEALTH_URL = `http://localhost:${appPort}/health`;
const GITHUB_OWNER = 'EraPartner';
const GITHUB_REPO = 'Vision';

// ── Port detection ────────────────────────────────────────────────────────────
// Try the preferred port; if it's in use, walk up until a free one is found.
function findFreePort(preferred) {
  return new Promise((resolve) => {
    const net = require('net');
    const tryPort = (port) => {
      const server = net.createServer();
      server.unref();
      server.on('error', () => tryPort(port + 1));
      server.listen(port, '127.0.0.1', () => {
        server.close(() => resolve(port));
      });
    };
    tryPort(preferred);
  });
}

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

async function saveSettings(data) {
  await fs.promises.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.promises.writeFile(settingsPath, JSON.stringify(data, null, 2));
}

// ── Repo/workDir resolution ───────────────────────────────────────────────────
// In dev (electron . from packaging/electron/): resolve two levels up.
// In packaged .app: uses embedded docker-compose.yml shipped in app resources.
async function resolveWorkDir() {
  if (!app.isPackaged) {
    return path.resolve(__dirname, '..', '..');
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

  // If we've already set up the embedded compose, reuse it.
  const settings = await loadSettings();
  const embeddedCompose = settings.embeddedDir && path.join(settings.embeddedDir, 'docker-compose.yml');
  const hasEmbedded = embeddedCompose && await fs.promises.access(embeddedCompose).then(() => true).catch(() => false);
  if (hasEmbedded) {
    return settings.embeddedDir;
  }

  // Copy embedded compose from resources to a writable app data folder.
  const embeddedSrc = path.join(process.resourcesPath, 'resources', 'docker-compose.yml');
  const embeddedDir = path.join(app.getPath('userData'), 'embedded_compose');
  try {
    await fs.promises.mkdir(embeddedDir, { recursive: true });
    const dest = path.join(embeddedDir, 'docker-compose.yml');
    // Overwrite if exists to allow updates on new app versions
    await fs.promises.copyFile(embeddedSrc, dest);
    await saveSettings({ ...(await loadSettings()), embeddedDir });
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
async function ensureEnv(workDir) {
  const envFile = path.join(workDir, '.env');
  const exists = await fs.promises.access(envFile).then(() => true).catch(() => false);
  if (!exists) {
    const pgPass = crypto.randomBytes(32).toString('hex');
    const contents = [
      '# Auto-generated by Vision on first launch. Do not commit this file.',
      `POSTGRES_PASSWORD=${pgPass}`,
      `DATABASE_URL=postgresql://ftm_user:${pgPass}@db:5432/financial_transactions`,
    ].join('\n') + '\n';
    await fs.promises.writeFile(envFile, contents, { encoding: 'utf8', mode: 0o600 });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
// Extend PATH so the docker CLI is found when launched as a macOS .app
const dockerEnv = {
  ...process.env,
  PATH: [process.env.PATH, '/usr/local/bin', '/opt/homebrew/bin'].filter(Boolean).join(':'),
};

function run(bin, args, cwd, opts = {}) {
  const { env: envOverride, ...rest } = opts;
  const env = envOverride || dockerEnv;
  return new Promise((resolve, reject) => {
    // Default maxBuffer to 200 MB — pg_dump output can be large.
    const maxBuffer = rest.maxBuffer ?? 200 * 1024 * 1024;
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
  await saveSettings({ ...settings, backupDeviceId });
  return backupDeviceId;
}

async function getBackupPassphrase() {
  const envPassphrase = process.env.VISION_BACKUP_PASSPHRASE;
  if (envPassphrase) return envPassphrase;
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function' || !safeStorage.isEncryptionAvailable()) {
    return null;
  }
  try {
    const settings = await loadSettings();
    const encoded = settings.backupPassphraseEncrypted;
    if (!encoded || typeof encoded !== 'string') return null;
    const raw = Buffer.from(encoded, 'base64');
    return safeStorage.decryptString(raw);
  } catch {
    return null;
  }
}

async function setBackupPassphrase(passphrase) {
  const settings = await loadSettings();
  const next = { ...settings };
  if (!passphrase) {
    delete next.backupPassphraseEncrypted;
    await saveSettings(next);
    return { success: true, available: true };
  }
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function' || !safeStorage.isEncryptionAvailable()) {
    return { success: false, available: false, error: 'OS secure storage is not available on this device.' };
  }
  try {
    const encrypted = safeStorage.encryptString(passphrase);
    next.backupPassphraseEncrypted = encrypted.toString('base64');
    await saveSettings(next);
    return { success: true, available: true };
  } catch (err) {
    return { success: false, available: true, error: String(err) };
  }
}

async function getBackupPassphraseStatus() {
  const settings = await loadSettings();
  return {
    hasEnvPassphrase: Boolean(process.env.VISION_BACKUP_PASSPHRASE),
    hasStoredPassphrase: typeof settings.backupPassphraseEncrypted === 'string' && settings.backupPassphraseEncrypted.length > 0,
    secureStorageAvailable: Boolean(safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable()),
  };
}

async function getBackupEncryptionKey() {
  const passphrase = await getBackupPassphrase();
  if (!passphrase) return null;
  return crypto.scryptSync(passphrase, `${APP_NAME.toLowerCase()}-backup-v1`, 32);
}

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

  let removed = 0;
  for (const file of stale) {
    try {
      await fs.promises.unlink(file.fullPath);
      removed += 1;
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
    return magic.equals(BACKUP_ENC_MAGIC);
  } catch {
    return false;
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* ignore */ }
    }
  }
}

async function encryptBackupFile(sqlFilePath) {
  const key = await getBackupEncryptionKey();
  if (!key) {
    return { file: sqlFilePath, encrypted: false, warning: 'Backup encryption skipped: VISION_BACKUP_PASSPHRASE is not set.' };
  }

  const encPath = `${sqlFilePath}.enc`;
  const iv = crypto.randomBytes(BACKUP_ENC_IV_BYTES);

  await new Promise((resolve, reject) => {
    const input = fs.createReadStream(sqlFilePath);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
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

    output.write(BACKUP_ENC_MAGIC);
    output.write(iv);

    input.pipe(cipher).pipe(output);

    output.on('finish', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
  });

  fs.unlink(sqlFilePath, () => {});
  return { file: encPath, encrypted: true };
}

async function decryptBackupFileToTemp(encryptedFilePath) {
  const key = await getBackupEncryptionKey();
  if (!key) {
    throw new Error('This backup is encrypted. Set VISION_BACKUP_PASSPHRASE to restore it.');
  }

  const headerLen = BACKUP_ENC_MAGIC.length + BACKUP_ENC_IV_BYTES;
  const header = Buffer.alloc(headerLen);
  let handle;
  try {
    handle = await fs.promises.open(encryptedFilePath, 'r');
    const { bytesRead } = await handle.read(header, 0, headerLen, 0);
    if (bytesRead !== headerLen) {
      throw new Error('Invalid encrypted backup header.');
    }
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* ignore */ }
    }
  }

  const magic = header.subarray(0, BACKUP_ENC_MAGIC.length);
  if (!magic.equals(BACKUP_ENC_MAGIC)) {
    throw new Error('Backup is not in a supported encrypted format.');
  }

  const iv = header.subarray(BACKUP_ENC_MAGIC.length, headerLen);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const tempSqlPath = path.join(app.getPath('temp'), `vision_restore_${Date.now()}_${process.pid}.sql`);

  await new Promise((resolve, reject) => {
    const input = fs.createReadStream(encryptedFilePath, { start: headerLen });
    const output = fs.createWriteStream(tempSqlPath);

    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      input.destroy();
      decipher.destroy();
      output.destroy();
      fs.unlink(tempSqlPath, () => {});
      reject(err);
    };

    input.on('error', fail);
    decipher.on('error', fail);
    output.on('error', fail);

    input.pipe(decipher).pipe(output);

    output.on('finish', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
  });

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
function pollHealth() {
  return new Promise((resolve, reject) => {
    let tries = 0;
    const attempt = async () => {
      if (await pingHealth()) return resolve();
      tries += 1;
      if (tries >= HEALTH_POLL_ATTEMPTS) return reject(new Error('timeout'));
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

function pollAndLoad() {
  const endPollHealth = bootMark('poll_health');
  pollHealth()
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

async function checkDocker(cwd) {
  // Fast path: hit the Docker socket directly — avoids spawning docker CLI
  // and serialising `docker info` output (~6s → <50ms on warm macOS).
  const homeDir = process.env.HOME || '';
  const socketCandidates = [
    process.env.DOCKER_HOST?.replace(/^unix:\/\//, ''),
    path.join(homeDir, '.docker', 'run', 'docker.sock'),
    path.join(homeDir, '.docker', 'desktop', 'docker.sock'),
    '/var/run/docker.sock',
  ].filter(Boolean);

  for (const socketPath of socketCandidates) {
    try {
      await fs.promises.access(socketPath);
      await pingDockerSocket(socketPath);
      return 'ok';
    } catch {
      // socket missing or daemon not responding — try next candidate
    }
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
    ...(app.isPackaged || skipBuild ? [] : ['--build']),
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
      // All already running — skip if packaged (no build possible) or if the
      // skip-build cache confirmed the running image matches the current source.
      // In dev mode without a cache hit, fall through so `compose up --build`
      // can detect whether the running containers have stale code.
      if (services.every(s => getState(s) === 'running') && (app.isPackaged || skipBuild)) return { built: false };
      // All in a known stopped state + not a forced dev rebuild → compose start.
      const knownStates = new Set(['running', 'exited', 'created', 'paused']);
      const canUseStart = app.isPackaged || skipBuild;
      if (canUseStart && services.every(s => knownStates.has(getState(s)))) {
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
  return { built: !skipBuild && !app.isPackaged };
}

function stopContainers(cwd, extraFiles = []) {
  const args = ['compose', ...composeArgs(cwd, extraFiles), 'down'];
  return run('docker', args, cwd, { timeout: 60000 });
}

// Pull the latest Docker image tag for the app service without stopping the DB.
// Returns true if a new image was pulled, false if already up to date.
async function pullLatestImage(cwd) {
  try {
    const output = await run('docker', ['compose', 'pull', 'app'], cwd, { timeout: 120000 });
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
  await run('docker', args, cwd, { timeout: 120000 });
}

// ── Main window ───────────────────────────────────────────────────────────────
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: APP_NAME,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // Preload exposes a minimal update API to the renderer
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  // Caller is responsible for loading the initial URL.
  mainWindow.on('closed', () => { mainWindow = null; });
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
  const pa = String(a || '').replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

function getCurrentVersionTag() {
  const candidates = [
    workDir ? path.join(workDir, 'package.json') : null,
    path.resolve(__dirname, '..', '..', 'package.json'),
  ].filter(Boolean);

  for (const pkgPath of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (typeof pkg.version === 'string' && pkg.version.trim()) {
        return normalizeVersionTag(pkg.version.trim());
      }
    } catch {
      // try next candidate
    }
  }

  return normalizeVersionTag(app.getVersion());
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function writeInstallerScript({ scriptPath, sourceRootPath, sourceLaunchPath, destRootPath, hostPid }) {
  const script = [
    '#!/bin/bash',
    'set -euo pipefail',
    `SRC_ROOT=${shellEscape(sourceRootPath)}`,
    `SRC_LAUNCH=${shellEscape(sourceLaunchPath || '')}`,
    `DEST_ROOT=${shellEscape(destRootPath)}`,
    `HOST_PID=${hostPid}`,
    '',
    '# Wait until the running app exits before replacing source files.',
    'for i in {1..120}; do',
    '  if ! kill -0 "$HOST_PID" 2>/dev/null; then break; fi',
    '  sleep 0.5',
    'done',
    '',
    'mkdir -p "$DEST_ROOT"',
    'rsync -a --delete --exclude ".env" --exclude "postgres_data" --exclude ".git" --exclude "node_modules" "$SRC_ROOT/" "$DEST_ROOT/"',
    '',
    '# Install bun if missing (non-interactive).',
    'if ! command -v bun >/dev/null 2>&1; then',
    '  export BUN_INSTALL="$HOME/.bun"',
    '  curl -fsSL https://bun.sh/install | bash',
    '  export PATH="$BUN_INSTALL/bin:$PATH"',
    'fi',
    '',
    'cd "$DEST_ROOT"',
    'bun install',
    '',
    'if [ -n "$SRC_LAUNCH" ] && [ -f "$SRC_LAUNCH" ]; then',
    '  cp "$SRC_LAUNCH" "$DEST_ROOT/launch.command" 2>/dev/null || true',
    '  chmod +x "$DEST_ROOT/launch.command" 2>/dev/null || true',
    'fi',
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

  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(zipPath);
    const req = https.get(sourceLauncherAsset.browser_download_url, {
      headers: { 'User-Agent': `${APP_NAME}-desktop/${app.getVersion()}` },
    }, (res) => {
      if (res.statusCode !== 200) {
        file.close(() => fs.unlink(zipPath, () => {}));
        reject(new Error(`Download failed (${res.statusCode})`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    });
    req.setTimeout(UPDATE_DOWNLOAD_TIMEOUT_MS, () => {
      req.destroy(new Error('Update download timed out'));
    });
    req.on('error', (err) => {
      file.close(() => fs.unlink(zipPath, () => {}));
      reject(err);
    });
    file.on('error', (err) => {
      req.destroy(err);
      reject(err);
    });
  });

  const checksumAsset = pickChecksumAsset(release, sourceLauncherAsset.name);
  if (checksumAsset?.browser_download_url) {
    let expected = null;
    try {
      const body = await fetchUrlBody(checksumAsset.browser_download_url);
      expected = parseSha256Body(body);
    } catch (err) {
      console.warn('[update] Failed to fetch checksum:', err && err.message ? err.message : err);
    }
    if (expected) {
      const actual = await computeFileSha256(zipPath);
      if (actual.toLowerCase() !== expected.toLowerCase()) {
        try { fs.unlinkSync(zipPath); } catch (_) {}
        throw new Error('Checksum mismatch');
      }
    }
  }

  await run('ditto', ['-x', '-k', zipPath, extractDir], tempRoot, { env: process.env });

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
}

async function checkForShellUpdate() {
  const release = await readGitHubRelease();
  const latestVersion = normalizeVersionTag(release?.tag_name);
  const currentVersion = getCurrentVersionTag();
  const sourceLauncherAsset = pickSourceLauncherZip(release);

  if (!latestVersion || !sourceLauncherAsset?.browser_download_url) {
    return { up_to_date: true, current_version: currentVersion, latest_version: null, error: 'No compatible source launcher update asset found.' };
  }

  return {
    up_to_date: compareVersions(latestVersion, currentVersion) <= 0,
    current_version: currentVersion,
    latest_version: latestVersion,
    html_url: release?.html_url,
    release_notes: release?.body || '',
    published_at: release?.published_at,
    source_launcher_available: Boolean(sourceLauncherAsset?.browser_download_url),
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
    const wasNew = await pullLatestImage(cwd);
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
    http.get(url, { headers: { 'Content-Type': 'application/json' } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
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

  let dbName = 'financial_transactions';
  let dbUser = 'ftm_user';
  try {
    const envFile = path.join(workDir, '.env');
    const envContents = await fs.promises.readFile(envFile, 'utf8');
    const urlMatch = envContents.match(/DATABASE_URL=postgresql:\/\/([^:@]+)(?::[^@]*)?@[^/]+\/(\S+)/);
    if (urlMatch) { dbUser = urlMatch[1]; dbName = urlMatch[2]; }
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

/**
 * Query the running DB for the current alembic revision.
 * Returns empty string if unavailable (e.g. DB not yet initialised).
 */
async function getSchemaHead(composeFileArgs, dbUser, dbName) {
  try {
    const result = await run('docker', [
      'compose', ...composeFileArgs, 'exec', '-T', 'db',
      'psql', '-U', dbUser, '-d', dbName, '-t', '-A', '-c',
      'SELECT version_num FROM alembic_version LIMIT 1;',
    ], workDir, { timeout: 10000 });
    return result.trim();
  } catch {
    return '';
  }
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
    const envFile = path.join(workDir, '.env');
    const envContents = await fs.promises.readFile(envFile, 'utf8');
    const urlMatch = envContents.match(/DATABASE_URL=postgresql:\/\/([^:@]+)(?::[^@]*)?@[^/]+\/(\S+)/);
    if (urlMatch) { dbUser = urlMatch[1]; dbName = urlMatch[2]; }
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

    // 5. Encrypt if passphrase configured
    const key = await getBackupEncryptionKey();
    let finalFile = bundlePath;
    let encrypted = false;
    let warning;
    if (key) {
      const { encPath } = await encryptBundle(bundlePath, key);
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
async function runBundleRestore(bundlePath) {
  if (!bundlePath) throw new Error('No backup file specified');
  if (!fs.existsSync(bundlePath)) throw new Error(`File not found: ${bundlePath}`);

  const key = await getBackupEncryptionKey();

  // Open bundle — decrypt + extract to temp dir
  const { metadata, dbSqlPath, attachmentsDir, frontendState, cleanup } = await openBundle(bundlePath, { key });

  let dbUser = 'ftm_user';
  let dbPass = '';
  let dbName = 'financial_transactions';
  try {
    const envFile = path.join(workDir, '.env');
    const envContents = await fs.promises.readFile(envFile, 'utf8');
    const urlMatch = envContents.match(/DATABASE_URL=postgresql:\/\/([^:@]+)(?::([^@]*))?@[^/]+\/(\S+)/);
    if (urlMatch) { dbUser = urlMatch[1]; dbPass = urlMatch[2] || ''; dbName = urlMatch[3]; }
  } catch { /* use defaults */ }

  const composeFileArgs = composeArgs(workDir, overrideFiles);

  // Schema version check: block restore if bundle is from a newer schema
  if (metadata.schemaHead) {
    const currentHead = await getSchemaHead(composeFileArgs, dbUser, dbName);
    if (currentHead && metadata.schemaHead > currentHead) {
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

    await new Promise((resolve, reject) => {
      const child = spawn('docker', [
        'run', '--rm',
        '-v', `${hostDir}:/restore:ro`,
        ...(networkName ? ['--network', networkName] : []),
        '-e', `PGPASSWORD=${dbPass}`,
        pgImageTag,
        'psql', '-h', 'db', '-U', dbUser, '-d', dbName,
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
    });

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

    // 6. Atomically swap attachments.staging → attachments once container is up
    if (attachmentsDir) {
      pollHealth().then(() => {
        const composeArgs_ = composeArgs(workDir, overrideFiles);
        return run('docker', [
          'compose', ...composeArgs_, 'exec', '-T', 'app',
          'sh', '-c',
          'rm -rf /app/data/attachments.old && ' +
          'mv /app/data/attachments /app/data/attachments.old 2>/dev/null; ' +
          'mv /app/data/attachments.staging /app/data/attachments && ' +
          'rm -rf /app/data/attachments.old',
        ], workDir, { timeout: 30000 });
      }).catch((err) => {
        console.error('Attachment swap failed after bundle restore:', err);
      });
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
    return { error: String(err) };
  }
});

ipcMain.handle('update:install-shell', async () => {
  try {
    return await installPreparedShellUpdate();
  } catch (err) {
    return { success: false, error: String(err) };
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
async function runRestore(sqlFilePath) {
  if (!sqlFilePath) throw new Error('No backup file specified');
  if (!fs.existsSync(sqlFilePath)) throw new Error(`File not found: ${sqlFilePath}`);

  let restoreSource = sqlFilePath;
  let cleanupRestoreSource = () => {};
  if (await isEncryptedBackupFile(sqlFilePath)) {
    restoreSource = await decryptBackupFileToTemp(sqlFilePath);
    cleanupRestoreSource = () => fs.unlink(restoreSource, () => {});
  }

  let dbName = 'financial_transactions';
  let dbUser = 'ftm_user';
  let dbPass = '';
  try {
    const envFile = path.join(workDir, '.env');
    const envContents = await fs.promises.readFile(envFile, 'utf8');
    const urlMatch = envContents.match(/DATABASE_URL=postgresql:\/\/([^:@]+)(?::([^@]*))?@[^/]+\/(\S+)/);
    if (urlMatch) { dbUser = urlMatch[1]; dbPass = urlMatch[2] || ''; dbName = urlMatch[3]; }
  } catch { /* use defaults */ }

  const composeFileArgs = composeArgs(workDir, overrideFiles);

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

    const dockerRunArgs = [
      'run', '--rm',
      '-v', `${hostDir}:/restore:ro`,
      ...(networkName ? ['--network', networkName] : []),
      '-e', `PGPASSWORD=${dbPass}`,
      pgImageTag,
      'psql',
      '-h', 'db',
      '-U', dbUser,
      '-d', dbName,
      '-f', `/restore/${sqlFilename}`,
    ];

    // Stream psql output — no buffering, works for any file size
    await new Promise((resolve, reject) => {
      const child = spawn('docker', dockerRunArgs, {
        env: dockerEnv,
        cwd: workDir,
      });

      const stderr = [];
      child.stderr.on('data', (chunk) => stderr.push(chunk));
      // psql outputs progress to stdout — discard it (we don't need it in memory)
      child.stdout.resume();

      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(Buffer.concat(stderr).toString().trim() || `psql exited with code ${code}`));
      });
    });

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
  return result.filePaths[0];
});

ipcMain.handle('backup:restore', async (_event, filePath) => {
  if (!workDir) return { success: false, error: 'workDir not set' };
  try {
    // Route .visionbak / .visionbak.enc through the new bundle restore path;
    // legacy .sql / .enc files fall through to the original runRestore.
    const isBundle = filePath.endsWith('.visionbak') || filePath.endsWith('.visionbak.enc');
    const result = isBundle
      ? await runBundleRestore(filePath)
      : await runRestore(filePath);
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
  }
});

// ── IPC: backup:run ───────────────────────────────────────────────────────────
// frontendStateJson is the serialised { keys: { … } } localStorage snapshot,
// collected by the renderer before invoking this handler.  Optional — when null
// (e.g. automated backup on quit) the bundle is created without frontend-state.json.
ipcMain.handle('backup:run', async (_event, destDir, frontendStateJson = null) => {
  if (!workDir) return { success: false, error: 'workDir not set' };
  try {
    const result = await runBundleBackup(destDir, frontendStateJson);
    return result;
  } catch (err) {
    return { success: false, error: String(err) };
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

ipcMain.handle('backup:save-settings', async (_event, { backupDir, backupOnQuit }) => {
  // Persist to database via the running backend API (source of truth).
  // Also mirror to local settings.json as a fallback for the will-quit handler
  // in case the backend is already shutting down.
  const payload = { backupDir: backupDir || '', backupOnQuit: !!backupOnQuit };
  await saveSettings({ ...(await loadSettings()), backupDir: payload.backupDir, backupOnQuit: payload.backupOnQuit });
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
    const data = await httpGet(`http://localhost:${appPort}/api/settings/backup_settings`);
    if (data && data.value) {
      const v = resolveBackupSettingsWithDefaults(data.value);
      // Mirror back to local settings.json so will-quit always has a fresh copy.
      await saveSettings({ ...(await loadSettings()), backupDir: v.backupDir || '', backupOnQuit: v.backupOnQuit === true });
      return { backupDir: v.backupDir || '', backupOnQuit: v.backupOnQuit === true };
    }
  } catch (err) {
    console.warn('backup:load-settings: could not read from DB, falling back to settings.json', err.message);
  }
  const s = resolveBackupSettingsWithDefaults(await loadSettings());
  return { backupDir: s.backupDir || '', backupOnQuit: s.backupOnQuit === true };
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

// ── Compose override (dev modes) ─────────────────────────────────────────────
// Set VISION_COMPOSE_OVERRIDE to a filename (relative to workDir) to layer an
// additional compose file on top of the base — e.g. docker-compose.dev.yml.
// Used by the electron:dev and electron:clean root package.json scripts.
function resolveOverrideFiles(workDir) {
  const override = process.env.VISION_COMPOSE_OVERRIDE;
  if (!override || app.isPackaged) return [];
  // Accept absolute paths too, but the common case is a repo-root filename.
  const resolved = path.isAbsolute(override) ? override : path.join(workDir, override);
  return fs.existsSync(resolved) ? [resolved] : [];
}

// ── Launch flow ───────────────────────────────────────────────────────────────
let workDir = null;
let overrideFiles = [];

async function launch() {
  const endLaunch = bootMark('launch');

  // 0. Register prod CSP + security headers before any window loads.
  registerSecurityHeaders();

  // 0a. Load i18n asynchronously so dialog strings resolve. If this fails,
  //     t() falls back to the key itself — survivable for startup paths.
  const endI18n = bootMark('init_i18n');
  await initI18n();
  endI18n();

  // 0b. Open the loading window IMMEDIATELY so the user sees something straight
  //    away — before any Docker I/O, which can take seconds or even minutes on
  //    a cold start. The window will navigate to APP_URL once the backend is ready.
  const endWindow = bootMark('create_window');
  createWindow();
  mainWindow.loadURL(
    'data:text/html,<html><body style="margin:0;background:#0f172a;display:flex;align-items:center;justify-content:center;height:100vh">' +
    '<p style="color:#94a3b8;font-family:system-ui,sans-serif;font-size:1rem">Starting Vision\u2026</p></body></html>'
  );
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
  const endParallelInit = bootMark('parallel_init');
  await Promise.all([
    // Find a free host port for the backend (default 3002, auto-increment if taken)
    (() => {
      const end = bootMark('find_free_port');
      return findFreePort(DEFAULT_APP_PORT).then(port => {
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
    app.isPackaged
      ? (async () => {
          const end = bootMark('pre_pull_image');
          try {
            const ids = await run(
              'docker',
              ['compose', ...composeArgs(workDir, overrideFiles), 'images', '-q', 'app'],
              workDir,
              { timeout: 10000, env: dockerEnv }
            ).then(r => r.trim()).catch(() => '');
            if (ids) { end(); return; }
            await run(
              'docker',
              ['compose', ...composeArgs(workDir, overrideFiles), 'pull', '--quiet', 'app'],
              workDir,
              { timeout: 600000, env: dockerEnv }
            );
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
    !app.isPackaged
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
    if (response === 0) shell.openPath('/Applications/Docker.app');
    app.quit();
    return;
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
  const endComposeUp = bootMark('compose_up');
  let composeDidBuild = false;
  try {
    const { built } = await composeStartOrUp(workDir, overrideFiles, skipBuild);
    composeDidBuild = built;
    endComposeUp();
  } catch (err) {
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
  pollAndLoad();

  // 10. Set up manual shell updater (non-blocking — runs in background)
  setupManualShellUpdater();

  // Dev-mode: watch source files and trigger a docker rebuild+restart when
  // local sources change. This ensures the electron dev wrapper picks up
  // code edits without requiring manual docker-compose rebuilds.
  if (!app.isPackaged && overrideFiles.length > 0) {
    try {
      let fileChangeTimer = null;
      let activeBuildChild = null;
      const watchTargets = ['apps/frontend', 'apps/node-backend', 'package.json', 'bun.lock', 'bun.lockb'];

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
            if (fname && /(^\.|~$|\.swp$|\.swx$)/.test(fname)) return;
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
}

// ── Shutdown flow ─────────────────────────────────────────────────────────────
let isQuitting = false;

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
      const data = await httpGet(`http://localhost:${appPort}/api/settings/backup_settings`);
      if (data && data.value) return data.value;
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
      .then(() => stopContainers(workDir, overrideFiles))
      .catch((err) => console.error('docker compose down failed:', err))
      .finally(() => {
        clearTimeout(forceQuitTimer);
        notify(t('app.stopped'));
        app.exit(0);
      });
  });
});

// ── App lifecycle ─────────────────────────────────────────────────────────────
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(launch);

  app.on('activate', () => {
    if (mainWindow === null) {
      createWindow();
      mainWindow.loadURL(APP_URL);
    }
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
