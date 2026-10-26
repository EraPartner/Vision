import { isAbortError } from "@/lib/api/abortError";
import { isRecord } from "@/lib/isRecord";
import { z } from "zod";
import {
    API_BASE_URL,
    generateRequestId,
    parseEnvelopeError,
    apiRequest,
    checkResponseContract,
} from "@/lib/api/client";
import { postMultipartImport } from "@/lib/api/helpers";
import {
    completionProgress,
    importProgressSchema,
    type CsvNumberFormat,
} from "@/lib/api/imports";
import { readValidatedSse } from "@/lib/api/sse";
import { asAccountId, asInvestmentId } from "@vision/types/brands";
import type { AccountId, InvestmentId } from "@vision/types/brands";
import type { ImportProgress } from "@/types/apiClient";
import type { AssetClass } from "@vision/types/assetClasses";
import type { components } from "@/types/generated";
import type { PortfolioTxnType } from "@vision/types/portfolioTxnTypes";
import { ImportCancelledError } from "@/lib/api/importCancelled";
import {
    PortfolioBatchCommitResultSchema,
    PortfolioBatchRollbackResultSchema,
    PortfolioImportResultSchema,
    PortfolioPreviewSchema,
    PortfolioRowOverrideResultSchema,
    PortfolioRowsOverrideResultSchema,
    SavedPortfolioParserConfigListSchema,
    SavedPortfolioParserConfigSchema,
} from "@vision/types/contracts";

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

const PORTFOLIO_STREAM_SCHEMAS = {
    progress: importProgressSchema,
    complete: portfolioImportResultSchema,
    review_required: portfolioReviewRequiredSchema,
    // Unvalidated on purpose: `extractErrorDetail` tolerates any shape.
    error: z.unknown(),
};

type PortfolioImportUpload = components["schemas"]["PortfolioImportUpload"];
/** Specialized statement parsers (`portfolio_format`); omitted for generic column mapping. */
export type PortfolioImportFormat = NonNullable<
    PortfolioImportUpload["portfolio_format"]
>;
export type PortfolioYieldBasisPolicy = NonNullable<
    PortfolioImportUpload["yield_basis_policy"]
>;

export interface PortfolioCustomConfig {
    /** Optional file-level destination for every trade staged with this parser. */
    accountId?: AccountId | undefined;
    /** Destination of dated asset withdrawals, when the statement contains them. */
    transferDestinationAccountId?: AccountId | undefined;
    /** Origin of dated asset returns, when source evidence identifies prior custody. */
    transferOriginAccountId?: AccountId | undefined;
    /** Explicit zero basis for proved existing yield-unit receipts in a bounded scope. */
    yieldBasisPolicy?: PortfolioYieldBasisPolicy;
    /** Explicit comma-separated asset symbols for a partial statement import. */
    includedSymbols?: string | undefined;
    /** Format-specific parser. Omit for the generic column mapper. */
    format?: PortfolioImportFormat;
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
    sourceIdColumn?: string;
    sourceAccountColumn?: string;
    dateFormat: string;
    separator: string;
    encoding: string;
    skipRows: number;
    number_format?: CsvNumberFormat;
    defaultAssetClass: AssetClass;
    defaultType: PortfolioTxnType;
    /** Absent on saved configs that predate the mapping. */
    typeMapping?: Record<string, string> | undefined;
}

export interface SavedPortfolioParserConfig {
    id: number;
    name: string;
    kind: string;
    config: PortfolioCustomConfig;
    created_at: string;
    updated_at: string;
}

/**
 * A staged import row as node-postgres returns it: the BIGINT `id` and the
 * NUMERIC amount columns arrive as decimal strings.
 */
