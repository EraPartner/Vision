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
   */
  checkRelease: () => ipcRenderer.invoke('update:check-github'),

  /**
   * Install a previously prepared shell update and restart the app.
   * @returns {Promise<{ success: boolean, version?: string, error?: string }>}
   */
  installShellUpdate: () => ipcRenderer.invoke('update:install-shell'),
});

/**
 * Expose backup controls to the renderer via contextBridge.
 */
contextBridge.exposeInMainWorld('electronBackup', {
  /**
   * Run a pg_dump backup immediately, writing a backup file to destDir.
   * @param {string} destDir  Absolute path to the destination directory.
   * @returns {Promise<{ success: boolean, file?: string, encrypted?: boolean, warning?: string, cleanupRemoved?: number, error?: string }>}
   */
  runBackup: (destDir) => ipcRenderer.invoke('backup:run', destDir),

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
   * Restore the database from a plain-SQL backup file.
   * Stops the app container, drops & recreates the DB, runs psql, then restarts.
   * @param {string} sqlFilePath  Absolute path to the .sql file on the host.
   * @returns {Promise<{ success: boolean, file?: string, error?: string }>}
   */
  restoreBackup: (sqlFilePath) => ipcRenderer.invoke('backup:restore', sqlFilePath),

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
