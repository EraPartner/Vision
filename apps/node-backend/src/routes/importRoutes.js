/**
 * Import routes - Full CSV import with bank adapters.
 *
 * Request parsing is validated with zod (schema → safeParse → ValidationError),
 * the idiom established in settings.js/reports.js. Batch/row route ids share
 * one coerced schema with the portfolio import router (lib/importBatchIds.js).
 * The CSV option/config schemas coerce multipart string fields exactly like the
 * pre-zod hand-rolled parsing (String()/parseInt fallbacks, trims, defaults).
 */

/// <reference path="../types/thirdPartyModules.d.ts" />
import { Router } from "express";
import { z } from "zod";
import {
  importRecipientsCSV,
  importCategoriesCSV,
} from "../services/dataImportService.js";
import {
  parseBatchIdParam,
  parseBatchRowIdParams,
  parseOverrideId,
} from "../lib/importBatchIds.js";
import { logger } from "../config/logger.js";
import {
  runImportPipeline,
  commitImport,
} from "../services/importPipeline/index.js";
import { ValidationError, NotFoundError } from "../middleware/errorHandler.js";
import {
  csvUpload,
  cleanup,
  csvUploadErrorTranslator,
} from "../lib/csvUpload.js";
import { streamImport } from "../lib/importProgress.js";
import { bodyFirstParam } from "../lib/httpParams.js";
import {
  listBatches,
  getBatch,
  rollbackBatch,
  getImportBatchPreview,
  overrideRecipient,
  overrideCategory,
  categoryExists,
} from "../services/importBatchService.js";
import {
  clearForecastMcCaches,
  scheduleMaterializedViewRefresh,
} from "../services/aggregationRefresh.js";
import { registerParserRoutes } from "./parserConfigRoutes.js";
import { registerImportBatchRoutes } from "./importBatchRoutes.js";

/**
 * @typedef {import('../types/express.js').ExpressRequest} ExpressRequest
 * @typedef {import('../types/express.js').ExpressResponse} ExpressResponse
 */

/**
 * The shape `runImportPipeline` resolves with (services/importPipeline/index.js).
 * @typedef {object} ImportPipelineResult
 * @property {import('../services/importPipeline/index.js').ImportBatchId} batchId
 * @property {number} total
 * @property {boolean} requiresReview
 * @property {number} [imported]
 * @property {number} [duplicates]
 * @property {number} [errors]
 * @property {object} [matchSourceCounts]
 * @property {number} [autoLinkedCount]
 */

const router = Router();

// Shared response-shaping tail for both the pipeline-driven imports
// (buildPipelineResult's output) and the review-commit endpoint (its own
// inline object below) — the two callers' input shapes genuinely differ
// (auto_linked_count present vs. absent, etc.), so this stays a loose record.
/** @param {Record<string, any>} result */
function buildImportResult(result) {
  return {
    ...result,
    status:
      result.status ||
      (result.errors > 0 ? "completed_with_errors" : "completed"),
    error_message: result.error_message || null,
    /** @type {any[]} */
    links: [],
  };
}

// Shared 202 "review required" response for the transaction CSV import endpoints.
/**
 * @param {ExpressResponse} res
 * @param {ImportPipelineResult} pipelineResult
 */
function respondReviewRequired(res, pipelineResult) {
  res.status(202);
  res.ok({
    batch_id: pipelineResult.batchId,
    requires_review: true,
    match_source_counts: pipelineResult.matchSourceCounts,
  });
}

// Shared completed-import result object for the transaction CSV import endpoints.
/** @param {ImportPipelineResult} pipelineResult */
function buildPipelineResult(pipelineResult) {
  return {
    total: pipelineResult.total,
    imported: pipelineResult.imported,
    duplicates: pipelineResult.duplicates,
    errors: pipelineResult.errors,
    batch_id: pipelineResult.batchId,
    auto_linked_count: pipelineResult.autoLinkedCount || 0,
  };
}

/* ── Zod schemas ─────────────────────────────────────────────────────────── */

