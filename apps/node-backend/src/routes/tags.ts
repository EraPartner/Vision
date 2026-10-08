/**
 * Tag routes.
 *
 * GET    /api/tags          — list (filter by ?active=true|false|all)
 * POST   /api/tags          — create or reactivate by slug
 * PATCH  /api/tags/:id      — update color and/or is_active
 * DELETE /api/tags/:id      — soft delete
 *
 * Data access + orchestration live in services/tagService.js — routes never
 * touch the repository layer directly (vision-local/no-repo-direct-from-route).
 */

import { Router } from "express";
import { z } from "zod";
import tagService from "../services/tagService.ts";
import { listBody, parseOptionalPagination } from "../lib/pagination.ts";
import { withCreateOutcome } from "../lib/createOutcome.ts";
import { parseInput } from "../lib/zodInput.ts";
import { activeOrAllQuery, idParams, pageFields } from "./_requestSchemas.ts";

const router = Router();

// `all` is the explicit tags/accounts compatibility mode; it is not an
// API-wide third boolean spelling.
const listQuery = z
  .object({ active: activeOrAllQuery, ...pageFields })
  .transform(({ active, ...page }) => ({
    active,
    page: parseOptionalPagination(page, { maxLimit: 1000 }),
  }));

// tagService keeps the slug rules (required, non-empty after slugify); the
// route pins the JSON types.
const createBody = z.object({
  slug: z.string().optional(),
  color: z.string().nullable().optional(),
});

// A bodiless PATCH is a no-op update, as before.
const updateBody = z
  .object({
    color: z.string().nullable().optional(),
    is_active: z.boolean().nullable().optional(),
  })
  .default({});

// Pagination is opt-in: without limit/offset this still answers the complete
// list (the tag pickers/filters render all of them), so no client is truncated.
router.get("/", async (req, res) => {
  const { active, page } = parseInput(listQuery, req.query);
  const { items, total } = await tagService.list({
    active,
    ...(page ?? {}),
  });
  res.ok({ ...listBody(items, total, page), links: [] });
});

router.post("/", async (req, res) => {
  const body = parseInput(createBody, req.body);
  const { tag, reactivated, wasInactive, junctionCount } =
    await tagService.createOrReactivate(body);

  res.status(reactivated && !wasInactive ? 200 : 201);
  res.ok(
    withCreateOutcome(tag, !reactivated, {
      reactivated,
      reactivated_junction_count:
        reactivated && wasInactive ? junctionCount : undefined,
    }),
  );
});

router.patch("/:id", async (req, res) => {
  const { id } = parseInput(idParams, req.params);
  const updated = await tagService.update(id, parseInput(updateBody, req.body));
  res.ok({ ...updated, links: [] });
});

// Deactivation, not a hard delete: the row survives with is_active = false, so
// this returns the deactivated entity rather than 204 (docs/reference/code-patterns.md,
// "DELETE responses").
router.delete("/:id", async (req, res) => {
  const { id } = parseInput(idParams, req.params);
  const deactivated = await tagService.softDelete(id);
  res.ok({ ...deactivated, links: [] });
});

export default router;
