/**
 * Feature Flag Service — business logic for runtime-toggleable feature flags.
 *
 * Provides a thin layer over featureFlagRepository with input validation and
 * typed errors.  Routes and middleware should use this service, not the
 * repository directly.
 */

import featureFlagRepository from '../repositories/featureFlagRepository.js';
import { AppError, NotFoundError, ValidationError } from '../middleware/errorHandler.js';
import { logger } from '../config/logger.js';

/**
 * List all feature flags.
 * @returns {Promise<import('../repositories/featureFlagRepository.js').FeatureFlag[]>}
 */
async function listFeatureFlags() {
  return featureFlagRepository.listAll();
}

/**
 * Get a single feature flag by key.
 * @param {string} key
 * @returns {Promise<import('../repositories/featureFlagRepository.js').FeatureFlag>}
 */
async function getFeatureFlag(key) {
  const flag = await featureFlagRepository.findByKey(key);
  if (!flag) {
    throw new NotFoundError(`Feature flag '${key}' not found`);
  }
  return flag;
}

/**
 * Check whether a feature flag is enabled. Returns false for unknown keys.
 * This is the safe runtime check — does not throw on missing flags.
 * @param {string} key
 * @returns {Promise<boolean>}
 */
async function isFeatureEnabled(key) {
  return featureFlagRepository.isEnabled(key);
}

/**
 * Toggle (or set) a feature flag.
 * @param {string} key
 * @param {boolean} enabled
 * @returns {Promise<import('../repositories/featureFlagRepository.js').FeatureFlag>}
 */
async function setFeatureFlag(key, enabled) {
  if (typeof enabled !== 'boolean') {
    throw new ValidationError('enabled must be a boolean', {
      field: 'enabled',
    });
  }

  // Verify flag exists before updating
  const existing = await featureFlagRepository.findByKey(key);
  if (!existing) {
    throw new NotFoundError(`Feature flag '${key}' not found`);
  }

  const updated = await featureFlagRepository.setEnabled(key, enabled);
  if (!updated) {
    throw new AppError(`Failed to update feature flag '${key}'`, { status: 500 });
  }

  logger.info('Feature flag updated', { key, enabled });
  return updated;
}

export { listFeatureFlags, getFeatureFlag, isFeatureEnabled, setFeatureFlag };