// schema → safeParse → joined issues → ValidationError (settings.js idiom).
// Messages here already name their field, so issues join without path prefixes.
/**
 * @template T
 * @param {z.ZodType<T>} schema
 * @param {unknown} input
 * @returns {T}
 */
function parseImportInput(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(
      result.error.issues.map((issue) => issue.message).join("; "),
    );
  }
  return result.data;
}

// Multipart/query fields arrive as strings; falsy values fall back to the
// defaults exactly like the old `String(a || b || default)` chains.
const csvImportOptionsSchema = z.object({
  separator: z
    .unknown()
    .optional()
    .transform((value, ctx) => {
      const separator = String(value || ",");
      if (separator.length !== 1) {
        ctx.addIssue({
          code: "custom",
          message: "separator must be a single character",
        });
        return z.NEVER;
      }
      return separator;
    }),
  encoding: z
    .unknown()
    .optional()
    .transform((value) => String(value || "utf-8")),
});

// Parse + validate the CSV separator/encoding options shared by the
// recipients/categories import endpoints. Cleans up the upload on rejection.
/** @param {ExpressRequest} req */
function parseCsvImportOptions(req) {
  const result = csvImportOptionsSchema.safeParse({
    separator: req.query.separator || req.body.separator,
    encoding: req.query.encoding || req.body.encoding,
  });
  if (!result.success) {
    if (req.file) cleanup(req.file.path);
    throw new ValidationError(
      result.error.issues.map((issue) => issue.message).join("; "),
    );
  }
  return result.data;
}

// Free-text multipart field: falsy passes through (the required-set check in
// superRefine owns the rejection message); a truthy non-string is a clean 400
// where it previously crashed on `.trim()`.
/** @param {string} field */
const multipartTextField = (field) =>
  z
    .unknown()
    .optional()
    .transform((value, ctx) => {
      if (!value) return value;
      if (typeof value !== "string") {
        ctx.addIssue({ code: "custom", message: `${field} must be a string` });
        return z.NEVER;
      }
      return value;
    });

// csv-parse throws "Invalid Option: from must be a positive integer" on a
// negative skip — validate here so it 400s instead of a raw 500.
const skipRowsField = z
  .unknown()
  .optional()
  .transform((value, ctx) => {
    const skipRows = parseInt(/** @type {string} */ (value), 10) || 0;
    if (skipRows < 0) {
      ctx.addIssue({
        code: "custom",
        message: "skip_rows must be zero or a positive integer",
      });
      return z.NEVER;
    }
    return skipRows;
  });

// POST /csv/custom flattened fields → { adapterName, customConfig }. The
// adapter name stays RAW (pre-zod behavior); only customConfig is trimmed.
const customCsvImportSchema = z
  .looseObject({
    bank_name: multipartTextField("bank_name"),
    date_format: multipartTextField("date_format"),
    date_column: multipartTextField("date_column"),
    recipient_column: multipartTextField("recipient_column"),
    amount_column: multipartTextField("amount_column"),
    memo_column: multipartTextField("memo_column"),
    encoding: z.unknown().optional(),
    separator: z
      .unknown()
      .optional()
      .transform((value, ctx) => {
        const separator = value != null ? String(value) : "";
        if (separator && separator.length !== 1) {
          ctx.addIssue({
            code: "custom",
            message: "separator must be a single character",
          });
          return z.NEVER;
        }
        return separator || ",";
      }),
    skip_rows: skipRowsField,
  })
  .superRefine((data, ctx) => {
    if (
      !data.bank_name ||
      !data.date_format ||
      !data.date_column ||
      !data.recipient_column ||
      !data.amount_column
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "Missing required parameters: bank_name, date_format, date_column, recipient_column, amount_column",
      });
    }
  })
  .transform((data) => {
    // The superRefine above guarantees the required fields are non-empty
    // strings; the casts inform tsc of what zod's unknown bridges cannot.
    const required =
      /** @type {Record<'bank_name'|'date_format'|'date_column'|'recipient_column'|'amount_column', string>} */ (
        data
      );
    return {
      adapterName: required.bank_name,
      customConfig: {
        bank_name: required.bank_name.trim(),
        date_format: required.date_format.trim(),
        encoding: data.encoding || "utf-8",
        separator: data.separator,
        skip_rows: data.skip_rows,
        column_mapping: {
          date: required.date_column.trim(),
          recipient: required.recipient_column.trim(),
          amount: required.amount_column.trim(),
          memo: data.memo_column
            ? /** @type {string} */ (data.memo_column).trim()
            : "",
        },
      },
    };
  });

