import { z } from "zod";
import {
    API_BASE_URL,
    generateRequestId,
    parseEnvelopeError,
    apiRequest,
    rawFetch,
} from "@/lib/api/client";
import { postMultipartImport } from "@/lib/api/helpers";
import { importProgressSchema, type CsvNumberFormat } from "@/lib/api/imports";
import { readSseStream } from "@/lib/api/sse";
import type { ImportProgress } from "@/types/apiClient";
import type { AssetClass } from "@vision/types/assetClasses";
import type { PortfolioTxnType } from "@vision/types/portfolioTxnTypes";
import { ImportCancelledError } from "@/lib/api/importCancelled";

/**
 * Runtime guards for the portfolio import SSE stream (ZOD-10); see the
 * matching note in imports.ts. Shapes mirror portfolioImportRoutes.js
 * `buildComplete` / the shared review_required payload.
 */
const portfolioImportResultSchema = z.looseObject({
    batch_id: z.number(),
    total_processed: z.number().optional(),
    total: z.number().optional(),
    skipped: z.number().optional(),
    imported: z.number(),
    duplicates: z.number(),
    errors: z.number(),
    status: z.string().optional(),
    requires_review: z.boolean().optional(),
});

const portfolioReviewRequiredSchema = z.looseObject({
    batch_id: z.number(),
    skipped: z.number().optional(),
});

const PORTFOLIO_STREAM_SCHEMAS: Record<string, z.ZodType> = {
    progress: importProgressSchema,
    complete: portfolioImportResultSchema,
    review_required: portfolioReviewRequiredSchema,
};

export interface PortfolioCustomConfig {
    /** Optional file-level destination for every trade staged with this parser. */
    accountId?: number;
    /** Destination of dated asset withdrawals, when the statement contains them. */
    transferDestinationAccountId?: number;
    /** Origin of dated asset returns, when source evidence identifies prior custody. */
    transferOriginAccountId?: number;
    /** Explicit zero basis for confirmed yield placeholders, selected with an XML reference. */
    yieldBasisPolicy?: "zero";
    /** Explicit comma-separated asset symbols for a partial statement import. */
    includedSymbols?: string;
    /** Format-specific parser. Omit for the generic column mapper. */
    format?:
        | "ibkr_transaction_history"
        | "kinesis_transaction_history"
        | "nexo_transaction_history"
        | "nexo_pro_spot_history"
        | "saxo_transaction_history";
    dateColumn: string;
    typeColumn: string;
    symbolColumn: string;
    nameColumn: string;
    unitsColumn: string;
    priceColumn: string;
    amountColumn: string;
    feesColumn: string;
    taxesColumn: string;
    currencyColumn: string;
    fxRateColumn: string;
    noteColumn: string;
    dateFormat: string;
    separator: string;
    encoding: string;
    skipRows: number;
    number_format?: CsvNumberFormat;
    defaultAssetClass: AssetClass;
    defaultType: PortfolioTxnType;
    typeMapping: Record<string, string>;
}

export interface SavedPortfolioParserConfig {
    id: number;
    name: string;
    kind: string;
    config: PortfolioCustomConfig;
    created_at: string;
    updated_at: string;
}

export interface PortfolioPreviewRow {
    id: number;
    row_index: number;
    status: string;
    /** Brokerage routing (ADR-095): 'cash' | 'portfolio' | null (legacy/non-brokerage). */
    route?: string | null;
    tx_date: string;
    type: string | null;
    type_raw: string | null;
    symbol_raw: string | null;
    name_raw: string | null;
    units: number | null;
    price_per_unit: number | null;
    amount: number | null;
    fees: number | null;
    taxes: number | null;
    currency: string | null;
    fx_rate_to_eur: number | null;
    note: string | null;
    match_source: string | null;
    error_message: string | null;
    user_override_investment_id: number | null;
}

export interface PortfolioPreviewGroup {
    /** Brokerage cash group (ADR-095): deposits/withdrawals, no instrument to resolve. */
    is_cash?: boolean;
    investment_id: number | null;
    investment_name: string | null;
    investment_symbol: string | null;
    investment_asset_class: string | null;
    raw_symbol: string | null;
    raw_name: string | null;
    row_count: number;
    rows: PortfolioPreviewRow[];
}

