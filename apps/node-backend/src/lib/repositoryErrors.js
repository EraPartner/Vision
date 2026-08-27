/**
 * Build the coded validation error used by repository-owned input checks.
 *
 * @param {string} message
 * @returns {Error & { code?: string }}
 */
export function makeValidationError(message) {
  const error = /** @type {Error & { code?: string }} */ (new Error(message));
  error.code = 'VALIDATION_ERROR';
  return error;
}
