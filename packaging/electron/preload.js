"use strict";

const { contextBridge, ipcRenderer } = require("electron");

function rendererFailureSource(event) {
  const candidate =
    event?.filename || event?.target?.src || event?.target?.href || "";
  try {
    return new URL(candidate).pathname.split("/").pop() || "unknown";
  } catch {
    return "unknown";
  }
}

function reportRendererFailure(payload) {
  ipcRenderer.invoke("app:renderer-failure", payload).catch(() => {
    /* diagnostics are best-effort and must never affect renderer startup */
  });
}

// Capture failures before the application bundle executes. Only structural
// metadata crosses IPC: never exception messages, URLs, or application data.
window.addEventListener(
  "error",
  (event) => {
    const targetTag = event?.target?.tagName;
    const isResource = targetTag === "SCRIPT" || targetTag === "LINK";
    if (event?.target && event.target !== window && !isResource) return;
    reportRendererFailure({
      kind: isResource ? "resource" : "error",
      name:
        !isResource && typeof event?.error?.name === "string"
          ? event.error.name
          : isResource
            ? "ResourceLoadError"
            : "UnknownError",
      source: rendererFailureSource(event),
      line: Number.isSafeInteger(event?.lineno) ? event.lineno : 0,
    });
  },
  true,
);

window.addEventListener("unhandledrejection", (event) => {
  reportRendererFailure({
    kind: "unhandledrejection",
    name:
      typeof event?.reason?.name === "string"
        ? event.reason.name
        : "UnhandledRejection",
    source: "unknown",
    line: 0,
  });
});

/**
 * Expose a minimal, safe update API to the renderer via contextBridge.
 * The renderer (React app running at localhost:3002 inside the Electron shell)
 * can call these to apply provider-specific updates or check for new releases.
 */
/** @type {import("./electron-api").ElectronUpdaterBridge} */
const electronUpdater = {
  /**
   * Pull the latest Docker image for the explicit Docker provider.
   */
  pullImage: () => ipcRenderer.invoke("update:pull-image"),

  /**
   * Query and (if needed) pre-download the latest shell update from GitHub.
   * Response includes `update_mode: 'source' | 'docker' | 'native' | 'dev'`.
   */
  checkRelease: () => ipcRenderer.invoke("update:check-github"),

  /**
   * Install a previously prepared shell update and restart the app.
   * Only valid when update_mode is 'source'. Returns an error in embedded mode.
   */
  installShellUpdate: () => ipcRenderer.invoke("update:install-shell"),

  /**
   * Get the current update mode and packaging state.
   */
  getMode: () => ipcRenderer.invoke("update:get-mode"),

  /**
   * Create a pre-update database backup in userData/pre-update-backups/.
   * Call this before any install action to ensure zero data loss.
   */
  preUpdateBackup: () => ipcRenderer.invoke("update:pre-update-backup"),
};
contextBridge.exposeInMainWorld("electronUpdater", electronUpdater);

/**
 * Expose backup controls to the renderer via contextBridge.
 */
/** @type {import("./electron-api").ElectronBackupBridge} */
const electronBackup = {
  /**
   * Create a .visionbak bundle in destDir.
   * frontendStateJson is the serialised { keys: { … } } localStorage snapshot;
   * pass null if unavailable (e.g. automated backup on quit).
   */
  runBackup: (destDir, frontendStateJson = null) =>
    ipcRenderer.invoke("backup:run", destDir, frontendStateJson),

  /**
   * Open the system folder-picker dialog to choose a backup directory.
   */
  selectDir: () => ipcRenderer.invoke("backup:select-dir"),

  /**
   * Open the system file-picker dialog to choose a .sql backup file to restore.
   */
  selectFile: () => ipcRenderer.invoke("backup:select-file"),

  /**
   * Restore from a backup file.  Accepts .visionbak, .visionbak.enc (new bundle
   * format) or legacy .sql / .enc files. When the file is encrypted, supply
   * `opts.passphrase` to decrypt it.
   */
  restoreBackup: (filePath, opts) =>
    ipcRenderer.invoke("backup:restore", filePath, opts),

  /**
   * Detect whether a backup file is encrypted.
   */
  isEncrypted: (filePath) =>
    ipcRenderer.invoke("backup:is-encrypted", filePath),

  /**
   * Persist backup settings (backupDir, backupOnQuit) to Electron settings.json.
   */
  saveSettings: (settings) =>
    ipcRenderer.invoke("backup:save-settings", settings),

  /**
   * Read backup settings from Electron settings.json.
   */
  loadSettings: () => ipcRenderer.invoke("backup:load-settings"),

  /**
   * Get backup encryption capability + passphrase presence.
   */
  getEncryptionStatus: () => ipcRenderer.invoke("backup:get-encryption-status"),

  /**
   * Store or clear optional backup passphrase in OS secure storage.
   * Empty string clears the stored passphrase.
   */
  setPassphrase: (passphrase) =>
    ipcRenderer.invoke("backup:set-passphrase", passphrase),
};
contextBridge.exposeInMainWorld("electronBackup", electronBackup);

