/**
 * Category routes.
 */

import { Router } from "express";
import { z } from "zod";
import categoryService from "../services/categoryService.js";
import {
  listCategoryNodes,
  getCategoryNode,
  createCategoryNode,
  updateCategoryNode,
  deleteCategoryNode,
  mergeCategoryNodes,
} from "../services/categoryService.js";
import { NotFoundError, ValidationError } from "../middleware/errorHandler.js";
import { validateIdParam, assertIdParam } from "../middleware/validation.js";
import { listBody, parseOptionalPagination } from "../lib/pagination.js";
import { withCreateOutcome } from "../lib/createOutcome.js";
import { parseBooleanQueryParam } from "../lib/httpParams.js";
// mv_monthly_summary / mv_category_totals embed the category name and the
// recipient default-category mapping, so category mutations must schedule a
// refresh — otherwise renamed/reassigned categories serve stale until an
// unrelated transaction mutation happens to refresh the views.
import { scheduleRefresh } from "../services/materializedViewService.js";

/**
 * @typedef {import('../types/express.js').ExpressRequest} ExpressRequest
 * @typedef {import('../types/express.js').ExpressResponse} ExpressResponse
 */

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

function parseHierarchy(schema, value) {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ValidationError(
      parsed.error.issues.map((issue) => issue.message).join("; "),
    );
  return parsed.data;
}

// The hierarchy contract is additive. Legacy /categories list, create and CSV
// import retain their general/detail inputs and stable category IDs.
router.get("/tree", async (_req, res) => {
  const items = await listCategoryNodes();
  res.ok({ items, total: items.length });
});

router.post("/tree", async (req, res) => {
  const input = parseHierarchy(hierarchyCreate, req.body);
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
    parseHierarchy(hierarchyUpdate, req.body),
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
  const { targetId } = parseHierarchy(hierarchyMerge, req.body);
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
router.get(
  "/",
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const { general, detail, active = "true", search } = req.query;
    const page = parseOptionalPagination(req.query, { maxLimit: 1000 });
    const opts = {
      ...(page ?? {}),
      general: general || undefined,
      detail: detail || undefined,
      search: search ? String(search).slice(0, 200) : undefined,
      active: parseBooleanQueryParam(active, true),
    };

    const items = await categoryService.getAll(opts);
    const total = page ? await categoryService.getCount(opts) : items.length;

    const enriched = items.map((c) => ({
      ...c,
      /** @type {any[]} */
      links: [],
    }));
    res.ok({ ...listBody(enriched, total, page), links: [] });
  },
);

router.post(
  "/",
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const { general, detail, description } = req.body;
    if (!general || !detail)
      throw new ValidationError("Missing required fields: general, detail");

    const { category, created } = await categoryService.createOrGet({
      general,
      detail,
      description,
    });
    res.status(created ? 201 : 200);
    res.ok(withCreateOutcome(category, created));
  },
);

router.get(
  "/:id",
  validateIdParam,
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const category = await categoryService.getById(assertIdParam(req));
    if (!category)
      throw new NotFoundError(`Category ${req.params.id} not found`);
    res.ok({ ...category, links: [] });
  },
);

router.patch(
  "/:id",
  validateIdParam,
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const id = assertIdParam(req);
    const updated = await categoryService.update(id, req.body);
    if (!updated) throw new NotFoundError(`Category ${id} not found`);
    scheduleRefresh();
    res.ok({ ...updated, links: [] });
  },
);

router.delete(
  "/:id",
  validateIdParam,
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const id = assertIdParam(req);
    const deleted = await categoryService.hardDelete(id);
    if (!deleted) throw new NotFoundError(`Category ${id} not found`);
    scheduleRefresh();
    // Hard delete → 204 No Content (docs/reference/code-patterns.md, "DELETE responses").
    res.status(204).send();
  },
);

router.post(
  "/:id/assign",
  validateIdParam,
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const categoryId = assertIdParam(req);
    let { recipient_ids } = req.body;
    if (!recipient_ids) throw new ValidationError("Missing recipient_ids");
    if (!Array.isArray(recipient_ids)) recipient_ids = [recipient_ids];

    const updated = await categoryService.assignToRecipients(
      categoryId,
      recipient_ids,
    );
    scheduleRefresh();
    res.ok({ updated_recipients: updated, links: [] });
  },
);

export default router;
