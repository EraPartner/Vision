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
import settingsRepository from '../services/settingsService.js';
import { validateIntArray } from '../middleware/validation.js';
import { NotFoundError, ValidationError } from '../middleware/errorHandler.js';

const router = Router();

const ALLOWED_COST_BASIS_METHODS = ['weighted_avg', 'fifo', 'lifo'];
const ALLOWED_THEME_VARIANTS = ['default', 'dracula', 'solarized', 'nord', 'high-contrast'];
const ALLOWED_THEME_MODES = ['light', 'dark', 'system', 'schedule'];
const ALLOWED_EXCLUSION_SCOPES = ['everywhere', 'dashboard', 'statistics'];

function assertSettingKeyLength(key, includeKeyInMessage = false) {
  if (key.length > 100) {
    const msg = includeKeyInMessage
      ? `Setting key '${key}' too long (max 100 chars)`
      : 'Setting key too long (max 100 chars)';
    throw new ValidationError(msg);
  }
}

function assertThemeSettingsValue(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('theme_settings must be an object');
  }
  if (value.variant !== undefined && !ALLOWED_THEME_VARIANTS.includes(value.variant)) {
    throw new ValidationError(`Invalid theme variant. Allowed: ${ALLOWED_THEME_VARIANTS.join(', ')}`);
  }
  if (value.mode !== undefined && !ALLOWED_THEME_MODES.includes(value.mode)) {
    throw new ValidationError(`Invalid theme mode. Allowed: ${ALLOWED_THEME_MODES.join(', ')}`);
  }
  if (value.schedule !== undefined) {
    const s = value.schedule;
    if (typeof s !== 'object' || s === null || Array.isArray(s)) {
      throw new ValidationError('theme_settings.schedule must be an object');
    }
    const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (s.lightFrom !== undefined && (typeof s.lightFrom !== 'string' || !hhmm.test(s.lightFrom))) {
      throw new ValidationError('schedule.lightFrom must be HH:MM');
    }
    if (s.darkFrom !== undefined && (typeof s.darkFrom !== 'string' || !hhmm.test(s.darkFrom))) {
      throw new ValidationError('schedule.darkFrom must be HH:MM');
    }
  }
}

function assertDashboardSettingsValue(value, { validateExcludeHiddenCategories = false, validateExclusionScope = false } = {}) {
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('dashboard_settings must be an object');
  }

  if (value.excludedCategoryIds !== undefined) {
    const cat = validateIntArray(value.excludedCategoryIds, 'excludedCategoryIds');
    if (!cat.valid) throw new ValidationError(cat.error);
    value.excludedCategoryIds = cat.value;
  }

  if (value.excludedRecipientIds !== undefined) {
    const rec = validateIntArray(value.excludedRecipientIds, 'excludedRecipientIds');
    if (!rec.valid) throw new ValidationError(rec.error);
    value.excludedRecipientIds = rec.value;
  }

  if (validateExcludeHiddenCategories
    && value.excludeHiddenCategories !== undefined
    && typeof value.excludeHiddenCategories !== 'boolean') {
    throw new ValidationError('excludeHiddenCategories must be boolean');
  }

  if (validateExclusionScope && value.exclusionScope !== undefined
    && !ALLOWED_EXCLUSION_SCOPES.includes(value.exclusionScope)) {
    throw new ValidationError('Invalid exclusionScope');
  }
}

