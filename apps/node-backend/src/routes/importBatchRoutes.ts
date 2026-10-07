/**
 * Shared batch-history and rollback route registration for both CSV import
 * pipelines. Pipeline-specific rollback effects stay in callbacks.
 */

import type { Router } from "express";
import { parseBatchIdParam } from "../lib/importBatchIds.ts";
import { parsePagination } from "../lib/pagination.ts";
import { NotFoundError, ValidationError } from "../middleware/errorHandler.ts";

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
    const { limit, offset } = parsePagination(req.query, { maxLimit: 200 });
    const { batches, total } = await listBatches({ limit, offset });
    res.ok({ items: batches, total, limit, offset });
  });

  router.get("/batches/:id", async (req, res) => {
    const id = parseBatchIdParam(req);
    const batch = await getBatch(id);
    if (!batch) throw new NotFoundError(`Import batch ${id} not found`);
    res.ok(batch);
  });

  router.delete("/batches/:id", async (req, res) => {
    const id = parseBatchIdParam(req);
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
