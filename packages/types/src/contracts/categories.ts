import { z } from "zod";

import { IdSchema, WireLinkSchema, wireListOf } from "./common.ts";

/** Fixture contract: the exact `CATEGORY_STUB` body the MSW tests serve. */
export const CategoryItemSchema = z.strictObject({
  id: z.number().int().positive(),
  general: z.string(),
  detail: z.string().nullable(),
  description: z.string().nullable(),
  is_active: z.boolean(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
  category_name: z.string(),
  links: z.array(z.unknown()),
});

/**
 * Wire contract for a legacy category row: the route answers `SELECT *` plus
 * `category_name` and `links: []`, so hierarchy columns such as `path_name`
 * arrive as extra keys. Required: `id`, `general`, `detail`, `is_active`.
 */
export const CategorySchema = z.looseObject({
  ...CategoryItemSchema.partial().shape,
  id: CategoryItemSchema.shape.id,
  general: CategoryItemSchema.shape.general,
  detail: CategoryItemSchema.shape.detail,
  is_active: CategoryItemSchema.shape.is_active,
  links: z.array(WireLinkSchema).optional(),
});

/** `GET /api/categories` — opt-in pagination. */
export const CategoryListSchema = wireListOf(CategorySchema);

/**
 * `mapNode` in categoryHierarchyRepository: one canonical tree node. Required:
 * `id`, `path` and `is_active`, which tree rendering and exclusion use.
 */
export const CategoryNodeSchema = z.looseObject({
  id: IdSchema,
  name: z.string().optional(),
  parentId: IdSchema.nullable().optional(),
  pathIds: z.array(IdSchema).optional(),
  path: z.array(z.string()),
  category_name: z.string().optional(),
  depth: z.number().int().positive().optional(),
  description: z.string().nullable().optional(),
  is_active: z.boolean(),
  hierarchyOnly: z.boolean().optional(),
  legacyCompatible: z.boolean().optional(),
});

/** `GET /api/categories/tree` — `{ items, total }`. */
export const CategoryTreeSchema = wireListOf(CategoryNodeSchema);
