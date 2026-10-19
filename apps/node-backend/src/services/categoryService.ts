/**
 * Category service — the route-facing seam over categoryRepository.
 *
 * Routes must not import repositories directly (eslint
 * vision-local/no-repo-direct-from-route); they go through this service, which
 * is where category name→id resolution and bulk operations belong.
 */
import { checkedRows, db } from "../database/db.ts";
import { categoryKeyRowSchema } from "../database/rowSchemas.ts";
import { ValidationError } from "../middleware/errorHandler.ts";
import type { CategoryId } from "@vision/types/brands";

export { default } from "../repositories/categoryRepository.ts";
export {
  listCategoryNodes,
  getCategoryNode,
  createCategoryNode,
  updateCategoryNode,
  deleteCategoryNode,
  mergeCategoryNodes,
} from "../repositories/categoryHierarchyRepository.ts";

/**
 * Resolve a 'General:Detail' category name to its id.
 *
 * Shared by the transaction and planned-transaction routes — previously each
 * carried its own copy of this lookup and they diverged: the planned route
 * silently dropped an unmatched name, so a typo'd category_name saved with no
 * category and no indication anything was wrong. One resolver, one behavior:
 * a malformed or unmatched name is always a ValidationError.
 *
 * @param name - category name in 'General:Detail' form
 * @returns the category id
 * @throws {ValidationError} on malformed input or when no category matches
 */
export async function resolveCategoryIdByName(
  name: string,
): Promise<CategoryId> {
  const normalized = String(name).toUpperCase().trim();
  const byPath = await checkedRows(
    categoryKeyRowSchema,
    db
      .selectFrom("categories")
      .select("id")
      .where("path_name", "=", normalized)
      .where("is_active", "=", true)
      .orderBy("id")
      .limit(2),
  );
  if (byPath.length > 1)
    throw new ValidationError(
      `Category path '${normalized}' is ambiguous. Select the category by id.`,
    );
  const [pathMatch] = byPath;
  if (pathMatch) return pathMatch.id;

  const delimiter = normalized.indexOf(":");
  if (delimiter < 1) {
    throw new ValidationError(
      `Invalid category name format '${normalized}'. Select a category id or use 'General:Detail'.`,
    );
  }
  const general = normalized.slice(0, delimiter).trim();
  const detail = normalized.slice(delimiter + 1).trim();
  const legacy = await checkedRows(
    categoryKeyRowSchema,
    db
      .selectFrom("categories")
      .select("id")
      .where("general", "=", general)
      .where("detail", "=", detail)
      .where("is_active", "=", true)
      .union(
        db
          .selectFrom("category_merge_aliases as a")
          .innerJoin("categories as c", "c.id", "a.target_category_id")
          .select("c.id")
          .where("a.general", "=", general)
          .where("a.detail", "=", detail)
          .where("c.is_active", "=", true),
      )
      .orderBy("id")
      .limit(2),
  );
  const [legacyMatch] = legacy;
  if (legacy.length !== 1 || !legacyMatch) {
    throw new ValidationError(
      `Category '${normalized}' does not exist. Please create it first or use an existing category.`,
    );
  }
  return legacyMatch.id;
}