export interface PortfolioPreviewResponse {
    batch_id: number;
    account_id: number | null;
    account_name: string | null;
    account_valid: boolean;
    groups: PortfolioPreviewGroup[];
    totals: {
        symbol: number;
        name_exact: number;
        unresolved: number;
        error: number;
    };
}

export interface PortfolioImportResult {
    batch_id: number;
    total_processed?: number;
    total?: number;
    /** Rows the adapter could not parse (bad column mapping / date format). */
    skipped?: number;
    imported: number;
    duplicates: number;
    errors: number;
    status?: string;
    requires_review?: boolean;
}

// Flatten the camelCase config into the snake_case form the backend route reads.
function configToParams(
    config: PortfolioCustomConfig,
    adapterName: string,
): URLSearchParams {
    const p = new URLSearchParams();
    p.append("adapter_name", adapterName);
    if (config.format) p.append("portfolio_format", config.format);
    if (config.transferDestinationAccountId != null)
        p.append(
            "transfer_destination_account_id",
            String(config.transferDestinationAccountId),
        );
    if (config.transferOriginAccountId != null)
        p.append(
            "transfer_origin_account_id",
            String(config.transferOriginAccountId),
        );
    if (config.includedSymbols?.trim())
        p.append("included_symbols", config.includedSymbols);
    if (config.yieldBasisPolicy)
        p.append("yield_basis_policy", config.yieldBasisPolicy);
    p.append("date_format", config.dateFormat);
    p.append("separator", config.separator);
    p.append("encoding", config.encoding);
    p.append("skip_rows", String(config.skipRows));
    p.append("number_format", config.number_format ?? "auto");
    p.append("default_asset_class", config.defaultAssetClass);
    p.append("default_type", config.defaultType);
    p.append("type_mapping", JSON.stringify(config.typeMapping || {}));
    p.append("date_column", config.dateColumn);
    if (config.typeColumn) p.append("type_column", config.typeColumn);
    if (config.symbolColumn) p.append("symbol_column", config.symbolColumn);
    if (config.nameColumn) p.append("name_column", config.nameColumn);
    if (config.unitsColumn) p.append("units_column", config.unitsColumn);
    if (config.priceColumn) p.append("price_column", config.priceColumn);
    if (config.amountColumn) p.append("amount_column", config.amountColumn);
    if (config.feesColumn) p.append("fees_column", config.feesColumn);
    if (config.taxesColumn) p.append("taxes_column", config.taxesColumn);
    if (config.currencyColumn)
        p.append("currency_column", config.currencyColumn);
    if (config.fxRateColumn) p.append("fx_rate_column", config.fxRateColumn);
    if (config.noteColumn) p.append("note_column", config.noteColumn);
    return p;
}

/** Brokerage fan-out (ADR-095): mark the import and the sleeve account its rows land on. */
export interface BrokerageImportOptions {
    isBrokerage: boolean;
    accountId?: number;
}

function appendBrokerage(
    p: URLSearchParams,
    brokerage?: BrokerageImportOptions,
): URLSearchParams {
    if (brokerage?.isBrokerage) {
        p.append("is_brokerage", "true");
        if (brokerage.accountId != null)
            p.append("account_id", String(brokerage.accountId));
    }
    return p;
}

export function importPortfolioCSVCustom(
    file: File,
    config: PortfolioCustomConfig,
    adapterName: string,
    brokerage?: BrokerageImportOptions,
): Promise<PortfolioImportResult> {
    return postMultipartImport(
        "/api/portfolio/import/csv/custom",
        file,
        appendBrokerage(configToParams(config, adapterName), brokerage),
    );
}

