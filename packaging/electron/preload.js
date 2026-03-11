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
   * Query the GitHub Releases API for the latest version.
   * @returns {Promise<{
   *   latest_version: string,
   *   current_version: string,
   *   up_to_date: boolean,
   *   release_notes: string,
   *   published_at: string,
   *   html_url: string,
   *   error?: string
   * }>}
   */
  checkRelease: () => ipcRenderer.invoke('update:check-github'),
});
