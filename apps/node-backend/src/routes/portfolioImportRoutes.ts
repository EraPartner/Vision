/**
 * Portfolio import routes — CSV import of brokerage/exchange trades into
 * portfolio_transactions. Supports custom column mappings and maintained
 * format-specific adapters, with a review step to resolve instruments.
 *
 * Request parsing is validated with zod (schema → safeParse → ValidationError),
 * the idiom established in settings.js/reports.js. Batch/row route ids share
 * one coerced schema with the transaction import router (lib/importBatchIds.ts);
 * multipart config/brokerage schemas normalize strings and validate the
 * supported encoding and numeric convention before staging.
 */

import { Router } from "express";
import { z } from "zod";
import { logger } from "../config/logger.ts";
import {
  parseBatchIdParam,
  parseBatchRowIdParams,
  parseOverrideId,
} from "../lib/importBatchIds.ts";
import { validateId } from "../middleware/validation.ts";
import { ValidationError, NotFoundError } from "../middleware/errorHandler.ts";
import { cleanup } from "../lib/csvUpload.ts";
import {
  portfolioUpload,
  portfolioUploadErrorTranslator,
  assertPortfolioUploadSupported,
} from "../lib/portfolioUpload.ts";
import { streamImport } from "../lib/importProgress.ts";
import { runPortfolioImportPipeline } from "../services/portfolioImportPipeline/index.ts";
import { VALID_PORTFOLIO_TXN_TYPES } from "../lib/portfolioTxnTypes.ts";
import {
  listBatches,
  getBatch,
  getPortfolioImportBatchPreview,
  overrideInvestment,
  createInvestmentForRow,
  resolveInvestmentRows,
  rollbackBatch,
} from "../services/portfolioImportBatchService.ts";
import {
  commitReviewedPortfolioImport,
  commitReviewedPortfolioImports,
} from "../services/portfolioImportCommitService.ts";
import { previewPortfolioImportReconciliation } from "../services/portfolioImportReconciliationService.ts";
import { VALID_ASSET_CLASSES } from "../lib/assetClasses.ts";
import {
  CSV_NUMBER_FORMATS,
  normalizeCsvEncoding,
} from "../services/importPipeline/adapters/_shared.ts";
import { registerParserRoutes } from "./parserConfigRoutes.ts";
import { registerImportBatchRoutes } from "./importBatchRoutes.ts";
import {
  assertPortfolioImportAccount,
  buildPortfolioImportPreviewRouting,
  getPortfolioImportAccountForPreview,
} from "../services/portfolioImportAccountService.ts";

const router = Router();

const PARSER_KIND = "portfolio";
const MAX_BULK_RESOLUTION_ROWS = 5000;