export function importPortfolioCSVWithProgress(
    file: File,
    config: PortfolioCustomConfig,
    adapterName: string,
    onProgress: (progress: ImportProgress) => void,
    brokerage?: BrokerageImportOptions,
): { abort: () => void; result: Promise<PortfolioImportResult> } {
    const controller = new AbortController();
    const formData = new FormData();
    formData.append("file", file);
    appendBrokerage(configToParams(config, adapterName), brokerage).forEach(
        (value, key) => formData.append(key, value),
    );
    const url = `${API_BASE_URL}/api/portfolio/import/csv/stream`;

    const extractErrorDetail = (payload: unknown): string => {
        if (payload && typeof payload === "object" && "detail" in payload) {
            const detail = (payload as { detail?: unknown }).detail;
            if (typeof detail === "string" && detail.trim()) return detail;
        }
        return "Import failed";
    };

    const result = (async (): Promise<PortfolioImportResult> => {
        try {
            const response = await fetch(url, {
                method: "POST",
                body: formData,
                headers: { "X-Request-Id": generateRequestId() },
                signal: controller.signal,
            });
            if (!response.ok)
                throw await parseEnvelopeError(response, "Import failed");

            let finalResult: PortfolioImportResult | null = null;
            for await (const { event, data } of readSseStream<unknown>(
                response,
                { schemas: PORTFOLIO_STREAM_SCHEMAS },
            )) {
                if (event === "progress") {
                    onProgress(data as ImportProgress);
                    continue;
                }
                if (event === "complete") {
                    finalResult = data as PortfolioImportResult;
                    onProgress({
                        ...(data as Partial<ImportProgress>),
                        phase: "complete",
                        percent: 100,
                    } as ImportProgress);
                    continue;
                }
                if (event === "review_required") {
                    const d = data as {
                        batch_id: number;
                        match_source_counts?: unknown;
                        skipped?: number;
                    };
                    finalResult = {
                        batch_id: d.batch_id,
                        imported: 0,
                        duplicates: 0,
                        errors: 0,
                        skipped: d.skipped,
                        status: "review_required",
                        requires_review: true,
                    };
                    onProgress({
                        phase: "review_required",
                        current: 0,
                        total: 0,
                        imported: 0,
                        duplicates: 0,
                        errors: 0,
                        percent: 70,
                    } as ImportProgress);
                    continue;
                }
                if (event === "error")
                    throw new Error(extractErrorDetail(data));
            }
            return (
                finalResult ?? {
                    batch_id: 0,
                    imported: 0,
                    duplicates: 0,
                    errors: 0,
                    status: "completed",
                }
            );
        } catch (err) {
            if ((err as Error).name === "AbortError")
                throw new ImportCancelledError({ cause: err });
            throw err;
        }
    })();

    return { abort: () => controller.abort(), result };
}

// --- Saved portfolio parsers ---
/** Canonical `{items, total}` collection body — callers only need the rows. */
export async function listPortfolioParserConfigs(): Promise<
    SavedPortfolioParserConfig[]
> {
    const { items } = await apiRequest<{
        items: SavedPortfolioParserConfig[];
        total: number;
    }>("/api/portfolio/import/parsers");
    return items;
}

export function createPortfolioParserConfig(
    name: string,
    config: PortfolioCustomConfig,
): Promise<SavedPortfolioParserConfig> {
    return apiRequest<SavedPortfolioParserConfig>(
        "/api/portfolio/import/parsers",
        {
            method: "POST",
            body: JSON.stringify({ name, config }),
        },
    );
}

export function updatePortfolioParserConfig(
    id: number,
    patch: { name?: string; config?: PortfolioCustomConfig },
): Promise<SavedPortfolioParserConfig> {
    return apiRequest<SavedPortfolioParserConfig>(
        `/api/portfolio/import/parsers/${id}`,
        {
            method: "PATCH",
            body: JSON.stringify(patch),
        },
    );
}

export function deletePortfolioParserConfig(id: number): Promise<void> {
    return apiRequest<void>(`/api/portfolio/import/parsers/${id}`, {
        method: "DELETE",
    });
}

// --- Batches + review ---
export function getPortfolioImportPreview(
    batchId: number,
): Promise<PortfolioPreviewResponse> {
    return apiRequest<PortfolioPreviewResponse>(
        `/api/portfolio/import/batches/${batchId}/preview`,
    );
}