// POST /api/import/csv
router.post(
  "/csv",
  csvUpload.single("file"),
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    if (!req.file) {
      throw new ValidationError(
        'No file uploaded. Send a CSV file as multipart form-data with field name "file".',
      );
    }

    const bankName = /** @type {string | undefined} */ (
      bodyFirstParam(req.body, req.query, "bank_name")
    );
    if (!bankName) {
      cleanup(req.file.path);
      throw new ValidationError(
        "Missing required parameter: bank_name (query or body)",
      );
    }

    try {
      const pipelineResult = await runImportPipeline({
        filePath: req.file.path,
        adapterName: bankName,
        filename: req.file.originalname,
        sizeBytes: req.file.size,
      });

      if (pipelineResult.requiresReview) {
        respondReviewRequired(res, pipelineResult);
        return;
      }

      const result = buildPipelineResult(pipelineResult);
      logger.info("CSV import completed", {
        bankName,
        fileName: req.file.originalname,
        ...result,
      });
      res.status(201);
      res.ok(buildImportResult(result));
    } catch (err) {
      if (err.message?.includes("No configuration found")) {
        throw new ValidationError(`Invalid bank configuration: ${err.message}`);
      }
      throw err;
    } finally {
      cleanup(req.file.path);
    }
  },
);

// POST /api/import/csv/custom
router.post(
  "/csv/custom",
  csvUpload.single("file"),
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    if (!req.file) {
      throw new ValidationError(
        'No file uploaded. Send a CSV file as multipart form-data with field name "file".',
      );
    }

    let adapterName, customConfig;
    try {
      ({ adapterName, customConfig } = parseImportInput(customCsvImportSchema, {
        ...req.query,
        ...req.body,
      }));
    } catch (err) {
      cleanup(req.file.path);
      throw err;
    }

    try {
      const pipelineResult = await runImportPipeline({
        filePath: req.file.path,
        adapterName,
        customConfig,
        filename: req.file.originalname,
        sizeBytes: req.file.size,
      });

      if (pipelineResult.requiresReview) {
        respondReviewRequired(res, pipelineResult);
        return;
      }

      const result = buildPipelineResult(pipelineResult);
      res.status(201);
      res.ok(buildImportResult(result));
    } finally {
      cleanup(req.file.path);
    }
  },
);

// --- Saved custom parser configs (CRUD) ---------------------------------

// Saved parser configs (camelCase CustomConfig shape). Strip mode drops
// unknown keys, exactly like the old hand-built return object. NOTE: unlike
// the live import endpoints, separator deliberately has no single-char rule
// here (pre-zod parity — any non-empty string sticks).
/** @param {string} key */
const requiredConfigColumn = (key) =>
  z
    .unknown()
    .optional()
    .transform((value, ctx) => {
      if (!value || typeof value !== "string" || value.trim().length === 0) {
        ctx.addIssue({ code: "custom", message: `config.${key} is required` });
        return z.NEVER;
      }
      return value.trim();
    });

const parserConfigSchema = z.object({
  dateColumn: requiredConfigColumn("dateColumn"),
  recipientColumn: requiredConfigColumn("recipientColumn"),
  amountColumn: requiredConfigColumn("amountColumn"),
  memoColumn: z
    .unknown()
    .optional()
    .transform((value) => (typeof value === "string" ? value.trim() : "")),
  dateFormat: z
    .unknown()
    .optional()
    .transform((value) =>
      typeof value === "string" && value.trim() ? value.trim() : "%Y-%m-%d",
    ),
  separator: z
    .unknown()
    .optional()
    .transform((value) =>
      typeof value === "string" && value.length ? value : ",",
    ),
  encoding: z
    .unknown()
    .optional()
    .transform((value) =>
      typeof value === "string" && value.trim() ? value.trim() : "utf-8",
    ),
  skipRows: z
    .unknown()
    .optional()
    .transform((value) => {
      const skipRows = parseInt(/** @type {string} */ (value), 10);
      return Number.isFinite(skipRows) && skipRows > 0 ? skipRows : 0;
    }),
});

