/**
 * Shared batch-history and rollback route registration for both CSV import
 * pipelines. Pipeline-specific rollback effects stay in callbacks.
 */

import type { Router } from "express";
import { z } from "zod";
import { coercedIdSchema } from "../lib/importBatchIds.ts";
import { parsePagination } from "../lib/pagination.ts";
import { parseInput } from "../lib/zodInput.ts";
import { NotFoundError, ValidationError } from "../middleware/errorHandler.ts";
import { optionalValue, pageFields } from "./_requestSchemas.ts";

const batchListQuery = z
  .object(pageFields)
  .transform((query) => parsePagination(query, { maxLimit: 200 }));

// Batch ids are BIGSERIAL, so they use the import routers' MAX_SAFE_ID-bounded
// id schema. Root issue: both pipelines answer every bad batch id with the
// same "Invalid batch id" message (lib/importBatchIds.ts).
const batchIdParams = z
  .object({ id: optionalValue })
  .transform((params, ctx) => {
    const result = coercedIdSchema.safeParse(params.id);
    if (result.success) return result.data;
    ctx.addIssue({ code: "custom", message: "Invalid batch id" });
    return z.NEVER;
  });

interface ImportBatchRouteOptions {
  listBatches: (page: {
    limit: number;
    offset: number;
  }) => Promise<{ batches: unknown[]; total: number }>;
  getBatch: (id: number) => Promise<{ status: string } | null | undefined>;
  inProgressStatuses: string[];
  rollback: (id: number) => Promise<Record<string, unknown>>;
}

// `typeof Router`, not `import type { Router }`: the legacy checkJs program
// resolves `express` to an untyped shim that has no type exports.
export function registerImportBatchRoutes(
  router: ReturnType<typeof Router>,
  options: ImportBatchRouteOptions,
) {
  const { listBatches, getBatch, inProgressStatuses, rollback } = options;

  router.get("/batches", async (req, res) => {
    const { limit, offset } = parseInput(batchListQuery, req.query);
    const { batches, total } = await listBatches({ limit, offset });
    res.ok({ items: batches, total, limit, offset });
  });

  router.get("/batches/:id", async (req, res) => {
    const id = parseInput(batchIdParams, req.params);
    const batch = await getBatch(id);
    if (!batch) throw new NotFoundError(`Import batch ${id} not found`);
    res.ok(batch);
  });

  router.delete("/batches/:id", async (req, res) => {
    const id = parseInput(batchIdParams, req.params);
    const batch = await getBatch(id);
    if (!batch) throw new NotFoundError(`Import batch ${id} not found`);
    if (batch.status === "aborted")
      throw new ValidationError("Batch is already aborted");
    if (inProgressStatuses.includes(batch.status)) {
      throw new ValidationError(
        "Cannot rollback a batch that is still in progress",
      );
    }

    res.ok(await rollback(id));
  });
}