export function overridePortfolioImportRow(
    batchId: number,
    rowId: number,
    payload: { investmentId?: number | null; createNew?: boolean },
): Promise<{
    row_id: number;
    investment_id?: number;
    created?: boolean;
    user_override_investment_id?: number | null;
}> {
    const body = payload.createNew
        ? { create_new: true }
        : { investment_id: payload.investmentId ?? null };
    return apiRequest(
        `/api/portfolio/import/batches/${batchId}/rows/${rowId}/investment-override`,
        {
            method: "POST",
            body: JSON.stringify(body),
        },
    );
}

export function overridePortfolioImportRows(
    batchId: number,
    rowIds: number[],
    payload: { investmentId?: number; createNew?: boolean },
): Promise<{
    investment_id: number;
    created: boolean;
    resolved: number;
    investment?: unknown;
}> {
    const body = payload.createNew
        ? { row_ids: rowIds, create_new: true }
        : { row_ids: rowIds, investment_id: payload.investmentId };
    return apiRequest(
        `/api/portfolio/import/batches/${batchId}/rows/investment-override`,
        {
            method: "POST",
            body: JSON.stringify(body),
        },
    );
}

export function commitPortfolioImportBatch(
    batchId: number,
    accountId?: number | null,
): Promise<{
    batch_id: number;
    imported: number;
    duplicates: number;
    errors: number;
}> {
    return apiRequest(`/api/portfolio/import/batches/${batchId}/commit`, {
        method: "POST",
        body: JSON.stringify(
            accountId != null ? { account_id: accountId } : {},
        ),
    });
}

export function rollbackPortfolioImportBatch(
    id: number,
): Promise<{ deleted: number }> {
    return apiRequest<{ deleted: number }>(
        `/api/portfolio/import/batches/${id}`,
        { method: "DELETE" },
    );
}

export type PortfolioReconciliationPolicy =
    "preserve_existing" | "prefer_source";
const batchPolicySchema = z.object({
    batchId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    adoptPolicy: z.enum(["preserve_existing", "prefer_source"]),
});
export type PortfolioBatchPolicy = z.infer<typeof batchPolicySchema>;

const portfolioBatchIdSchema = z
    .union([
        z.number(),
        z
            .string()
            .regex(/^[1-9]\d*$/)
            .transform(Number),
    ])
    .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER));
const portfolioImportBatchPageSchema = z.object({
    items: z
        .array(
            z.looseObject({
                id: portfolioBatchIdSchema,
                adapter_name: z.string(),
                source_filename: z.string().nullable().optional(),
                account_id: portfolioBatchIdSchema.nullable().optional(),
                status: z.enum([
                    "pending",
                    "staging",
                    "validating",
                    "matching",
                    "committing",
                    "complete",
                    "complete_with_errors",
                    "failed",
                    "aborted",
                    "awaiting_review",
                ]),
                rows_total: z.number().int().nonnegative(),
                rows_error: z.number().int().nonnegative(),
            }),
        )
        .max(200),
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive().max(200),
    offset: z.number().int().nonnegative(),
});
export type PortfolioImportBatchPage = z.infer<
    typeof portfolioImportBatchPageSchema
>;
export async function listPortfolioImportBatches(
    limit = 50,
    offset = 0,
): Promise<PortfolioImportBatchPage> {
    const pagination = z
        .object({
            limit: z.number().int().positive().max(200),
            offset: z.number().int().nonnegative(),
        })
        .parse({ limit, offset });
    const result = await apiRequest<unknown>(
        `/api/portfolio/import/batches?limit=${pagination.limit}&offset=${pagination.offset}`,
    );
    const parsed = portfolioImportBatchPageSchema.safeParse(result);
    if (
        parsed.success &&
        parsed.data.limit === limit &&
        parsed.data.offset === offset
    )
        return parsed.data;
    const error = new Error("Unverified portfolio batch response");
    error.name = "PortfolioImportResponseError";
    throw error;
}

const reconciliationValuesSchema = z
    .record(z.string(), z.union([z.string(), z.number(), z.null()]))
    .superRefine((values, context) => {
        if (
            values.dividend_amount_convention != null &&
            !["gross", "net", "unknown"].includes(
                String(values.dividend_amount_convention),
            )
        )
            context.addIssue({
                code: "custom",
                message: "Invalid dividend amount convention",
                path: ["dividend_amount_convention"],
            });
    });