// The raw label → canonical type map is only shape-checked here; the type
// normalizer rejects any mapped value that is not a valid canonical type.
function parseTypeMapping(raw: unknown): Record<string, string> {
  if (!raw) return {};
  if (typeof raw === "object") return raw as Record<string, string>;
  try {
    const parsed: unknown = JSON.parse(String(raw));
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

// Services signal expected failures with a coded Error; translate those to the
// typed errors the envelope handler maps to 400/404 and rethrow the rest.
function rethrowCodedError(err: unknown): never {
  if (err instanceof Error && "code" in err) {
    if (err.code === "VALIDATION_ERROR") throw new ValidationError(err.message);
    if (err.code === "NOT_FOUND") throw new NotFoundError(err.message);
  }
  throw err;
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

// Brokerage import (ADR-095): a flag + the sleeve account every row lands on.
// Multipart fields arrive as strings; coerce them. The account is required when
// brokerage is on (cash rows need a ledger account to land on).
const brokerageParamsSchema = z
  .looseObject({
    is_brokerage: z
      .unknown()
      .optional()
      .transform((value) => value === true || value === "true"),
    // validateId, not Number(): every row this import stages lands on the named
    // account, so an accepted-but-retargeted id ('1e3' → 1000, '0x10' → 16,
    // true → 1) files a whole CSV against an account the user never picked.
    account_id: z
      .unknown()
      .optional()
      .transform((value, ctx) => {
        if (value == null || value === "") return undefined;
        const parsed = validateId(value, "account_id");
        if (!parsed.valid) {
          ctx.addIssue({
            code: "custom",
            message: "account_id must be a positive integer",
          });
          return z.NEVER;
        }
        return parsed.value;
      }),
  })
  .superRefine((data, ctx) => {
    if (data.is_brokerage && data.account_id == null) {
      ctx.addIssue({
        code: "custom",
        message:
          "A brokerage import requires account_id (the sleeve cash + trades land on)",
      });
    }
  })
  .transform((data) => ({
    isBrokerage: data.is_brokerage,
    accountId: data.account_id,
  }));

function parseBrokerageParams(data: unknown) {
  return parseImportInput(brokerageParamsSchema, data);
}

/**
 * Format-specific routing contract. Maintained transaction-history formats
 * contain cash movements as well as asset transactions, so every row must have
 * the brokerage sleeve that receives both routes.
 */
function assertPortfolioFormatBrokerage(
  customConfig: { format?: string },
  brokerage: { isBrokerage: boolean; accountId?: number },
) {
  const formatNames: Record<string, string> = {
    ibkr_transaction_history: "IBKR",
    ibkr_funding_history: "IBKR",
    kinesis_transaction_history: "Kinesis",
    nexo_transaction_history: "Nexo",
    nexo_pro_spot_history: "Nexo Pro Spot",
    saxo_transaction_history: "Saxo",
  };
  const { format } = customConfig;
  if (
    format !== undefined &&
    Object.prototype.hasOwnProperty.call(formatNames, format) &&
    (!brokerage.isBrokerage || brokerage.accountId == null)
  ) {
    throw new ValidationError(
      `${formatNames[format]} Transaction History requires is_brokerage=true and account_id`,
    );
  }
}

// Optional column-mapping field: trimmed when a string, '' otherwise.
const trimOrEmptyField = z
  .unknown()
  .optional()
  .transform((value) => (typeof value === "string" ? value.trim() : ""));

// Text field with a default: `(value && String(value).trim()) || fallback`.
const defaultedTextField = (fallback: string) =>
  z
    .unknown()
    .optional()
    .transform((value) => (value ? String(value).trim() : "") || fallback);

const optionalPortfolioAccountId = (field: string) =>
  z
    .unknown()
    .optional()
    .transform((value, ctx) => {
      if (value == null || value === "") return undefined;
      const parsed = validateId(value, field);
      if (!parsed.valid) {
        ctx.addIssue({
          code: "custom",
          message: `${field} must be a positive integer`,
        });
        return z.NEVER;
      }
      return parsed.value;
    });

async function assertTransferDestination(
  config: {
    transfer_destination_account_id?: number;
    transfer_origin_account_id?: number;
  },
  brokerage: { accountId?: number },
) {
  for (const accountId of [
    config.transfer_destination_account_id,
    config.transfer_origin_account_id,
  ]) {
    if (accountId === undefined) continue;
    if (accountId === brokerage.accountId)
      throw new ValidationError(
        "Transfer source and destination accounts must differ",
      );
    await assertPortfolioImportAccount(accountId);
  }
}

// Flattened request fields → { customConfig, defaultAssetClass, defaultType,
// adapterName }, the shape both /csv/custom and /csv/stream hand to the
// pipeline. Field coercions mirror the pre-zod build byte for byte.
const portfolioImportConfigSchema = z
  .looseObject({
    date_column: z
      .unknown()
      .optional()
      .transform((value, ctx) => {
        if (!value || typeof value !== "string" || !value.trim()) {
          ctx.addIssue({ code: "custom", message: "date_column is required" });
          return z.NEVER;
        }
        return value.trim();
      }),
    type_column: trimOrEmptyField,
    symbol_column: trimOrEmptyField,
    name_column: trimOrEmptyField,
    units_column: trimOrEmptyField,
    price_column: trimOrEmptyField,
    amount_column: trimOrEmptyField,
    fees_column: trimOrEmptyField,
    taxes_column: trimOrEmptyField,
    currency_column: trimOrEmptyField,
    fx_rate_column: trimOrEmptyField,
    note_column: trimOrEmptyField,
    source_id_column: z
      .string()
      .trim()
      .max(200)
      .optional()
      .transform((value) => value || undefined),
    source_account_column: z
      .string()
      .trim()
      .max(200)
      .optional()
      .transform((value) => value || undefined),
    default_asset_class: z.enum([...VALID_ASSET_CLASSES], {
      error: "default_asset_class is required and must be a valid asset class",
    }),
    // Falsy (absent/'') falls back to 'buy' downstream; a truthy value must be a
    // valid canonical type.
    default_type: z.preprocess(
      (value) => value || undefined,
      z
        .enum([...VALID_PORTFOLIO_TXN_TYPES], {
          error: (issue) =>
            `default_type "${issue.input}" is not a valid transaction type`,
        })
        .optional(),
    ),
    separator: z
      .unknown()
      .optional()
      .transform((value, ctx) => {
        const separator = value != null ? String(value) : ",";
        if (separator && separator.length !== 1) {
          ctx.addIssue({
            code: "custom",
            message: "separator must be a single character",
          });
          return z.NEVER;
        }
        return separator || ",";
      }),
    date_format: defaultedTextField("%Y-%m-%d"),
    encoding: z
      .unknown()
      .optional()
      .transform((value) => normalizeCsvEncoding(value)),
    number_format: z.enum(CSV_NUMBER_FORMATS).default("auto"),
    // csv-parse throws "Invalid Option: from must be a positive integer" on a
    // negative skip — validate here so it 400s instead of a raw 500.
    skip_rows: z
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
      }),
    type_mapping: z.unknown().optional().transform(parseTypeMapping),
    adapter_name: defaultedTextField("portfolio_generic"),
    transfer_destination_account_id: optionalPortfolioAccountId(
      "transfer_destination_account_id",
    ),
    transfer_origin_account_id: optionalPortfolioAccountId(
      "transfer_origin_account_id",
    ),
    included_symbols: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .optional()
      .transform((value) =>
        value === undefined
          ? undefined
          : [
              ...new Set(
                value.split(",").map((symbol) => symbol.trim().toUpperCase()),
              ),
            ],
      )
      .pipe(
        z
          .array(z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,29}$/))
          .min(1)
          .max(30)
          .optional(),
      ),
    yield_basis_policy: z.literal("zero").optional(),
    portfolio_format: z
      .enum(
        [
          "ibkr_transaction_history",
          "ibkr_funding_history",
          "kinesis_transaction_history",
          "nexo_transaction_history",
          "nexo_pro_spot_history",
          "saxo_transaction_history",
        ],
        { error: "portfolio_format must be a supported portfolio format" },
      )
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.symbol_column && !data.name_column) {
      ctx.addIssue({
        code: "custom",
        message: "map at least one of symbol_column or name_column",
      });
    }
  })
  .transform((data) => ({
    customConfig: {
      date_format: data.date_format,
      separator: data.separator,
      encoding: data.encoding,
      number_format: data.number_format,
      skip_rows: data.skip_rows,
      default_asset_class: data.default_asset_class,
      default_type: data.default_type || "buy",
      type_mapping: data.type_mapping,
      ...(data.transfer_destination_account_id !== undefined
        ? {
            transfer_destination_account_id:
              data.transfer_destination_account_id,
          }
        : {}),
      ...(data.transfer_origin_account_id !== undefined
        ? { transfer_origin_account_id: data.transfer_origin_account_id }
        : {}),
      ...(data.included_symbols !== undefined
        ? { included_symbols: data.included_symbols }
        : {}),
      ...(data.yield_basis_policy !== undefined
        ? { yield_basis_policy: data.yield_basis_policy }
        : {}),
      ...(data.portfolio_format ? { format: data.portfolio_format } : {}),
      column_mapping: {
        date: data.date_column,
        type: data.type_column,
        symbol: data.symbol_column,
        name: data.name_column,
        units: data.units_column,
        price: data.price_column,
        amount: data.amount_column,
        fees: data.fees_column,
        taxes: data.taxes_column,
        currency: data.currency_column,
        fx_rate: data.fx_rate_column,
        note: data.note_column,
        ...(data.source_id_column !== undefined
          ? { source_id: data.source_id_column }
          : {}),
        ...(data.source_account_column !== undefined
          ? { source_account: data.source_account_column }
          : {}),
      },
    },
    defaultAssetClass: data.default_asset_class,
    defaultType: data.default_type || "buy",
    adapterName: data.adapter_name,
  }));

