/**
 * Shared SSE plumbing for the import routers (bank-statement and portfolio):
 * the progress → percent mapping and the stream-import handler skeleton.
 * Both pipelines emit the same { phase, current, total, ... } events, so the
 * percent banding (staging 0-40, validating 40-55, matching 55-70, committing
 * 70-100) lives here once instead of per-router.
 */

import { createSseWriter } from './sse.js';
import { cleanup } from './csvUpload.js';
import { ValidationError } from '../middleware/errorHandler.js';
import { logger } from '../config/logger.js';

/**
 * The `{ phase, current, total, ... }` shape both pipelines' `onProgress`
 * callback is invoked with.
 * @typedef {object} ImportProgressEvent
 * @property {'staging'|'validating'|'matching'|'committing'|'complete'|string} phase
 * @property {number} [current]
 * @property {number} [total]
 * @property {number} [imported]
 * @property {number} [duplicates]
 * @property {number} [errors]
 */

/**
 * The pipeline-result shape this shared skeleton reads directly (both
 * runImportPipeline and runPortfolioImportPipeline resolve with a superset of
 * this — see routes/importRoutes.js and routes/portfolioImportRoutes.js
 * `buildComplete` mappers for the rest of each pipeline's own fields, which
 * this module never touches).
 * @typedef {object} StreamImportResult
 * @property {boolean} [requiresReview]
 * @property {number|string} [batchId]
 * @property {any} [matchSourceCounts]
 * @property {number} [errors]
 */

/* eslint-disable vision-local-money/no-raw-money-arithmetic */
/**
 * @param {ImportProgressEvent} ev
 */
export function progressToPercent(ev) {
  const { phase, current = 0, total = 0, imported = 0, duplicates = 0, errors = 0 } = ev;
  const frac = total > 0 ? current / total : 0;
  let percent = 0;
  if (phase === 'staging') percent = Math.round(frac * 40);
  else if (phase === 'validating') percent = 40 + Math.round(frac * 15);
  else if (phase === 'matching') percent = 55 + Math.round(frac * 15);
  else if (phase === 'committing') percent = 70 + Math.round(frac * 30);
  else if (phase === 'complete') percent = 100;
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
 * `import('express').Request/Response` — express ships no type declarations
 * and `@types/express` is not a workspace dependency, so referencing its
 * types resolves to an implicit `any` (TS7016) under `noImplicitAny`. This
 * function only forwards both straight into `createSseWriter`, which is
 * typed the same way (see lib/sse.js).
 *
 * `run`'s resolved value and `buildComplete`'s parameter are typed `any`,
 * not `StreamImportResult`: the two current callers (routes/importRoutes.js,
 * routes/portfolioImportRoutes.js) resolve with genuinely different pipeline
 * result shapes (each has fields — `total`/`autoLinkedCount` vs.
 * `total`/`skipped` — the other doesn't), and a shared skeleton generic over
 * a caller-specific result type is exactly the "different upstream shape per
 * call site" case `any` is for. This function's OWN reads of the result
 * (requiresReview/batchId/matchSourceCounts/errors below) are cast to the
 * precise `StreamImportResult` locally instead, so a typo there still gets
 * caught.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {{
 *   filePath: string,
 *   errorLogMessage: string,
 *   run: (onProgress: (ev: ImportProgressEvent) => Promise<void>) => Promise<any>,
 *   buildComplete: (result: any) => object,
 * }} opts  `run` executes the pipeline; `buildComplete` maps its result to the
 *   `complete` event payload (status/percent are appended here).
 */
export async function streamImport(req, res, { filePath, errorLogMessage, run, buildComplete }) {
  const writer = createSseWriter(req, res);

  try {
    const runResult = await run(async (ev) => { await writer.write('progress', progressToPercent(ev)); });
    /** @type {StreamImportResult} */
    const result = runResult;

    if (result.requiresReview) {
      if (!writer.closed) {
        await writer.write('review_required', {
          batch_id: result.batchId,
          match_source_counts: result.matchSourceCounts,
          percent: 70,
        });
        writer.end();
      }
    } else if (!writer.closed) {
      await writer.write('complete', {
        ...buildComplete(result),
        status: result.errors > 0 ? 'completed_with_errors' : 'completed',
        percent: 100,
      });
      writer.end();
    }
  } catch (err) {
    logger.error(errorLogMessage, { error: err.message });
    if (!writer.closed) {
      const detail = err instanceof ValidationError ? err.message : 'Import failed';
      await writer.write('error', { detail });
      writer.end();
    }
  } finally {
    cleanup(filePath);
  }
}
