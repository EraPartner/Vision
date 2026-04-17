/**
 * Back-compat shim — canonical module is services/calculations/recurrence.js.
 * Kept so existing `services/recurrenceService.js` imports continue to work.
 * Remove once all callers switch to the new path.
 */
export {
  calculateNextDate,
  isValidPattern,
  getSupportedPatterns,
} from './calculations/recurrence.js';
