/**
 * Admin routes.
 *
 * Update strategy (packaged desktop app):
 *   - Electron shell updates: handled by electron-updater checking GitHub Releases
 *   - Docker image updates: Electron calls `docker compose pull` + `docker compose up -d`
 *   - Alembic migrations: run automatically via docker-entrypoint.sh on every container start
 *
 * The git-pull based update approach has been removed. The Node backend running
 * inside the Docker container has no git repo, so those endpoints were only
 * applicable to bare self-hosted installs (which can still use git manually).
 * Version information is now read from the GitHub Releases API.
 */

import { Router } from 'express';
import https from 'https';
import { checkConnection, getTableCount } from '../database/connection.js';
import { getSettings } from '../config/config.js';
import { logger } from '../config/logger.js';

const GITHUB_OWNER = 'EraPartner';
const GITHUB_REPO = 'Vision';
const GITHUB_RELEASES_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;

/**
 * Fetch the latest GitHub Release metadata.
 * Returns a plain object — callers handle errors.
 */
function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': `${GITHUB_REPO}-backend`,
        'Accept': 'application/vnd.github+json',
      },
    };
    https.get(GITHUB_RELEASES_URL, options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`Failed to parse GitHub response: ${e.message}`)); }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

const router = Router();

// GET /api/admin
router.get('/', async (req, res) => {
  try {
    const isConnected = await checkConnection();
    const tableCount = isConnected ? await getTableCount() : 0;

    res.json({
      is_initialised: isConnected && tableCount > 0,
      table_count: tableCount,
      timestamp: new Date().toISOString(),
      links: [],
    });
  } catch (err) {
    logger.error('Admin status retrieval failed', { error: err.message });
    res.status(500).json({ detail: 'Failed to retrieve administration status' });
  }
});

// POST /api/admin/database/init
router.post('/database/init', async (req, res) => {
  try {
    // Tables are managed by Alembic/SQLAlchemy - just verify connection
    const isConnected = await checkConnection();
    if (!isConnected) {
      return res.status(500).json({ detail: 'Cannot connect to database' });
    }
    res.status(201).json({
      message: 'Database connection verified successfully',
      details: { note: 'Tables are managed by Alembic migrations' },
      links: [],
    });
  } catch (err) {
    logger.error('Database init check failed', { error: err.message });
    res.status(500).json({ detail: `Database initialisation failed: ${err.message}` });
  }
});

// POST /api/admin/database/reset
router.post('/database/reset', async (req, res) => {
  const settings = getSettings();
  if (!settings.admin.enableResetDb) {
    return res.status(404).json({ detail: 'Database reset endpoint disabled' });
  }

  const force = req.query.force === 'true';
  if (!force) {
    return res.status(400).json({
      message: 'Database reset requires force=true parameter',
      details: { error: 'Set force=true query parameter to confirm reset (DESTRUCTIVE)' },
      links: [],
    });
  }

  // Not implementing actual reset in Node backend - delegate to Python/Alembic
  res.json({
    message: 'Database reset should be performed via Alembic migrations (Python backend)',
    details: { warning: 'Use the Python backend for destructive database operations' },
    links: [],
  });
});

// GET /api/admin/update/check
// Queries the GitHub Releases API for the latest published release.
// Works in any environment (Docker, bare-metal) — no git required.
router.get('/update/check', async (req, res) => {
  try {
    const release = await fetchLatestRelease();

    if (release.message === 'Not Found' || !release.tag_name) {
      return res.json({ up_to_date: true, error: 'No published releases found', latest_version: null });
    }

    const latestVersion = release.tag_name;          // e.g. "v1.2.3"
    // The running image is tagged with the same semver at build time via CI.
    // Fall back to APP_IMAGE_TAG env var (set in docker-compose.yml) or "unknown".
    const currentVersion = process.env.APP_VERSION || process.env.APP_IMAGE_TAG || 'unknown';

    const upToDate = latestVersion === currentVersion || latestVersion === `v${currentVersion}`;

    logger.info('Update check via GitHub Releases', { currentVersion, latestVersion, upToDate });
    return res.json({
      up_to_date: upToDate,
      current_version: currentVersion,
      latest_version: latestVersion,
      published_at: release.published_at,
      release_notes: release.body || '',
      html_url: release.html_url,
    });
  } catch (err) {
    logger.error('Update check failed', { error: err.message });
    res.status(500).json({ detail: `Update check failed: ${err.message}` });
  }
});

// POST /api/admin/update/apply
// In the packaged desktop app, the actual update is orchestrated by Electron
// (docker compose pull → docker compose up → alembic migrations via entrypoint).
// This endpoint exists so the frontend can trigger a soft "update acknowledgement"
// and surface a user-facing message directing them to the Electron shell update.
router.post('/update/apply', async (req, res) => {
  res.json({
    success: true,
    note: 'Updates are applied automatically by the desktop app. If an update is available, use the notification in the Vision app window to download and install it.',
  });
});

// POST /api/admin/update/apply-and-restart (kept for backwards-compatibility)
router.post('/update/apply-and-restart', async (req, res) => {
  res.json({
    success: true,
    note: 'Updates are managed by the Vision desktop app via Docker image pulls and electron-updater. No manual action is required.',
  });
});

export default router;