// Build the backend customConfig + batch defaults from flattened request fields.
function buildPortfolioConfig(data: unknown) {
  return parseImportInput(portfolioImportConfigSchema, data);
}

// Pure contract seam for listener-free route-schema tests. The desktop
// sandbox cannot bind Supertest sockets, but request coercion must still be
// pinned independently of Express transport.
export {
  buildPortfolioConfig as __buildPortfolioConfig,
  assertPortfolioFormatBrokerage as __assertPortfolioFormatBrokerage,
};

// POST /api/portfolio/import/csv/custom — one-shot (202 if review needed)
router.post("/csv/custom", portfolioUpload.single("file"), async (req, res) => {
  if (!req.file) throw new ValidationError("No file uploaded.");
  let built;
  try {
    built = buildPortfolioConfig(req.body);
  } catch (err) {
    cleanup(req.file.path);
    throw err;
  }

  let brokerage;
  try {
    brokerage = parseBrokerageParams(req.body);
    assertPortfolioFormatBrokerage(built.customConfig, brokerage);
    await assertPortfolioImportAccount(brokerage.accountId);
    await assertTransferDestination(built.customConfig, brokerage);
    await assertPortfolioUploadSupported(req.file.path, built.customConfig);
  } catch (err) {
    cleanup(req.file.path);
    throw err;
  }

  try {
    const result = await runPortfolioImportPipeline({
      filePath: req.file.path,
      adapterName: built.adapterName,
      customConfig: built.customConfig,
      defaultAssetClass: built.defaultAssetClass,
      defaultType: built.defaultType,
      filename: req.file.originalname,
      sizeBytes: req.file.size,
      isBrokerage: brokerage.isBrokerage,
      accountId: brokerage.accountId,
    });

    if (result.requiresReview) {
      res.status(202);
      res.ok({
        batch_id: result.batchId,
        requires_review: true,
        match_source_counts: result.matchSourceCounts,
        skipped: result.skipped,
      });
      return;
    }
    res.status(201);
    res.ok({
      batch_id: result.batchId,
      total: result.total,
      skipped: result.skipped,
      imported: result.imported,
      duplicates: result.duplicates,
      errors: result.errors,
    });
  } finally {
    cleanup(req.file.path);
  }
});