// Validates and normalizes the column-mapping config to the frontend's
// CustomConfig shape. Required: dateColumn, recipientColumn, amountColumn.
/** @param {unknown} config */
function normalizeParserConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new ValidationError('Missing or invalid "config"');
  }
  return parseImportInput(parserConfigSchema, config);
}

// GET/POST/PATCH/DELETE /api/import/parsers[/:id] — shared with the portfolio router.
registerParserRoutes(router, {
  kind: "transaction",
  normalizeConfig: normalizeParserConfig,
});

// POST /api/import/csv/stream — SSE, preserves raw event protocol
router.post(
  "/csv/stream",
  csvUpload.single("file"),
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    if (!req.file) {
      throw new ValidationError("No file uploaded.");
    }

    const bankName = /** @type {string | undefined} */ (
      bodyFirstParam(req.body, req.query, "bank_name")
    );
    if (!bankName) {
      cleanup(req.file.path);
      throw new ValidationError("Missing required parameter: bank_name");
    }

    // streamImport is typed via node:http's base classes (lib/importProgress.js)
    // — ExpressRequest/ExpressResponse are a narrower structural stand-in that
    // doesn't model IncomingMessage/ServerResponse, so forward via an any cast,
    // same as routes/ai.js's createSseWriter call.
    await streamImport(/** @type {any} */ (req), /** @type {any} */ (res), {
      filePath: req.file.path,
      errorLogMessage: "Streaming CSV import error",
      run: (onProgress) =>
        runImportPipeline({
          filePath: req.file.path,
          adapterName: bankName,
          filename: req.file.originalname,
          sizeBytes: req.file.size,
          onProgress,
        }),
      buildComplete: (pipelineResult) => ({
        total_processed: pipelineResult.total,
        imported: pipelineResult.imported,
        duplicates: pipelineResult.duplicates,
        errors: pipelineResult.errors,
        batch_id: pipelineResult.batchId,
        auto_linked_count: pipelineResult.autoLinkedCount || 0,
      }),
    });
  },
);

// (Removed dead GET /api/import/supported-banks — it had zero frontend callers
// and returned capitalized internal names that never matched the display list.
// The adapter catalog is served from /api/info/supported-adapters, derived from
// the registry, which is the single source of truth.)

// POST /api/import/recipients
router.post(
  "/recipients",
  csvUpload.single("file"),
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    if (!req.file) {
      throw new ValidationError(
        'No file uploaded. Send a CSV file as multipart form-data with field name "file".',
      );
    }

    const { separator, encoding } = parseCsvImportOptions(req);

    try {
      const result = await importRecipientsCSV(req.file.path, {
        separator,
        encoding,
      });
      logger.info("Recipient CSV import completed", result);
      res.status(201);
      res.ok({
        ...result,
        status: result.errors > 0 ? "completed_with_errors" : "completed",
      });
    } finally {
      cleanup(req.file.path);
    }
  },
);

// POST /api/import/categories
router.post(
  "/categories",
  csvUpload.single("file"),
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    if (!req.file) {
      throw new ValidationError(
        'No file uploaded. Send a CSV file as multipart form-data with field name "file".',
      );
    }

    const { separator, encoding } = parseCsvImportOptions(req);

    try {
      const result = await importCategoriesCSV(req.file.path, {
        separator,
        encoding,
      });
      logger.info("Category CSV import completed", result);
      res.status(201);
      res.ok({
        ...result,
        status: result.errors > 0 ? "completed_with_errors" : "completed",
      });
    } finally {
      cleanup(req.file.path);
    }
  },
);

// ─── Batch history + rollback ─────────────────────────────────────────────────