const reconciliationBlockerSchema = z.object({
    batchId: z.number().int().positive(),
    rowId: z.number().int().positive().optional(),
    rowOrdinal: z.number().int().positive().optional(),
    referenceTransactionId: z.string().uuid().optional(),
    reason: z.string(),
    candidateTransactionIds: z.array(z.number()),
});
const reconciliationPlanSchema = z.looseObject({
    batchIds: z.array(z.number().int().positive()),
    adoptPolicy: z.enum(["preserve_existing", "prefer_source"]).nullable(),
    batchPolicies: z.array(batchPolicySchema).max(100).default([]),
    planFingerprint: z.string().min(1),
    ready: z.boolean(),
    actions: z.array(
        z
            .looseObject({
                batchId: z.number().int().positive(),
                rowId: z.number().int().positive(),
                rowOrdinal: z.number().int().positive(),
                action: z.string(),
                policy: z
                    .enum(["exact", "preserve_existing", "prefer_source"])
                    .optional(),
                existingTransactionId: z
                    .number()
                    .int()
                    .positive()
                    .max(Number.MAX_SAFE_INTEGER)
                    .optional(),
                importedTransactionId: z
                    .number()
                    .int()
                    .positive()
                    .max(Number.MAX_SAFE_INTEGER)
                    .optional(),
                originalBatchId: z
                    .number()
                    .int()
                    .positive()
                    .max(Number.MAX_SAFE_INTEGER)
                    .optional(),
                source: reconciliationValuesSchema.optional(),
                existing: reconciliationValuesSchema.optional(),
                importedExisting: reconciliationValuesSchema.optional(),
                adjustment: z
                    .object({
                        date: z.string(),
                        units: z.string(),
                        kind: z.enum(["yield_reversal", "asset_fee"]),
                        basisPolicy: z.enum(["zero_yield_only", "carried"]),
                        accountId: z
                            .number()
                            .int()
                            .positive()
                            .max(Number.MAX_SAFE_INTEGER),
                    })
                    .optional(),
                corrections: z.array(z.string()).optional(),
                economicsProven: z.boolean().optional(),
                transfer: z
                    .object({
                        date: z.string(),
                        units: z.string(),
                        feeUnits: z.string(),
                        receivedUnits: z.string(),
                        sourceAccountId: z.number().int().positive(),
                        destinationAccountId: z.number().int().positive(),
                    })
                    .optional(),
            })
            .superRefine((action, context) => {
                if (
                    action.action === "repair_duplicate" &&
                    (!action.existingTransactionId ||
                        !action.importedTransactionId ||
                        !action.originalBatchId ||
                        !action.source ||
                        !action.existing ||
                        !action.importedExisting ||
                        action.existingTransactionId ===
                            action.importedTransactionId)
                )
                    context.addIssue({
                        code: "custom",
                        message: "Incomplete duplicate repair evidence",
                    });
                if (action.action === "adjustment" && !action.adjustment)
                    context.addIssue({
                        code: "custom",
                        message: "Incomplete asset adjustment evidence",
                    });
            }),
    ),
    blockers: z.array(reconciliationBlockerSchema),
    summary: z.record(z.string(), z.number().int().nonnegative()),
});
export type PortfolioReconciliationPlan = z.infer<
    typeof reconciliationPlanSchema
>;

const reviewedImportResultSchema = z.looseObject({
    batches: z.array(
        z.looseObject({
            batch_id: z.number().int().positive(),
            imported: z.number().int().nonnegative(),
            duplicates: z.number().int().nonnegative(),
            adopted: z.number().int().nonnegative(),
            repaired: z.number().int().nonnegative(),
            errors: z.number().int().nonnegative(),
        }),
    ),
    imported: z.number().int().nonnegative(),
    duplicates: z.number().int().nonnegative(),
    adopted: z.number().int().nonnegative(),
    repaired: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
});
export type ReviewedPortfolioImportResult = z.infer<
    typeof reviewedImportResultSchema
>;