// POST /api/portfolio/import/csv/stream — SSE progress
router.post("/csv/stream", portfolioUpload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file) throw new ValidationError("No file uploaded.");
  let built: ReturnType<typeof buildPortfolioConfig>;
  try {
    built = buildPortfolioConfig(req.body);
  } catch (err) {
    cleanup(file.path);
    throw err;
  }

  // Validate before streamImport commits the SSE headers, so rejections still
  // travel through the envelope error handler (previously this ran after
  // writeHead, corrupting the response and leaking the upload on a bad
  // account_id).
  let brokerage: ReturnType<typeof parseBrokerageParams>;
  try {
    brokerage = parseBrokerageParams(req.body);
    assertPortfolioFormatBrokerage(built.customConfig, brokerage);
    await assertPortfolioImportAccount(brokerage.accountId);
    await assertTransferDestination(built.customConfig, brokerage);
    await assertPortfolioUploadSupported(file.path, built.customConfig);
  } catch (err) {
    cleanup(file.path);
    throw err;
  }

  await streamImport(req, res, {
    filePath: file.path,
    errorLogMessage: "Streaming portfolio import error",
    run: (onProgress) =>
      runPortfolioImportPipeline({
        filePath: file.path,
        adapterName: built.adapterName,
        customConfig: built.customConfig,
        defaultAssetClass: built.defaultAssetClass,
        defaultType: built.defaultType,
        filename: file.originalname,
        sizeBytes: file.size,
        isBrokerage: brokerage.isBrokerage,
        accountId: brokerage.accountId,
        onProgress,
      }),
    buildComplete: (result) => ({
      batch_id: result.batchId,
      total_processed: result.total,
      skipped: result.skipped,
      imported: result.imported,
      duplicates: result.duplicates,
      errors: result.errors,
    }),
  });
});

