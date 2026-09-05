/**
 * Category service — the route-facing seam over categoryRepository.
 *
 * Routes must not import repositories directly (eslint
 * vision-local/no-repo-direct-from-route); they go through this service, which
 * is where category name→id resolution and bulk operations belong.
 */
import { query } from "../database/connection.js";
import { ValidationError } from "../middleware/errorHandler.js";

export { default } from "../repositories/categoryRepository.js";

/**
 * Resolve a 'General:Detail' category name to its id.
 *
 * Shared by the transaction and planned-transaction routes — previously each
 * carried its own copy of this lookup and they diverged: the planned route
 * silently dropped an unmatched name, so a typo'd category_name saved with no
 * category and no indication anything was wrong. One resolver, one behavior:
 * a malformed or unmatched name is always a ValidationError.
 *
 * @param {string} name - category name in 'General:Detail' form
 * @returns {Promise<number>} the category id
 * @throws {ValidationError} on malformed input or when no category matches
 */
export async function resolveCategoryIdByName(name) {
  const normalized = String(name).toUpperCase().trim();
  if (!normalized.includes(":")) {
    throw new ValidationError(
      `Invalid category name format '${normalized}'. Expected format: 'General:Detail' (e.g., 'FOOD:BEVERAGES')`,
    );
  }
  const [general, detail] = normalized.split(":", 2).map((s) => s.trim());
  const result = await query(
    `SELECT id FROM categories
      WHERE general = $1 AND detail = $2 AND is_active = true
      LIMIT 1`,
    [general, detail],
  );
  if (result.rows.length === 0) {
    throw new ValidationError(
      `Category '${normalized}' does not exist. Please create it first or use an existing category.`,
    );
  }
  return result.rows[0].id;
}