export interface PortfolioPreviewRow {
    id: string;
    row_index: number;
    status: string;
    /** Brokerage routing (ADR-095): 'cash' | 'portfolio' | null (legacy/non-brokerage). */
    route: string | null;
    tx_date: string | null;
    type: string | null;
    type_raw: string | null;
    symbol_raw: string | null;
    name_raw: string | null;
    units: string | null;
    price_per_unit: string | null;
    amount: string | null;
    fees: string | null;
    taxes: string | null;
    currency: string | null;
    fx_rate_to_eur: string | null;
    note: string | null;
    match_source: string | null;
    error_message: string | null;
    user_override_investment_id: InvestmentId | null;
}

export interface PortfolioPreviewGroup {
    /** Brokerage cash group (ADR-095): deposits/withdrawals, no instrument to resolve. */
    is_cash?: boolean;
    investment_id: InvestmentId | null;
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
    account_id: AccountId | null;
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
    total_processed?: number | undefined;
    total?: number | undefined;
    /** Rows the adapter could not parse (bad column mapping / date format). */
    skipped?: number | undefined;
    imported: number;
    duplicates: number;
    errors: number;
    status?: string | undefined;
    requires_review?: boolean | undefined;
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
    p.append("type_mapping", JSON.stringify(
            config.typeMapping ?? {},
        ));
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
    if (config.sourceIdColumn)
        p.append("source_id_column", config.sourceIdColumn);
    if (config.sourceAccountColumn)
        p.append("source_account_column", config.sourceAccountColumn);
    return p;
}

/** Brokerage fan-out (ADR-095): mark the import and the sleeve account its rows land on. */
export interface BrokerageImportOptions {
    isBrokerage: boolean;
    accountId?: AccountId | undefined;
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

export async function importPortfolioCSVCustom(
    file: File,
    config: PortfolioCustomConfig,
    adapterName: string,
    brokerage?: BrokerageImportOptions,
): Promise<PortfolioImportResult> {
    const result = await postMultipartImport<PortfolioImportResult>(
        "/api/portfolio/import/csv/custom",
        file,
        appendBrokerage(configToParams(config, adapterName), brokerage),
    );
    return checkResponseContract(
        PortfolioImportResultSchema,
        result,
        "POST /api/portfolio/import/csv/custom",
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
        if (isRecord(payload)) {
            const detail = payload.detail;
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
            for await (const { event, data } of readValidatedSse(
                response,
                PORTFOLIO_STREAM_SCHEMAS,
            )) {
                if (event === "progress") {
                    onProgress(data);
                    continue;
                }
                if (event === "complete") {
                    finalResult = data;
                    onProgress(completionProgress(data));
                    continue;
                }
                if (event === "review_required") {
                    const d = data;
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
                    });
                    continue;
                }
                // The only remaining registered event is "error".
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
            if (isAbortError(err))
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
    }>("/api/portfolio/import/parsers", {
        schema: SavedPortfolioParserConfigListSchema,
    });
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
            schema: SavedPortfolioParserConfigSchema,
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
            schema: SavedPortfolioParserConfigSchema,
        },
    );
}

export function deletePortfolioParserConfig(id: number): Promise<void> {
    return apiRequest(`/api/portfolio/import/parsers/${id}`, {
        method: "DELETE",
    });
}

// --- Batches + review ---
export function getPortfolioImportPreview(
    batchId: number,
): Promise<PortfolioPreviewResponse> {
    return apiRequest<PortfolioPreviewResponse>(
        `/api/portfolio/import/batches/${batchId}/preview`,
        { schema: PortfolioPreviewSchema },
    );
}

export function overridePortfolioImportRow(
    batchId: number,
    rowId: number,
    payload: { investmentId?: InvestmentId | null; createNew?: boolean },
): Promise<{
    row_id: number;
    investment_id?: InvestmentId;
    created?: boolean;
    user_override_investment_id?: InvestmentId | null;
}> {
    const body = payload.createNew
        ? { create_new: true }
        : { investment_id: payload.investmentId ?? null };
    return apiRequest(
        `/api/portfolio/import/batches/${batchId}/rows/${rowId}/investment-override`,
        {
            method: "POST",
            body: JSON.stringify(body),
            schema: PortfolioRowOverrideResultSchema,
        },
    );
}