// --- Saved portfolio parser configs (CRUD) ------------------------------------

// Stores the frontend's PortfolioCustomConfig (camelCase) as JSONB. Required:
// dateColumn, a symbol or name column, and a valid defaultAssetClass.
const portfolioParserConfigSchema = z
  .looseObject({
    number_format: z.enum(CSV_NUMBER_FORMATS).default("auto"),
    encoding: z
      .unknown()
      .transform((value) => normalizeCsvEncoding(value))
      .optional(),
    dateColumn: z
      .unknown()
      .optional()
      .transform((value, ctx) => {
        if (!value || typeof value !== "string" || !value.trim()) {
          ctx.addIssue({
            code: "custom",
            message: "config.dateColumn is required",
          });
          return z.NEVER;
        }
        return value;
      }),
    defaultAssetClass: z.enum([...VALID_ASSET_CLASSES], {
      error: "config.defaultAssetClass must be a valid asset class",
    }),
    transferDestinationAccountId: optionalPortfolioAccountId(
      "config.transferDestinationAccountId",
    ),
    transferOriginAccountId: optionalPortfolioAccountId(
      "config.transferOriginAccountId",
    ),
    yieldBasisPolicy: z.literal("zero").optional(),
    accountId: z
      .unknown()
      .optional()
      .transform((value, ctx) => {
        if (value == null || value === "") return undefined;
        const parsed = validateId(value, "config.accountId");
        if (!parsed.valid) {
          ctx.addIssue({
            code: "custom",
            message: "config.accountId must be a positive integer",
          });
          return z.NEVER;
        }
        return parsed.value;
      }),
  })
  .superRefine((config, ctx) => {
    const hasSymbol =
      typeof config.symbolColumn === "string" && config.symbolColumn.trim();
    const hasName =
      typeof config.nameColumn === "string" && config.nameColumn.trim();
    if (!hasSymbol && !hasName) {
      ctx.addIssue({
        code: "custom",
        message: "config requires symbolColumn or nameColumn",
      });
    }
  });

// Preserve additional parser keys, normalize supported encodings, and default
// configurations saved before numeric conventions were introduced to auto.
function normalizePortfolioParserConfig(config: unknown) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new ValidationError('Missing or invalid "config"');
  }
  return parseImportInput(portfolioParserConfigSchema, config);
}

// GET/POST/PATCH/DELETE /parsers[/:id] — shared with the transaction import router.
registerParserRoutes(router, {
  kind: PARSER_KIND,
  normalizeConfig: normalizePortfolioParserConfig,
  label: "portfolio ",
});

// --- Batch history + rollback -------------------------------------------------

// Canonical collection shape `{items, total, limit, offset}` — the service
// keeps its `batches` key internally, only the wire key is normalised.
registerImportBatchRoutes(router, {
  listBatches,
  getBatch,
  inProgressStatuses: [
    "pending",
    "staging",
    "validating",
    "matching",
    "committing",
  ],
  rollback: async (batchId) => {
    let deleted;
    try {
      ({ deleted } = await rollbackBatch(batchId));
    } catch (err) {
      rethrowCodedError(err);
    }
    logger.info("[portfolio-import] batch rolled back", { batchId, deleted });
    return { deleted };
  },
});

