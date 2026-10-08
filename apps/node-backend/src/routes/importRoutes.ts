/**
 * Import routes - Full CSV import with bank adapters.
 *
 * Request parsing is validated with zod (schema → safeParse → ValidationError),
 * the idiom established in settings.js/reports.js. Batch/row route ids share
 * one coerced schema with the portfolio import router (lib/importBatchIds.ts).
 * CSV option/config schemas normalize multipart fields and validate the
 * supported encoding and numeric convention before staging.
 */

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
} from "../lib/importBatchIds.ts";
import { logger } from "../config/logger.ts";
import {
  runImportPipeline,
  commitImport,
} from "../services/importPipeline/index.ts";
import { ValidationError, NotFoundError } from "../middleware/errorHandler.ts";
import {
  csvUpload,
  cleanup,
  csvUploadErrorTranslator,
} from "../lib/csvUpload.ts";
import { streamImport } from "../lib/importProgress.ts";
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
import { registerParserRoutes } from "./parserConfigRoutes.ts";
import { registerImportBatchRoutes } from "./importBatchRoutes.ts";
import {
  normalizeCsvEncoding,
  CSV_NUMBER_FORMATS,
} from "../services/importPipeline/adapters/_shared.ts";

/** The shape `runImportPipeline` resolves with (services/importPipeline/index.js). */
type ImportPipelineResult = Awaited<ReturnType<typeof runImportPipeline>>;

// Structural slices of Express's Request/Response: the legacy checkJs program
// resolves `express` to an untyped shim that has no type exports.
interface CsvOptionsRequest {
  body?: { separator?: unknown; encoding?: unknown };
  file?: { path: string };
}
interface EnvelopeResponse {
  status(code: number): unknown;
  ok(data: unknown): unknown;
}

/** The fields buildImportResult reads; every other key passes through. */
interface ImportResultInput {
  status?: string;
  errors?: number;
  error_message?: string | null;
  [key: string]: unknown;
}

const router = Router();

// Shared response-shaping tail for both the pipeline-driven imports
// (buildPipelineResult's output) and the review-commit endpoint (its own
// inline object below) — the two callers' input shapes genuinely differ
// (auto_linked_count present vs. absent, etc.), so this stays a loose record.
function buildImportResult(result: ImportResultInput) {
  const links: unknown[] = [];
  return {
    ...result,
    status:
      result.status ||
      ((result.errors ?? 0) > 0 ? "completed_with_errors" : "completed"),
    error_message: result.error_message || null,
    links,
  };
}

// Shared 202 "review required" response for the transaction CSV import endpoints.
function respondReviewRequired(
  res: EnvelopeResponse,
  pipelineResult: ImportPipelineResult,
) {
  res.status(202);
  res.ok({
    batch_id: pipelineResult.batchId,
    requires_review: true,
    match_source_counts: pipelineResult.matchSourceCounts,
  });
}

// Shared completed-import result object for the transaction CSV import endpoints.
function buildPipelineResult(pipelineResult: ImportPipelineResult) {
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
function parseImportInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(
      result.error.issues.map((issue) => issue.message).join("; "),
    );
  }
  return result.data;
}

const csvEncodingField = z
  .unknown()
  .optional()
  .transform((value, ctx) => {
    try {
      return normalizeCsvEncoding(value);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
      });
      return z.NEVER;
    }
  });

// Multipart fields arrive as strings; empty values use the endpoint defaults.
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
  encoding: csvEncodingField,
});

// Parse + validate the CSV separator/encoding options shared by the
// recipients/categories import endpoints. Cleans up the upload on rejection.
function parseCsvImportOptions(req: CsvOptionsRequest) {
  const result = csvImportOptionsSchema.safeParse({
    separator: req.body?.separator,
    encoding: req.body?.encoding,
  });
  if (!result.success) {
    if (req.file) cleanup(req.file.path);
    throw new ValidationError(
      result.error.issues.map((issue) => issue.message).join("; "),
    );
  }
  return result.data;
}

