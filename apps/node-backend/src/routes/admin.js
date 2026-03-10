/**
 * Admin routes.
 *
 * Mirrors: apps/backend/api/api_routes_admin.py
 */

import { Router } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { checkConnection, getTableCount } from '../database/connection.js';
import { getSettings } from '../config/config.js';
import { logger } from '../config/logger.js';

const execFileAsync = promisify(execFile);

const REPO_URL = 'https://github.com/EraPartner/Vision.git';

/**
 * Run a git command inside the repo root (three levels up from this file's src/ dir).
 * Uses execFile (not exec/shell) to avoid shell injection.
 */
async function git(args, cwd) {
  const { stdout, stderr } = await execFileAsync('git', args, {
    cwd,
    timeout: 30_000,
    maxBuffer: 1024 * 512,
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

async function getRepoRoot() {
  // __dirname equivalent in ESM
  const { dirname } = await import('path');
  const { fileURLToPath } = await import('url');
  const currentDir = dirname(fileURLToPath(import.meta.url));
  // src/routes -> src -> node-backend -> apps -> project-root
  const { resolve } = await import('path');
  return resolve(currentDir, '..', '..', '..', '..');
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
// Fetches the latest refs from origin and returns whether the local repo is behind.
router.get('/update/check', async (req, res) => {
  try {
    const cwd = await getRepoRoot();

    // Fetch without merging so we get up-to-date remote tracking refs
    try {
      await git(['fetch', REPO_URL], cwd);
    } catch (fetchErr) {
      logger.warn('git fetch failed during update check', { error: fetchErr.message });
      // Continue – we can still compare cached remote refs
    }

    const [localHead, remoteHead] = await Promise.all([
      git(['rev-parse', 'HEAD'], cwd).then(r => r.stdout),
      git(['rev-parse', '@{u}'], cwd).then(r => r.stdout).catch(() => null),
    ]);

    if (!remoteHead) {
      return res.json({ up_to_date: true, current_commit: localHead, latest_commit: null, behind_by: 0, error: 'No upstream tracking branch configured' });
    }

    if (localHead === remoteHead) {
      return res.json({ up_to_date: true, current_commit: localHead, latest_commit: remoteHead, behind_by: 0 });
    }

    // Count commits between HEAD and upstream
    const { stdout: countStr } = await git(['rev-list', '--count', `HEAD..@{u}`], cwd).catch(() => ({ stdout: '?' }));

    // Get the latest commit message on the upstream
    const { stdout: latestMsg } = await git(['log', '-1', '--format=%s', '@{u}'], cwd).catch(() => ({ stdout: '' }));

    logger.info('Update check: updates available', { behind_by: countStr });
    return res.json({
      up_to_date: false,
      current_commit: localHead,
      latest_commit: remoteHead,
      behind_by: parseInt(countStr, 10) || countStr,
      latest_message: latestMsg,
    });
  } catch (err) {
    logger.error('Update check failed', { error: err.message });
    res.status(500).json({ detail: `Update check failed: ${err.message}` });
  }
});

// POST /api/admin/update/apply
// Runs `git pull --ff-only` to update the local repo.
// POST /api/admin/update/apply-and-restart
// Pulls the latest code and, when running inside Docker (EXTERNAL_DATABASE=true),
// exits the process after responding so Docker's restart policy brings the server back up.
router.post('/update/apply-and-restart', async (req, res) => {
  try {
    const cwd = await getRepoRoot();
    const isDocker = process.env.EXTERNAL_DATABASE === 'true';

    logger.info('Applying update + restart via git pull', { isDocker });
    const { stdout, stderr } = await git(['pull', '--ff-only', REPO_URL, 'main'], cwd)
      .catch(async (err) => {
        const { stdout: s, stderr: e } = await git(['pull', '--ff-only', 'origin', 'main'], cwd)
          .catch(() => { throw err; });
        return { stdout: s, stderr: e };
      });

    const output = [stdout, stderr].filter(Boolean).join('\n');
    const alreadyUpToDate = /already up[ -]to[ -]date/i.test(output);

    logger.info('git pull completed (apply-and-restart)', { output, alreadyUpToDate, isDocker });
    res.json({
      success: true,
      already_up_to_date: alreadyUpToDate,
      output,
      restarting: isDocker && !alreadyUpToDate,
      note: alreadyUpToDate
        ? 'Already up to date.'
        : isDocker
          ? 'Update applied. The server will restart automatically via Docker.'
          : 'Update applied. Please restart the application manually for changes to take effect.',
    });

    // In Docker, exit gracefully so the container restarts and picks up the new code.
    if (!alreadyUpToDate && isDocker) {
      setTimeout(() => process.exit(0), 1500);
    }
  } catch (err) {
    logger.error('git pull + restart failed', { error: err.message, stderr: err.stderr });
    const detail = err.stderr || err.message;
    res.status(500).json({ success: false, detail: `Update failed: ${detail}` });
  }
});

// NOTE: The server process must be restarted separately for code changes to take effect.
router.post('/update/apply', async (req, res) => {
  try {
    const cwd = await getRepoRoot();

    logger.info('Applying update via git pull');
    const { stdout, stderr } = await git(['pull', '--ff-only', REPO_URL, 'main'], cwd)
      .catch(async (err) => {
        // Try with named remote as fallback
        const { stdout: s, stderr: e } = await git(['pull', '--ff-only', 'origin', 'main'], cwd)
          .catch(() => { throw err; });
        return { stdout: s, stderr: e };
      });

    const output = [stdout, stderr].filter(Boolean).join('\n');
    const alreadyUpToDate = /already up[ -]to[ -]date/i.test(output);

    logger.info('git pull completed', { output });
    res.json({
      success: true,
      already_up_to_date: alreadyUpToDate,
      output,
      note: alreadyUpToDate ? 'Already up to date.' : 'Update applied. Restart the server for changes to take effect.',
    });
  } catch (err) {
    logger.error('git pull failed', { error: err.message, stderr: err.stderr });
    const detail = err.stderr || err.message;
    res.status(500).json({ success: false, detail: `Update failed: ${detail}` });
  }
});

export default router;
