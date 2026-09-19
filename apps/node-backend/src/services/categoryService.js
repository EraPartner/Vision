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
export {
  listCategoryNodes,
  getCategoryNode,
  createCategoryNode,
  updateCategoryNode,
  deleteCategoryNode,
  mergeCategoryNodes,
} from "../repositories/categoryHierarchyRepository.js";

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
  const result = await query(
    `SELECT id FROM categories
     WHERE path_name = $1 AND is_active = true
     ORDER BY id LIMIT 2`,
    [normalized],
  );
  if (result.rows.length > 1)
    throw new ValidationError(
      `Category path '${normalized}' is ambiguous. Select the category by id.`,
    );
  if (result.rows.length === 1) return result.rows[0].id;

  const delimiter = normalized.indexOf(":");
  if (delimiter < 1) {
    throw new ValidationError(
      `Invalid category name format '${normalized}'. Select a category id or use 'General:Detail'.`,
    );
  }
  const general = normalized.slice(0, delimiter).trim();
  const detail = normalized.slice(delimiter + 1).trim();
  const legacy = await query(
    `SELECT id FROM categories
     WHERE general = $1 AND detail = $2 AND is_active = true
     UNION
     SELECT c.id FROM category_merge_aliases a
     JOIN categories c ON c.id = a.target_category_id
     WHERE a.general = $1 AND a.detail = $2 AND c.is_active = true
     ORDER BY id LIMIT 2`,
    [general, detail],
  );
  if (legacy.rows.length !== 1) {
    throw new ValidationError(
      `Category '${normalized}' does not exist. Please create it first or use an existing category.`,
    );
  }
  return legacy.rows[0].id;
}