export function overridePortfolioImportRows(
    batchId: number,
    /** Preview row ids; the route also accepts the BIGINT digit strings. */
    rowIds: ReadonlyArray<number | string>,
    payload: { investmentId?: InvestmentId; createNew?: boolean },
): Promise<{
    investment_id: InvestmentId;
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
            schema: PortfolioRowsOverrideResultSchema,
        },
    );
}

export function commitPortfolioImportBatch(
    batchId: number,
    accountId?: AccountId | null,
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
        schema: PortfolioBatchCommitResultSchema,
    });
}

export function rollbackPortfolioImportBatch(
    id: number,
): Promise<{ deleted: number }> {
    return apiRequest<{ deleted: number }>(
        `/api/portfolio/import/batches/${id}`,
        { method: "DELETE", schema: PortfolioBatchRollbackResultSchema },
    );
}

export type PortfolioReconciliationPolicy = NonNullable<
    components["schemas"]["PortfolioImportReconciliationRequest"]["adopt_policy"]
>;
const batchPolicySchema = z.object({
    batchId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    adoptPolicy: z.enum(["preserve_existing", "prefer_source"]),
});
export type PortfolioBatchPolicy = z.infer<typeof batchPolicySchema>;
/**
 * The owner's answer for a row that resembles a transaction the account
 * already holds: record it as a new transaction, or settle it as that one.
 */
const rowChoiceSchema = z.object({
    batchId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    rowId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    choice: z.enum(["keep_both", "same_transaction"]),
});
export type PortfolioRowChoice = z.infer<typeof rowChoiceSchema>;

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
                account_id: portfolioBatchIdSchema
                    .transform(asAccountId)
                    .nullable()
                    .optional(),
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
        if (
            values.income_recognition_role != null &&
            (!["standard", "included_in_units"].includes(
                String(values.income_recognition_role),
            ) ||
                (values.income_recognition_role === "included_in_units" &&
                    values.type !== "dividend"))
        )
            context.addIssue({
                code: "custom",
                message: "Invalid income recognition role",
                path: ["income_recognition_role"],
            });
    });
