import { z } from "zod";
import {
    API_BASE_URL,
    generateRequestId,
    parseEnvelopeError,
    apiRequest,
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
    /** Explicit zero basis for proved existing yield-unit receipts in a bounded scope. */
    yieldBasisPolicy?: "zero";
    /** Explicit comma-separated asset symbols for a partial statement import. */
    includedSymbols?: string;
    /** Format-specific parser. Omit for the generic column mapper. */
    format?:
        | "ibkr_transaction_history"
        | "ibkr_funding_history"
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
    sourceIdColumn?: string;
    sourceAccountColumn?: string;
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
    if (config.sourceIdColumn)
        p.append("source_id_column", config.sourceIdColumn);
    if (config.sourceAccountColumn)
        p.append("source_account_column", config.sourceAccountColumn);
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
const reconciliationModeSchema = z.enum([
    "full",
    "adopt_existing_only",
    "correct_existing_only",
    "record_in_kind_income_only",
    "record_cash_only",
]);

export type PortfolioReconciliationMode = z.infer<
    typeof reconciliationModeSchema
>;
const reconciliationMetadata = {
    reconciliationScope: reconciliationModeSchema.optional(),
    pending: z.number().int().nonnegative().optional(),
    complete: z.boolean().optional(),
    deferredCounts: z
        .record(z.string(), z.number().int().nonnegative())
        .optional(),
};
const selectedRowIdsSchema = z
    .array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
    .refine((ids) => new Set(ids).size === ids.length);
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
    referenceTransactionId: z.string().uuid().optional(),
    reason: z.string(),
    candidateTransactionIds: z.array(z.number()),
});
const cashValuesSchema = z.strictObject({
    date: z.iso.date(),
    amount: z.string().regex(/^-?\d+(?:\.\d+)?$/),
    currency: z.string().regex(/^[A-Z]{3}$/),
    accountId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    isTransfer: z.boolean(),
    transferSource: z.literal("brokerage"),
    transferPeerId: z.null(),
});
const cashProofSchema = z.strictObject({
    kind: z.literal("closed_kinesis_cash"),
    groupKey: z.string().regex(/^[a-f0-9]{64}$/),
    eventKey: z.string().regex(/^[a-f0-9]{64}$/),
    eventKind: z.enum(["trade_quote", "own_account_funding", "card_expense"]),
    fileHash: z.string().regex(/^[a-f0-9]{64}$/),
    memberCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    componentCount: z.union([z.literal(1), z.literal(2)]),
});
const reconciliationPlanSchema = z.looseObject({
    ...reconciliationMetadata,
    selectedRowIds: selectedRowIdsSchema.optional(),
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
                investmentId: z
                    .number()
                    .int()
                    .positive()
                    .max(Number.MAX_SAFE_INTEGER)
                    .nullable()
                    .optional(),
                isCash: z.boolean().optional(),
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
                cashValues: cashValuesSchema.optional(),
                cashFeeValues: cashValuesSchema.optional(),
                cashProof: cashProofSchema.optional(),
                existingCashFeeTransactionId: z
                    .number()
                    .int()
                    .positive()
                    .max(Number.MAX_SAFE_INTEGER)
                    .optional(),
                incomeProof: z
                    .strictObject({
                        kind: z.literal("paired_kinesis_income"),
                        unitRowId: z
                            .number()
                            .int()
                            .positive()
                            .max(Number.MAX_SAFE_INTEGER)
                            .optional(),
                        unitTransactionId: z
                            .number()
                            .int()
                            .positive()
                            .max(Number.MAX_SAFE_INTEGER)
                            .optional(),
                    })
                    .optional(),
                dateProof: z
                    .strictObject({
                        kind: z.literal("closed_kinesis_yield_group"),
                        groupKey: z.string().regex(/^[a-f0-9]{64}$/),
                        recordedDate: z.iso.date(),
                        paymentDate: z.iso.date(),
                        memberCount: z.number().int().positive(),
                    })
                    .optional(),
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
                    action.isCash &&
                    action.action === "adopt" &&
                    (action.investmentId != null ||
                        action.policy !== "prefer_source" ||
                        !action.existingTransactionId ||
                        !action.corrections?.length ||
                        action.corrections.some(
                            (field) => !["amount", "currency"].includes(field),
                        ) ||
                        action.source?.date !== action.existing?.date ||
                        [action.source, action.existing].some(
                            (values) =>
                                !values ||
                                !z.iso.date().safeParse(values.date).success ||
                                typeof values.currency !== "string" ||
                                !/^[A-Z]{3}$/.test(values.currency) ||
                                values.amount == null ||
                                (typeof values.amount === "string" &&
                                    !values.amount.trim()) ||
                                !Number.isFinite(Number(values.amount)) ||
                                Number(values.amount) === 0,
                        ))
                )
                    context.addIssue({
                        code: "custom",
                        message: "Incomplete cash correction evidence",
                    });
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

function verifiedDateCorrection(
    action: PortfolioReconciliationPlan["actions"][number],
) {
    const { dateProof, source, existing } = action;
    return Boolean(
        dateProof &&
        source &&
        existing &&
        action.corrections?.length === 1 &&
        action.corrections[0] === "date" &&
        dateProof.recordedDate !== dateProof.paymentDate &&
        existing.date === dateProof.recordedDate &&
        source.date === dateProof.paymentDate &&
        existing.type === "gift" &&
        ["amount", "price_per_unit", "fees", "taxes"].every(
            (field) => existing[field] == null || Number(existing[field]) === 0,
        ) &&
        [
            "type",
            "units",
            "amount",
            "price_per_unit",
            "fees",
            "taxes",
            "currency",
            "fx_rate_to_eur",
            "dividend_amount_convention",
        ].every((field) => source[field] === existing[field]),
    );
}

function verifiedDateProofGroups(
    actions: PortfolioReconciliationPlan["actions"],
) {
    const groups = new Map<
        string,
        {
            paymentDate: string;
            memberCount: number;
            transactionIds: Set<number>;
        }
    >();
    const matchedTransactionIds = new Set<number>();
    for (const action of actions) {
        if (!action.dateProof) continue;
        const { groupKey, paymentDate, memberCount } = action.dateProof;
        const group = groups.get(groupKey);
        if (
            action.action !== "adopt" ||
            !action.existingTransactionId ||
            matchedTransactionIds.has(action.existingTransactionId) ||
            !verifiedDateCorrection(action) ||
            (group &&
                (group.paymentDate !== paymentDate ||
                    group.memberCount !== memberCount ||
                    group.transactionIds.has(action.existingTransactionId)))
        )
            return false;
        const transactionIds = group?.transactionIds ?? new Set<number>();
        transactionIds.add(action.existingTransactionId);
        if (transactionIds.size > memberCount) return false;
        matchedTransactionIds.add(action.existingTransactionId);
        groups.set(groupKey, { paymentDate, memberCount, transactionIds });
    }
    return true;
}

function verifiedIncomeProofActions(
    actions: PortfolioReconciliationPlan["actions"],
    full = false,
) {
    const unitIds = new Set<number>();
    const unitRowIds = new Set<number>();
    const existingIncomeIds = new Set<number>();
    const incomes = full
        ? actions.filter(
              (action) =>
                  action.incomeProof || action.action === "record_income",
          )
        : actions;
    const valid = incomes.every((action) => {
        const proof = action.incomeProof;
        if (
            !proof ||
            !["record_income", "duplicate", "settled"].includes(
                action.action,
            ) ||
            action.dateProof ||
            action.corrections?.length ||
            action.cashProof ||
            action.cashValues ||
            action.cashFeeValues ||
            action.transfer ||
            action.adjustment ||
            action.policy === "prefer_source" ||
            (proof.unitTransactionId !== undefined &&
                unitIds.has(proof.unitTransactionId))
        )
            return false;
        if (proof.unitTransactionId !== undefined)
            unitIds.add(proof.unitTransactionId);
        if (full) {
            if (!proof.unitRowId || unitRowIds.has(proof.unitRowId))
                return false;
            unitRowIds.add(proof.unitRowId);
            const units = actions.filter(
                (candidate) => candidate.rowId === proof.unitRowId,
            );
            const unit = units[0];
            const unitDate = unit?.source?.date ?? unit?.existing?.date;
            const incomeDate = action.source?.date ?? action.existing?.date;
            if (
                units.length !== 1 ||
                unit === action ||
                unit.batchId !== action.batchId ||
                !["insert", "adopt", "duplicate", "settled"].includes(
                    unit.action,
                ) ||
                unit.incomeProof ||
                unit.cashProof ||
                (unit.source && unit.source.type !== "gift") ||
                (unit.existing && unit.existing.type !== "gift") ||
                (unitDate != null &&
                    incomeDate != null &&
                    unitDate !== incomeDate) ||
                (unit.source &&
                    (["amount", "price_per_unit", "fees", "taxes"].some(
                        (field) => Number(unit.source?.[field] ?? 0) !== 0,
                    ) ||
                        (unit.source.income_recognition_role != null &&
                            unit.source.income_recognition_role !==
                                "standard"))) ||
                !unit.investmentId ||
                !action.investmentId ||
                unit.investmentId !== action.investmentId
            )
                return false;
            if (unit.action === "insert") {
                if (
                    action.action !== "record_income" ||
                    proof.unitTransactionId !== undefined ||
                    unit.source?.type !== "gift" ||
                    Number(unit.source.units) <= 0 ||
                    !Number.isFinite(Number(unit.source.units)) ||
                    ["amount", "price_per_unit", "fees", "taxes"].some(
                        (field) => Number(unit.source?.[field] ?? 0) !== 0,
                    )
                )
                    return false;
            } else if (
                !proof.unitTransactionId ||
                unit.existingTransactionId !== proof.unitTransactionId
            )
                return false;
        } else if (!proof.unitTransactionId || proof.unitRowId !== undefined)
            return false;
        if (action.action === "record_income") {
            const source = action.source;
            return Boolean(
                source &&
                !action.existingTransactionId &&
                source.type === "dividend" &&
                source.income_recognition_role === "included_in_units" &&
                source.units === null &&
                source.price_per_unit === null &&
                source.fx_rate_to_eur == null &&
                source.amount !== null &&
                source.amount !== undefined &&
                String(source.amount).trim() &&
                Number.isFinite(Number(source.amount)) &&
                Number(source.amount) >= 0 &&
                z.iso.date().safeParse(source.date).success &&
                source.currency &&
                ["fees", "taxes"].every(
                    (field) => Number(source[field] ?? 0) === 0,
                ),
            );
        }
        const incomeId = action.existingTransactionId;
        if (
            !incomeId ||
            incomeId === proof.unitTransactionId ||
            existingIncomeIds.has(incomeId) ||
            (action.source && action.source.type !== "dividend") ||
            (action.existing &&
                (action.existing.type !== "dividend" ||
                    (action.existing.income_recognition_role != null &&
                        action.existing.income_recognition_role !==
                            "included_in_units")))
        )
            return false;
        existingIncomeIds.add(incomeId);
        return true;
    });
    return valid && [...unitIds].every((id) => !existingIncomeIds.has(id));
}

function verifiedCashProofActions(
    actions: PortfolioReconciliationPlan["actions"],
) {
    const groups = new Map<
        string,
        {
            batchId: number;
            fileHash: string;
            memberCount: number;
            count: number;
        }
    >();
    const eventKeys = new Set<string>();
    const existingIds = new Set<number>();
    for (const action of actions) {
        const proof = action.cashProof;
        const values = action.cashValues;
        const fee = action.cashFeeValues;
        if (
            !proof ||
            !["cash", "duplicate", "settled"].includes(action.action) ||
            action.incomeProof ||
            action.dateProof ||
            action.transfer ||
            action.adjustment ||
            action.source ||
            action.existing ||
            action.importedExisting ||
            action.corrections?.length ||
            action.importedTransactionId ||
            action.originalBatchId ||
            action.policy === "prefer_source" ||
            eventKeys.has(proof.eventKey)
        )
            return false;
        eventKeys.add(proof.eventKey);
        if (action.action === "cash") {
            if (
                !values ||
                action.existingTransactionId ||
                action.existingCashFeeTransactionId
            )
                return false;
        } else {
            if (
                !action.existingTransactionId ||
                existingIds.has(action.existingTransactionId)
            )
                return false;
            existingIds.add(action.existingTransactionId);
            if (proof.componentCount === 2) {
                if (
                    !action.existingCashFeeTransactionId ||
                    existingIds.has(action.existingCashFeeTransactionId)
                )
                    return false;
                existingIds.add(action.existingCashFeeTransactionId);
            }
        }
        if (
            proof.componentCount === 1 &&
            (fee || action.existingCashFeeTransactionId)
        )
            return false;
        if (
            proof.componentCount === 2 &&
            (proof.eventKind !== "own_account_funding" ||
                Boolean(values) !== Boolean(fee) ||
                (values &&
                    fee &&
                    (Number(values.amount) >= 0 ||
                        Number(fee.amount) >= 0 ||
                        !Number.isFinite(Number(fee.amount)) ||
                        fee.isTransfer ||
                        fee.accountId !== values.accountId ||
                        fee.date !== values.date ||
                        fee.currency !== values.currency)))
        )
            return false;
        if (
            values &&
            (values.isTransfer !== (proof.eventKind !== "card_expense") ||
                !Number.isFinite(Number(values.amount)) ||
                Number(values.amount) === 0 ||
                (proof.eventKind === "card_expense" &&
                    Number(values.amount) >= 0))
        )
            return false;
        const group = groups.get(proof.groupKey);
        if (
            group &&
            (group.batchId !== action.batchId ||
                group.fileHash !== proof.fileHash ||
                group.memberCount !== proof.memberCount)
        )
            return false;
        groups.set(proof.groupKey, {
            batchId: action.batchId,
            fileHash: proof.fileHash,
            memberCount: proof.memberCount,
            count: (group?.count ?? 0) + 1,
        });
    }
    return [...groups.values()].every(
        (group) => group.count === group.memberCount,
    );
}

function verifiedRecordedSubtotals(result: ReviewedPortfolioImportResult) {
    for (const field of ["recordedIncome", "recordedCash"] as const) {
        const count = result[field];
        if (count === undefined) {
            if (result.batches.some((batch) => batch[field] !== undefined))
                return false;
        } else if (
            result.batches.some((batch) => batch[field] === undefined) ||
            count !==
                result.batches.reduce(
                    (sum, batch) => sum + (batch[field] ?? 0),
                    0,
                )
        )
            return false;
    }
    return (
        (result.recordedIncome ?? 0) + (result.recordedCash ?? 0) <=
            result.imported &&
        result.batches.every(
            (batch) =>
                (batch.recordedIncome ?? 0) + (batch.recordedCash ?? 0) <=
                batch.imported,
        )
    );
}

const reviewedImportResultSchema = z.looseObject({
    ...reconciliationMetadata,
    selectedRowIds: selectedRowIdsSchema.optional(),
    batches: z.array(
        z.looseObject({
            ...reconciliationMetadata,
            batch_id: z.number().int().positive(),
            imported: z.number().int().nonnegative(),
            duplicates: z.number().int().nonnegative(),
            adopted: z.number().int().nonnegative(),
            repaired: z.number().int().nonnegative(),
            errors: z.number().int().nonnegative(),
            recordedIncome: z.number().int().nonnegative().optional(),
            recordedCash: z.number().int().nonnegative().optional(),
        }),
    ),
    imported: z.number().int().nonnegative(),
    duplicates: z.number().int().nonnegative(),
    adopted: z.number().int().nonnegative(),
    repaired: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    recordedIncome: z.number().int().nonnegative().optional(),
    recordedCash: z.number().int().nonnegative().optional(),
});
export type ReviewedPortfolioImportResult = z.infer<
    typeof reviewedImportResultSchema
>;

export interface PortfolioReconciliationScope {
    batchIds: number[];
    adoptPolicy?: PortfolioReconciliationPolicy;
    batchPolicies?: PortfolioBatchPolicy[];
    reconciliationScope?: PortfolioReconciliationMode;
    cashFundingPolicy?: "own_account_transfer";
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
    const reconciliationScope = reconciliationModeSchema.parse(
        scope.reconciliationScope ?? "full",
    );
    if (
        new Set(overrides.map((item) => item.batchId)).size !==
            overrides.length ||
        overrides.some((item) => !batchIds.includes(item.batchId))
    ) {
        throw new Error(
            "Statement policies must identify distinct selected batches",
        );
    }
    if (
        reconciliationScope === "adopt_existing_only" &&
        batchIds.some(
            (batchId) =>
                (overrides.find((item) => item.batchId === batchId)
                    ?.adoptPolicy ?? scope.adoptPolicy) !== "preserve_existing",
        )
    )
        throw new Error("Source attachment requires preserving existing facts");
    if (
        reconciliationScope === "correct_existing_only" &&
        (scope.adoptPolicy !== "prefer_source" ||
            overrides.some((item) => item.adoptPolicy !== "prefer_source"))
    )
        throw new Error("Existing corrections require explicit source facts");
    if (
        reconciliationScope === "record_in_kind_income_only" &&
        (scope.adoptPolicy !== "preserve_existing" ||
            overrides.some((item) => item.adoptPolicy !== "preserve_existing"))
    )
        throw new Error(
            "In-kind income requires preserving proved existing units",
        );
    if (
        reconciliationScope === "record_cash_only" &&
        (scope.adoptPolicy !== "preserve_existing" ||
            overrides.some(
                (item) => item.adoptPolicy !== "preserve_existing",
            ) ||
            scope.cashFundingPolicy !== "own_account_transfer")
    )
        throw new Error(
            "Cash recording requires preserving existing facts and confirmed own-account funding",
        );
    if (
        reconciliationScope !== "record_cash_only" &&
        scope.cashFundingPolicy !== undefined
    )
        throw new Error(
            "Cash funding confirmation requires the cash-only scope",
        );
    return {
        batch_ids: batchIds,
        ...(reconciliationScope !== "full"
            ? { reconciliation_scope: reconciliationScope }
            : {}),
        ...(scope.adoptPolicy ? { adopt_policy: scope.adoptPolicy } : {}),
        ...(scope.cashFundingPolicy
            ? { cash_funding_policy: scope.cashFundingPolicy }
            : {}),
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

function verifiedReconciliationScope(
    result: {
        reconciliationScope?: PortfolioReconciliationMode;
        pending?: number;
        complete?: boolean;
        deferredCounts?: Record<string, number>;
    },
    expectedScope: PortfolioReconciliationMode,
) {
    if ((result.reconciliationScope ?? "full") !== expectedScope) return false;
    if (
        (expectedScope !== "full" ||
            result.complete !== undefined ||
            result.pending !== undefined ||
            result.deferredCounts !== undefined) &&
        (result.pending === undefined ||
            result.complete === undefined ||
            result.deferredCounts === undefined)
    )
        return false;
    return (
        !(
            result.pending !== undefined &&
            result.complete !== undefined &&
            result.complete !== (result.pending === 0)
        ) &&
        !(
            result.pending !== undefined &&
            result.deferredCounts !== undefined &&
            Object.values(result.deferredCounts).reduce(
                (count, value) => count + value,
                0,
            ) !== result.pending
        )
    );
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
        !verifiedReconciliationScope(
            parsed.data,
            scope.reconciliationScope ?? "full",
        ) ||
        (parsed.data.actions.some((action) => action.dateProof) &&
            (scope.reconciliationScope !== "correct_existing_only" ||
                !verifiedDateProofGroups(parsed.data.actions))) ||
        (parsed.data.actions.some(
            (action) => action.incomeProof || action.action === "record_income",
        ) &&
            !["full", "record_in_kind_income_only"].includes(
                scope.reconciliationScope ?? "full",
            )) ||
        (["full", "record_in_kind_income_only"].includes(
            scope.reconciliationScope ?? "full",
        ) &&
            !verifiedIncomeProofActions(
                parsed.data.actions,
                (scope.reconciliationScope ?? "full") === "full",
            )) ||
        (parsed.data.actions.some(
            (action) =>
                action.cashProof ||
                action.cashValues ||
                action.cashFeeValues ||
                action.existingCashFeeTransactionId,
        ) &&
            ((scope.reconciliationScope ?? "full") === "full"
                ? !verifiedCashProofActions(
                      parsed.data.actions.filter(
                          (action) =>
                              action.cashProof ||
                              action.cashValues ||
                              action.cashFeeValues ||
                              action.existingCashFeeTransactionId,
                      ),
                  ) ||
                  parsed.data.actions.some(
                      (action) =>
                          action.cashProof &&
                          !["duplicate", "settled"].includes(action.action),
                  )
                : scope.reconciliationScope !== "record_cash_only")) ||
        (scope.reconciliationScope === "record_cash_only" &&
            !verifiedCashProofActions(parsed.data.actions)) ||
        (scope.reconciliationScope !== undefined &&
            scope.reconciliationScope !== "full" &&
            (!parsed.data.selectedRowIds ||
                parsed.data.actions.some(
                    (action) =>
                        !(
                            scope.reconciliationScope ===
                            "record_in_kind_income_only"
                                ? ["record_income", "duplicate", "settled"]
                                : scope.reconciliationScope ===
                                    "record_cash_only"
                                  ? ["cash", "duplicate", "settled"]
                                  : ["adopt", "duplicate", "settled"]
                        ).includes(action.action) ||
                        (scope.reconciliationScope ===
                            "record_in_kind_income_only" &&
                            action.action === "record_income" &&
                            (!action.incomeProof ||
                                action.dateProof ||
                                action.corrections?.length ||
                                action.existingTransactionId ||
                                action.source?.type !== "dividend" ||
                                action.source?.income_recognition_role !==
                                    "included_in_units" ||
                                action.source?.units !== null ||
                                action.source?.price_per_unit !== null ||
                                action.source?.fx_rate_to_eur != null ||
                                action.source?.amount === null ||
                                action.source?.amount === undefined ||
                                (typeof action.source.amount === "string" &&
                                    !action.source.amount.trim()) ||
                                !Number.isFinite(
                                    Number(action.source?.amount),
                                ) ||
                                Number(action.source?.amount) < 0 ||
                                !z.iso.date().safeParse(action.source?.date)
                                    .success ||
                                !action.source?.currency ||
                                ["fees", "taxes"].some(
                                    (field) =>
                                        Number(action.source?.[field] ?? 0) !==
                                        0,
                                ))) ||
                        ([
                            "adopt_existing_only",
                            "record_in_kind_income_only",
                            "record_cash_only",
                        ].includes(scope.reconciliationScope ?? "") &&
                            action.policy === "prefer_source") ||
                        (scope.reconciliationScope ===
                            "correct_existing_only" &&
                            action.action === "adopt" &&
                            (action.policy !== "prefer_source" ||
                                !action.existingTransactionId ||
                                !action.corrections?.length ||
                                (action.dateProof
                                    ? !verifiedDateCorrection(action)
                                    : action.source?.date !==
                                          action.existing?.date ||
                                      action.corrections?.some(
                                          (field) =>
                                              ![
                                                  "amount",
                                                  "price_per_unit",
                                                  "fees",
                                                  "taxes",
                                                  "currency",
                                                  "fx_rate_to_eur",
                                              ].includes(field),
                                      )))),
                ) ||
                JSON.stringify(
                    [...parsed.data.selectedRowIds].sort((a, b) => a - b),
                ) !==
                    JSON.stringify(
                        parsed.data.actions
                            .map((action) => action.rowId)
                            .sort((a, b) => a - b),
                    ) ||
                Object.entries(parsed.data.summary).some(
                    ([kind, count]) =>
                        count !==
                        parsed.data.actions.filter(
                            (action) => action.action === kind,
                        ).length,
                ) ||
                parsed.data.actions.some(
                    (action) =>
                        !Object.hasOwn(parsed.data.summary, action.action),
                ))) ||
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
        !verifiedReconciliationScope(
            parsed.data,
            scope.reconciliationScope ?? "full",
        ) ||
        !verifiedRecordedSubtotals(parsed.data) ||
        (scope.reconciliationScope !== undefined &&
            scope.reconciliationScope !== "full" &&
            (!parsed.data.selectedRowIds ||
                (!["record_in_kind_income_only", "record_cash_only"].includes(
                    scope.reconciliationScope,
                ) &&
                    parsed.data.imported !== 0) ||
                parsed.data.repaired !== 0)) ||
        (scope.reconciliationScope === "record_in_kind_income_only" &&
            (parsed.data.recordedIncome === undefined ||
                parsed.data.imported !== parsed.data.recordedIncome ||
                parsed.data.adopted !== 0 ||
                parsed.data.batches.some(
                    (batch) =>
                        batch.recordedIncome === undefined ||
                        batch.recordedIncome !== batch.imported ||
                        batch.adopted !== 0 ||
                        batch.repaired !== 0,
                ) ||
                parsed.data.recordedIncome !==
                    parsed.data.batches.reduce(
                        (sum, batch) => sum + (batch.recordedIncome ?? 0),
                        0,
                    ))) ||
        (scope.reconciliationScope === "record_cash_only" &&
            (parsed.data.recordedCash === undefined ||
                parsed.data.imported !== parsed.data.recordedCash ||
                parsed.data.adopted !== 0 ||
                (parsed.data.recordedIncome ?? 0) !== 0 ||
                parsed.data.batches.some(
                    (batch) =>
                        batch.recordedCash === undefined ||
                        batch.recordedCash !== batch.imported ||
                        batch.adopted !== 0 ||
                        batch.repaired !== 0 ||
                        (batch.recordedIncome ?? 0) !== 0,
                ) ||
                parsed.data.recordedCash !==
                    parsed.data.batches.reduce(
                        (sum, batch) => sum + (batch.recordedCash ?? 0),
                        0,
                    ))) ||
        parsed.data.batches.some(
            (batch) =>
                !verifiedReconciliationScope(
                    batch,
                    scope.reconciliationScope ?? "full",
                ),
        ) ||
        (parsed.data.pending !== undefined &&
            (parsed.data.batches.some((batch) => batch.pending === undefined) ||
                parsed.data.pending !==
                    parsed.data.batches.reduce(
                        (count, batch) => count + (batch.pending ?? 0),
                        0,
                    ))) ||
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
