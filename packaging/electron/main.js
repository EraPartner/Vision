'use strict';

const { app, BrowserWindow, dialog, Notification, shell, ipcMain, safeStorage } = require('electron');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
// Small i18n loader for main process dialogs
function loadI18n() {
  const locale = (app && app.getLocale && typeof app.getLocale === 'function') ? app.getLocale() : 'en';
  const lang = locale && locale.startsWith('nl') ? 'nl' : 'en';

  // Prefer i18n shipped in the app resources (packaged .app).
  const resourceI18nDir = path.join(process.resourcesPath || '', 'i18n');
  const fallbackI18nDir = path.join(__dirname, 'i18n');

  const tryLoad = (dir) => {
    try {
      const p = path.join(dir, `${lang}.json`);
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      // ignore
    }
    return null;
  };

  const byResources = resourceI18nDir && tryLoad(resourceI18nDir);
  if (byResources) return byResources;

  const byFallback = tryLoad(fallbackI18nDir);
  if (byFallback) return byFallback;

  // Last resort: try English in resources then fallback dir
  try {
    const p2 = path.join(resourceI18nDir, 'en.json');
    if (fs.existsSync(p2)) return JSON.parse(fs.readFileSync(p2, 'utf8'));
  } catch (e) {}
  try {
    const p3 = path.join(fallbackI18nDir, 'en.json');
    if (fs.existsSync(p3)) return JSON.parse(fs.readFileSync(p3, 'utf8'));
  } catch (e) {}

  return {};
}

const i18n = loadI18n();
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
const HEALTH_POLL_ATTEMPTS = 120;  // 120 × 300ms = 36s max
const HEALTH_POLL_INTERVAL_MS = 300;
const MANUAL_UPDATE_CHECK_DELAY_MS = 30_000;
const BACKUP_ENC_MAGIC = Buffer.from('VISIONENC1');
const BACKUP_ENC_IV_BYTES = 16;
const BACKUP_RETENTION_KEEP = 7;
const BACKUP_RETENTION_GRACE_MS = 10 * 60 * 1000;
const UPDATE_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

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

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
  catch { return {}; }
}