/**
 * Expose service-lifecycle controls (currently the opt-in "keep services running
 * on quit" toggle) to the renderer via contextBridge.
 */
/** @type {import("./electron-api").ElectronServicesBridge} */
const electronServices = {
  /**
   * Persist the keep-services-running-on-quit toggle to Electron settings.json
   * (and, via the main-process handler, the database).
   * When enabled, quitting leaves the Docker containers up so the next launch
   * takes the hot path.
   */
  saveSettings: (settings) =>
    ipcRenderer.invoke("services:save-settings", settings),

  /**
   * Read the keep-services-running-on-quit toggle.
   */
  loadSettings: () => ipcRenderer.invoke("services:load-settings"),
};
contextBridge.exposeInMainWorld("electronServices", electronServices);

/**
 * Expose the native desktop integration surface (menu actions, dock/taskbar badge,
 * CSV open-with handoff, system accent color, fullscreen state). Subscription
 * helpers return an unsubscribe function. The renderer must call ready() once
 * its listeners are mounted — main queues messages until then.
 */
/** @type {import("./electron-api").ElectronApiBridge} */
const electronAPI = {
  /** 'darwin' | 'win32' | 'linux' — used to gate traffic-light inset CSS. */
  platform: process.platform,

  /** Signal that renderer listeners are mounted; main flushes queued messages. */
  ready: () => ipcRenderer.invoke("app:renderer-ready"),

  /**
   * Set the native dock/taskbar badge to a count of due planned payments (0 clears it).
   */
  setDockBadge: (count) => ipcRenderer.invoke("app:set-badge", count),

  /** Keep native menus and dialogs aligned with the persisted in-app language. */
  setLanguage: (language) => ipcRenderer.invoke("app:set-language", language),

  /** Enable the macOS under-window material only for the effective enhanced tier. */
  setVibrancy: (enabled) => ipcRenderer.invoke("app:set-vibrancy", enabled),

  /** macOS accent color as RRGGBBAA hex, or null when unavailable. */
  getAccentColor: () => ipcRenderer.invoke("app:get-accent-color"),

  /**
   * Persist the active theme's primary colors (HSL component strings) so the
   * next boot splash matches the chosen palette.
   */
  persistSplashTheme: (colors) =>
    ipcRenderer.invoke("theme:persist-splash", colors),

  /** Fires with the new RRGGBBAA hex (or null) when the user changes the system accent. */
  onAccentColorChanged: (cb) => {
    const listener = (_event, color) => cb(color);
    ipcRenderer.on("app:accent-color-changed", listener);
    return () =>
      ipcRenderer.removeListener("app:accent-color-changed", listener);
  },

  /** Native menu / dock menu actions: { action: string, payload?: unknown }. */
  onMenuAction: (cb) => {
    const listener = (_event, message) => cb(message);
    ipcRenderer.on("menu:action", listener);
    return () => ipcRenderer.removeListener("menu:action", listener);
  },

  /** Finder/dock "open with Vision" CSV handoff: { name: string, content: string }. */
  onCsvOpen: (cb) => {
    const listener = (_event, file) => cb(file);
    ipcRenderer.on("app:csv-opened", listener);
    return () => ipcRenderer.removeListener("app:csv-opened", listener);
  },

  /** Native fullscreen enter/leave (traffic lights auto-hide in fullscreen). */
  onFullScreenChange: (cb) => {
    const listener = (_event, isFullScreen) => cb(isFullScreen);
    ipcRenderer.on("window:fullscreen", listener);
    return () => ipcRenderer.removeListener("window:fullscreen", listener);
  },
};
contextBridge.exposeInMainWorld("electronAPI", electronAPI);

/**
 * Expose startup-recovery controls used by error.html when backend health
 * polling fails. Renderer is sandboxed, so only the narrow ipc surface is available.
 */
/** @type {import("./electron-api").ElectronRecoveryBridge} */
const electronRecovery = {
  retry: () => ipcRenderer.invoke("recovery:retry"),
  openLogs: () => ipcRenderer.invoke("recovery:open-logs"),
  onBackendLost: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on("backend:lost", listener);
    return () => ipcRenderer.removeListener("backend:lost", listener);
  },
  onBackendRestored: (cb) => {
    const listener = () => cb();
    ipcRenderer.on("backend:restored", listener);
    return () => ipcRenderer.removeListener("backend:restored", listener);
  },
};
contextBridge.exposeInMainWorld("electronRecovery", electronRecovery);