// Listener-free contract seam for environments that cannot bind a test socket.
export const __parseCsvImportOptionsForTests = parseCsvImportOptions;

// Free-text multipart field: falsy passes through (the required-set check in
// superRefine owns the rejection message); a truthy non-string is a clean 400
// where it previously crashed on `.trim()`. Falsy values normalize to
// undefined; every reader treats them identically.
const multipartTextField = (field: string) =>
  z
    .unknown()
    .optional()
    .transform((value, ctx) => {
      if (!value) return undefined;
      if (typeof value !== "string") {
        ctx.addIssue({ code: "custom", message: `${field} must be a string` });
        return z.NEVER;
      }
      return value;
    });

// csv-parse throws on an invalid from_line option for a
// negative skip — validate here so it 400s instead of a raw 500.
const skipRowsField = z
  .unknown()
  .optional()
  .transform((value, ctx) => {
    const skipRows = parseInt(String(value), 10) || 0;
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
    encoding: csvEncodingField,
    number_format: z.enum(CSV_NUMBER_FORMATS).default("auto"),
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
    const {
      bank_name,
      date_format,
      date_column,
      recipient_column,
      amount_column,
    } = data;
    // Unreachable: the superRefine above already rejected empty values.
    if (
      !bank_name ||
      !date_format ||
      !date_column ||
      !recipient_column ||
      !amount_column
    ) {
      throw new Error("customCsvImportSchema: required fields missing");
    }
    return {
      adapterName: bank_name,
      customConfig: {
        bank_name: bank_name.trim(),
        date_format: date_format.trim(),
        encoding: data.encoding || "utf-8",
        number_format: data.number_format,
        separator: data.separator,
        skip_rows: data.skip_rows,
        column_mapping: {
          date: date_column.trim(),
          recipient: recipient_column.trim(),
          amount: amount_column.trim(),
          memo: data.memo_column ? data.memo_column.trim() : "",
        },
      },
    };
  });

// Listener-free seam for the same request schema used by the upload handler.
function buildCustomCsvConfig(input: unknown) {
  return parseImportInput(customCsvImportSchema, input);
}

export { buildCustomCsvConfig as __buildCustomCsvConfig };

// POST /api/import/csv
router.post("/csv", csvUpload.single("file"), async (req, res) => {
  if (!req.file) {
    throw new ValidationError(
      'No file uploaded. Send a CSV file as multipart form-data with field name "file".',
    );
  }

  // A repeated multipart field arrives as an array; only one name is valid.
  const bankName: unknown = req.body?.bank_name;
  if (typeof bankName !== "string" || !bankName) {
    cleanup(req.file.path);
    throw new ValidationError("Missing required multipart field: bank_name");
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
    if (
      err instanceof Error &&
      err.message.includes("No configuration found")
    ) {
      throw new ValidationError(`Invalid bank configuration: ${err.message}`);
    }
    throw err;
  } finally {
    cleanup(req.file.path);
  }
});

// POST /api/import/csv/custom
router.post("/csv/custom", csvUpload.single("file"), async (req, res) => {
  if (!req.file) {
    throw new ValidationError(
      'No file uploaded. Send a CSV file as multipart form-data with field name "file".',
    );
  }

  let built: ReturnType<typeof buildCustomCsvConfig>;
  try {
    built = buildCustomCsvConfig(req.body);
  } catch (err) {
    cleanup(req.file.path);
    throw err;
  }

  try {
    const pipelineResult = await runImportPipeline({
      filePath: req.file.path,
      adapterName: built.adapterName,
      customConfig: built.customConfig,
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
});

// --- Saved custom parser configs (CRUD) ---------------------------------

// Saved parser configs (camelCase CustomConfig shape). Strip mode drops
// unknown keys, exactly like the old hand-built return object. NOTE: unlike
// the live import endpoints, separator deliberately has no single-char rule
// here (pre-zod parity — any non-empty string sticks).
const requiredConfigColumn = (key: string) =>
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
  encoding: csvEncodingField,
  number_format: z.enum(CSV_NUMBER_FORMATS).default("auto"),
  skipRows: z
    .unknown()
    .optional()
    .transform((value) => {
      const skipRows = parseInt(String(value), 10);
      return Number.isFinite(skipRows) && skipRows > 0 ? skipRows : 0;
    }),
});

// Validates and normalizes the column-mapping config to the frontend's
// CustomConfig shape. Required: dateColumn, recipientColumn, amountColumn.
function normalizeParserConfig(config: unknown) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new ValidationError('Missing or invalid "config"');
  }
  return parseImportInput(parserConfigSchema, config);
}