export interface PortfolioReconciliationScope {
    batchIds: number[];
    adoptPolicy?: PortfolioReconciliationPolicy;
    batchPolicies?: PortfolioBatchPolicy[];
}

function reconciliationRequest(scope: PortfolioReconciliationScope) {
    const batchIds = z
        .array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
        .min(1)
        .max(100)
        .parse(scope.batchIds);
    const overrides = z
        .array(batchPolicySchema)
        .max(100)
        .parse(scope.batchPolicies ?? []);
    if (
        new Set(overrides.map((item) => item.batchId)).size !==
            overrides.length ||
        overrides.some((item) => !batchIds.includes(item.batchId))
    ) {
        throw new Error(
            "Statement policies must identify distinct selected batches",
        );
    }
    return {
        batch_ids: batchIds,
        ...(scope.adoptPolicy ? { adopt_policy: scope.adoptPolicy } : {}),
        ...(overrides.length
            ? {
                  batch_policies: [...overrides]
                      .sort((left, right) => left.batchId - right.batchId)
                      .map((item) => ({
                          batch_id: item.batchId,
                          adopt_policy: item.adoptPolicy,
                      })),
              }
            : {}),
    };
}

export async function previewPortfolioImportReconciliation(
    scope: PortfolioReconciliationScope,
): Promise<PortfolioReconciliationPlan> {
    const result = await apiRequest<unknown>(
        "/api/portfolio/import/reconciliation/preview",
        { method: "POST", body: JSON.stringify(reconciliationRequest(scope)) },
    );
    const parsed = reconciliationPlanSchema.safeParse(result);
    const overrides = [...(scope.batchPolicies ?? [])].sort(
        (left, right) => left.batchId - right.batchId,
    );
    if (
        !parsed.success ||
        parsed.data.actions.some(
            (action) => !scope.batchIds.includes(action.batchId),
        ) ||
        parsed.data.blockers.some(
            (blocker) => !scope.batchIds.includes(blocker.batchId),
        ) ||
        JSON.stringify(parsed.data.batchPolicies) !==
            JSON.stringify(overrides) ||
        parsed.data.adoptPolicy !== (scope.adoptPolicy ?? null) ||
        JSON.stringify([...parsed.data.batchIds].sort((a, b) => a - b)) !==
            JSON.stringify([...scope.batchIds].sort((a, b) => a - b))
    ) {
        const error = new Error("Unverified portfolio import response");
        error.name = "PortfolioImportResponseError";
        throw error;
    }
    return parsed.data;
}

export const portfolioReferenceResultSchema = z.object({
    batch_ids: z
        .array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
        .min(1)
        .max(100),
    matched_reference_rows: z.number().int().nonnegative(),
    source_corrections: z.number().int().nonnegative(),
    replacement_batches: z
        .array(
            z.object({
                original_batch_id: z
                    .number()
                    .int()
                    .positive()
                    .max(Number.MAX_SAFE_INTEGER),
                review_batch_id: z
                    .number()
                    .int()
                    .positive()
                    .max(Number.MAX_SAFE_INTEGER),
            }),
        )
        .max(100),
    supplemental_batches: z
        .array(
            z.object({
                batch_id: z
                    .number()
                    .int()
                    .positive()
                    .max(Number.MAX_SAFE_INTEGER),
                account_id: z
                    .number()
                    .int()
                    .positive()
                    .max(Number.MAX_SAFE_INTEGER),
                adapter_name: z.string().min(1),
                source_filename: z.string().min(1),
                status: z.literal("awaiting_review"),
                rows_total: z.number().int().nonnegative(),
                original_batch_id: z
                    .number()
                    .int()
                    .positive()
                    .max(Number.MAX_SAFE_INTEGER)
                    .optional(),
            }),
        )
        .max(100),
    blockers: z.array(
        z.object({
            reason: z.string().min(1),
            rowOrdinal: z.number().int().positive().optional(),
            referenceTransactionId: z.string().uuid().optional(),
            accountId: z.number().int().positive().optional(),
        }),
    ),
});
export type PortfolioReferenceResult = z.infer<
    typeof portfolioReferenceResultSchema
>;

