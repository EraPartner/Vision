/**
 * Admin routes.
 *
 * Mirrors: apps/backend/api/api_routes_admin.py
 */

import { Router } from 'express';
import { checkConnection, getTableCount } from '../database/connection.js';
import { getSettings } from '../config/config.js';
import { logger } from '../config/logger.js';

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

export default router;