export { normalizeParserConfig as __normalizeParserConfig };

// GET/POST/PATCH/DELETE /api/import/parsers[/:id] — shared with the portfolio router.
registerParserRoutes(router, {
  kind: "transaction",
  normalizeConfig: normalizeParserConfig,
});

// POST /api/import/csv/stream — SSE, preserves raw event protocol
router.post("/csv/stream", csvUpload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file) {
    throw new ValidationError("No file uploaded.");
  }

  // A repeated multipart field arrives as an array; only one name is valid.
  const bankName: unknown = req.body?.bank_name;
  if (typeof bankName !== "string" || !bankName) {
    cleanup(file.path);
    throw new ValidationError("Missing required parameter: bank_name");
  }

  await streamImport(req, res, {
    filePath: file.path,
    errorLogMessage: "Streaming CSV import error",
    run: (onProgress) =>
      runImportPipeline({
        filePath: file.path,
        adapterName: bankName,
        filename: file.originalname,
        sizeBytes: file.size,
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
});

// (Removed dead GET /api/import/supported-banks — it had zero frontend callers
// and returned capitalized internal names that never matched the display list.
// The adapter catalog is served from /api/info/supported-adapters, derived from
// the registry, which is the single source of truth.)

// POST /api/import/recipients
router.post("/recipients", csvUpload.single("file"), async (req, res) => {
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
});

// POST /api/import/categories
router.post("/categories", csvUpload.single("file"), async (req, res) => {
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
});

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
            error: err instanceof Error ? err.message : String(err),
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
router.get("/batches/:id/preview", async (req, res) => {
  const batchId = parseBatchIdParam(req);

  const batch = await getBatch(batchId);
  if (!batch) throw new NotFoundError(`Import batch ${batchId} not found`);

  const preview = await getImportBatchPreview(batchId);
  res.ok({ batch_id: batchId, ...preview });
});

// POST /api/import/batches/:id/rows/:rowId/override
// Set (or clear) user_override_recipient_id on a single staging row.
router.post("/batches/:id/rows/:rowId/override", async (req, res) => {
  const { batchId, rowId } = parseBatchRowIdParams(req);

  const { recipient_id } = req.body ?? {};
  // null/absent clears the override; anything else must be a real recipient id
  // (parseOverrideId, not Number() — see lib/importBatchIds.ts).
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
});

// POST /api/import/batches/:id/rows/:rowId/category-override
// Set (or clear) override_category_id on a single staging row. Symmetrical to
// the recipient override above. The category landing on the committed
// transaction is COALESCE(staging.override_category_id, recipient.default_category_id).
router.post("/batches/:id/rows/:rowId/category-override", async (req, res) => {
  const { batchId, rowId } = parseBatchRowIdParams(req);

  const { category_id } = req.body ?? {};
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
});

// POST /api/import/batches/:id/commit
// Commit a reviewed batch, honouring any user overrides set above.
router.post("/batches/:id/commit", async (req, res) => {
  const batchId = parseBatchIdParam(req);

  const batch = await getBatch(batchId);
  if (!batch) throw new NotFoundError(`Import batch ${batchId} not found`);
  if (!["awaiting_review", "matched"].includes(batch.status)) {
    throw new ValidationError(
      `Batch ${batchId} is not in a reviewable state (status: ${batch.status})`,
    );
  }

  const { imported, duplicates, errors, autoLinkedCount } = await commitImport({
    batchId,
  });

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
});

// Multer error translator — convert to typed errors so global handler emits envelope.
router.use(csvUploadErrorTranslator);

export default router;
