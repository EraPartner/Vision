'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Expose a minimal, safe update API to the renderer via contextBridge.
 * The renderer (React app running at localhost:3002 inside the Electron shell)
 * can call these to trigger Docker image pulls or check for new releases.
 */
contextBridge.exposeInMainWorld('electronUpdater', {
  /**
   * Pull the latest Docker image and hot-swap the app container.
   * @returns {Promise<{ success: boolean, wasNew: boolean, error?: string }>}
   */
  pullImage: () => ipcRenderer.invoke('update:pull-image'),

  /**
   * Query and (if needed) pre-download the latest shell update from GitHub.
   * Response includes `update_mode: 'source' | 'docker' | 'dev'`.
   */
  checkRelease: () => ipcRenderer.invoke('update:check-github'),

  /**
   * Install a previously prepared shell update and restart the app.
   * Only valid when update_mode is 'source'. Returns an error in embedded mode.
   * @returns {Promise<{ success: boolean, version?: string, error?: string }>}
   */
  installShellUpdate: () => ipcRenderer.invoke('update:install-shell'),

  /**
   * Get the current update mode and packaging state.
   * @returns {Promise<{ mode: 'source' | 'docker' | 'dev', is_packaged: boolean, use_repo_mode: boolean }>}
   */
  getMode: () => ipcRenderer.invoke('update:get-mode'),

  /**
   * Create a pre-update database backup in userData/pre-update-backups/.
   * Call this before any install action to ensure zero data loss.
   * @returns {Promise<{ success: boolean, file?: string, error?: string }>}
   */
  preUpdateBackup: () => ipcRenderer.invoke('update:pre-update-backup'),
});

/**
 * Expose backup controls to the renderer via contextBridge.
 */
contextBridge.exposeInMainWorld('electronBackup', {
  /**
   * Create a .visionbak bundle in destDir.
   * frontendStateJson is the serialised { keys: { … } } localStorage snapshot;
   * pass null if unavailable (e.g. automated backup on quit).
   * @param {string}      destDir           Absolute path to the destination directory.
   * @param {string|null} frontendStateJson JSON string of { keys: { … } } or null.
   * @returns {Promise<{ success: boolean, file?: string, encrypted?: boolean, warning?: string, cleanupRemoved?: number, error?: string }>}
   */
  runBackup: (destDir, frontendStateJson = null) => ipcRenderer.invoke('backup:run', destDir, frontendStateJson),

  /**
   * Open the system folder-picker dialog to choose a backup directory.
   * @returns {Promise<string | null>}  Chosen path or null if cancelled.
   */
  selectDir: () => ipcRenderer.invoke('backup:select-dir'),

  /**
   * Open the system file-picker dialog to choose a .sql backup file to restore.
   * @returns {Promise<string | null>}  Chosen file path or null if cancelled.
   */
  selectFile: () => ipcRenderer.invoke('backup:select-file'),

  /**
   * Restore from a backup file.  Accepts .visionbak, .visionbak.enc (new bundle
   * format) or legacy .sql / .enc files. When the file is encrypted, supply
   * `opts.passphrase` to decrypt it.
   * @param {string} filePath  Absolute path to the backup file on the host.
   * @param {{ passphrase?: string }} [opts]
   * @returns {Promise<{ success: boolean, file?: string, frontendState?: object|null, error?: string }>}
   */
  restoreBackup: (filePath, opts) => ipcRenderer.invoke('backup:restore', filePath, opts),

  /**
   * Detect whether a backup file is encrypted.
   * @param {string} filePath  Absolute path to the backup file on the host.
   * @returns {Promise<boolean>}
   */
  isEncrypted: (filePath) => ipcRenderer.invoke('backup:is-encrypted', filePath),

  /**
   * Persist backup settings (backupDir, backupOnQuit) to Electron settings.json.
   * @param {{ backupDir: string, backupOnQuit: boolean }} settings
   */
  saveSettings: (settings) => ipcRenderer.invoke('backup:save-settings', settings),

  /**
   * Read backup settings from Electron settings.json.
   * @returns {Promise<{ backupDir: string, backupOnQuit: boolean }>}
   */
  loadSettings: () => ipcRenderer.invoke('backup:load-settings'),

  /**
   * Get backup encryption capability + passphrase presence.
   * @returns {Promise<{ success: boolean, secureStorageAvailable: boolean, hasStoredPassphrase: boolean, hasEnvPassphrase: boolean }>}
   */
  getEncryptionStatus: () => ipcRenderer.invoke('backup:get-encryption-status'),

  /**
   * Store or clear optional backup passphrase in OS secure storage.
   * @param {string} passphrase Empty string clears the stored passphrase.
   * @returns {Promise<{ success: boolean, available: boolean, error?: string }>}
   */
  setPassphrase: (passphrase) => ipcRenderer.invoke('backup:set-passphrase', passphrase),
});

