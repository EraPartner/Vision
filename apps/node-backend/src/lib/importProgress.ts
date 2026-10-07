/**
 * Shared SSE plumbing for the import routers (bank-statement and portfolio):
 * the progress → percent mapping and the stream-import handler skeleton.
 * Both pipelines emit the same { phase, current, total, ... } events, so the
 * percent banding (staging 0-40, validating 40-55, matching 55-70, committing
 * 70-100) lives here once instead of per-router.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createSseWriter } from "./sse.ts";
import { cleanup } from "./csvUpload.ts";
import { ValidationError } from "../middleware/errorHandler.ts";
import { logger } from "../config/logger.ts";
import { ApiErrorCode } from "@vision/types/errors";

/**
 * The `{ phase, current, total, ... }` shape both pipelines' `onProgress`
 * callback is invoked with.
 */
export interface ImportProgressEvent {
  phase: 'staging'|'validating'|'matching'|'committing'|'complete'|string;
  current?: number;
  total?: number;
  imported?: number;
  duplicates?: number;
  errors?: number;
}

/**
 * The pipeline-result shape this shared skeleton reads directly (both
 * runImportPipeline and runPortfolioImportPipeline resolve with a superset of
 * this — see routes/importRoutes.js and routes/portfolioImportRoutes.js
 * `buildComplete` mappers for the rest of each pipeline's own fields, which
 * this module never touches).
 */
export interface StreamImportResult {
  requiresReview?: boolean;
  batchId?: number|string;
  matchSourceCounts?: unknown;
  skipped?: number;
  errors?: number;
}

/* eslint-disable vision-local-money/no-raw-money-arithmetic */
export function progressToPercent(ev: ImportProgressEvent) {
  const {
    phase,
    current = 0,
    total = 0,
    imported = 0,
    duplicates = 0,
    errors = 0,
  } = ev;
  const frac = total > 0 ? current / total : 0;
  let percent = 0;
  if (phase === "staging") percent = Math.round(frac * 40);
  else if (phase === "validating") percent = 40 + Math.round(frac * 15);
  else if (phase === "matching") percent = 55 + Math.round(frac * 15);
  else if (phase === "committing") percent = 70 + Math.round(frac * 30);
  else if (phase === "complete") percent = 100;
  return { phase, current, total, imported, duplicates, errors, percent };
}
/* eslint-enable vision-local-money/no-raw-money-arithmetic */

/**
 * Shared SSE stream-import handler skeleton for POST …/csv/stream.
 *
 * Commits the SSE headers (via createSseWriter), runs the pipeline with
 * progress events mapped through progressToPercent, then emits either a
 * `review_required` or `complete` terminal event. Failures emit an `error`
 * event: expected validation failures (zero-row batch, bad config) carry a
 * safe, actionable message; anything else stays generic to avoid leaking
 * internals. Always cleans up the uploaded file.
 *
 * `req`/`res` are typed via `node:http`'s base classes rather than
 * `import('express').Request/Response` — the legacy checkJs program resolves
 * `express` to the ambient `any` shim in thirdPartyModules.d.ts. This
 * function only forwards both straight into `createSseWriter`, which is
 * typed the same way (see lib/sse.ts).
 *
 * The skeleton is generic over the pipeline result `R`: the two current
 * callers (routes/importRoutes.js, routes/portfolioImportRoutes.js) resolve
 * with genuinely different pipeline result shapes (each has fields —
 * `total`/`autoLinkedCount` vs. `total`/`skipped` — the other doesn't), so
 * `buildComplete` sees the caller's own type while this function's reads stay
 * limited to the shared `StreamImportResult` slice.
 *
 * @param opts.run executes the pipeline.
 * @param opts.buildComplete maps its result to the `complete` event payload
 *   (status/percent are appended here).
 */
export async function streamImport<R extends StreamImportResult>(
  req: IncomingMessage,
  res: ServerResponse,
  {
    filePath,
    errorLogMessage,
    run,
    buildComplete,
  }: {
    filePath: string;
    errorLogMessage: string;
    run: (onProgress: (ev: ImportProgressEvent) => Promise<void>) => Promise<R>;
    buildComplete: (result: R) => object;
  },
) {
  const writer = createSseWriter(req, res);

  try {
    const result = await run(async (ev) => {
      await writer.write("progress", progressToPercent(ev));
    });

    if (result.requiresReview) {
      if (!writer.closed) {
        await writer.write("review_required", {
          batch_id: result.batchId,
          match_source_counts: result.matchSourceCounts,
          skipped: result.skipped,
          percent: 70,
        });
        writer.end();
      }
    } else if (!writer.closed) {
      await writer.write("complete", {
        ...buildComplete(result),
        status: (result.errors ?? 0) > 0 ? "completed_with_errors" : "completed",
        percent: 100,
      });
      writer.end();
    }
  } catch (err) {
    logger.error(errorLogMessage, { error: (err as Error).message });
    if (!writer.closed) {
      const expected = err instanceof ValidationError;
      const detail = expected ? err.message : "Import failed";
      const code = expected ? err.code : ApiErrorCode.INTERNAL_SERVER_ERROR;
      await writer.write("error", { detail, code });
      writer.end();
    }
  } finally {
    cleanup(filePath);
  }
}