registerImportBatchRoutes(router, {
  listBatches,
  getBatch,
  inProgressStatuses: ["staging", "validating", "matching", "committing"],
  rollback: async (batchId) => {
    const { deleted, recipientsRemoved } = await rollbackBatch(batchId);
    logger.info("[import] batch rolled back", {
      batchId,
      deleted,
      recipientsRemoved,
    });
    if (deleted > 0 || recipientsRemoved > 0) {
      try {
        await clearForecastMcCaches();
      } catch (err) {
        logger.warn(
          "[import] post-rollback forecast cache invalidation failed",
          {
            batchId,
            error: err?.message,
          },
        );
      }
      scheduleMaterializedViewRefresh();
    }
    return { deleted, recipientsRemoved };
  },
});

// ─── Import review endpoints ──────────────────────────────────────────────────

// GET /api/import/batches/:id/preview
// Returns staging rows grouped by resolved recipient with match-source badges.
router.get(
  "/batches/:id/preview",
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const batchId = parseBatchIdParam(req);

    const batch = await getBatch(batchId);
    if (!batch) throw new NotFoundError(`Import batch ${batchId} not found`);

    const preview = await getImportBatchPreview(batchId);
    res.ok({ batch_id: batchId, ...preview });
  },
);

// POST /api/import/batches/:id/rows/:rowId/override
// Set (or clear) user_override_recipient_id on a single staging row.
router.post(
  "/batches/:id/rows/:rowId/override",
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const { batchId, rowId } = parseBatchRowIdParams(req);

    const { recipient_id } = req.body;
    // null/absent clears the override; anything else must be a real recipient id
    // (parseOverrideId, not Number() — see lib/importBatchIds.js).
    const effectiveRecipientId = parseOverrideId(recipient_id, "recipient_id");

    const rowCount = await overrideRecipient({
      batchId,
      rowId,
      recipientId: effectiveRecipientId,
    });

    if (rowCount === 0) {
      throw new NotFoundError(
        `Row ${rowId} not found in batch ${batchId} or not in matched status`,
      );
    }

    res.ok({ row_id: rowId, user_override_recipient_id: effectiveRecipientId });
  },
);

// POST /api/import/batches/:id/rows/:rowId/category-override
// Set (or clear) override_category_id on a single staging row. Symmetrical to
// the recipient override above. The category landing on the committed
// transaction is COALESCE(staging.override_category_id, recipient.default_category_id).
router.post(
  "/batches/:id/rows/:rowId/category-override",
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const { batchId, rowId } = parseBatchRowIdParams(req);

    const { category_id } = req.body;
    const effectiveCategoryId = parseOverrideId(category_id, "category_id");

    if (
      effectiveCategoryId !== null &&
      !(await categoryExists(effectiveCategoryId))
    ) {
      throw new ValidationError(`Category ${effectiveCategoryId} not found`);
    }

    const rowCount = await overrideCategory({
      batchId,
      rowId,
      categoryId: effectiveCategoryId,
    });

    if (rowCount === 0) {
      throw new NotFoundError(
        `Row ${rowId} not found in batch ${batchId} or not in matched status`,
      );
    }

    res.ok({ row_id: rowId, override_category_id: effectiveCategoryId });
  },
);

// POST /api/import/batches/:id/commit
// Commit a reviewed batch, honouring any user overrides set above.
router.post(
  "/batches/:id/commit",
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const batchId = parseBatchIdParam(req);

    const batch = await getBatch(batchId);
    if (!batch) throw new NotFoundError(`Import batch ${batchId} not found`);
    if (!["awaiting_review", "matched"].includes(batch.status)) {
      throw new ValidationError(
        `Batch ${batchId} is not in a reviewable state (status: ${batch.status})`,
      );
    }

    const { imported, duplicates, errors, autoLinkedCount } =
      await commitImport({ batchId });

    logger.info("[import] batch committed after review", {
      batchId,
      imported,
      duplicates,
      errors,
      autoLinkedCount,
    });
    res.ok(
      buildImportResult({
        batch_id: batchId,
        total: imported + duplicates + errors,
        imported,
        duplicates,
        errors,
        auto_linked_count: autoLinkedCount || 0,
      }),
    );
  },
);

// Multer error translator — convert to typed errors so global handler emits envelope.
router.use(csvUploadErrorTranslator);

export default router;