/**
 * Expose service-lifecycle controls (currently the opt-in "keep services running
 * on quit" toggle) to the renderer via contextBridge.
 */
contextBridge.exposeInMainWorld('electronServices', {
  /**
   * Persist the keep-services-running-on-quit toggle to Electron settings.json.
   * When enabled, quitting leaves the Docker containers up so the next launch
   * takes the hot path.
   * @param {{ keepServicesOnQuit: boolean }} settings
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  saveSettings: (settings) => ipcRenderer.invoke('services:save-settings', settings),

  /**
   * Read the keep-services-running-on-quit toggle from Electron settings.json.
   * @returns {Promise<{ keepServicesOnQuit: boolean }>}
   */
  loadSettings: () => ipcRenderer.invoke('services:load-settings'),
});

/**
 * Expose the macOS-native integration surface (menu bar actions, dock badge,
 * CSV open-with handoff, system accent color, fullscreen state). Subscription
 * helpers return an unsubscribe function. The renderer must call ready() once
 * its listeners are mounted — main queues messages until then.
 */
contextBridge.exposeInMainWorld('electronAPI', {
  /** 'darwin' | 'win32' | 'linux' — used to gate traffic-light inset CSS. */
  platform: process.platform,

  /** Signal that renderer listeners are mounted; main flushes queued messages. */
  ready: () => ipcRenderer.invoke('app:renderer-ready'),

  /**
   * Set the dock badge to a count of due planned payments (0 clears it).
   * @param {number} count
   */
  setDockBadge: (count) => ipcRenderer.invoke('app:set-badge', count),

  /** macOS accent color as RRGGBBAA hex, or null when unavailable. */
  getAccentColor: () => ipcRenderer.invoke('app:get-accent-color'),

  /**
   * Persist the active theme's primary colors (HSL component strings) so the
   * next boot splash matches the chosen palette.
   * @param {{ background: string, foreground: string }} colors
   */
  persistSplashTheme: (colors) => ipcRenderer.invoke('theme:persist-splash', colors),

  /** Fires with the new RRGGBBAA hex (or null) when the user changes the system accent. */
  onAccentColorChanged: (cb) => {
    const listener = (_event, color) => cb(color);
    ipcRenderer.on('app:accent-color-changed', listener);
    return () => ipcRenderer.removeListener('app:accent-color-changed', listener);
  },

  /** Native menu / dock menu actions: { action: string, payload?: unknown }. */
  onMenuAction: (cb) => {
    const listener = (_event, message) => cb(message);
    ipcRenderer.on('menu:action', listener);
    return () => ipcRenderer.removeListener('menu:action', listener);
  },

  /** Finder/dock "open with Vision" CSV handoff: { name: string, content: string }. */
  onCsvOpen: (cb) => {
    const listener = (_event, file) => cb(file);
    ipcRenderer.on('app:csv-opened', listener);
    return () => ipcRenderer.removeListener('app:csv-opened', listener);
  },

  /** Native fullscreen enter/leave (traffic lights auto-hide in fullscreen). */
  onFullScreenChange: (cb) => {
    const listener = (_event, isFullScreen) => cb(isFullScreen);
    ipcRenderer.on('window:fullscreen', listener);
    return () => ipcRenderer.removeListener('window:fullscreen', listener);
  },
});

/**
 * Expose startup-recovery controls used by error.html when backend health
 * polling fails. Renderer is sandboxed, so only the narrow ipc surface is available.
 */
contextBridge.exposeInMainWorld('electronRecovery', {
  retry: () => ipcRenderer.invoke('recovery:retry'),
  openLogs: () => ipcRenderer.invoke('recovery:open-logs'),
  onBackendLost: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('backend:lost', listener);
    return () => ipcRenderer.removeListener('backend:lost', listener);
  },
  onBackendRestored: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('backend:restored', listener);
    return () => ipcRenderer.removeListener('backend:restored', listener);
  },
});
