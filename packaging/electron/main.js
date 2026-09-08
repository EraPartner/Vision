"use strict";

const {
  app,
  BrowserWindow,
  dialog,
  Menu,
  Notification,
  screen,
  shell,
  ipcMain,
  session,
  systemPreferences,
  nativeImage,
} = require("electron");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { isBundleEncrypted } = require("./backup/bundle");
const backupCrypto = require("./backup/crypto");
const {
  getDefaultICloudBackupDir,
  resolveBackupSettingsWithDefaults,
  getBackupPassphraseStatus,
  setBackupPassphrase,
  isEncryptedBackupFile,
} = backupCrypto;
const backupRestore = require("./backup/restore");
const { runBundleBackup, runBundleRestore, runRestore } = backupRestore;
const updater = require("./updater");
const {
  resolveRuntimeMode,
  readRuntimeSelectionState,
  createRuntimeProvider,
} = require("./runtime");
const {
  DEMO_POSTGRES_PORT,
  DEMO_RUNTIME_ID,
  finalizeNativeDemo,
  prepareNativeDemo,
  rollbackNativeDemo,
} = require("./runtime/native-demo");
const { createBadgePngBuffer } = require("./badge-image");
const {
  GITHUB_OWNER,
  GITHUB_REPO,
  getUpdateMode,
  checkForShellUpdate,
  installPreparedShellUpdate,
  setupManualShellUpdater,
} = updater;
// Async i18n loader for main process dialogs. Populated during launch() before
// any t() use. Until then, t() falls back to the key itself — which only
// happens if a dialog fires before initI18n() resolves (startup error paths).
let i18n = {};
let nativeLanguage = null;
let nativeLanguageRequest = 0;

function resolveNativeLanguage(requestedLanguage) {
  if (requestedLanguage === "en" || requestedLanguage === "nl")
    return requestedLanguage;
  const locale =
    app && app.getLocale && typeof app.getLocale === "function"
      ? app.getLocale()
      : "en";
  return locale && locale.startsWith("nl") ? "nl" : "en";
}