// Saved cash-aware rebalancing plans (ADR-098): a list of user-defined target
// allocations the rebalance page deploys spendable cash toward. Stored here (not
// a dedicated table) since they are small, per-install config — same key-value
// store as the other settings.
const MAX_REBALANCE_PLANS = 50;
function assertRebalancePlansValue(value) {
  if (!Array.isArray(value)) {
    throw new ValidationError('rebalance_plans must be an array');
  }
  if (value.length > MAX_REBALANCE_PLANS) {
    throw new ValidationError(`rebalance_plans may contain at most ${MAX_REBALANCE_PLANS} plans`);
  }
  for (const plan of value) {
    if (typeof plan !== 'object' || plan === null || Array.isArray(plan)) {
      throw new ValidationError('each rebalance plan must be an object');
    }
    if (typeof plan.id !== 'string' || plan.id.length === 0 || plan.id.length > 100) {
      throw new ValidationError('rebalance plan id must be a non-empty string (max 100 chars)');
    }
    if (typeof plan.name !== 'string' || plan.name.trim().length === 0 || plan.name.length > 80) {
      throw new ValidationError('rebalance plan name must be a string of 1-80 chars');
    }
    const weights = plan.targetWeights;
    if (typeof weights !== 'object' || weights === null || Array.isArray(weights)) {
      throw new ValidationError('rebalance plan targetWeights must be an object');
    }
    const keys = Object.keys(weights);
    if (keys.length === 0) {
      throw new ValidationError('rebalance plan targetWeights must have at least one sleeve');
    }
    for (const [sleeve, weight] of Object.entries(weights)) {
      const n = Number(weight);
      if (!Number.isFinite(n) || n < 0) {
        throw new ValidationError(`rebalance plan targetWeights.${sleeve} must be a non-negative number`);
      }
    }
    if (plan.cashCap !== undefined) {
      const cap = Number(plan.cashCap);
      if (!Number.isFinite(cap) || cap < 0) {
        throw new ValidationError('rebalance plan cashCap must be a non-negative number');
      }
    }
  }
}

router.get('/', async (req, res) => {
  const settings = await settingsRepository.getAll();
  res.ok(settings);
});

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
    autoClearPlannedOnMatch: true,
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
  cost_basis_method: 'weighted_avg',
  rebalance_plans: [],
};

router.get('/:key', async (req, res) => {
  const { key } = req.params;
  const value = await settingsRepository.get(key);
  if (value === null) {
    if (key in SETTING_DEFAULTS) {
      res.ok({ key, value: SETTING_DEFAULTS[key] });
      return;
    }
    throw new NotFoundError(`Setting '${key}' not found`);
  }
  res.ok({ key, value });
});

// Per-key value validation shared by the single-key and bulk handlers so the
// bulk endpoint can't bypass the rules the single-key endpoint enforces.
function validateSettingValue(key, value) {
  if (key === 'dashboard_settings') {
    assertDashboardSettingsValue(value, {
      validateExcludeHiddenCategories: true,
      validateExclusionScope: true,
    });
  }
  if (key === 'theme_settings') assertThemeSettingsValue(value);
  if (key === 'cost_basis_method') {
    if (!ALLOWED_COST_BASIS_METHODS.includes(value)) {
      throw new ValidationError(`Invalid cost_basis_method. Allowed: ${ALLOWED_COST_BASIS_METHODS.join(', ')}`);
    }
  }
  if (key === 'includeTransfers' && typeof value !== 'boolean') {
    throw new ValidationError('includeTransfers must be a boolean');
  }
  if (key === 'rebalance_plans') assertRebalancePlansValue(value);
}

router.put('/:key', async (req, res) => {
  const { key } = req.params;
  const { value } = req.body;

  assertSettingKeyLength(key);
  if (value === undefined) throw new ValidationError('Missing "value" in request body');

  validateSettingValue(key, value);

  const result = await settingsRepository.set(key, value);
  res.ok(result);
});

router.put('/', async (req, res) => {
  const settings = req.body;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new ValidationError('Body must be a JSON object of key→value pairs');
  }

  for (const key of Object.keys(settings)) assertSettingKeyLength(key, true);

  for (const [key, value] of Object.entries(settings)) {
    validateSettingValue(key, value);
  }

  await settingsRepository.setMany(settings);
  res.ok({ saved: Object.keys(settings).length });
});

router.delete('/:key', async (req, res) => {
  const { key } = req.params;
  const deleted = await settingsRepository.delete(key);
  if (!deleted) throw new NotFoundError(`Setting '${key}' not found`);
  res.ok({ deleted: true });
});

export default router;