function saveSettings(data) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2));
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
    if (!fs.existsSync(packagedI18n)) {
      // If it's missing, attempt to copy from the repo i18n/source (best effort)
      const repoI18n = path.join(__dirname, '..', 'i18n');
      if (fs.existsSync(repoI18n)) {
        fs.mkdirSync(packagedI18n, { recursive: true });
        const files = fs.readdirSync(repoI18n);
        for (const f of files) {
          const src = path.join(repoI18n, f);
          const dst = path.join(packagedI18n, f);
          try { fs.copyFileSync(src, dst); } catch (e) { /* ignore */ }
        }
      }
    }
  } catch (e) {
    // Non-fatal — packaged app should include i18n via build step. If not,
    // dialogs will fallback to internal defaults.
  }

  // If we've already set up the embedded compose, reuse it.
  const settings = loadSettings();
  if (settings.embeddedDir && fs.existsSync(path.join(settings.embeddedDir, 'docker-compose.yml'))) {
    return settings.embeddedDir;
  }

  // Copy embedded compose from resources to a writable app data folder.
  const embeddedSrc = path.join(process.resourcesPath, 'resources', 'docker-compose.yml');
  const embeddedDir = path.join(app.getPath('userData'), 'embedded_compose');
  try {
    fs.mkdirSync(embeddedDir, { recursive: true });
    const dest = path.join(embeddedDir, 'docker-compose.yml');
    // Overwrite if exists to allow updates on new app versions
    fs.copyFileSync(embeddedSrc, dest);
    saveSettings({ ...loadSettings(), embeddedDir });
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
function ensureEnv(workDir) {
  const envFile = path.join(workDir, '.env');
  if (!fs.existsSync(envFile)) {
    const pgPass = crypto.randomBytes(32).toString('hex');
    const contents = [
      '# Auto-generated by Vision on first launch. Do not commit this file.',
      `POSTGRES_PASSWORD=${pgPass}`,
      `DATABASE_URL=postgresql://ftm_user:${pgPass}@db:5432/financial_transactions`,
    ].join('\n') + '\n';
    fs.writeFileSync(envFile, contents, { encoding: 'utf8', mode: 0o600 });
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

function getBackupDeviceId() {
  const settings = loadSettings();
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
  saveSettings({ ...settings, backupDeviceId });
  return backupDeviceId;
}

function getBackupPassphrase() {
  const envPassphrase = process.env.VISION_BACKUP_PASSPHRASE;
  if (envPassphrase) return envPassphrase;
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function' || !safeStorage.isEncryptionAvailable()) {
    return null;
  }
  try {
    const settings = loadSettings();
    const encoded = settings.backupPassphraseEncrypted;
    if (!encoded || typeof encoded !== 'string') return null;
    const raw = Buffer.from(encoded, 'base64');
    return safeStorage.decryptString(raw);
  } catch {
    return null;
  }
}

function setBackupPassphrase(passphrase) {
  const settings = loadSettings();
  const next = { ...settings };
  if (!passphrase) {
    delete next.backupPassphraseEncrypted;
    saveSettings(next);
    return { success: true, available: true };
  }
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function' || !safeStorage.isEncryptionAvailable()) {
    return { success: false, available: false, error: 'OS secure storage is not available on this device.' };
  }
  try {
    const encrypted = safeStorage.encryptString(passphrase);
    next.backupPassphraseEncrypted = encrypted.toString('base64');
    saveSettings(next);
    return { success: true, available: true };
  } catch (err) {
    return { success: false, available: true, error: String(err) };
  }
}

function getBackupPassphraseStatus() {
  const settings = loadSettings();
  return {
    hasEnvPassphrase: Boolean(process.env.VISION_BACKUP_PASSPHRASE),
    hasStoredPassphrase: typeof settings.backupPassphraseEncrypted === 'string' && settings.backupPassphraseEncrypted.length > 0,
    secureStorageAvailable: Boolean(safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable()),
  };
}

function getBackupEncryptionKey() {
  const passphrase = getBackupPassphrase();
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
    .filter((name) => name.startsWith(prefix) && (name.endsWith('.sql') || name.endsWith('.sql.enc')))
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

function isEncryptedBackupFile(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const magic = Buffer.alloc(BACKUP_ENC_MAGIC.length);
      const bytesRead = fs.readSync(fd, magic, 0, magic.length, 0);
      if (bytesRead !== BACKUP_ENC_MAGIC.length) return false;
      return magic.equals(BACKUP_ENC_MAGIC);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

async function encryptBackupFile(sqlFilePath) {
  const key = getBackupEncryptionKey();
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
  const key = getBackupEncryptionKey();
  if (!key) {
    throw new Error('This backup is encrypted. Set VISION_BACKUP_PASSPHRASE to restore it.');
  }

  const headerLen = BACKUP_ENC_MAGIC.length + BACKUP_ENC_IV_BYTES;
  const header = Buffer.alloc(headerLen);
  const fd = fs.openSync(encryptedFilePath, 'r');
  try {
    const bytesRead = fs.readSync(fd, header, 0, headerLen, 0);
    if (bytesRead !== headerLen) {
      throw new Error('Invalid encrypted backup header.');
    }
  } finally {
    fs.closeSync(fd);
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

// Poll /health until success or timeout
function pollHealth() {
  return new Promise((resolve, reject) => {
    let tries = 0;
    const attempt = () => {
      const req = http.get(HEALTH_URL, (res) => {
        if (res.statusCode >= 200 && res.statusCode < 400) return resolve();
        res.resume();
        retry();
      });
      req.on('error', retry);
      req.setTimeout(1500, () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (++tries >= HEALTH_POLL_ATTEMPTS) return reject(new Error('timeout'));
      setTimeout(attempt, HEALTH_POLL_INTERVAL_MS);
    };
    attempt();
  });
}

// ── Docker checks ─────────────────────────────────────────────────────────────
// A single `docker info` call tells us both: if docker isn't on PATH it throws
// ENOENT (not installed); if Docker Desktop isn't running it exits non-zero.
// Returns 'ok' | 'not-installed' | 'not-running'
async function checkDocker(cwd) {
  try {
    await run('docker', ['info'], cwd, { timeout: 8000 });
    return 'ok';
  } catch (err) {
    // ENOENT / "command not found" → binary missing
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
    const envContents = fs.readFileSync(envFile, 'utf8');
    const urlMatch = envContents.match(/DATABASE_URL=postgresql:\/\/([^:@]+)(?::[^@]*)?@[^/]+\/(\S+)/);
    if (urlMatch) { dbUser = urlMatch[1]; dbName = urlMatch[2]; }
  } catch { /* use defaults */ }

  const deviceId = getBackupDeviceId();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const filename = `vision_backup_${deviceId}_${timestamp}.sql`;
  const sqlFile = path.join(destDir, filename);

  fs.mkdirSync(destDir, { recursive: true });

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
//   4. Restart the app container (backend reconnects + schemaInit runs)
async function runRestore(sqlFilePath) {
  if (!sqlFilePath) throw new Error('No backup file specified');
  if (!fs.existsSync(sqlFilePath)) throw new Error(`File not found: ${sqlFilePath}`);

  let restoreSource = sqlFilePath;
  let cleanupRestoreSource = () => {};
  if (isEncryptedBackupFile(sqlFilePath)) {
    restoreSource = await decryptBackupFileToTemp(sqlFilePath);
    cleanupRestoreSource = () => fs.unlink(restoreSource, () => {});
  }

  let dbName = 'financial_transactions';
  let dbUser = 'ftm_user';
  let dbPass = '';
  try {
    const envFile = path.join(workDir, '.env');
    const envContents = fs.readFileSync(envFile, 'utf8');
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
      { name: 'Vision Backup Files', extensions: ['sql', 'enc'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('backup:restore', async (_event, sqlFilePath) => {
  if (!workDir) return { success: false, error: 'workDir not set' };
  try {
    const result = await runRestore(sqlFilePath);
    return result;
  } catch (err) {
    // Make sure app container is back up even after an error
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
ipcMain.handle('backup:run', async (_event, destDir) => {
  if (!workDir) return { success: false, error: 'workDir not set' };
  try {
    const result = await runBackup(destDir);
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
  saveSettings({ ...loadSettings(), backupDir: payload.backupDir, backupOnQuit: payload.backupOnQuit });
  try {
    await httpPut(`http://localhost:${appPort}/api/settings/backup_settings`, { value: payload });
  } catch (err) {
    console.warn('backup:save-settings: could not persist to DB, kept in local settings.json', err.message);
  }
  return { success: true };
});

ipcMain.handle('backup:get-encryption-status', async () => {
  return { success: true, ...getBackupPassphraseStatus() };
});

ipcMain.handle('backup:set-passphrase', async (_event, passphrase) => {
  const value = typeof passphrase === 'string' ? passphrase : '';
  return setBackupPassphrase(value.trim());
});

ipcMain.handle('backup:load-settings', async () => {
  // Prefer reading from the database; fall back to settings.json if the backend
  // is not yet available (e.g. during very early startup).
  try {
    const data = await httpGet(`http://localhost:${appPort}/api/settings/backup_settings`);
    if (data && data.value) {
      const v = resolveBackupSettingsWithDefaults(data.value);
      // Mirror back to local settings.json so will-quit always has a fresh copy.
      saveSettings({ ...loadSettings(), backupDir: v.backupDir || '', backupOnQuit: v.backupOnQuit === true });
      return { backupDir: v.backupDir || '', backupOnQuit: v.backupOnQuit === true };
    }
  } catch (err) {
    console.warn('backup:load-settings: could not read from DB, falling back to settings.json', err.message);
  }
  const s = resolveBackupSettingsWithDefaults(loadSettings());
  return { backupDir: s.backupDir || '', backupOnQuit: s.backupOnQuit === true };
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
  // 0. Open the loading window IMMEDIATELY so the user sees something straight
  //    away — before any Docker I/O, which can take seconds or even minutes on
  //    a cold start. The window will navigate to APP_URL once the backend is ready.
  createWindow();
  mainWindow.loadURL(
    'data:text/html,<html><body style="margin:0;background:#0f172a;display:flex;align-items:center;justify-content:center;height:100vh">' +
    '<p style="color:#94a3b8;font-family:system-ui,sans-serif;font-size:1rem">Starting Vision\u2026</p></body></html>'
  );

  // 1. Resolve project folder
  workDir = await resolveWorkDir();
  if (!workDir) return;

  // 1b. Resolve any compose override requested via env var (dev flows only)
  overrideFiles = resolveOverrideFiles(workDir);

  // 1c–2. Find a free port, generate .env, check Docker health, and (in dev) check
  //        if the app image already exists — all are independent so run in parallel.
  let skipBuild = false;
  let dockerStatus = 'ok';
  await Promise.all([
    // Find a free host port for the backend (default 3002, auto-increment if taken)
    findFreePort(DEFAULT_APP_PORT).then(port => {
      appPort = port;
      APP_URL = `http://localhost:${appPort}`;
      HEALTH_URL = `http://localhost:${appPort}/health`;
    }),

    // First run: generate .env if missing (synchronous file I/O, wrapped to fit Promise.all)
    Promise.resolve(ensureEnv(workDir)),

    // Check Docker is installed and running — overlaps with port scan and env init
    checkDocker(workDir).then(status => { dockerStatus = status; }),

    // In dev, decide whether to skip --build. We prefer to skip when an image
    // already exists and the source hasn't changed since it was built. To do
    // that we inspect the composed app image and compare its creation time to
    // the latest git commit time — and also respect uncommitted local changes.
    !app.isPackaged
      ? (async () => {
          try {
            const imageIds = (await run('docker', [
              'compose', ...composeArgs(workDir, overrideFiles), 'images', '-q', 'app',
            ], workDir, { timeout: 10000 })).trim();
            if (!imageIds) { skipBuild = false; return; }
            // Use first image id returned (compose may list multiple lines)
            const imageId = imageIds.split(/\s+/)[0];
            // If there are local uncommitted changes, force rebuild so dev sees them
            const por = (await run('git', ['status', '--porcelain'], workDir).catch(() => '')).trim();
            if (por.length > 0) { skipBuild = false; return; }
            // Get last commit time (unix seconds)
            const commitTsStr = (await run('git', ['log', '-1', '--format=%ct'], workDir).catch(() => '')).trim();
            if (!commitTsStr) { skipBuild = false; return; }
            const commitTs = parseInt(commitTsStr, 10) * 1000;
            // Inspect image creation time
            const createdStr = (await run('docker', ['image', 'inspect', imageId, '--format', '{{.Created}}'], workDir).catch(() => '')).trim();
            if (!createdStr) { skipBuild = false; return; }
            const createdTs = Date.parse(createdStr);
            if (isNaN(createdTs) || isNaN(commitTs)) { skipBuild = false; return; }
            // If the latest commit is newer than the image creation, rebuild.
            skipBuild = commitTs <= createdTs;
          } catch (e) {
            // Any failure here means we conservatively do not skip the build.
            skipBuild = false;
          }
        })()
      : Promise.resolve(),
  ]);

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

  // 7. docker compose up
  try {
    await startContainers(workDir, overrideFiles, skipBuild);
  } catch (err) {
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

  // 8. Backend is being polled — poll /health in the background; navigate once ready.
  pollHealth()
    .then(() => {
      if (mainWindow) mainWindow.loadURL(APP_URL);
      notify(t('app.running'));
    })
    .catch(() => {
      // Timed out — navigate anyway and let the user see the error in the UI.
      if (mainWindow) mainWindow.loadURL(APP_URL);
      dialog.showMessageBox({
        type: 'warning',
        buttons: [t('common.ok')],
        title: APP_NAME,
        message: t('app.startSlow'),
        detail: t('app.startSlowDetail', { url: APP_URL }),
      });
    });

  // 10. Set up manual shell updater (non-blocking — runs in background)
  setupManualShellUpdater();

  // Dev-mode: watch source files and trigger a docker rebuild+restart when
  // local sources change. This ensures the electron dev wrapper picks up
  // code edits without requiring manual docker-compose rebuilds.
  if (!app.isPackaged && overrideFiles.length > 0) {
    try {
      let fileChangeTimer = null;
      let isBuildingOnChange = false;
      const watchTargets = ['apps/frontend', 'apps/node-backend', 'package.json', 'bun.lock', 'bun.lockb'];
      const scheduleRebuild = () => {
        if (isBuildingOnChange) return;
        if (fileChangeTimer) clearTimeout(fileChangeTimer);
        fileChangeTimer = setTimeout(async () => {
          fileChangeTimer = null;
          if (isBuildingOnChange) return;
          isBuildingOnChange = true;
          notify('Rebuilding app image (dev)...');
          try {
            // Build only the app service image, then restart that container
            await run('docker', ['compose', ...composeArgs(workDir, overrideFiles), 'build', 'app'], workDir, { timeout: 0 });
            await restartAppContainer(workDir, overrideFiles);
            await pollHealth().catch(() => {});
            notify('Rebuild complete');
          } catch (err) {
            console.warn('Dev rebuild failed:', err);
            notify('Rebuild failed — check logs');
          } finally {
            isBuildingOnChange = false;
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
      ? runBackup(backupDir)
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
app.whenReady().then(launch);

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
    mainWindow.loadURL(APP_URL);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