async function loadI18nAsync(requestedLanguage) {
  const lang = resolveNativeLanguage(requestedLanguage);

  // Prefer i18n shipped in the app resources (packaged .app).
  const resourceI18nDir = path.join(process.resourcesPath || "", "i18n");
  const fallbackI18nDir = path.join(__dirname, "i18n");

  const tryLoad = async (dir, file) => {
    try {
      const p = path.join(dir, file);
      const raw = await fs.promises.readFile(p, "utf8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };

  const localeFile = `${lang}.json`;
  const byResources =
    resourceI18nDir && (await tryLoad(resourceI18nDir, localeFile));
  if (byResources) return byResources;

  const byFallback = await tryLoad(fallbackI18nDir, localeFile);
  if (byFallback) return byFallback;

  // Last resort: try English in resources then fallback dir
  const enRes = await tryLoad(resourceI18nDir, "en.json");
  if (enRes) return enRes;
  const enFb = await tryLoad(fallbackI18nDir, "en.json");
  if (enFb) return enFb;

  return {};
}

async function initI18n(requestedLanguage) {
  i18n = await loadI18nAsync(requestedLanguage);
  nativeLanguage = resolveNativeLanguage(requestedLanguage);
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
//      a second local runtime and makes existing settings appear to disappear.
// MUST run before any `app.getPath('userData')` (e.g. settingsPath below).
//
// Demo builds ship a `resources/DEMO` marker (electron-builder-demo.json). When
// present, the app runs as a fully separate "Vision Demo" — its own userData dir,
// native runtime, deterministic synthetic database, and attachments directory.
// It can never reach the real app's data.
const __IS_DEMO = (() => {
  try {
    return fs.existsSync(
      path.join(process.resourcesPath || "", "resources", "DEMO"),
    );
  } catch {
    return false;
  }
})();
app.setName(__IS_DEMO ? "Vision Demo" : "Vision");
const __IS_DEVELOPMENT_PROFILE =
  !__IS_DEMO &&
  !app.isPackaged &&
  process.env.VISION_DEVELOPMENT_PROFILE === "true";
if (__IS_DEVELOPMENT_PROFILE) {
  app.setPath(
    "userData",
    path.join(app.getPath("appData"), "Vision Development"),
  );
}
const NATIVE_RUNTIME_ID = __IS_DEMO
  ? DEMO_RUNTIME_ID
  : __IS_DEVELOPMENT_PROFILE
    ? "vision_dev"
    : "vision";

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
if (gotSingleInstanceLock)
  (function initFileLogger() {
    try {
      const logDir = path.join(app.getPath("userData"), "logs");
      fs.mkdirSync(logDir, { recursive: true });
      const logPath = path.join(logDir, "main.log");
      // Rotate once the live log passes ~2 MB so it can't grow unbounded across
      // sessions; keep exactly one previous generation.
      try {
        if (fs.statSync(logPath).size > 2 * 1024 * 1024) {
          try {
            fs.renameSync(logPath, `${logPath}.1`);
          } catch {
            /* best effort */
          }
        }
      } catch {
        /* no existing log — first run */
      }
      const stream = fs.createWriteStream(logPath, { flags: "a" });
      stream.on("error", () => {
        /* never let a log write crash the app */
      });
      const serialize = (a) => {
        if (typeof a === "string") return a;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      };
      const write = (level, args) => {
        try {
          stream.write(
            `${new Date().toISOString()} [${level}] ${args.map(serialize).join(" ")}\n`,
          );
        } catch {
          /* best effort */
        }
      };
      for (const level of ["log", "warn", "error"]) {
        const orig = console[level].bind(console);
        console[level] = (...args) => {
          write(level, args);
          orig(...args);
        };
      }
      write("log", [`main-process logger started (pid ${process.pid})`]);
    } catch {
      /* logging is best-effort; never block boot */
    }
  })();

// One-shot migration from the legacy "vision-desktop" userData dir to the
// canonical "Vision" dir. Preserves existing settings and native runtime data.
// Skipped for a second instance (it doesn't hold the lock and is about to quit).
if (gotSingleInstanceLock)
  (function migrateLegacyUserData() {
    try {
      if (__IS_DEMO || __IS_DEVELOPMENT_PROFILE) return;
      const target = app.getPath("userData");
      const legacy = path.join(path.dirname(target), "vision-desktop");
      if (legacy === target) return;
      if (!fs.existsSync(legacy)) return;
      const targetExists = fs.existsSync(target);
      const targetEmpty = targetExists
        ? fs.readdirSync(target).filter((n) => n !== ".DS_Store").length === 0
        : false;
      if (!targetExists || targetEmpty) {
        if (targetExists) fs.rmSync(target, { recursive: true, force: true });
        fs.renameSync(legacy, target);
        console.error(
          '[migrate] Moved legacy userData "vision-desktop" → "Vision"',
        );
      } else {
        const archived = `${legacy}.legacy-${Date.now()}`;
        fs.renameSync(legacy, archived);
        console.error(
          `[migrate] "Vision" userData already populated; archived legacy dir to ${archived}`,
        );
      }
    } catch (err) {
      console.warn(
        "[migrate] userData migration failed (non-fatal):",
        err && err.message ? err.message : err,
      );
    }
  })();

// ── Constants ─────────────────────────────────────────────────────────────────
const APP_NAME = __IS_DEMO ? "Vision Demo" : "Vision";
const REPOSITORY_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`;
const DOCUMENTATION_URL = `${REPOSITORY_URL}/tree/main/docs`;
const TRUSTED_EXTERNAL_URLS = new Set([REPOSITORY_URL, DOCUMENTATION_URL]);

function openTrustedExternalUrl(url) {
  if (!TRUSTED_EXTERNAL_URLS.has(url)) return false;
  void shell.openExternal(url);
  return true;
}
// Last-resort fallback only. The real port is a truly-random free port chosen
// once per app and persisted (settings.appPort) — see resolveAppPort(). Random
// per-app ports mean the demo and the real app never fight over a fixed port.
const DEFAULT_APP_PORT = 3002;
const HEALTH_POLL_ATTEMPTS =
  Number(process.env.VISION_HEALTH_POLL_ATTEMPTS) || 200; // 200 × 300ms = 60s max
const HEALTH_POLL_INTERVAL_MS =
  Number(process.env.VISION_HEALTH_POLL_INTERVAL_MS) || 300;
// A cold native start may initialize PostgreSQL and run migrations. Give that
// path a larger budget than a warm restart. 600 × 300ms ≈ 3 min.
const HEALTH_POLL_BUILD_ATTEMPTS =
  Number(process.env.VISION_HEALTH_POLL_BUILD_ATTEMPTS) || 600;
const HEALTH_WATCHDOG_INTERVAL_MS = 10_000;
const HEALTH_WATCHDOG_FAILURE_THRESHOLD = 3;
const RENDERER_READY_TIMEOUT_MS =
  Number(process.env.VISION_RENDERER_READY_TIMEOUT_MS) || 12_000;

// ── Startup instrumentation ───────────────────────────────────────────────────
// Phase 1 of startup-speedup plan. Emits structured JSON marks to stderr so
// boot timings are easy to grep/chart. Cheap (<1ms per mark); leave on by
// default. Disable with VISION_BOOT_TRACE=0.
const BOOT_TRACE_ENABLED = process.env.VISION_BOOT_TRACE !== "0";
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
function bootSummary(extraPhase = "launch_total") {
  const total = Date.now() - _bootT0;
  if (BOOT_TRACE_ENABLED) {
    console.error(
      `[startup] ${JSON.stringify({ phase: extraPhase, ms: total, marks: _bootMarks })}`,
    );
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
].join("; ");

function registerSecurityHeaders() {
  if (!app.isPackaged) return;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [CSP_POLICY],
        "X-Content-Type-Options": ["nosniff"],
        "X-Frame-Options": ["DENY"],
        "Referrer-Policy": ["strict-origin-when-cross-origin"],
      },
    });
  });
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => {
      callback(false);
    },
  );
}

// Resolved at launch by resolveAppPort() — a persisted random free port.
let appPort = DEFAULT_APP_PORT;
const appUrl = () => `http://localhost:${appPort}`;
const healthUrl = () => `${appUrl()}/health`;
let activeRuntime = null;

// ── Settings (persisted across launches) ─────────────────────────────────────
const settingsPath = path.join(app.getPath("userData"), "settings.json");

async function loadSettings() {
  let raw;
  try {
    raw = await fs.promises.readFile(settingsPath, "utf8");
  } catch {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    try {
      const corruptPath = `${settingsPath}.corrupt-${Date.now()}`;
      await fs.promises.rename(settingsPath, corruptPath);
      console.warn(
        `[settings] Corrupt settings.json renamed to ${corruptPath}: ${err && err.message ? err.message : err}`,
      );
    } catch (renameErr) {
      console.warn(
        "[settings] Failed to quarantine corrupt settings.json:",
        renameErr && renameErr.message ? renameErr.message : renameErr,
      );
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
    try {
      await fs.promises.unlink(tmpPath);
    } catch {
      /* best effort */
    }
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
// Threads main.js globals/singletons into the extracted backup and update
// modules. Mutable state is passed as getters/callbacks so those modules always
// observe the live value.
backupCrypto.init({
  APP_NAME,
  loadSettings,
  updateSettings,
});
backupRestore.init({
  workDir: () => workDir,
  appPort: () => appPort,
  repoRootFallback: path.resolve(__dirname, "..", ".."),
  pollHealth,
  HEALTH_POLL_BUILD_ATTEMPTS,
  runtimeProvider: () => activeRuntime,
});
updater.init({
  APP_NAME,
  IS_DEMO: __IS_DEMO,
  t,
  notify,
  workDir: () => workDir,
  stopRuntime: async () => {
    if (activeRuntime?.mode === "native") await activeRuntime.stop();
  },
  startRuntime: async () => {
    if (activeRuntime?.mode === "native") {
      await activeRuntime.start();
      await activeRuntime.waitUntilReady({ detailed: true });
    }
  },
  markQuitting: () => {
    isQuitting = true;
  },
});

// ── Backend host-port resolution ───────────────────────────────────────────────
// The native backend listens on a random loopback port chosen once per app and
// persisted in settings. The demo and real app therefore cannot collide.

// Resolve true if `port` can be bound on loopback right now (i.e. nothing else
// holds it). Persisted ports are not re-picked until startup reports a collision.
function isPortFree(port) {
  return new Promise((resolve) => {
    const net = require("net");
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
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
  try {
    await updateSettings((cur) => {
      cur.appPort = port;
    });
  } catch (err) {
    console.warn(
      "[port] failed to persist appPort:",
      err && err.message ? err.message : err,
    );
  }
  return port;
}

// Pick a fresh free port and persist it. URL accessors derive from appPort.
// Used to self-heal after a foreign process squats the persisted appPort.
async function repickAppPort() {
  const port = await pickRandomFreePort();
  appPort = port;
  try {
    await updateSettings((cur) => {
      cur.appPort = port;
    });
  } catch (err) {
    console.warn(
      "[port] failed to persist re-picked appPort:",
      err && err.message ? err.message : err,
    );
  }
  return port;
}

function notify(body) {
  if (Notification.isSupported()) {
    new Notification({ title: APP_NAME, body }).show();
  }
}

// Reused keep-alive agent so successive /health probes share a TCP socket
// instead of paying handshake cost per attempt.
const healthAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 1,
  keepAliveMsecs: 1000,
});

// Single /health request — resolves true when 2xx/3xx, false otherwise.
async function pingHealth(timeoutMs = 1500) {
  if (activeRuntime) {
    return activeRuntime
      .health({ timeoutMs })
      .then(() => true)
      .catch(() => false);
  }
  return new Promise((resolve) => {
    const req = http.get(healthUrl(), { agent: healthAgent }, (res) => {
      const ok = res.statusCode >= 200 && res.statusCode < 400;
      res.resume();
      resolve(ok);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
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
      if (tries >= maxAttempts) return reject(new Error("timeout"));
      const interval =
        tries < HEALTH_POLL_FAST_ATTEMPTS
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
    const req = http.get(
      `${appUrl()}/health/detailed`,
      { agent: healthAgent },
      (res) => {
        const code = res.statusCode;
        if (code === 404) {
          res.resume();
          return resolve({ ready: true });
        }
        if (code < 200 || code >= 400) {
          res.resume();
          return resolve(undefined);
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => {
          try {
            const d = JSON.parse(body);
            // `materializedViews` backs the dashboard aggregations; gate on it rather
            // than full `ready` so a slow/offline network warmup can't stall startup.
            resolve({
              ready:
                d.status === "ready" || d?.caches?.materializedViews === true,
            });
          } catch {
            resolve({ ready: true });
          }
        });
      },
    );
    req.on("error", () => resolve(undefined));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(undefined);
    });
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
      if (tries >= maxAttempts) return reject(new Error("timeout"));
      const interval =
        tries < HEALTH_POLL_FAST_ATTEMPTS
          ? HEALTH_POLL_FAST_INTERVAL_MS
          : HEALTH_POLL_INTERVAL_MS;
      setTimeout(attempt, interval);
    };
    attempt();
  });
}

// Load the error.html shell with localized strings + returns URL the window
// should present.
function loadErrorPage({ messageKey = "app.errorPageMessage" } = {}) {
  if (!mainWindow) return;
  const theme = readSplashTheme();
  const palette = deriveSplashPalette(
    theme?.background || DEFAULT_BRAND_PRIMARY,
    theme,
  );
  const params = new URLSearchParams({
    title: t("app.errorPageTitle"),
    msg: t(messageKey),
    retry: t("app.errorPageRetry"),
    logs: t("app.errorPageOpenLogs"),
    paletteBase: palette.base,
    paletteGlow: palette.glow,
    paletteForeground: palette.foreground,
  });
  const pageUrl = `file://${path.join(__dirname, "assets", "error.html")}?${params.toString()}`;
  mainWindow.loadURL(pageUrl);
}

// Capture a small, redacted backend-log snapshot when readiness polling fails
// so startup errors can be diagnosed from userData/logs/main.log.
function redactStartupDiagnostics(value) {
  return String(value || "")
    .replace(/(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s/]+(@)/gi, "$1***$2")
    .replace(/\x1b\[[0-9;]*m/g, "");
}

async function logStartupDiagnostics() {
  try {
    const log = await fs.promises.readFile(
      activeRuntime.paths.backendLog,
      "utf8",
    );
    const tail = log.split("\n").slice(-200).join("\n");
    console.error(
      `[startup-diagnostics] native backend log\n${redactStartupDiagnostics(tail)}`,
    );
  } catch (error) {
    console.error(
      "[startup-diagnostics] native backend log unavailable:",
      error && error.message ? error.message : error,
    );
  }
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
        mainWindow.webContents.send("backend:restored");
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
      mainWindow.webContents.send("backend:lost", {
        message: t("app.backendLost"),
      });
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
  if (renavTimer) {
    clearTimeout(renavTimer);
    renavTimer = null;
  }
}
function renavigateWhenReady(maxAttempts = HEALTH_POLL_BUILD_ATTEMPTS) {
  stopRenavigateWhenReady();
  let tries = 0;
  const tick = async () => {
    renavTimer = null;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    // Give up as soon as we're no longer on the error page — a successful Retry
    // (or any other navigation) has taken over.
    let url = "";
    try {
      url = mainWindow.webContents.getURL();
    } catch {
      return;
    }
    if (!url.includes("error.html")) return;
    const status = await pingReady();
    if (status && status.ready) {
      const loaded = await loadApplicationPage();
      if (!loaded) return;
      notify(t("app.running"));
      startHealthWatchdog();
      return;
    }
    tries += 1;
    if (tries >= maxAttempts) return;
    renavTimer = setTimeout(tick, HEALTH_POLL_INTERVAL_MS);
  };
  renavTimer = setTimeout(tick, HEALTH_POLL_INTERVAL_MS);
}

let rendererBootTimer = null;
let rendererReloadAttempted = false;

function stopRendererBootWatchdog({ resetRetry = false } = {}) {
  if (rendererBootTimer) {
    clearTimeout(rendererBootTimer);
    rendererBootTimer = null;
  }
  if (resetRetry) rendererReloadAttempted = false;
}

function isCurrentApplicationDocument() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  try {
    const current = new URL(mainWindow.webContents.getURL());
    const expected = new URL(appUrl());
    return current.origin === expected.origin;
  } catch {
    return false;
  }
}

function startRendererBootWatchdog() {
  stopRendererBootWatchdog();
  if (rendererReady) return;
  rendererBootTimer = setTimeout(() => {
    rendererBootTimer = null;
    if (rendererReady || !isCurrentApplicationDocument()) return;

    if (!rendererReloadAttempted) {
      rendererReloadAttempted = true;
      console.warn(
        "[renderer] ready signal timed out; retrying once without cache",
      );
      mainWindow.webContents.reloadIgnoringCache();
      startRendererBootWatchdog();
      return;
    }

    console.error("[renderer] ready signal timed out after cache-bypass retry");
    loadErrorPage({ messageKey: "app.rendererErrorPageMessage" });
  }, RENDERER_READY_TIMEOUT_MS);
}

async function loadApplicationPage() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  stopRendererBootWatchdog({ resetRetry: true });
  rendererReady = false;
  try {
    await mainWindow.loadURL(appUrl());
  } catch (error) {
    console.error(
      "[renderer] application document failed to load:",
      redactStartupDiagnostics(error && error.message ? error.message : error),
    );
    loadErrorPage({ messageKey: "app.rendererErrorPageMessage" });
    return false;
  }
  startRendererBootWatchdog();
  return true;
}

function pollAndLoad({ building = false } = {}) {
  const endPollHealth = bootMark("poll_ready");
  // A fresh boot poll supersedes any background re-navigation loop still running
  // from a previous timeout.
  stopRenavigateWhenReady();
  pollReady(building ? HEALTH_POLL_BUILD_ATTEMPTS : HEALTH_POLL_ATTEMPTS)
    .then(async () => {
      endPollHealth();
      const loaded = await loadApplicationPage();
      if (!loaded) return;
      notify(t("app.running"));
      startHealthWatchdog();
      bootSummary("launch_total");
    })
    .catch(() => {
      endPollHealth();
      logStartupDiagnostics().catch((err) => {
        console.error(
          "[startup-diagnostics] collection failed:",
          redactStartupDiagnostics(err),
        );
      });
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
        type: "warning",
        buttons: [t("common.ok")],
        title: APP_NAME,
        message: t("app.startSlow"),
        detail: t("app.startSlowDetail", { url: appUrl() }),
      });
    });
}

// ── Main window ───────────────────────────────────────────────────────────────
let mainWindow = null;

// ── Boot splash ───────────────────────────────────────────────────────────────
// Localized, theme-aware splash shown before native runtime I/O. The renderer mirrors
// the active palette's primary colors into settings.json (theme:persist-splash),
// so the splash paints in the chosen theme (emerald on default, purple on
// dracula, …). Falls back to neutral slate (light/dark via prefers-color-scheme)
// when nothing has been persisted yet — e.g. the very first launch.
// setSplashStatus() narrates the slow service-start phases.
const SPLASH_THEME_KEY = "splashTheme";
const DEFAULT_BRAND_PRIMARY = "158 64% 52%";

// HSL component strings only ("158 64% 52%"): digits, spaces, %, dots. The value
// is interpolated into the splash HTML/CSS, so this guards against CSS/HTML
// injection — anything outside the pattern is rejected and the slate fallback wins.
const HSL_COMPONENTS_RE =
  /^\d{1,3}(?:\.\d+)?\s+\d{1,3}(?:\.\d+)?%\s+\d{1,3}(?:\.\d+)?%$/;
function isValidHslComponents(value) {
  return (
    typeof value === "string" &&
    value.length <= 32 &&
    HSL_COMPONENTS_RE.test(value)
  );
}

function readSplashTheme() {
  try {
    const data = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const theme = data?.[SPLASH_THEME_KEY];
    if (
      !theme ||
      !isValidHslComponents(theme.background) ||
      !isValidHslComponents(theme.foreground) ||
      (theme.mode != null && theme.mode !== "light" && theme.mode !== "dark") ||
      (theme.surface != null && !isValidHslComponents(theme.surface)) ||
      (theme.text != null && !isValidHslComponents(theme.text))
    ) {
      return undefined;
    }
    return {
      mode: theme.mode,
      background: theme.background,
      foreground: theme.foreground,
      surface: theme.surface,
      text: theme.text,
    };
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
function deriveSplashPalette(primary, theme) {
  const m =
    /^(\d{1,3}(?:\.\d+)?)\s+(\d{1,3}(?:\.\d+)?)%\s+\d{1,3}(?:\.\d+)?%$/.exec(
      primary,
    );
  if (!m) return undefined;
  if (
    theme?.mode === "light" &&
    isValidHslComponents(theme.surface) &&
    isValidHslComponents(theme.text)
  ) {
    return { base: theme.surface, glow: primary, foreground: theme.text };
  }
  const hue = m[1];
  const sat = Number(m[2]);
  return {
    base: `${hue} ${Math.round(Math.min(sat, 45))}% 6%`, // near-black, faintly hued
    glow: primary, // bright accent → the "shine"
    foreground: `${hue} ${Math.round(Math.min(sat, 24))}% 88%`,
  };
}

function splashDataUrl() {
  const theme = readSplashTheme();
  const derived = deriveSplashPalette(
    theme?.background || DEFAULT_BRAND_PRIMARY,
    theme,
  );
  const palette = `body {
    background:
      radial-gradient(85% 60% at 50% 38%, hsl(${derived.glow} / 0.16), transparent 70%),
      hsl(${derived.base});
    color: hsl(${derived.foreground} / 0.82);
  }
  .name { color: hsl(${derived.foreground}); }`;
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
  <div class="status" id="splash-status">${t("splash.starting")}</div>
</body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function setSplashStatus(key) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // Only while the splash is still showing — never poke the real app.
  if (!mainWindow.webContents.getURL().startsWith("data:")) return;
  mainWindow.webContents
    .executeJavaScript(
      `(() => { const el = document.getElementById('splash-status'); if (el) el.textContent = ${JSON.stringify(t(key))}; })()`,
      true,
    )
    .catch(() => {
      /* splash already navigated away */
    });
}

// ── Window-state persistence ──────────────────────────────────────────────────
// Restore frame across launches (baseline macOS behavior). Bounds live in the
// existing settings.json mirror under `windowBounds`; saved debounced on
// resize/move, restored clamped to the matching display's workArea so an
// unplugged monitor can't strand the window off-screen.
const WINDOW_BOUNDS_KEY = "windowBounds";
const WINDOW_MIN_WIDTH = 800;
const WINDOW_MIN_HEIGHT = 600;
const WINDOW_BOUNDS_SAVE_DEBOUNCE_MS = 500;

// Sync read: createWindow() runs once, before any window exists, and the
// splash must not wait on async settings I/O ordering.
function readSavedWindowBounds() {
  try {
    const data = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const b = data?.[WINDOW_BOUNDS_KEY];
    if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite))
      return undefined;
    return b;
  } catch {
    return undefined;
  }
}

function clampBoundsToWorkArea(bounds) {
  const wa = (screen.getDisplayMatching(bounds) || screen.getPrimaryDisplay())
    .workArea;
  const width = Math.max(WINDOW_MIN_WIDTH, Math.min(bounds.width, wa.width));
  const height = Math.max(
    WINDOW_MIN_HEIGHT,
    Math.min(bounds.height, wa.height),
  );
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
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const color =
      l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * color)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function splashBackgroundColor() {
  try {
    const theme = readSplashTheme();
    const derived = deriveSplashPalette(
      theme?.background || DEFAULT_BRAND_PRIMARY,
      theme,
    );
    if (derived) {
      const m =
        /^(\d{1,3}(?:\.\d+)?)\s+(\d{1,3}(?:\.\d+)?)%\s+(\d{1,3}(?:\.\d+)?)%$/.exec(
          derived.base,
        );
      if (m) return hslToHex(Number(m[1]), Number(m[2]), Number(m[3]));
    }
  } catch {
    /* fall through to the default brand base */
  }
  return hslToHex(158, 45, 6);
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
      await updateSettings((cur) => {
        cur[WINDOW_BOUNDS_KEY] = bounds;
      });
    } catch (err) {
      console.warn(
        "window-bounds save failed (non-fatal):",
        err.message || err,
      );
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
    // The renderer enables under-window vibrancy only for the effective
    // enhanced tier, keeping the common reduced/standard window opaque.
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset",
          trafficLightPosition: { x: 20, y: 20 },
          visualEffectState: "followWindow",
        }
      : {}),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // Preload exposes a minimal update API to the renderer
      preload: path.join(__dirname, "preload.js"),
    },
  });
  // Renderer drops the traffic-light inset while in native fullscreen
  // (the lights auto-hide there).
  mainWindow.on("enter-full-screen", () => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send("window:fullscreen", true);
  });
  mainWindow.on("leave-full-screen", () => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send("window:fullscreen", false);
  });
  // The renderer's fixed About links open in the OS browser. Every new-window
  // request is still denied inside Electron, and arbitrary URLs never reach
  // shell.openExternal.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openTrustedExternalUrl(url);
    return { action: "deny" };
  });

  // Native right-click menu for text: without this, plain inputs (search boxes,
  // the AI-chat composer, the dbEditor cell/WHERE editors) get no copy/paste/
  // select-all, and Electron's default-on spellcheck underlines misspellings
  // with no way to reach the suggestions. Cut/Copy/Paste/SelectAll roles carry
  // OS-native (already-localized) labels; the dictionary label uses t().
  mainWindow.webContents.on("context-menu", (_event, params) => {
    const wc = mainWindow.webContents;
    const items = [];
    const suggestions = Array.isArray(params.dictionarySuggestions)
      ? params.dictionarySuggestions
      : [];
    for (const suggestion of suggestions) {
      items.push({
        label: suggestion,
        click: () => wc.replaceMisspelling(suggestion),
      });
    }
    if (params.misspelledWord) {
      if (items.length) items.push({ type: "separator" });
      items.push({
        label: t("menu.addToDictionary", null, "Add to Dictionary"),
        click: () =>
          wc.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      });
    }
    const flags = params.editFlags || {};
    const roleItems = [];
    if (params.isEditable)
      roleItems.push({ role: "cut", enabled: !!flags.canCut });
    if (params.isEditable || params.selectionText)
      roleItems.push({ role: "copy", enabled: !!flags.canCopy });
    if (params.isEditable)
      roleItems.push({ role: "paste", enabled: !!flags.canPaste });
    if (params.isEditable) roleItems.push({ role: "selectAll" });
    if (roleItems.length) {
      if (items.length) items.push({ type: "separator" });
      items.push(...roleItems);
    }
    if (!items.length) return;
    Menu.buildFromTemplate(items).popup({ window: mainWindow });
  });

  // Block navigation to any URL that isn't localhost/127.0.0.1 or a local file.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    try {
      const parsed = new URL(url);
      const allowed =
        parsed.protocol === "file:" ||
        parsed.hostname === "localhost" ||
        parsed.hostname === "127.0.0.1";
      if (!allowed) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });

  // Loading the HTML shell is not enough to prove that the React renderer
  // started. Keep main-process diagnostics for failures that would otherwise
  // leave the static boot placeholder spinning forever.
  mainWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return; // navigation was superseded
      let source = "unknown";
      try {
        source = path.basename(new URL(validatedURL).pathname) || "/";
      } catch {
        /* retain the non-sensitive fallback */
      }
      console.error(
        `[renderer] main-frame load failed (${errorCode}, ${errorDescription || "unknown"}) at ${source}`,
      );
    },
  );
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error(
      `[renderer] process exited (${details?.reason || "unknown"}, ${Number.isInteger(details?.exitCode) ? details.exitCode : "unknown"})`,
    );
  });

  // Menu accelerators with click handlers (⌘1-9, ⌘N, ⇧⌘I, ⌃⌘S) are matched
  // here instead of relying on AppKit key-equivalent dispatch: with the
  // sandboxed renderer focused, the unhandled-keystroke → menu redispatch is
  // unreliable, so accelerator-only items silently do nothing from the
  // keyboard (menu *clicks* were always fine). before-input-event sees every
  // real keystroke first, and preventDefault() suppresses any late menu
  // dispatch, so an item can never fire twice. Roles (reload, zoom, copy…)
  // stay on the native path.
  mainWindow.webContents.on("before-input-event", handleMenuAccelerator);

  // Renderer readiness is per-document: a real navigation/reload invalidates
  // the previous document's app:renderer-ready signal. This must NOT listen to
  // did-start-loading — that also fires for same-document navigations (React
  // Router pushState), and since the renderer only calls ready() once per
  // document, resetting there permanently jams sendToApp()'s queue after the
  // first client-side route change (menu, dock and CSV actions all go silent).
  mainWindow.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) rendererReady = false;
  });

  // Persist the window frame across launches (debounced).
  mainWindow.on("resize", () => scheduleWindowBoundsSave(mainWindow));
  mainWindow.on("move", () => scheduleWindowBoundsSave(mainWindow));

  // macOS convention: the red close button HIDES the window instead of
  // destroying it, keeping the fully-booted renderer (route + scroll state) and
  // the warm backend/containers resident so reopening is ~instant. A real quit
  // (⌘Q / menu Quit → before-quit sets isAppQuitting) closes for real. Only
  // darwin hides — elsewhere close must destroy so window-all-closed → app.quit()
  // still fires. `activate`/`second-instance` show() the hidden window.
  mainWindow.on("close", (e) => {
    if (
      process.platform === "darwin" &&
      !isAppQuitting &&
      mainWindow &&
      !mainWindow.isDestroyed()
    ) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  // Caller is responsible for loading the initial URL.
  mainWindow.on("closed", () => {
    stopRendererBootWatchdog({ resetRetry: true });
    mainWindow = null;
    rendererReady = false;
  });
}

// ── HTTP helpers (main-process API calls) ─────────────────────────────────────
// Lightweight wrappers around Node's built-in `http` module so the main process
// can talk to the running backend without importing a heavy fetch polyfill.

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http
      .get(url, { headers: { "Content-Type": "application/json" } }, (res) => {
        let body = "";
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
    req.setTimeout(10000, () => {
      req.destroy(new Error("httpGet timed out after 10 s"));
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
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    };
    const req = http.request(options, (res) => {
      let body = "";
      res.on("data", (c) => {
        body += c;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve(body);
        }
      });
    });
    req.on("error", reject);
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
//   • requireWorkDir — precondition for handlers that need the runtime root.
//   • wrapErrors — uniform catch → { success: false, error: String(err) }.
// Nothing currently opts out: the app has exactly one BrowserWindow, new
// windows are denied (setWindowOpenHandler), and the splash + error pages load
// into that same window — so the recovery channels reached from error.html do
// come from mainWindow.webContents like every other channel.
const REJECT_SENDER = Symbol("reject-unauthorized-sender");

/**
 * @param {import("./electron-api").ElectronInvokeChannel} channel
 * @param {(...args: any[]) => any} fn
 * @param {object} [options]
 * @param {boolean} [options.allowAnySender]
 * @param {any} [options.senderFailure]
 * @param {boolean} [options.requireWorkDir]
 * @param {boolean} [options.wrapErrors]
 */
function registerHandler(
  channel,
  fn,
  {
    allowAnySender = false,
    senderFailure = { success: false, error: "Unauthorized sender" },
    requireWorkDir = false,
    wrapErrors = false,
  } = {},
) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (
      !allowAnySender &&
      (!mainWindow || event.sender !== mainWindow.webContents)
    ) {
      if (senderFailure === REJECT_SENDER) {
        throw new Error(`Unauthorized sender for ${channel}`);
      }
      return senderFailure;
    }
    if (requireWorkDir && !workDir)
      return { success: false, error: "workDir not set" };
    if (!wrapErrors) return fn(event, ...args);
    try {
      return await fn(event, ...args);
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
}

registerHandler(
  "update:check-github",
  async () => await checkForShellUpdate(),
  { senderFailure: REJECT_SENDER },
);

registerHandler(
  "update:install-shell",
  async () => await installPreparedShellUpdate(),
  { wrapErrors: true },
);

registerHandler(
  "update:get-mode",
  () => ({
    mode: getUpdateMode(),
    is_packaged: app.isPackaged,
  }),
  { senderFailure: REJECT_SENDER },
);

registerHandler("update:pre-update-backup", async () => {
  try {
    const backupDir = path.join(app.getPath("userData"), "pre-update-backups");
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
  "/System",
  "/usr",
  "/bin",
  "/sbin",
  "/etc",
  "/private/etc",
  "/private/var/db",
  "/Library",
];

// Shared destination validation for every path that can set or use a backup
// directory (backup:run, backup:save-settings → quit-time backup). Returns an
// error string, or null when the destination is acceptable.
function validateBackupDest(dir) {
  if (typeof dir !== "string" || !dir) return "Invalid backup directory";
  const resolved = path.resolve(dir);
  if (!path.isAbsolute(resolved))
    return "Backup directory must be an absolute path";
  if (
    BLOCKED_BACKUP_PREFIXES.some(
      (p) => resolved === p || resolved.startsWith(p + "/"),
    )
  ) {
    return "Backup to system directories is not allowed";
  }
  return null;
}

const ALLOWED_RESTORE_EXTS = new Set([".visionbak", ".enc", ".sql"]);
function hasAllowedRestoreExt(p) {
  const lower = String(p).toLowerCase();
  if (lower.endsWith(".visionbak.enc")) return true;
  for (const ext of ALLOWED_RESTORE_EXTS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

registerHandler(
  "backup:select-file",
  async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      title: "Select Backup File to Restore",
      buttonLabel: "Restore",
      filters: [
        {
          name: "Vision Backup Files",
          extensions: ["visionbak", "visionbak.enc", "sql", "enc"],
        },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const chosen = path.resolve(result.filePaths[0]);
    ALLOWED_RESTORE_PATHS.add(chosen);
    return chosen;
  },
  { senderFailure: null },
);

registerHandler(
  "backup:is-encrypted",
  async (_event, filePath) => {
    try {
      if (typeof filePath !== "string" || !filePath) return false;
      const resolved = path.resolve(filePath);
      if (!ALLOWED_RESTORE_PATHS.has(resolved)) return false;
      if (!fs.existsSync(resolved)) return false;
      if (
        resolved.endsWith(".visionbak") ||
        resolved.endsWith(".visionbak.enc")
      ) {
        return await isBundleEncrypted(resolved);
      }
      return await isEncryptedBackupFile(resolved);
    } catch {
      return false;
    }
  },
  { senderFailure: REJECT_SENDER },
);

registerHandler(
  "backup:restore",
  async (event, filePath, opts) => {
    if (typeof filePath !== "string" || !filePath) {
      return { success: false, error: "Invalid restore path" };
    }
    const resolved = path.resolve(filePath);
    if (!ALLOWED_RESTORE_PATHS.has(resolved)) {
      return {
        success: false,
        error: "Restore path was not selected via the file picker",
      };
    }
    if (!hasAllowedRestoreExt(resolved)) {
      return { success: false, error: "Unsupported backup file extension" };
    }
    if (!fs.existsSync(resolved)) {
      return { success: false, error: "Backup file not found" };
    }

    // Require explicit user confirmation before overwriting live data.
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      // Route the one destructive dialog through the same main-process t() loader
      // every other Electron dialog uses (reusing existing settings.restore.* keys),
      // so it follows the app language instead of being hardcoded English.
      buttons: [
        t("settings.restore.runNow", null, "Restore"),
        t("settings.restore.cancelButton", null, "Cancel"),
      ],
      defaultId: 1,
      cancelId: 1,
      title: t("settings.restore.title", null, "Restore Backup"),
      message: t(
        "settings.restore.warning",
        null,
        "This will permanently replace all current data and cannot be undone.",
      ),
      detail: path.basename(resolved),
    });
    if (response !== 0)
      return { success: false, error: "Restore cancelled by user" };

    const passphrase =
      opts && typeof opts === "object" ? opts.passphrase : undefined;

    // Pause health monitoring while restore stops and recreates the database.
    stopHealthWatchdog();
    try {
      // Route .visionbak / .visionbak.enc through the new bundle restore path;
      // legacy .sql / .enc files fall through to the original runRestore.
      const lower = resolved.toLowerCase();
      const isBundle =
        lower.endsWith(".visionbak") || lower.endsWith(".visionbak.enc");
      const result = isBundle
        ? await runBundleRestore(resolved, { passphrase })
        : await runRestore(resolved, { passphrase });
      return result;
    } catch (err) {
      return { success: false, error: String(err) };
    } finally {
      startHealthWatchdog();
    }
  },
  { requireWorkDir: true },
);

// ── IPC: backup:run ───────────────────────────────────────────────────────────
// frontendStateJson is the serialised { keys: { … } } localStorage snapshot,
// collected by the renderer before invoking this handler.  Optional — when null
// (e.g. automated backup on quit) the bundle is created without frontend-state.json.
let backupInFlight = false;
registerHandler(
  "backup:run",
  async (event, destDir, frontendStateJson = null) => {
    const destError = validateBackupDest(destDir);
    if (destError) return { success: false, error: destError };
    const resolvedDest = path.resolve(destDir);
    if (backupInFlight)
      return { success: false, error: "A backup is already in progress" };
    backupInFlight = true;
    try {
      return await runBundleBackup(resolvedDest, frontendStateJson);
    } finally {
      backupInFlight = false;
    }
  },
  { requireWorkDir: true, wrapErrors: true },
);

registerHandler(
  "backup:select-dir",
  async () => {
    const defaultPath = getDefaultICloudBackupDir() || app.getPath("documents");
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      title: "Select Backup Directory",
      buttonLabel: "Choose",
      defaultPath,
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  },
  { senderFailure: null },
);

// Sender check matters here like on backup:restore — a compromised non-main
// frame must not be able to repoint where the quit-time backup writes.
registerHandler(
  "backup:save-settings",
  async (event, { backupDir, backupOnQuit }) => {
    // Validate the destination NOW: the quit-time backup (will-quit handler)
    // writes wherever this setting points, with no further checks.
    if (backupDir) {
      const destError = validateBackupDest(backupDir);
      if (destError) return { success: false, error: destError };
    }
    // Persist to database via the running backend API (source of truth).
    // Also mirror to local settings.json as a fallback for the will-quit handler
    // in case the backend is already shutting down.
    const payload = {
      backupDir: backupDir || "",
      backupOnQuit: !!backupOnQuit,
    };
    await updateSettings((cur) => {
      cur.backupDir = payload.backupDir;
      cur.backupOnQuit = payload.backupOnQuit;
    });
    try {
      await httpPut(
        `http://localhost:${appPort}/api/settings/backup_settings`,
        { value: payload },
      );
    } catch (err) {
      console.warn(
        "backup:save-settings: could not persist to DB, kept in local settings.json",
        err.message,
      );
    }
    return { success: true };
  },
);

registerHandler(
  "backup:get-encryption-status",
  async () => {
    return { success: true, ...(await getBackupPassphraseStatus()) };
  },
  { senderFailure: REJECT_SENDER },
);

registerHandler(
  "backup:set-passphrase",
  async (_event, passphrase) => {
    const value = typeof passphrase === "string" ? passphrase : "";
    return await setBackupPassphrase(value.trim());
  },
  {
    senderFailure: {
      success: false,
      available: false,
      error: "Unauthorized sender",
    },
  },
);

registerHandler(
  "backup:load-settings",
  async () => {
    // Prefer reading from the database; fall back to settings.json if the backend
    // is not yet available (e.g. during very early startup).
    try {
      // The API wraps responses as { ok, data: { key, value } } (ADR-026).
      const body = await httpGet(
        `http://localhost:${appPort}/api/settings/backup_settings`,
      );
      const stored = body && body.data ? body.data.value : undefined;
      if (stored && typeof stored === "object") {
        // Mirror the RAW stored value (not the default-resolved one) back to
        // settings.json so the will-quit fallback matches the DB instead of
        // baking display defaults into the stored config.
        await updateSettings((cur) => {
          cur.backupDir =
            typeof stored.backupDir === "string" ? stored.backupDir : "";
          cur.backupOnQuit = stored.backupOnQuit === true;
        });
        const v = resolveBackupSettingsWithDefaults(stored);
        return {
          backupDir: v.backupDir || "",
          backupOnQuit: v.backupOnQuit === true,
        };
      }
    } catch (err) {
      console.warn(
        "backup:load-settings: could not read from DB, falling back to settings.json",
        err.message,
      );
    }
    const s = resolveBackupSettingsWithDefaults(await loadSettings());
    return {
      backupDir: s.backupDir || "",
      backupOnQuit: s.backupOnQuit === true,
    };
  },
  { senderFailure: REJECT_SENDER },
);

// ── Services (keep-running-on-quit) settings ─────────────────────────────────
// Opt-in toggle: when enabled, quit leaves the native services running so the
// next launch can take the hot path. Same dual DB + settings.json mirror as backup settings
// above — the will-quit handler needs a value even if the backend already
// stopped responding.
registerHandler(
  "services:save-settings",
  async (event, { keepServicesOnQuit } = {}) => {
    const payload = { keepServicesOnQuit: !!keepServicesOnQuit };
    await updateSettings((cur) => {
      cur.keepServicesOnQuit = payload.keepServicesOnQuit;
    });
    try {
      await httpPut(
        `http://localhost:${appPort}/api/settings/services_settings`,
        { value: payload },
      );
    } catch (err) {
      console.warn(
        "services:save-settings: could not persist to DB, kept in local settings.json",
        err.message,
      );
    }
    return { success: true };
  },
);

registerHandler(
  "services:load-settings",
  async () => {
    try {
      // The API wraps responses as { ok, data: { key, value } } (ADR-026).
      const body = await httpGet(
        `http://localhost:${appPort}/api/settings/services_settings`,
      );
      const stored = body && body.data ? body.data.value : undefined;
      if (stored && typeof stored === "object") {
        const keepServicesOnQuit = stored.keepServicesOnQuit === true;
        // Mirror back to settings.json so the will-quit fallback matches the DB.
        await updateSettings((cur) => {
          cur.keepServicesOnQuit = keepServicesOnQuit;
        });
        return { keepServicesOnQuit };
      }
    } catch (err) {
      console.warn(
        "services:load-settings: could not read from DB, falling back to settings.json",
        err.message,
      );
    }
    const s = await loadSettings();
    return { keepServicesOnQuit: s.keepServicesOnQuit === true };
  },
  { senderFailure: REJECT_SENDER },
);

// ── Recovery (error page) ────────────────────────────────────────────────────
registerHandler("recovery:retry", () => {
  pollAndLoad();
  return { success: true };
});

registerHandler("recovery:open-logs", async () => {
  try {
    const logsDir =
      activeRuntime?.mode === "native"
        ? activeRuntime.paths.logs
        : app.getPath("logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const err = await shell.openPath(logsDir);
    if (err) return { success: false, error: err };
    return { success: true, path: logsDir };
  } catch (err) {
    return {
      success: false,
      error: err && err.message ? err.message : String(err),
    };
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
    // readiness rather than a bare loadURL(appUrl()), so a backend that died while
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

registerHandler(
  "app:renderer-failure",
  (_event, payload) => {
    const kind = ["error", "resource", "unhandledrejection"].includes(
      payload?.kind,
    )
      ? payload.kind
      : "error";
    const name =
      typeof payload?.name === "string" &&
      /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(payload.name)
        ? payload.name
        : "UnknownError";
    const source =
      typeof payload?.source === "string" &&
      /^[A-Za-z0-9_.-]{1,160}$/.test(payload.source)
        ? payload.source
        : "unknown";
    const line = Number.isSafeInteger(payload?.line) ? payload.line : 0;
    console.error(
      `[renderer] ${kind} (${name}) at ${source}${line > 0 ? `:${line}` : ""}`,
    );
    return { success: true };
  },
  { senderFailure: { success: false } },
);

registerHandler(
  "app:renderer-ready",
  () => {
    rendererReady = true;
    stopRendererBootWatchdog({ resetRetry: true });
    while (pendingAppMessages.length > 0) {
      const [channel, payload] = pendingAppMessages.shift();
      mainWindow.webContents.send(channel, payload);
    }
    return { success: true };
  },
  { senderFailure: { success: false } },
);

function menuAction(action, payload) {
  sendToApp("menu:action", { action, payload });
}

// Mirrors GO_TO_ROUTES in apps/frontend/src/hooks/useGoToShortcuts.ts — keep
// both lists in sync when adding a destination.
const GO_MENU_ROUTES = [
  { url: "/", titleKey: "nav.dashboard" },
  { url: "/transactions", titleKey: "nav.transactions" },
  { url: "/statistics", titleKey: "nav.statistics" },
  { url: "/categories", titleKey: "nav.categories" },
  { url: "/recipients", titleKey: "nav.recipients" },
  { url: "/import", titleKey: "nav.importExport" },
  { url: "/portfolio", titleKey: "nav.portfolio" },
  { url: "/portfolio/net-worth", titleKey: "nav.netWorth" },
  { url: "/ai-chat", titleKey: "nav.aiChat" },
];

// Keyboard matcher for the accelerator-only menu items (see the
// before-input-event comment in createWindow). Mirrors the accelerators
// declared in setupApplicationMenu() — keep both in sync. Digits match on
// input.code (physical key) so ⌘1-9 stay positional on non-QWERTY layouts
// (AZERTY digits would otherwise need Shift); letters match on input.key.
function handleMenuAccelerator(event, input) {
  if (input.type !== "keyDown" || input.isAutoRepeat) return;
  const isMac = process.platform === "darwin";
  const primary = isMac ? input.meta : input.control; // CmdOrCtrl
  const crossMod = isMac ? input.control : input.meta; // the other platform's primary
  if (!primary) return;

  // Go menu: ⌘1 … ⌘9
  const digit = /^Digit([1-9])$/.exec(input.code || "");
  if (digit && !input.shift && !input.alt && !crossMod) {
    const route = GO_MENU_ROUTES[Number(digit[1]) - 1];
    if (!route) return;
    event.preventDefault();
    menuAction("navigate", route.url);
    return;
  }

  const key = typeof input.key === "string" ? input.key.toLowerCase() : "";
  // File → New Transaction: ⌘N
  if (key === "n" && !input.shift && !input.alt && !crossMod) {
    event.preventDefault();
    menuAction("new-transaction");
    return;
  }
  // File → Import CSV…: ⇧⌘I
  if (key === "i" && input.shift && !input.alt && !crossMod) {
    event.preventDefault();
    menuAction("navigate", "/import");
    return;
  }
  // View → Toggle Sidebar: ⌃⌘S on macOS, Ctrl+Shift+S elsewhere
  const sidebarChord = isMac
    ? key === "s" && input.control && !input.shift && !input.alt
    : key === "s" && input.shift && !input.alt && !input.meta;
  if (sidebarChord) {
    event.preventDefault();
    menuAction("toggle-sidebar");
  }
}

function setupApplicationMenu() {
  // Populate the native About panel ({ role: 'about' } below) — otherwise it
  // shows only the bare app name with no version, copyright, or license.
  try {
    app.setAboutPanelOptions({
      applicationName: APP_NAME,
      applicationVersion: app.getVersion ? app.getVersion() : "",
      copyright: `© ${new Date().getFullYear()} Vision · AGPL-3.0`,
      website: REPOSITORY_URL,
    });
  } catch {
    /* non-fatal — cosmetic */
  }

  const template = [
    ...(process.platform === "darwin"
      ? [
          {
            label: APP_NAME,
            submenu: [
              { role: "about" },
              { type: "separator" },
              {
                label: t("menu.settings"),
                accelerator: "CmdOrCtrl+,",
                click: () => menuAction("open-settings"),
              },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    {
      label: t("menu.file"),
      submenu: [
        {
          label: t("menu.newTransaction"),
          accelerator: "CmdOrCtrl+N",
          click: () => menuAction("new-transaction"),
        },
        {
          label: t("menu.importCsv"),
          accelerator: "Shift+CmdOrCtrl+I",
          click: () => menuAction("navigate", "/import"),
        },
        { type: "separator" },
        { role: process.platform === "darwin" ? "close" : "quit" },
      ],
    },
    {
      label: t("menu.edit"),
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: t("menu.view"),
      submenu: [
        {
          label: t("menu.toggleSidebar"),
          // ⌃⌘S mirrors Finder/Mail "Show/Hide Sidebar" on macOS.
          accelerator:
            process.platform === "darwin" ? "Ctrl+Cmd+S" : "Ctrl+Shift+S",
          click: () => menuAction("toggle-sidebar"),
        },
        { type: "separator" },
        { role: "reload" },
        ...(app.isPackaged ? [] : [{ role: "toggleDevTools" }]),
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: t("menu.go"),
      submenu: GO_MENU_ROUTES.map((route, i) => ({
        label: t(route.titleKey),
        accelerator: `CmdOrCtrl+${i + 1}`,
        click: () => menuAction("navigate", route.url),
      })),
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        ...(process.platform === "darwin"
          ? []
          : [
              {
                label: t("menu.about", { app: APP_NAME }, `About ${APP_NAME}`),
                click: () => app.showAboutPanel(),
              },
              { type: "separator" },
            ]),
        {
          label: t("menu.keyboardShortcuts"),
          click: () => menuAction("open-shortcuts"),
        },
        { type: "separator" },
        {
          label: t("menu.sourceCode"),
          click: () => {
            openTrustedExternalUrl(REPOSITORY_URL);
          },
        },
        {
          label: t("menu.documentation"),
          click: () => {
            openTrustedExternalUrl(DOCUMENTATION_URL);
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function setupDockMenu() {
  if (process.platform !== "darwin" || !app.dock) return;
  app.dock.setMenu(
    Menu.buildFromTemplate([
      {
        label: t("menu.newTransaction"),
        click: () => menuAction("new-transaction"),
      },
      {
        label: t("nav.dashboard"),
        click: () => menuAction("navigate", "/"),
      },
    ]),
  );
}

// Native dock/taskbar badge — count of planned payments due, pushed by the renderer (it owns
// the query + the user's dismissals). Input is clamped server-side so a
// compromised renderer can at most show a number.
function windowsBadgeOverlay(count) {
  if (process.platform !== "win32" || !mainWindow || mainWindow.isDestroyed())
    return;
  if (count < 1) {
    mainWindow.setOverlayIcon(null, "");
    return;
  }
  const label = count > 99 ? "99+" : String(count);
  const icon = nativeImage.createFromBuffer(createBadgePngBuffer(count), {
    scaleFactor: 1,
  });
  const countKey = count === 1 ? "upcoming.count.one" : "upcoming.count.other";
  mainWindow.setOverlayIcon(
    icon,
    t(countKey, { count: label }, `${label} planned payments due`),
  );
}

registerHandler(
  "app:set-badge",
  (event, count) => {
    const n = Number(count);
    if (!Number.isFinite(n)) return { success: false };
    const clamped = Math.max(0, Math.min(999, Math.floor(n)));
    if (process.platform === "win32") {
      windowsBadgeOverlay(clamped);
      return { success: true };
    }
    if (process.platform === "darwin" && app.dock) {
      app.dock.setBadge(clamped > 0 ? String(clamped) : "");
      return { success: true };
    }
    if (typeof app.setBadgeCount !== "function") return { success: false };
    return { success: app.setBadgeCount(clamped) !== false };
  },
  { senderFailure: { success: false } },
);

registerHandler(
  "app:set-language",
  async (event, language) => {
    if (language !== "en" && language !== "nl") return { success: false };
    const request = ++nativeLanguageRequest;
    if (nativeLanguage === language) return { success: true };
    const nextI18n = await loadI18nAsync(language);
    if (request !== nativeLanguageRequest)
      return { success: true, superseded: true };
    i18n = nextI18n;
    nativeLanguage = language;
    await updateSettings((settings) => {
      settings.nativeLanguage = language;
    });
    if (request !== nativeLanguageRequest)
      return { success: true, superseded: true };
    setupApplicationMenu();
    setupDockMenu();
    return { success: true };
  },
  { senderFailure: { success: false } },
);

registerHandler(
  "app:set-vibrancy",
  (event, enabled) => {
    if (typeof enabled !== "boolean") return { success: false };
    if (process.platform !== "darwin") return { success: false };
    if (!mainWindow || mainWindow.isDestroyed()) return { success: false };
    mainWindow.setVibrancy(enabled ? "under-window" : null);
    return { success: true };
  },
  { senderFailure: { success: false } },
);

// System accent color — RRGGBBAA hex from macOS, or null when unavailable.
function readSystemAccentColor() {
  if (process.platform !== "darwin") return null;
  try {
    const color = systemPreferences.getAccentColor();
    return typeof color === "string" && color ? color : null;
  } catch {
    return null;
  }
}

registerHandler(
  "app:get-accent-color",
  () => {
    return readSystemAccentColor();
  },
  { senderFailure: null },
);

// Renderer mirrors the active theme's primary colors here so the next boot
// splash matches the chosen palette (see splashDataUrl / readSplashTheme).
// Validated on write and again on read — the values land in splash HTML/CSS.
registerHandler(
  "theme:persist-splash",
  async (event, colors) => {
    if (
      !colors ||
      !isValidHslComponents(colors.background) ||
      !isValidHslComponents(colors.foreground) ||
      (colors.mode != null &&
        colors.mode !== "light" &&
        colors.mode !== "dark") ||
      (colors.surface != null && !isValidHslComponents(colors.surface)) ||
      (colors.text != null && !isValidHslComponents(colors.text))
    ) {
      return { success: false };
    }
    try {
      await updateSettings((cur) => {
        cur[SPLASH_THEME_KEY] = {
          mode: colors.mode,
          background: colors.background,
          foreground: colors.foreground,
          surface: colors.surface,
          text: colors.text,
        };
      });
      return { success: true };
    } catch (err) {
      console.warn(
        "theme:persist-splash failed (non-fatal):",
        err && err.message ? err.message : err,
      );
      return { success: false };
    }
  },
  { senderFailure: { success: false } },
);

function subscribeAccentColorChanges() {
  if (process.platform !== "darwin") return;
  try {
    systemPreferences.subscribeNotification(
      "AppleColorPreferencesChangedNotification",
      () => {
        if (mainWindow && !mainWindow.isDestroyed() && rendererReady) {
          mainWindow.webContents.send(
            "app:accent-color-changed",
            readSystemAccentColor(),
          );
        }
      },
    );
  } catch (err) {
    console.warn(
      "accent-color subscription failed (non-fatal):",
      err && err.message ? err.message : err,
    );
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
    const content = await fs.promises.readFile(filePath, "utf8");
    sendToApp("app:csv-opened", { name: path.basename(filePath), content });
  } catch (err) {
    console.warn(
      "open-file forward failed (non-fatal):",
      err && err.message ? err.message : err,
    );
  }
}

app.on("open-file", (event, filePath) => {
  event.preventDefault();
  if (app.isReady()) {
    forwardCsvOpen(filePath);
  } else {
    app.whenReady().then(() => forwardCsvOpen(filePath));
  }
});

// ── Launch flow ───────────────────────────────────────────────────────────────
let workDir = null;

async function launch() {
  const endLaunch = bootMark("launch");

  // 0. Register prod CSP + security headers before any window loads.
  registerSecurityHeaders();

  // 0a. Load i18n asynchronously so dialog strings resolve. If this fails,
  //     t() falls back to the key itself — survivable for startup paths.
  const endI18n = bootMark("init_i18n");
  const persistedSettings = await loadSettings();
  try {
    const runtimeState = await readRuntimeSelectionState(
      app.getPath("userData"),
      NATIVE_RUNTIME_ID,
    );
    resolveRuntimeMode({
      settings: persistedSettings,
      runtimeState,
      isDemo: __IS_DEMO,
    });
  } catch (error) {
    await dialog.showMessageBox({
      type: "error",
      buttons: ["OK"],
      title: APP_NAME,
      message: "Vision runtime configuration is invalid.",
      detail: error && error.message ? error.message : String(error),
    });
    app.quit();
    return;
  }
  await initI18n(persistedSettings.nativeLanguage);
  endI18n();

  // 0b. Open the loading window IMMEDIATELY so the user sees something straight
  //    away — before menu/dock setup and runtime I/O. The native menus need
  //    localized labels, so they still follow initI18n, but they do not need to
  //    block the first splash frame. The window navigates to appUrl() once the
  //    backend is ready.
  const endWindow = bootMark("create_window");
  createWindow();
  mainWindow.loadURL(splashDataUrl());
  endWindow();

  // 0b-bis. Complete native platform integration after splash loading has
  // started. Accent-color push subscription is darwin-only and inert otherwise.
  setupApplicationMenu();
  setupDockMenu();
  subscribeAccentColorChanges();

  {
    const endNative = bootMark("native_runtime_start");
    const repoRoot = path.resolve(__dirname, "..", "..");
    const runtimeRoot = app.isPackaged
      ? path.join(process.resourcesPath, "native-runtime")
      : repoRoot;
    const nativePayloadRoot = app.isPackaged
      ? runtimeRoot
      : path.join(__dirname, "native-runtime");
    workDir = runtimeRoot;
    try {
      const port = await resolveAppPort();
      appPort = port;
      activeRuntime = createRuntimeProvider("native", {
        native: {
          userDataDir: app.getPath("userData"),
          repoRoot: app.isPackaged ? undefined : repoRoot,
          runtimeRoot,
          postgresRuntimeRoot: nativePayloadRoot,
          browserRuntimeRoot: nativePayloadRoot,
          alembicPath: path.join(nativePayloadRoot, "vision-alembic"),
          allowExternalPostgres:
            process.env.VISION_ALLOW_EXTERNAL_POSTGRES === "true",
          runtimeId: NATIVE_RUNTIME_ID,
          postgresPort: __IS_DEMO ? DEMO_POSTGRES_PORT : undefined,
          appPort: () => appPort,
          requireRuntimeManifest: app.isPackaged,
        },
      });
      await activeRuntime.ensureLayout();
      if (!__IS_DEMO) await activeRuntime.importApplicationEnv(process.env);
      const preparedDemo = __IS_DEMO
        ? await prepareNativeDemo(activeRuntime, {
            seedRoot: path.join(process.resourcesPath, "demo-seed"),
          })
        : undefined;
      if (preparedDemo?.status === "current") {
        const finalized = await finalizeNativeDemo(activeRuntime, preparedDemo);
        if (finalized.resetCleanupWarning) {
          console.warn(finalized.resetCleanupWarning);
        }
      }
      try {
        setSplashStatus("splash.startingServices");
        try {
          await activeRuntime.start();
        } catch (error) {
          if (error?.code !== "PORT_COLLISION") throw error;
          await repickAppPort();
          await activeRuntime.start();
        }
        if (preparedDemo?.switchToken) {
          await activeRuntime.waitUntilReady({ detailed: true });
          const finalized = await finalizeNativeDemo(
            activeRuntime,
            preparedDemo,
          );
          if (finalized.resetCleanupWarning) {
            console.warn(finalized.resetCleanupWarning);
          }
        }
      } catch (error) {
        if (preparedDemo?.switchToken) {
          await rollbackNativeDemo(activeRuntime, preparedDemo);
        }
        throw error;
      }
      endNative();
      setSplashStatus("splash.waitingApp");
      pollAndLoad({ building: true });
      if (!__IS_DEMO) setupManualShellUpdater();
      endLaunch();
      return;
    } catch (error) {
      endNative();
      await dialog.showMessageBox({
        type: "error",
        buttons: [t("common.ok", null, "OK")],
        title: APP_NAME,
        message:
          error?.code === "LEGACY_RUNTIME_MIGRATION_REQUIRED"
            ? "Existing Vision data requires migration with Vision 1.0.2."
            : t("app.failedStart", null, "Vision could not start."),
        detail: error && error.message ? error.message : String(error),
      });
      app.quit();
      return;
    }
  }

  // ── Shutdown flow ─────────────────────────────────────────────────────────────
}

let isQuitting = false;

// Distinct from isQuitting (will-quit's re-entrancy guard): this flips on the
// FIRST quit signal (⌘Q, menu Quit, app.quit()), before any window 'close'
// fires, so the hide-on-close handler knows a red-button close from a real quit.
// The shell-updater path (which sets isQuitting directly then calls app.quit())
// also routes through before-quit, so windows there destroy rather than hide.
let isAppQuitting = false;
app.on("before-quit", () => {
  isAppQuitting = true;
});

app.on("will-quit", (e) => {
  if (isQuitting || !workDir) return;
  e.preventDefault();
  isQuitting = true;

  // Hard-kill safeguard: if backup and native service shutdown have not
  // finished in 45 seconds, force-exit so the app never hangs forever on quit.
  const forceQuitTimer = setTimeout(() => {
    console.warn("will-quit: hard timeout reached — forcing exit");
    app.exit(0);
  }, 45_000);
  forceQuitTimer.unref(); // don't prevent Node from exiting if nothing else is running

  // Run backup-on-quit if the user has configured a backup directory.
  // Prefer reading from the database (more up-to-date); fall back to the local
  // settings.json mirror that is kept in sync by backup:save-settings / backup:load-settings.
  async function resolveBackupSettings() {
    try {
      // The API wraps responses as { ok, data: { key, value } } (ADR-026).
      const body = await httpGet(
        `http://localhost:${appPort}/api/settings/backup_settings`,
      );
      const stored = body && body.data ? body.data.value : undefined;
      if (stored && typeof stored === "object") return stored;
    } catch {
      /* backend may already be down, use local mirror */
    }
    return loadSettings();
  }

  // Opt-in "keep services running on quit": leave the selected provider up so
  // the next launch takes the hot path instead of a warm restart. Same dual
  // DB + settings.json read as resolveBackupSettings above (the backend may
  // already be shutting down by the time this runs).
  async function resolveKeepServicesOnQuit() {
    try {
      const body = await httpGet(
        `http://localhost:${appPort}/api/settings/services_settings`,
      );
      const stored = body && body.data ? body.data.value : undefined;
      if (stored && typeof stored === "object")
        return stored.keepServicesOnQuit === true;
    } catch {
      /* backend may already be down, use local mirror */
    }
    try {
      return (await loadSettings()).keepServicesOnQuit === true;
    } catch {
      return false;
    }
  }

  resolveBackupSettings().then((s) => {
    const effective = resolveBackupSettingsWithDefaults(s);
    const backupOnQuit = effective.backupOnQuit === true;
    const backupDir = effective.backupDir || "";

    const doBackup =
      backupOnQuit && backupDir
        ? runBundleBackup(backupDir, null) // frontendState unavailable at quit time
            .then((result) => {
              if (result && result.warning) console.warn(result.warning);
              notify(t("backup.done"));
            })
            .catch((err) => {
              console.error("Backup on quit failed:", err);
              notify(t("backup.failed"));
            })
        : Promise.resolve();

    doBackup
      .then(async () => {
        // Drop the watchdog's idle keep-alive socket so the backend's
        // graceful shutdown isn't held open waiting on it.
        stopHealthWatchdog();
        try {
          healthAgent.destroy();
        } catch {
          /* already gone */
        }
        const keepServices = await resolveKeepServicesOnQuit();
        if (keepServices) return;
        return activeRuntime?.stop();
      })
      .catch((err) => console.error("runtime shutdown failed:", err))
      .finally(() => {
        clearTimeout(forceQuitTimer);
        notify(t("app.stopped"));
        app.exit(0);
      });
  });
});

// ── App lifecycle ─────────────────────────────────────────────────────────────
// The single-instance lock is acquired early (just after app.setName). A second
// instance already called app.quit() up there; only the primary registers here.
if (gotSingleInstanceLock) {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(launch);

  app.on("activate", () => {
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
    // loadURL(appUrl()) that would paint a blank window — or a connection error if
    // the backend isn't answering yet.
    if (mainWindow === null) {
      createWindow();
      mainWindow.loadURL(splashDataUrl());
      pollAndLoad();
    }
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