const reconciliationBlockerSchema = z.object({
    batchId: z.number().int().positive(),
    rowId: z.number().int().positive().optional(),
    rowOrdinal: z.number().int().positive().optional(),
    reason: z.string(),
    candidateTransactionIds: z.array(z.number()),
});
const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const reconciliationPlanSchema = z.looseObject({
    batchIds: z.array(z.number().int().positive()),
    adoptPolicy: z.enum(["preserve_existing", "prefer_source"]).nullable(),
    batchPolicies: z.array(batchPolicySchema).max(100).default([]),
    rowChoices: z.array(rowChoiceSchema).default([]),
    ready: z.boolean(),
    actions: z.array(
        z
            .looseObject({
                batchId: z.number().int().positive(),
                rowId: z.number().int().positive(),
                rowOrdinal: z.number().int().positive(),
                action: z.string(),
                investmentId: positiveId
                    .transform(asInvestmentId)
                    .nullable()
                    .optional(),
                policy: z
                    .enum(["exact", "preserve_existing", "prefer_source"])
                    .nullable()
                    .optional(),
                existingTransactionId: positiveId.optional(),
                source: reconciliationValuesSchema.optional(),
                existing: reconciliationValuesSchema.optional(),
                adjustment: z
                    .object({
                        date: z.string(),
                        units: z.string(),
                        kind: z.enum(["yield_reversal", "asset_fee"]),
                        basisPolicy: z.enum(["zero_yield_only", "carried"]),
                        accountId: positiveId.transform(asAccountId),
                    })
                    .optional(),
                corrections: z.array(z.string()).optional(),
                economicsProven: z.boolean().optional(),
                /** Settled by another export of the same broker history. */
                crossFormat: z.boolean().optional(),
                /** The existing transaction is brokerage cash. */
                cash: z.boolean().optional(),
                duplicateOfRowId: positiveId.optional(),
                transfer: z
                    .object({
                        date: z.string(),
                        units: z.string(),
                        feeUnits: z.string(),
                        receivedUnits: z.string(),
                        sourceAccountId: z
                            .number()
                            .int()
                            .positive()
                            .transform(asAccountId),
                        destinationAccountId: z
                            .number()
                            .int()
                            .positive()
                            .transform(asAccountId),
                    })
                    .optional(),
            })
            .superRefine((action, context) => {
                if (
                    action.action === "adopt" &&
                    action.existingTransactionId === undefined
                )
                    context.addIssue({
                        code: "custom",
                        message: "Adoption without an existing transaction",
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
            errors: z.number().int().nonnegative(),
        }),
    ),
    imported: z.number().int().nonnegative(),
    duplicates: z.number().int().nonnegative(),
    adopted: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
});
export type ReviewedPortfolioImportResult = z.infer<
    typeof reviewedImportResultSchema
>;

export interface PortfolioReconciliationScope {
    batchIds: number[];
    adoptPolicy?: PortfolioReconciliationPolicy | undefined;
    batchPolicies?: PortfolioBatchPolicy[] | undefined;
    rowChoices?: PortfolioRowChoice[] | undefined;
}

function reconciliationRequest(scope: PortfolioReconciliationScope) {
    const rowChoices = z
        .array(rowChoiceSchema)
        .max(10000)
        .parse(scope.rowChoices ?? []);
    const batchIds = z
        .array(positiveId)
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
        ...(overrides.length > 0
            ? {
                  batch_policies: [...overrides]
                      .sort((left, right) => left.batchId - right.batchId)
                      .map((item) => ({
                          batch_id: item.batchId,
                          adopt_policy: item.adoptPolicy,
                      })),
              }
            : {}),
        ...(rowChoices.length > 0
            ? {
                  row_choices: rowChoices.map((item) => ({
                      batch_id: item.batchId,
                      row_id: item.rowId,
                      choice: item.choice,
                  })),
              }
            : {}),
    };
}

const sortedIds = (ids: readonly number[]) =>
    JSON.stringify([...ids].sort((a, b) => a - b));
/** Row choices in the order the server echoes them. */
const sortedChoices = (choices: readonly PortfolioRowChoice[]) =>
    [...choices]
        .sort((left, right) =>
            left.batchId === right.batchId
                ? left.rowId - right.rowId
                : left.batchId - right.batchId,
        )
        .map(({ batchId, rowId, choice }) => ({ batchId, rowId, choice }));

function unverifiedResponse(): Error {
    const error = new Error("Unverified portfolio import response");
    error.name = "PortfolioImportResponseError";
    return error;
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
        JSON.stringify(parsed.data.rowChoices) !==
            JSON.stringify(sortedChoices(scope.rowChoices ?? [])) ||
        parsed.data.adoptPolicy !== (scope.adoptPolicy ?? null) ||
        sortedIds(parsed.data.batchIds) !== sortedIds(scope.batchIds)
    )
        throw unverifiedResponse();
    return parsed.data;
}

export async function commitReviewedPortfolioImports(
    scope: PortfolioReconciliationScope,
): Promise<ReviewedPortfolioImportResult> {
    const result = await apiRequest<unknown>(
        "/api/portfolio/import/reconciliation/commit",
        { method: "POST", body: JSON.stringify(reconciliationRequest(scope)) },
    );
    const parsed = reviewedImportResultSchema.safeParse(result);
    if (
        !parsed.success ||
        parsed.data.errors !== 0 ||
        parsed.data.batches.some((batch) => batch.errors !== 0) ||
        (["imported", "duplicates", "adopted"] as const).some(
            (field) =>
                parsed.data[field] !==
                parsed.data.batches.reduce(
                    (count, batch) => count + batch[field],
                    0,
                ),
        ) ||
        sortedIds(parsed.data.batches.map((batch) => batch.batch_id)) !==
            sortedIds(scope.batchIds)
    )
        throw unverifiedResponse();
    return parsed.data;
}
