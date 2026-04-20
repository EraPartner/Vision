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

function getSettingKeyTooLongError(key, includeKeyInMessage) {
  return includeKeyInMessage
    ? `Setting key '${key}' too long (max 100 chars)`
    : 'Setting key too long (max 100 chars)';
}

function validateSettingKeyLength(key, includeKeyInMessage = false) {
  if (key.length > 100) {
    return getSettingKeyTooLongError(key, includeKeyInMessage);
  }
  return null;
}

const ALLOWED_THEME_VARIANTS = ['default', 'dracula', 'solarized', 'nord', 'high-contrast'];
const ALLOWED_THEME_MODES = ['light', 'dark', 'system', 'schedule'];

function validateThemeSettingsValue(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'theme_settings must be an object' };
  }
  if (value.variant !== undefined && !ALLOWED_THEME_VARIANTS.includes(value.variant)) {
    return { ok: false, error: `Invalid theme variant. Allowed: ${ALLOWED_THEME_VARIANTS.join(', ')}` };
  }
  if (value.mode !== undefined && !ALLOWED_THEME_MODES.includes(value.mode)) {
    return { ok: false, error: `Invalid theme mode. Allowed: ${ALLOWED_THEME_MODES.join(', ')}` };
  }
  if (value.schedule !== undefined) {
    const s = value.schedule;
    if (typeof s !== 'object' || s === null || Array.isArray(s)) {
      return { ok: false, error: 'theme_settings.schedule must be an object' };
    }
    const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (s.lightFrom !== undefined && (typeof s.lightFrom !== 'string' || !hhmm.test(s.lightFrom))) {
      return { ok: false, error: 'schedule.lightFrom must be HH:MM' };
    }
    if (s.darkFrom !== undefined && (typeof s.darkFrom !== 'string' || !hhmm.test(s.darkFrom))) {
      return { ok: false, error: 'schedule.darkFrom must be HH:MM' };
    }
  }
  return { ok: true };
}

function normalizeDashboardSettingsValue(value, { validateExcludeHiddenCategories = false, validateExclusionScope = false } = {}) {
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'dashboard_settings must be an object' };
  }

  if (value.excludedCategoryIds !== undefined) {
    const cat = validateIntArray(value.excludedCategoryIds, 'excludedCategoryIds');
    if (!cat.valid) return { ok: false, error: cat.error };
    value.excludedCategoryIds = cat.value;
  }

  if (value.excludedRecipientIds !== undefined) {
    const rec = validateIntArray(value.excludedRecipientIds, 'excludedRecipientIds');
    if (!rec.valid) return { ok: false, error: rec.error };
    value.excludedRecipientIds = rec.value;
  }

  if (validateExcludeHiddenCategories
    && value.excludeHiddenCategories !== undefined
    && typeof value.excludeHiddenCategories !== 'boolean') {
    return { ok: false, error: 'excludeHiddenCategories must be boolean' };
  }

  if (validateExclusionScope && value.exclusionScope !== undefined) {
    const allowed = ['everywhere', 'dashboard', 'statistics'];
    if (!allowed.includes(value.exclusionScope)) return { ok: false, error: 'Invalid exclusionScope' };
  }

  return { ok: true };
}

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
    mode: 'system',
    schedule: { lightFrom: '07:00', darkFrom: '20:00' },
    variant: 'default',
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

    const keyLengthError = validateSettingKeyLength(key);
    if (keyLengthError) {
      return res.status(400).json({ detail: keyLengthError });
    }
    if (value === undefined) {
      return res.status(400).json({ detail: 'Missing "value" in request body' });
    }

    // Special-case validation for dashboard_settings key
    if (key === 'dashboard_settings') {
      const validatedDashboardSettings = normalizeDashboardSettingsValue(value, {
        validateExcludeHiddenCategories: true,
        validateExclusionScope: true,
      });
      if (!validatedDashboardSettings.ok) {
        return res.status(400).json({ detail: validatedDashboardSettings.error });
      }
    }

    if (key === 'theme_settings') {
      const validatedTheme = validateThemeSettingsValue(value);
      if (!validatedTheme.ok) {
        return res.status(400).json({ detail: validatedTheme.error });
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
      const keyLengthError = validateSettingKeyLength(key, true);
      if (keyLengthError) {
        return res.status(400).json({ detail: keyLengthError });
      }
    }

    // Validate known structured keys
    for (const [key, value] of Object.entries(settings)) {
      if (key === 'dashboard_settings') {
        const validatedDashboardSettings = normalizeDashboardSettingsValue(value);
        if (!validatedDashboardSettings.ok) {
          return res.status(400).json({ detail: validatedDashboardSettings.error });
        }
      }
      if (key === 'theme_settings') {
        const validatedTheme = validateThemeSettingsValue(value);
        if (!validatedTheme.ok) {
          return res.status(400).json({ detail: validatedTheme.error });
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
