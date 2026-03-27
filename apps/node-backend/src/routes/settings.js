/**
 * Settings routes.
 *
 * GET  /api/settings          — get all settings
 * GET  /api/settings/:key     — get a single setting
 * PUT  /api/settings/:key     — upsert a single setting
 * PUT  /api/settings          — bulk upsert settings
 * DELETE /api/settings/:key   — delete a setting
 */

import { Router } from 'express';
import settingsRepository from '../repositories/settingsRepository.js';
import { validateIntArray } from '../middleware/validation.js';
import { logger } from '../config/logger.js';

const router = Router();

// GET /api/settings — all settings
router.get('/', async (req, res) => {
  try {
    const settings = await settingsRepository.getAll();
    res.json(settings);
  } catch (err) {
    logger.error('Failed to fetch settings', { error: err.message });
    res.status(500).json({ detail: 'Failed to fetch settings' });
  }
});

// Default values for known settings keys
const SETTING_DEFAULTS = {
  onboarding_complete: false,
  dismissed_recurring_patterns: [],
  app_settings: {
    defaultCurrency: 'EUR',
    dateFormat: 'DD/MM/YYYY',
    numberFormat: 'eu',
    defaultPageSize: 50,
    startOfWeek: 'monday',
    showDecimalPlaces: 2,
    language: 'en',
  },
  dashboard_settings: {
    excludedCategoryIds: [],
    excludedRecipientIds: [],
    excludeHiddenCategories: true,
  },
  theme_settings: {
    theme: 'system',
    accentColor: 'default',
  },
  backup_settings: {
    backupDir: '',
    backupOnQuit: false,
  },
  widget_visibility: {},
};

// GET /api/settings/:key — single setting (returns default if not found)
router.get('/:key', async (req, res) => {
  try {
    const { key } = req.params;
    const value = await settingsRepository.get(key);
    if (value === null) {
      if (key in SETTING_DEFAULTS) {
        return res.json({ key, value: SETTING_DEFAULTS[key] });
      }
      return res.status(404).json({ detail: `Setting '${key}' not found` });
    }
    res.json({ key, value });
  } catch (err) {
    logger.error('Failed to fetch setting', { error: err.message });
    res.status(500).json({ detail: 'Failed to fetch setting' });
  }
});

// PUT /api/settings/:key — upsert single setting
router.put('/:key', async (req, res) => {
  try {
  const { key } = req.params;
  const { value } = req.body;

    if (key.length > 100) {
      return res.status(400).json({ detail: 'Setting key too long (max 100 chars)' });
    }
    if (value === undefined) {
      return res.status(400).json({ detail: 'Missing "value" in request body' });
    }

    // Special-case validation for dashboard_settings key
    if (key === 'dashboard_settings') {
      if (typeof value !== 'object' || Array.isArray(value)) {
        return res.status(400).json({ detail: 'dashboard_settings must be an object' });
      }
      // Validate excludedCategoryIds and excludedRecipientIds
      if (value.excludedCategoryIds !== undefined) {
        const cat = validateIntArray(value.excludedCategoryIds, 'excludedCategoryIds');
        if (!cat.valid) return res.status(400).json({ detail: cat.error });
        // normalize
        value.excludedCategoryIds = cat.value;
      }
      if (value.excludedRecipientIds !== undefined) {
        const rec = validateIntArray(value.excludedRecipientIds, 'excludedRecipientIds');
        if (!rec.valid) return res.status(400).json({ detail: rec.error });
        value.excludedRecipientIds = rec.value;
      }
      if (value.excludeHiddenCategories !== undefined && typeof value.excludeHiddenCategories !== 'boolean') {
        return res.status(400).json({ detail: 'excludeHiddenCategories must be boolean' });
      }
      if (value.exclusionScope !== undefined) {
        const allowed = ['everywhere', 'dashboard', 'statistics'];
        if (!allowed.includes(value.exclusionScope)) return res.status(400).json({ detail: 'Invalid exclusionScope' });
      }
    }

    const result = await settingsRepository.set(key, value);
    res.json(result);
  } catch (err) {
    logger.error('Failed to save setting', { error: err.message });
    res.status(500).json({ detail: 'Failed to save setting' });
  }
});

// PUT /api/settings — bulk upsert
router.put('/', async (req, res) => {
  try {
    const settings = req.body;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return res.status(400).json({ detail: 'Body must be a JSON object of key→value pairs' });
    }

    // Validate keys
    for (const key of Object.keys(settings)) {
      if (key.length > 100) {
        return res.status(400).json({ detail: `Setting key '${key}' too long (max 100 chars)` });
      }
    }

    // Validate known structured keys
    for (const [key, value] of Object.entries(settings)) {
      if (key === 'dashboard_settings') {
        if (typeof value !== 'object' || Array.isArray(value)) {
          return res.status(400).json({ detail: 'dashboard_settings must be an object' });
        }
        if (value.excludedCategoryIds !== undefined) {
          const cat = validateIntArray(value.excludedCategoryIds, 'excludedCategoryIds');
          if (!cat.valid) return res.status(400).json({ detail: cat.error });
          value.excludedCategoryIds = cat.value;
        }
        if (value.excludedRecipientIds !== undefined) {
          const rec = validateIntArray(value.excludedRecipientIds, 'excludedRecipientIds');
          if (!rec.valid) return res.status(400).json({ detail: rec.error });
          value.excludedRecipientIds = rec.value;
        }
      }
    }

    await settingsRepository.setMany(settings);
    res.json({ saved: Object.keys(settings).length });
  } catch (err) {
    logger.error('Failed to bulk save settings', { error: err.message });
    res.status(500).json({ detail: 'Failed to save settings' });
  }
});

// DELETE /api/settings/:key
router.delete('/:key', async (req, res) => {
  try {
    const { key } = req.params;
    const deleted = await settingsRepository.delete(key);
    if (!deleted) {
      return res.status(404).json({ detail: `Setting '${key}' not found` });
    }
    res.json({ deleted: true });
  } catch (err) {
    logger.error('Failed to delete setting', { error: err.message });
    res.status(500).json({ detail: 'Failed to delete setting' });
  }
});

export default router;
