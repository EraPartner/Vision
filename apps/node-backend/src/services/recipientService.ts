/**
 * Recipient service — the route-facing seam over recipientRepository.
 * Routes delegate here instead of importing the repository directly
 * (eslint vision-local/no-repo-direct-from-route).
 */
import { queryOne } from '../database/rowContracts.ts';
import { idRowSchema } from '../database/rows/catalog.ts';
import { ValidationError } from '../middleware/errorHandler.ts';
import { normalizeForMatching } from '../lib/textNormalization.ts';

export { default } from '../repositories/recipientRepository.ts';

/**
 * Resolve a recipient name to its id, matching on normalized_name.
 *
 * Shared by the transaction and planned-transaction routes — previously each
 * carried its own copy of this lookup and they diverged: the planned route
 * silently dropped an unmatched name, so a typo'd recipient_name saved with no
 * recipient and no indication anything was wrong. One resolver, one behavior:
 * an unmatched name is always a ValidationError.
 *
 * @returns the recipient id
 * @throws {ValidationError} when no recipient matches
 */
export async function resolveRecipientIdByName(name: string): Promise<number> {
  const normalized = normalizeForMatching(name);
  const row = await queryOne(
    idRowSchema,
    `SELECT id FROM recipients WHERE normalized_name = $1 LIMIT 1`,
    [normalized],
  );
  if (!row) {
    throw new ValidationError(`Recipient with name '${name}' does not exist`);
  }
  return row.id;
}
