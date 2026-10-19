// Sandboxed preload: the only runtime module is "electron". Everything else is
// a type-only import, erased at compile time (preload-sandbox.contract.test).
import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type {
  ElectronApiBridge,
  ElectronAuditBridge,
  ElectronBackupBridge,
  ElectronEventContract,
  ElectronRecoveryBridge,
  ElectronServicesBridge,
  ElectronUpdaterBridge,
  RendererFailurePayload,
} from "./electron-api";

// `value?.[key]` for event targets, errors and rejection reasons of unknown shape.
function property(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function rendererFailureSource(event: ErrorEvent): string {
  const candidate =
    event.filename ||
    property(event.target, "src") ||
    property(event.target, "href") ||
    "";
  try {
    return new URL(String(candidate)).pathname.split("/").pop() || "unknown";
  } catch {
    return "unknown";
  }
}

function reportRendererFailure(payload: RendererFailurePayload): void {
  ipcRenderer.invoke("app:renderer-failure", payload).catch(() => {
    /* diagnostics are best-effort and must never affect renderer startup */
  });
}

// Capture failures before the application bundle executes. Only structural
// metadata crosses IPC: never exception messages, URLs, or application data.
window.addEventListener(
  "error",
  (event) => {
    const targetTag = property(event.target, "tagName");
    const isResource = targetTag === "SCRIPT" || targetTag === "LINK";
    if (event.target && event.target !== window && !isResource) return;
    const errorName = property(event.error, "name");
    reportRendererFailure({
      kind: isResource ? "resource" : "error",
      name:
        !isResource && typeof errorName === "string"
          ? errorName
          : isResource
            ? "ResourceLoadError"
            : "UnknownError",
      source: rendererFailureSource(event),
      line: Number.isSafeInteger(event.lineno) ? event.lineno : 0,
    });
  },
  true,
);

window.addEventListener("unhandledrejection", (event) => {
  const reasonName = property(event.reason, "name");
  reportRendererFailure({
    kind: "unhandledrejection",
    name: typeof reasonName === "string" ? reasonName : "UnhandledRejection",
    source: "unknown",
    line: 0,
  });
});

/**
 * Expose a minimal, safe update API to the renderer via contextBridge.
 * The renderer (React app running at localhost:3002 inside the Electron shell)
 * can call these to install native updates or check for new releases.
 */
const electronUpdater: ElectronUpdaterBridge = {
  /**
   * Query and (if needed) pre-download the latest shell update from GitHub.
   * Response includes `update_mode: 'native' | 'source'`.
   */
  checkRelease: () => ipcRenderer.invoke("update:check-github"),

  /**
   * Install a previously prepared shell update and restart the app.
   * The native updater replaces the packaged application after verification.
   */
  installShellUpdate: () => ipcRenderer.invoke("update:install-shell"),

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
const electronBackup: ElectronBackupBridge = {
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

const electronAudit: ElectronAuditBridge = {
  enroll: () => ipcRenderer.invoke("audit:enroll"),
  read: (options) => ipcRenderer.invoke("audit:read", options),
  exportSnapshot: () => ipcRenderer.invoke("audit:export"),
  exportTransfer: (password) =>
    ipcRenderer.invoke("audit:transfer-export", password),
  importTransfer: (password) =>
    ipcRenderer.invoke("audit:transfer-import", password),
  rotateKey: () => ipcRenderer.invoke("audit:rotate-key"),
};
contextBridge.exposeInMainWorld("electronAudit", electronAudit);

/**
 * Expose service-lifecycle controls (currently the opt-in "keep services running
 * on quit" toggle) to the renderer via contextBridge.
 */
const electronServices: ElectronServicesBridge = {
  /**
   * Persist the keep-services-running-on-quit toggle to Electron settings.json
   * (and, via the main-process handler, the database).
   * When enabled, quitting leaves the native services up for a faster relaunch.
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
const electronAPI: ElectronApiBridge = {
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
    const listener = (
      _event: IpcRendererEvent,
      color: ElectronEventContract["app:accent-color-changed"],
    ) => cb(color);
    ipcRenderer.on("app:accent-color-changed", listener);
    return () =>
      ipcRenderer.removeListener("app:accent-color-changed", listener);
  },

  /** Native menu / dock menu actions: { action: string, payload?: unknown }. */
  onMenuAction: (cb) => {
    const listener = (
      _event: IpcRendererEvent,
      message: ElectronEventContract["menu:action"],
    ) => cb(message);
    ipcRenderer.on("menu:action", listener);
    return () => ipcRenderer.removeListener("menu:action", listener);
  },

  /** Finder/dock "open with Vision" CSV handoff: { name: string, content: string }. */
  onCsvOpen: (cb) => {
    const listener = (
      _event: IpcRendererEvent,
      file: ElectronEventContract["app:csv-opened"],
    ) => cb(file);
    ipcRenderer.on("app:csv-opened", listener);
    return () => ipcRenderer.removeListener("app:csv-opened", listener);
  },

  /** Native fullscreen enter/leave (traffic lights auto-hide in fullscreen). */
  onFullScreenChange: (cb) => {
    const listener = (
      _event: IpcRendererEvent,
      isFullScreen: ElectronEventContract["window:fullscreen"],
    ) => cb(isFullScreen);
    ipcRenderer.on("window:fullscreen", listener);
    return () => ipcRenderer.removeListener("window:fullscreen", listener);
  },
};
contextBridge.exposeInMainWorld("electronAPI", electronAPI);

/**
 * Expose startup-recovery controls used by error.html when backend health
 * polling fails. Renderer is sandboxed, so only the narrow ipc surface is available.
 */
const electronRecovery: ElectronRecoveryBridge = {
  retry: () => ipcRenderer.invoke("recovery:retry"),
  openLogs: () => ipcRenderer.invoke("recovery:open-logs"),
  onBackendLost: (cb) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: ElectronEventContract["backend:lost"],
    ) => cb(payload);
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