// --- Review -------------------------------------------------------------------

router.get("/batches/:id/preview", async (req, res) => {
  const batchId = parseBatchIdParam(req);
  const batch = await getBatch(batchId);
  if (!batch) throw new NotFoundError(`Import batch ${batchId} not found`);

  const preview = await getPortfolioImportBatchPreview(batchId);
  const account = await getPortfolioImportAccountForPreview(batch.account_id);
  res.ok({
    batch_id: batchId,
    ...buildPortfolioImportPreviewRouting(batch, account),
    ...preview,
  });
});

// POST /api/portfolio/import/batches/:id/rows/investment-override
// Body: { row_ids, investment_id } or { row_ids, create_new: true }.
router.post("/batches/:id/rows/investment-override", async (req, res) => {
  const batchId = parseBatchIdParam(req);
  const rawRowIds = req.body?.row_ids;
  if (!Array.isArray(rawRowIds) || rawRowIds.length === 0) {
    throw new ValidationError("row_ids must be a non-empty array");
  }
  if (rawRowIds.length > MAX_BULK_RESOLUTION_ROWS) {
    throw new ValidationError(
      `row_ids must contain at most ${MAX_BULK_RESOLUTION_ROWS} entries`,
    );
  }

  const rowIds = rawRowIds.map((raw, index) => {
    const parsed = validateId(
      raw,
      `row_ids[${index}]`,
      Number.MAX_SAFE_INTEGER,
    );
    if (!parsed.valid)
      throw new ValidationError(`row_ids[${index}] must be a positive integer`);
    return parsed.value;
  });
  if (new Set(rowIds).size !== rowIds.length) {
    throw new ValidationError("row_ids must not contain duplicates");
  }

  if (req.body?.create_new !== undefined && req.body.create_new !== true) {
    throw new ValidationError("create_new must be true when provided");
  }
  const createNew = req.body?.create_new === true;
  const hasInvestmentId =
    req.body?.investment_id !== undefined && req.body?.investment_id !== null;
  if (createNew === hasInvestmentId) {
    throw new ValidationError(
      "Provide exactly one of investment_id or create_new: true",
    );
  }

  let investmentId;
  if (hasInvestmentId) {
    const parsed = validateId(req.body.investment_id, "investment_id");
    if (!parsed.valid)
      throw new ValidationError("investment_id must be a positive integer");
    investmentId = parsed.value;
  }

  let result;
  try {
    result = await resolveInvestmentRows({
      batchId,
      rowIds,
      investmentId,
      createNew,
    });
  } catch (err) {
    rethrowCodedError(err);
  }

  res.ok({
    investment_id: result.investmentId,
    created: result.created,
    resolved: result.resolved,
    ...(result.investment ? { investment: result.investment } : {}),
  });
});

// POST /api/portfolio/import/batches/:id/rows/:rowId/investment-override
// Body: { investment_id } to point at an existing holding, or { create_new: true }.
router.post(
  "/batches/:id/rows/:rowId/investment-override",
  async (req, res) => {
    const { batchId, rowId } = parseBatchRowIdParams(req);

    if (req.body?.create_new === true) {
      let investment;
      try {
        investment = await createInvestmentForRow({ batchId, rowId });
      } catch (err) {
        // Repository/service VALIDATION_ERROR (missing default asset class, no
        // name, duplicate symbol) → typed 400, matching investmentService's
        // translateRepoError — a raw coded Error would surface as a 500.
        rethrowCodedError(err);
      }
      if (!investment)
        throw new NotFoundError(`Row ${rowId} not found in batch ${batchId}`);
      res.ok({
        row_id: rowId,
        investment_id: investment.id,
        created: true,
        investment,
      });
      return;
    }

    const { investment_id } = req.body ?? {};
    // null/absent clears the override; anything else must be a real investment id
    // (parseOverrideId, not Number() — see lib/importBatchIds.ts).
    const effectiveId = parseOverrideId(investment_id, "investment_id");

    const rowCount = await overrideInvestment({
      batchId,
      rowId,
      investmentId: effectiveId,
    });
    if (rowCount === 0) {
      throw new NotFoundError(
        `Row ${rowId} not found in batch ${batchId} or not eligible for an investment override`,
      );
    }
    res.ok({ row_id: rowId, user_override_investment_id: effectiveId });
  },
);

