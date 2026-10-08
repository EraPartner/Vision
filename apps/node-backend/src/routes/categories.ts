/**
 * Category routes.
 */

import { Router } from "express";
import { z } from "zod";
import categoryService from "../services/categoryService.ts";
import {
  listCategoryNodes,
  getCategoryNode,
  createCategoryNode,
  updateCategoryNode,
  deleteCategoryNode,
  mergeCategoryNodes,
} from "../services/categoryService.ts";
import { NotFoundError } from "../middleware/errorHandler.ts";
import {
  validateIdParam,
  assertIdParam,
  validateIntArray,
} from "../middleware/validation.ts";
import { parseInput } from "../lib/zodInput.ts";
import { listBody, parseOptionalPagination } from "../lib/pagination.ts";
import { withCreateOutcome } from "../lib/createOutcome.ts";
import {
  optionalQueryString,
  parseBooleanQueryParam,
} from "../lib/httpParams.ts";
// mv_monthly_summary / mv_category_totals embed the category name and the
// recipient default-category mapping, so category mutations must schedule a
// refresh — otherwise renamed/reassigned categories serve stale until an
// unrelated transaction mutation happens to refresh the views.
import { scheduleRefresh } from "../services/materializedViewService.ts";

const router = Router();

const hierarchyName = z.string().trim().min(1).max(100);
const hierarchyCreate = z.strictObject({
  name: hierarchyName,
  parentId: z.number().int().positive().nullable().default(null),
  description: z.string().max(500).nullable().optional(),
});
const hierarchyUpdate = z.strictObject({
  name: hierarchyName.optional(),
  parentId: z.number().int().positive().nullable().optional(),
  description: z.string().max(500).nullable().optional(),
  is_active: z.boolean().optional(),
});
const hierarchyMerge = z.strictObject({
  targetId: z.number().int().positive(),
});

// Legacy flat-category bodies. The repository upper-cases general/detail, so a
// non-string used to fail there as a TypeError 500. Presence checks run on the
// whole body so their messages stay unprefixed, as before.
const legacyCreate = z
  .object({
    general: z.string().optional(),
    detail: z.string().optional(),
    description: z.string().nullable().optional(),
  })
  .transform(({ general, detail, description }, ctx) => {
    if (!general || !detail) {
      ctx.addIssue({
        code: "custom",
        message: "Missing required fields: general, detail",
      });
      return z.NEVER;
    }
    return { general, detail, description };
  });
// null general/detail/is_active mean "leave unchanged" in the repository.
const legacyUpdate = z.object({
  general: z.string().nullable().optional(),
  detail: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  is_active: z.boolean().nullable().optional(),
});
// A scalar is wrapped into a one-element list; ids follow validateId, so junk
// no longer reaches the int[] cast as a 500.
const assignBody = z
  .object({ recipient_ids: z.unknown().optional() })
  .transform(({ recipient_ids }, ctx) => {
    if (!recipient_ids) {
      ctx.addIssue({ code: "custom", message: "Missing recipient_ids" });
      return z.NEVER;
    }
    const result = validateIntArray(recipient_ids, "recipient_ids");
    if (!result.valid) {
      ctx.addIssue({ code: "custom", message: result.error });
      return z.NEVER;
    }
    return result.value;
  });

// The hierarchy contract is additive. Legacy /categories list, create and CSV
// import retain their general/detail inputs and stable category IDs.
router.get("/tree", async (_req, res) => {
  const items = await listCategoryNodes();
  res.ok({ items, total: items.length });
});

router.post("/tree", async (req, res) => {
  const input = parseInput(hierarchyCreate, req.body);
  const node = await createCategoryNode(input);
  scheduleRefresh();
  res.status(201);
  res.ok(node);
});

router.get("/tree/:id", validateIdParam, async (req, res) => {
  const node = await getCategoryNode(assertIdParam(req));
  if (!node) throw new NotFoundError(`Category ${req.params.id} not found`);
  res.ok(node);
});

router.patch("/tree/:id", validateIdParam, async (req, res) => {
  const node = await updateCategoryNode(
    assertIdParam(req),
    parseInput(hierarchyUpdate, req.body),
  );
  if (!node) throw new NotFoundError(`Category ${req.params.id} not found`);
  scheduleRefresh();
  res.ok(node);
});

router.delete("/tree/:id", validateIdParam, async (req, res) => {
  if (!(await deleteCategoryNode(assertIdParam(req))))
    throw new NotFoundError(`Category ${req.params.id} not found`);
  scheduleRefresh();
  res.status(204).send();
});

router.post("/tree/:id/merge", validateIdParam, async (req, res) => {
  const sourceId = assertIdParam(req);
  const { targetId } = parseInput(hierarchyMerge, req.body);
  const node = await mergeCategoryNodes(sourceId, targetId);
  if (!node) throw new NotFoundError("Source or target category not found");
  scheduleRefresh();
  res.ok(node);
});

// Pagination is opt-in: without limit/offset this still answers the complete
// list (category pickers/pages render all of them), so no client is truncated.
// When unpaginated, `total` is just the row count and the extra COUNT
// round-trip is skipped; a supplied limit/offset pages the rows while `total`
// stays the full match count.
router.get("/", async (req, res) => {
  const { active = "true" } = req.query;
  const general = optionalQueryString(req.query, "general");
  const detail = optionalQueryString(req.query, "detail");
  const search = optionalQueryString(req.query, "search");
  const page = parseOptionalPagination(req.query, { maxLimit: 1000 });
  const opts = {
    ...(page ?? {}),
    general: general || undefined,
    detail: detail || undefined,
    search: search ? search.slice(0, 200) : undefined,
    active: parseBooleanQueryParam(active, true),
  };

  const items = await categoryService.getAll(opts);
  const total = page ? await categoryService.getCount(opts) : items.length;

  const enriched = items.map((c) => ({
    ...c,
    links: [],
  }));
  res.ok({ ...listBody(enriched, total, page), links: [] });
});

router.post("/", async (req, res) => {
  const { general, detail, description } = parseInput(
    legacyCreate,
    req.body ?? {},
  );
  const { category, created } = await categoryService.createOrGet({
    general,
    detail,
    description,
  });
  res.status(created ? 201 : 200);
  res.ok(withCreateOutcome(category ?? {}, created));
});

router.get("/:id", validateIdParam, async (req, res) => {
  const category = await categoryService.getById(assertIdParam(req));
  if (!category) throw new NotFoundError(`Category ${req.params.id} not found`);
  res.ok({ ...category, links: [] });
});

router.patch("/:id", validateIdParam, async (req, res) => {
  const id = assertIdParam(req);
  const updated = await categoryService.update(
    id,
    parseInput(legacyUpdate, req.body),
  );
  if (!updated) throw new NotFoundError(`Category ${id} not found`);
  scheduleRefresh();
  res.ok({ ...updated, links: [] });
});

router.delete("/:id", validateIdParam, async (req, res) => {
  const id = assertIdParam(req);
  const deleted = await categoryService.hardDelete(id);
  if (!deleted) throw new NotFoundError(`Category ${id} not found`);
  scheduleRefresh();
  // Hard delete → 204 No Content (docs/reference/code-patterns.md, "DELETE responses").
  res.status(204).send();
});

router.post("/:id/assign", validateIdParam, async (req, res) => {
  const categoryId = assertIdParam(req);
  const recipientIds = parseInput(assignBody, req.body ?? {});
  const updated = await categoryService.assignToRecipients(
    categoryId,
    recipientIds,
  );
  scheduleRefresh();
  res.ok({ updated_recipients: updated, links: [] });
});

export default router;
