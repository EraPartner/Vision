import { z } from "zod";

import {
  IdSchema,
  WireLinkSchema,
  WireTimestampSchema,
  wireCollectionOf,
  wireListOf,
} from "./common.ts";

/**
 * A legacy category row: the route answers `SELECT * FROM categories` plus
 * `category_name` (`enrichCategory`: `path_name`, else `general:detail`) and
 * `links: []`. The hierarchy columns (`parent_id`, `name`, `hierarchy_only`,
 * `legacy_compatible`, `path_name`) arrive because of the `SELECT *`.
 */
const categoryFields = {
  id: IdSchema,
  general: z.string(),
  detail: z.string(),
  description: z.string().nullable(),
  is_active: z.boolean(),
  created_at: WireTimestampSchema.nullable(),
  updated_at: WireTimestampSchema,
  parent_id: IdSchema.nullable(),
  name: z.string(),
  hierarchy_only: z.boolean(),
  legacy_compatible: z.boolean(),
  path_name: z.string(),
  category_name: z.string(),
  links: z.array(WireLinkSchema),
};

/** Fixture contract: the exact `CATEGORY_STUB` body the MSW tests serve. */
export const CategoryItemSchema = z.strictObject(categoryFields);

/** Wire contract for a legacy category row (list and detail reads). */
export const CategorySchema = z.looseObject(categoryFields);

/**
 * `GET /api/categories` — opt-in pagination: `limit`/`offset` only when the
 * request paginated; the body-level `links` is always present.
 */
export const CategoryListSchema = wireListOf(CategorySchema).extend({
  links: z.array(WireLinkSchema),
});

/**
 * `mapNode` in categoryHierarchyRepository: one canonical tree node built from
 * `categories` joined to the `category_paths` view. Every key is always set.
 */
export const CategoryNodeSchema = z.looseObject({
  id: IdSchema,
  name: z.string(),
  parentId: IdSchema.nullable(),
  pathIds: z.array(IdSchema),
  path: z.array(z.string()),
  category_name: z.string(),
  depth: z.number().int().positive(),
  description: z.string().nullable(),
  is_active: z.boolean(),
  hierarchyOnly: z.boolean(),
  legacyCompatible: z.boolean(),
});

/** `GET /api/categories/tree` — `{ items, total }`. */
export const CategoryTreeSchema = wireCollectionOf(CategoryNodeSchema);
