/**
 * Recipient service — the route-facing seam over recipientRepository.
 * Routes delegate here instead of importing the repository directly
 * (eslint vision-local/no-repo-direct-from-route).
 */
import { query } from '../database/connection.js';
import { ValidationError } from '../middleware/errorHandler.js';
import { normalizeForMatching } from '../lib/textNormalization.js';

export { default } from '../repositories/recipientRepository.js';

/**
 * Resolve a recipient name to its id, matching on normalized_name.
 *
 * Shared by the transaction and planned-transaction routes — previously each
 * carried its own copy of this lookup and they diverged: the planned route
 * silently dropped an unmatched name, so a typo'd recipient_name saved with no
 * recipient and no indication anything was wrong. One resolver, one behavior:
 * an unmatched name is always a ValidationError.
 *
 * @param {string} name
 * @returns {Promise<number>} the recipient id
 * @throws {ValidationError} when no recipient matches
 */
export async function resolveRecipientIdByName(name) {
  const normalized = normalizeForMatching(name);
  const result = await query(
    `SELECT id FROM recipients WHERE normalized_name = $1 LIMIT 1`,
    [normalized],
  );
  if (result.rows.length === 0) {
    throw new ValidationError(`Recipient with name '${name}' does not exist`);
  }
  return result.rows[0].id;
}