/** Stage source corrections and supplemental history from an explicit XML reference. */
export async function applyPortfolioImportReference(options: {
    file: File;
    batchIds: number[];
    placeholderBasisPolicy: "zero";
}): Promise<PortfolioReferenceResult> {
    const batchIds = reconciliationRequest({
        batchIds: options.batchIds,
    }).batch_ids;
    const policy = z.literal("zero").parse(options.placeholderBasisPolicy);
    const form = new FormData();
    form.append("file", options.file, options.file.name);
    form.append("batch_ids", JSON.stringify(batchIds));
    form.append("placeholder_basis_policy", policy);
    const response = await rawFetch(
        `${API_BASE_URL}/api/portfolio/import/reconciliation/reference`,
        {
            method: "POST",
            body: form,
        },
    );
    if (!response.ok)
        throw await parseEnvelopeError(response, "Reference staging failed");
    const envelope = z
        .object({ ok: z.literal(true), data: portfolioReferenceResultSchema })
        .safeParse(await response.json());
    if (envelope.success) {
        const result = envelope.data.data;
        const supplementalIds = result.supplemental_batches.map(
            (batch) => batch.batch_id,
        );
        const replacedOriginals = result.replacement_batches.map(
            (batch) => batch.original_batch_id,
        );
        const replacements = result.replacement_batches.map(
            (batch) => batch.review_batch_id,
        );
        const expectedIds = [
            ...batchIds.filter((id) => !replacedOriginals.includes(id)),
            ...supplementalIds,
        ].sort((a, b) => a - b);
        if (
            new Set(replacedOriginals).size === replacedOriginals.length &&
            new Set(replacements).size === replacements.length &&
            replacedOriginals.every((id) => batchIds.includes(id)) &&
            replacements.every(
                (id) => supplementalIds.includes(id) && !batchIds.includes(id),
            ) &&
            result.supplemental_batches.every(
                (batch) =>
                    batch.original_batch_id === undefined ||
                    result.replacement_batches.some(
                        (replacement) =>
                            replacement.review_batch_id === batch.batch_id &&
                            replacement.original_batch_id ===
                                batch.original_batch_id,
                    ),
            ) &&
            result.supplemental_batches.every(
                (batch) =>
                    replacements.includes(batch.batch_id) ||
                    batch.adapter_name === "portfolio_performance_reference",
            ) &&
            new Set(expectedIds).size === expectedIds.length &&
            JSON.stringify([...result.batch_ids].sort((a, b) => a - b)) ===
                JSON.stringify(expectedIds)
        )
            return result;
    }
    const error = new Error("Unverified portfolio reference response");
    error.name = "PortfolioImportResponseError";
    throw error;
}

export async function commitReviewedPortfolioImports(
    scope: PortfolioReconciliationScope & { expectedPlanFingerprint: string },
): Promise<ReviewedPortfolioImportResult> {
    const result = await apiRequest<unknown>(
        "/api/portfolio/import/reconciliation/commit",
        {
            method: "POST",
            body: JSON.stringify({
                ...reconciliationRequest(scope),
                expected_plan_fingerprint: z
                    .string()
                    .min(1)
                    .parse(scope.expectedPlanFingerprint),
            }),
        },
    );
    const parsed = reviewedImportResultSchema.safeParse(result);
    if (
        !parsed.success ||
        parsed.data.errors !== 0 ||
        parsed.data.batches.some((batch) => batch.errors !== 0) ||
        parsed.data.batches.some(
            (batch) => batch.duplicates < batch.adopted + batch.repaired,
        ) ||
        (["imported", "duplicates", "adopted", "repaired"] as const).some(
            (field) =>
                parsed.data[field] !==
                parsed.data.batches.reduce(
                    (count, batch) => count + batch[field],
                    0,
                ),
        ) ||
        JSON.stringify(
            parsed.data.batches
                .map((batch) => batch.batch_id)
                .sort((a, b) => a - b),
        ) !== JSON.stringify([...scope.batchIds].sort((a, b) => a - b))
    ) {
        const error = new Error("Unverified portfolio import response");
        error.name = "PortfolioImportResponseError";
        throw error;
    }
    return parsed.data;
}
