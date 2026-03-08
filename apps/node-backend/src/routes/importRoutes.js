/**
 * Import routes (stub).
 *
 * Mirrors: apps/backend/api/api_routes_import.py
 *
 * CSV import is complex (bank adapters, deduplication, etc.)
 * This provides a stub that returns a helpful message.
 * For full import functionality, use the Python backend.
 */

import { Router } from 'express';

const router = Router();

// POST /api/import/csv
router.post('/csv', (req, res) => {
  res.status(501).json({
    detail: 'CSV import is not yet implemented in the Node.js backend. Use the Python backend for import functionality.',
    links: [],
  });
});

// POST /api/import/csv/custom
router.post('/csv/custom', (req, res) => {
  res.status(501).json({
    detail: 'Custom CSV import is not yet implemented in the Node.js backend. Use the Python backend for import functionality.',
    links: [],
  });
});

export default router;