const reconciliationScopeSchema = z.strictObject({
  batch_ids: z
    .array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
    .min(1)
    .max(100),
  adopt_policy: z.enum(["preserve_existing", "prefer_source"]).optional(),
  reconciliation_scope: z
    .enum([
      "full",
      "adopt_existing_only",
      "correct_existing_only",
      "record_in_kind_income_only",
      "record_cash_only",
    ])
    .optional(),
  cash_funding_policy: z.enum(["own_account_transfer"]).optional(),
  batch_policies: z
    .array(
      z.strictObject({
        batch_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        adopt_policy: z.enum(["preserve_existing", "prefer_source"]),
      }),
    )
    .max(100)
    .optional(),
});
const reconciliationCommitSchema = reconciliationScopeSchema.extend({
  expected_plan_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});

router.post("/reconciliation/preview", async (req, res) => {
  const input = parseImportInput(reconciliationScopeSchema, req.body);
  res.ok(
    await previewPortfolioImportReconciliation({
      batchIds: input.batch_ids,
      adoptPolicy: input.adopt_policy,
      reconciliationScope: input.reconciliation_scope,
      cashFundingPolicy: input.cash_funding_policy,
      batchPolicies: input.batch_policies?.map((policy) => ({
        batchId: policy.batch_id,
        adoptPolicy: policy.adopt_policy,
      })),
    }),
  );
});

router.post("/reconciliation/commit", async (req, res) => {
  const input = parseImportInput(reconciliationCommitSchema, req.body);
  const result = await commitReviewedPortfolioImports({
    batchIds: input.batch_ids,
    adoptPolicy: input.adopt_policy,
    reconciliationScope: input.reconciliation_scope,
    cashFundingPolicy: input.cash_funding_policy,
    batchPolicies: input.batch_policies?.map((policy) => ({
      batchId: policy.batch_id,
      adoptPolicy: policy.adopt_policy,
    })),
    expectedPlanFingerprint: input.expected_plan_fingerprint,
  });
  logger.info("[portfolio-import] reviewed scope committed", {
    batchCount: result.batches.length,
    imported: result.imported,
    adopted: result.adopted,
    duplicates: result.duplicates,
  });
  res.ok(result);
});

// POST /api/portfolio/import/batches/:id/commit
router.post("/batches/:id/commit", async (req, res) => {
  const batchId = parseBatchIdParam(req);
  // Optional batch-level brokerage account (ADR-095): validate its shape here.
  // The service validates existence, repairs missing-account cash rows, and
  // holds the batch lock through commit so concurrent recommits cannot swap it.
  const { account_id } = req.body ?? {};
  let accountId;
  if (account_id !== undefined && account_id !== null) {
    // validateId, not Number(): the existence check below only sees what the
    // coercion produced, so '1e3' passed it as the perfectly real account 1000
    // and every lot committed from this batch was stamped with it.
    const parsed = validateId(account_id, "account_id");
    if (!parsed.valid)
      throw new ValidationError("account_id must be a positive integer");
    accountId = parsed.value;
  }

  const { imported, duplicates, errors } = await commitReviewedPortfolioImport({
    batchId,
    accountId,
  });
  logger.info("[portfolio-import] batch committed after review", {
    batchId,
    imported,
    duplicates,
    errors,
  });
  res.ok({
    batch_id: batchId,
    total: imported + duplicates + errors,
    imported,
    duplicates,
    errors,
  });
});

router.use(portfolioUploadErrorTranslator);

export { normalizePortfolioParserConfig as __normalizePortfolioParserConfig };

export default router;
