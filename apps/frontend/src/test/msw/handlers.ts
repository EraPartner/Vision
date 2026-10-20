import { http, HttpResponse } from "msw";
// Test-only: the MSW stand-ins for the tax overview and compute routes run the same shared
// engine the backend serves; the application bundle never imports it.
import { buildTaxOverview } from "@vision/shared-utils/belgian-tax/overview";
import {
    computeHouseholdTax,
    toBelgianTaxCalculation,
} from "@vision/shared-utils/belgian-tax/household";
import type { BelgianTaxHouseholdV2 } from "@vision/shared-utils/belgian-tax/householdTypes";

const API_BASE = "http://localhost:3002";

interface EnvelopeMeta {
    requestId?: string;
    total?: number;
    page?: number;
    limit?: number;
    [key: string]: unknown;
}

/**
 * ADR-026 success envelope: { ok: true, data, meta? }.
 *
 * The status is part of the contract, not an afterthought: express routes that
 * call `res.status(201)` (or 202) before `res.ok(...)` put a different code on
 * the wire than the ones that just call `res.ok(...)`. A handler that answers
 * 200 for a 201 route is a mock that cannot fail when the route's status
 * drifts — hence the explicit `ok201`/`ok202` variants below, and the
 * status column pinned per row in contracts.test.ts.
 */
function okWithStatus<T>(status: number, data: T, meta?: EnvelopeMeta) {
    return HttpResponse.json(
        { ok: true, data, ...(meta ? { meta } : {}) },
        { status },
    );
}

/** 200 OK — routes that call `res.ok(...)` with no preceding `res.status(...)`. */
export function ok<T>(data: T, meta?: EnvelopeMeta) {
    return okWithStatus(200, data, meta);
}

/** 201 Created — routes that call `res.status(201)` before `res.ok(...)`. */
export function ok201<T>(data: T, meta?: EnvelopeMeta) {
    return okWithStatus(201, data, meta);
}

/** 202 Accepted — the deferred-work arm (CSV import's review branch). */
export function ok202<T>(data: T, meta?: EnvelopeMeta) {
    return okWithStatus(202, data, meta);
}

const ERROR_CODE_BY_STATUS: Record<number, string> = {
    400: "VALIDATION_ERROR",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    409: "CONFLICT",
    422: "VALIDATION_ERROR",
    429: "RATE_LIMITED",
    500: "INTERNAL_SERVER_ERROR",
    502: "BAD_GATEWAY",
    503: "SERVICE_UNAVAILABLE",
    504: "GATEWAY_TIMEOUT",
};

/** ADR-026 failure envelope: { ok: false, error: { message, code } } */
export function err(status: number, message: string, code?: string) {
    return HttpResponse.json(
        {
            ok: false,
            error: {
                message,
                code: code ?? ERROR_CODE_BY_STATUS[status] ?? "APP_ERROR",
            },
        },
        { status },
    );
}

const AGG_COMPUTED_AT = "2025-01-01T00:00:00Z";

/** Aggregation-endpoint envelope: ok({ data, meta: { computedAt, source: "live" } }). */
export function aggOk<T>(data: T, computedAt: string = AGG_COMPUTED_AT) {
    return ok({ data, meta: { computedAt, source: "live" as const } });
}

/**
 * `GET /api/settings?withBaselines=true` body (ADR-173): the stored values and
 * the persisted baseline each one was read from.
 */
export function settingsWithBaselines(settings: Record<string, unknown>) {
    return {
        settings,
        expected: Object.fromEntries(
            Object.entries(settings).map(([key, value]) => [
                key,
                { exists: true, value },
            ]),
        ),
    };
}

/**
 * Hard-delete stub: 204 No Content, no envelope.
 * See docs/reference/code-patterns.md, "DELETE responses".
 */
export function noContent() {
    return new HttpResponse(null, { status: 204 });
}

// ── Mutation fixture stubs — minimal valid shapes matching backend formatters ─

/**
 * A transaction as `formatTransaction` emits it (routes/transactions.ts): the
 * list, detail and PATCH body. `running_balance` is only added on
 * `include_balance=true` list reads; POST also adds `auto_linked`
 * (`TRANSACTION_CREATED_STUB`). Checked by `TransactionSchema`.
 */
export const TRANSACTION_STUB = {
    id: 1,
    transaction_date: "2025-01-15",
    bank_account: "BE12345678901234",
    account_id: 1,
    is_transfer: false,
    transfer_peer_id: null,
    transfer_source: null,
    recipient_id: 1,
    recipient_name: "Test Recipient",
    memo: "Test memo",
    amount: -25.5,
    amount_eur: -25.5,
    currency: "EUR",
    balance: null,
    category_id: 1,
    category_name: "FOOD:GROCERIES",
    comment: null,
    tags: [],
    is_active: true,
    created_at: "2025-01-15T10:00:00.000Z",
    updated_at: "2025-01-15T10:00:00.000Z",
    links: [],
};

/** `POST /api/transactions`: the formatted row plus `auto_linked`. */
export const TRANSACTION_CREATED_STUB = {
    ...TRANSACTION_STUB,
    auto_linked: null,
};

/**
 * A legacy category row: `SELECT * FROM categories` (hierarchy columns
 * included) plus `category_name` and `links: []`. Checked by `CategorySchema`.
 */
export const CATEGORY_STUB = {
    id: 1,
    general: "FOOD",
    detail: "GROCERIES",
    description: null,
    is_active: true,
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
    parent_id: 100,
    name: "GROCERIES",
    hierarchy_only: false,
    legacy_compatible: true,
    path_name: "FOOD:GROCERIES",
    category_name: "FOOD:GROCERIES",
    links: [],
};

/** A canonical tree node as `mapNode` emits it. Checked by `CategoryNodeSchema`. */
export const CATEGORY_NODE_STUB = {
    id: 1,
    name: "GROCERIES",
    parentId: 100,
    pathIds: [100, 1],
    path: ["FOOD", "GROCERIES"],
    category_name: "FOOD:GROCERIES",
    depth: 2,
    description: null,
    is_active: true,
    hierarchyOnly: false,
    legacyCompatible: true,
};

/**
 * An `EnrichedRecipientRow` plus `links: []` (list, detail, PATCH, merge
 * primary). Checked by `RecipientSchema`.
 */
export const RECIPIENT_STUB = {
    id: 1,
    name: "Test Recipient",
    normalized_name: "test recipient",
    default_category_id: null,
    primary_recipient_id: null,
    notes: null,
    is_active: true,
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
    default_category_name: null,
    primary_bank_account: null,
    primary_recipient_name: null,
    alias_count: 0,
    links: [],
};

/** `POST /api/recipients`: `withCreateOutcome` adds `created`. */
export const RECIPIENT_CREATED_STUB = {
    ...RECIPIENT_STUB,
    created: false,
};

/** A `recipient_match_patterns` row (`listPatternsForRecipient`). */
export const RECIPIENT_PATTERN_STUB = {
    id: 1,
    pattern: "TEST RECIPIENT",
    pattern_kind: "literal_prefix",
    case_sensitive: false,
    priority: 100,
    is_active: true,
    source: "user",
    notes: null,
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
};

export const INVESTMENT_STUB = {
    id: 1,
    name: "MSCI World ETF",
    symbol: "IWDA",
    asset_class: "etf",
    currency: "EUR",
    current_price: 95.5,
    interest_rate: null,
    maturity_date: null,
    location: null,
    municipality: null,
    cadastral_income: null,
    municipality_tax_rate: null,
    notes: null,
    is_active: true,
    price_provider: "yahoo",
    price_provider_id: "IWDA.AS",
    price_provider_url: null,
    price_provider_latest_url: null,
    price_provider_latest_path: null,
    price_provider_history_url: null,
    price_provider_history_path: null,
    price_provider_history_ts_path: null,
    price_provider_history_price_path: null,
    price_updated_at: "2025-01-15T10:00:00.000Z",
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-15T10:00:00.000Z",
};

/** A `portfolio_transactions` row after `mapPortfolioTxRow`. */
export const PORTFOLIO_TRANSACTION_STUB = {
    id: 1,
    investment_id: 1,
    type: "buy",
    date: "2025-01-01",
    amount: 100,
    units: 1,
    price_per_unit: 100,
    fees: null,
    taxes: null,
    dividend_amount_convention: "unknown",
    income_recognition_role: "standard",
    currency: "EUR",
    fx_rate_to_eur: null,
    note: null,
    is_recurring: false,
    recurrence_interval: null,
    recurrence_end_date: null,
    account_id: null,
    import_batch_id: null,
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
};

/** portfolioSummaryService.getPortfolioSummary with no holdings. */
/** Zero `PortfolioHoldingTotals` (portfolioAssetClassTotals.buildHoldingTotals). */
export const HOLDING_TOTALS_STUB = {
    holdingCount: 0,
    totalPortfolioValue: 0,
    totalInvested: 0,
    totalGainLoss: 0,
    totalRealizedGain: 0,
    totalUnrealizedGain: 0,
    totalIncome: 0,
    totalDividends: 0,
    totalInKindIncome: 0,
    totalFees: 0,
    totalTaxes: 0,
    totalFeesAndTaxes: 0,
    netReturnExcludingIncome: 0,
    netReturnWithDividends: 0,
    totalAppreciation: 0,
    totalPropertyReturn: 0,
    totalAccruedInterest: 0,
    totalProjectedAnnualInterest: 0,
    valueWeightedInterestRate: 0,
    estimatedMonthlyRent: 0,
    monthlyRentRateMissing: false,
    usedFallbackRate: false,
};

/** The five `byAssetGroup` entries, zero totals unless overridden per group. */
export function assetGroupTotalsStub(
    overrides: Partial<
        Record<
            | "stocks_etfs"
            | "crypto"
            | "metals"
            | "real_estate"
            | "savings_bonds",
            Partial<typeof HOLDING_TOTALS_STUB>
        >
    > = {},
) {
    const groups = [
        ["stocks_etfs", ["stock", "etf"]],
        ["crypto", ["crypto"]],
        ["metals", ["metals"]],
        ["real_estate", ["real_estate"]],
        ["savings_bonds", ["savings", "bond"]],
    ] as const;
    return groups.map(([group, assetClasses]) => ({
        group,
        assetClasses: [...assetClasses],
        ...HOLDING_TOTALS_STUB,
        ...overrides[group],
    }));
}

export const PORTFOLIO_SUMMARY_STUB = {
    currency: "EUR",
    computed_at: "2025-01-01T00:00:00.000Z",
    totals: {
        totalPortfolioValue: 0,
        totalInvested: 0,
        totalGainLoss: 0,
        totalRealizedGain: 0,
        totalUnrealizedGain: 0,
        totalGain: 0,
        totalIncome: 0,
        totalDividends: 0,
        totalInKindIncome: 0,
        totalFees: 0,
        totalTaxes: 0,
        totalAssetGain: 0,
        totalFxGain: 0,
        totalReturnPct: 0,
        usedFallbackRate: false,
    },
    summaries: [],
    byAccount: [],
    accountTotals: [],
    byAssetClass: [],
    byAssetGroup: assetGroupTotalsStub(),
    archivedInKindIncome: [],
    brokerageCashFees: {
        total: 0,
        gainAfterFees: 0,
        usedFallbackRate: false,
        byAccount: [],
    },
};

/**
 * One portfolio-summary `summaries[]` entry for INVESTMENT_STUB with no
 * transactions. The `SELECT i.*` passthrough keeps NUMERIC columns as strings
 * and maturity_date as a serialized Date.
 */
export const PORTFOLIO_SUMMARY_ITEM_STUB = {
    id: 1,
    name: "MSCI World ETF",
    symbol: "IWDA",
    asset_class: "etf",
    assetClass: "etf",
    is_active: true,
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-15T10:00:00.000Z",
    notes: null,
    location: null,
    municipality: null,
    cadastral_income: null,
    municipality_tax_rate: null,
    maturity_date: null,
    maturityDate: null,
    price_provider: "yahoo",
    price_provider_id: "IWDA.AS",
    price_updated_at: "2025-01-15T10:00:00.000Z",
    currency: "EUR",
    originalCurrency: "EUR",
    totalUnits: 0,
    currentPrice: 95.5,
    current_price: 95.5,
    interestRate: 0,
    interest_rate: 0,
    totalInvested: 0,
    totalBuyCost: 0,
    totalSellProceeds: 0,
    currentValue: 0,
    totalFees: 0,
    totalTaxes: 0,
    totalDividends: 0,
    totalIncome: 0,
    totalInKindIncome: 0,
    avgCostBasis: 0,
    realizedGain: 0,
    unrealizedGain: 0,
    totalGain: 0,
    gainLoss: 0,
    gainLossPercent: 0,
    assetGain: 0,
    fxGain: 0,
    nativeCurrentValue: 0,
    usedFallbackRate: false,
    accruedInterest: 0,
    projectedAnnualInterest: 0,
    totalAppreciation: 0,
    feesAndTaxes: 0,
    propertyReturn: 0,
    monthlyRent: 0,
    unrealizedGainPercent: 0,
    fullyAssigned: true,
    oversold: false,
    byAccount: [],
    accountTotals: [],
};

/** A `saved_charts` row (routes/savedCharts.ts). */
export const SAVED_CHART_STUB = {
    id: 1,
    name: "Test chart",
    chart_type: "line",
    category_ids: [],
    recipient_ids: [],
    tag_ids: [],
    all_categories: false,
    all_recipients: false,
    all_tags: false,
    chart_variant: "default",
    time_bucket: "monthly",
    date_range_start: null,
    date_range_end: null,
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
};

export const PLANNED_TRANSACTION_STUB = {
    id: 1,
    planned_date: "2025-02-01",
    bank_account: "BE12345678901234",
    recipient_id: 1,
    recipient_name: "Landlord",
    memo: "Monthly rent",
    amount: 1200.0,
    currency: "EUR",
    category_id: null,
    category_name: null,
    comment: null,
    url: null,
    is_recurring: true,
    recurrence_pattern: "monthly",
    recurrence_end_date: null,
    max_occurrences: null,
    reminder_days_before: null,
    is_executed: false,
    last_executed_date: null,
    is_loan: false,
    loan_type: null,
    loan_principal: null,
    loan_annual_interest_rate: null,
    loan_term_months: null,
    loan_start_date: null,
    loan_payment_day: null,
    loan_regular_payment_amount: null,
    loan_first_payment_date: null,
    loan_schedule: [],
    executed_transaction_id: null,
    execution_count: 0,
    executions: [],
    tags: [],
    is_active: true,
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: null,
    links: [],
};

/**
 * An accounts SINGLE-ROW body: exactly accountRepository's COLUMNS list
 * (accountRepository.js:26-29) plus the route's `res.ok({ ...account,
 * links: [] })` (routes/accounts.js:46/56/65). Deliberately WITHOUT
 * `computed_balance`/`drift` — those are list-endpoint enrichments
 * (accountRepository.list, and marked "list endpoint only" on the Account
 * type, types/api.ts:89-117) that `GET /:id`, `POST` and `PATCH` never emit.
 * A test modelling a LIST response should use `ACCOUNT_LIST_ITEM_STUB` below,
 * or spread the enrichments it asserts on explicitly.
 */
export const ACCOUNT_STUB = {
    id: 1,
    name: "Main Checking",
    display_name: "Main Checking",
    institution: "Test Bank",
    currency: "EUR",
    type: "checking",
    liquidity_class: "liquid",
    spendable: true,
    in_net_worth: true,
    tax_wrapper: "none",
    owner: "me",
    multi_currency_cash: false,
    has_cash_sleeve: false,
    funding_account_id: null,
    is_active: true,
    // `closed_at` and `links` are on every accounts single-row body:
    // accountRepository's COLUMNS list (accountRepository.js:26-29) plus the
    // route's `res.ok({ ...account, links: [] })` (routes/accounts.js:45/56/…).
    closed_at: null,
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
    links: [],
};

const { links: _accountLinks, ...ACCOUNT_COLUMNS } = ACCOUNT_STUB;

/**
 * An accounts LIST item: the single-row columns (no per-item `links`) plus the
 * enrichments `accountService.list` computes per row, all as JSON numbers:
 * `computed_balance` (the anchor+delta balance, ADR-094), the per-currency
 * `balance_parts` and `statement_balances`, the reconciliation base
 * (`reconcilable_balance`/`reconcilable_currency`) and `drift` (statement −
 * base, null when no statement reading). `anchor_date`/`post_anchor_count`
 * are omitted for an unstamped account; tests that need them add them.
 * Checked by `AccountListItemSchema`.
 */
export const ACCOUNT_LIST_ITEM_STUB = {
    ...ACCOUNT_COLUMNS,
    has_transactions: true,
    statement_balances: [] as Array<{
        currency: string;
        balance: number;
        balance_date: string;
    }>,
    computed_balance: 0,
    balance_parts: [] as Array<{ currency: string; balance: number }>,
    balance_incomplete: false,
    unconverted_currencies: [] as string[],
    reconcilable_balance: 0,
    reconcilable_currency: "EUR",
    drift: null as number | null,
};

/**
 * A `transaction_splits` row as `splitRepository.formatSplit` emits it
 * (apps/node-backend/src/repositories/splitRepository.js:717). This is what
 * `POST /api/splits/:id/settle` answers with — `res.ok(split)`, splits.js:343
 * — not a `{message}` acknowledgement.
 *
 * `settleSplit`'s `RETURNING *` carries no join, so the real response has
 * `recipient_name: null` and `amount_paid: 0` regardless of the split's actual
 * paid total (documented on the repo method); the stub mirrors that.
 */
export const SPLIT_STUB = {
    id: 1,
    transaction_id: 1,
    recipient_id: 1,
    recipient_name: null,
    amount: 25,
    amount_paid: 0,
    note: null,
    is_settled: false,
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
};

/** `summary` on GET /api/splits/owed[/:id]: nothing outstanding. */
export const OWED_TOTALS_STUB = {
    currency: "EUR",
    remaining: 0,
    unconverted_count: 0,
    unconverted_currencies: [],
};

const EMPTY_ACCOUNT_GROUP_TOTAL = {
    total: 0,
    cash: 0,
    holdings: 0,
    holdings_unavailable: false,
    unconverted_count: 0,
    unconverted_currencies: [],
};

/** GET /api/accounts/totals for the default empty account list. */
export function accountTotalsStub(currency = "EUR") {
    return {
        currency,
        net_cash: { total: 0, unconverted_count: 0, unconverted_currencies: [] },
        groups: {
            cash: EMPTY_ACCOUNT_GROUP_TOTAL,
            portfolio: EMPTY_ACCOUNT_GROUP_TOTAL,
            liabilities: EMPTY_ACCOUNT_GROUP_TOTAL,
            archived: EMPTY_ACCOUNT_GROUP_TOTAL,
        },
        accounts: [],
    };
}

/**
 * A `split_payments` row as `splitRepository.formatPayment` emits it
 * (splitRepository.js:701): NUMERIC `amount` coerced to a number, DATE
 * `paid_at` as a calendar-day string. `POST /api/splits/:id/pay` answers with
 * this row (`res.ok(payment)`, splits.js:321), not a `{message}`.
 */
export const SPLIT_PAYMENT_STUB = {
    id: 1,
    split_id: 1,
    amount: 10,
    note: null,
    paid_at: "2025-01-15",
    created_at: "2025-01-15T10:00:00.000Z",
};

/**
 * Completed CSV import result — what `POST /api/import/csv` and
 * `POST /api/import/csv/custom` actually put on the wire when the batch
 * auto-commits: `buildImportResult(buildPipelineResult(...))`
 * (node-backend/src/routes/importRoutes.js:59-94).
 *
 * `status` is derived by the backend, never sent as "queued": it is
 * "completed_with_errors" when `errors > 0` and "completed" otherwise. The
 * other outcome of these two routes is the 202 review path
 * (`{ batch_id, requires_review: true, match_source_counts }`,
 * `respondReviewRequired`); the default handler models the completed one, and
 * `importCsvReviewRequiredHandlers` below models the other arm for tests that
 * need it, via `server.use(...)`.
 */
export const IMPORT_CSV_RESULT_STUB = {
    total: 3,
    imported: 2,
    duplicates: 1,
    errors: 0,
    batch_id: 1,
    auto_linked_count: 0,
    status: "completed",
    error_message: null,
    links: [],
};

/**
 * The other arm of the same two routes: `respondReviewRequired`
 * (node-backend/src/routes/importRoutes.js:74-84) answers 202 with only these
 * three fields — no `total`, no counts, because nothing was committed.
 */
export const IMPORT_CSV_REVIEW_REQUIRED_STUB = {
    batch_id: 7,
    requires_review: true,
    match_source_counts: { exact: 1, fuzzy: 1, pattern: 0, new: 2 },
};

/**
 * Override handlers that put both CSV import routes on the 202 review branch.
 * Pass to `server.use(...)` in a test that needs that arm. The status really is
 * 202 (not the default 200 of `ok()`) because that is the contract clients
 * narrow on alongside `requires_review`.
 */
export const importCsvReviewRequiredHandlers = [
    http.post(`${API_BASE}/api/import/csv`, () =>
        ok202(IMPORT_CSV_REVIEW_REQUIRED_STUB),
    ),
    http.post(`${API_BASE}/api/import/csv/custom`, () =>
        ok202(IMPORT_CSV_REVIEW_REQUIRED_STUB),
    ),
];

/**
 * GET /api/belgian-tax/dashboard for a user without a profile or taxable income:
 * only the live year, computed on an empty household. Overrides patch fields.
 */
export function taxDashboardStub(
    year: number,
    overrides: Record<string, unknown> = {},
) {
    return {
        year,
        currency: "EUR",
        isHistorical: false,
        hasIncomeSources: false,
        hasStatsData: false,
        isEmpty: true,
        portfolioTaxesForYear: 0,
        totalTaxIncludingPortfolio: 0,
        totalTaxIncludingPropertyEstimate: 0,
        yearlyIncome: [],
        monthlyIncomeTax: [],
        recordedIncomeByPartner: null,
        yearCalculations: [
            {
                year,
                calculation: {
                    grossIncome: 0,
                    totalPIT: 0,
                    effectiveRate: 0,
                    netTakeHome: 0,
                },
                isFiled: false,
                hasFrozenCalculation: false,
                isCurrent: true,
                hasSnapshot: false,
                hasTransactions: false,
            },
        ],
        currentInputs: {},
        exportProfile: {},
        suggestions: [],
        householdBreakdownRows: [],
        rules: [],
        unconvertedCurrencies: [],
        incompleteFigures: [],
        ...overrides,
    };
}

/** GET /api/belgian-tax/portfolio-dashboard for a user without investments. */
export function portfolioTaxDashboardStub(
    year: number,
    overrides: Record<string, unknown> = {},
) {
    return {
        year,
        currency: "EUR",
        isEmpty: true,
        hasProfile: false,
        hasInKindIncomeUnclassified: false,
        totals: {
            totalTaxes: 0,
            totalFees: 0,
            totalTaxesAndFees: 0,
            totalRecordedTaxes: 0,
            totalRecordedFees: 0,
            totalManualTaxes: 0,
            totalManualFees: 0,
            totalManualCosts: 0,
            totalRealizedGain: 0,
            totalUnrealizedGain: 0,
            effectiveTaxRate: 0,
            totalPIT: 0,
            portfolioTaxesPlusPIT: 0,
        },
        taxBreakdown: [],
        feeBreakdown: [],
        taxByAssetClass: [],
        investmentBreakdown: [],
        yearlyCostTrend: [],
        dividend: {
            totalDividendIncome: 0,
            dividendWhtRecorded: 0,
            grossDividendWht: 0,
            dividendExemption: 0,
            grossDividendBase: 0,
            dividendWhtReclaim: 0,
            dividendWhtNetCost: 0,
            unknownDividendConventionCount: 0,
        },
        estimates: {
            tobRecorded: 0,
            tobAutoEstimate: 0,
            tacrEstimate: 0,
            reyndersEstimate: 0,
            cgtEstimate: 0,
        },
        taxTable: {
            securitiesAccountTaxRate: 0.0015,
            capitalGainsTaxRate: 0.1,
            reyndersTaxRate: 0.3,
            dividendWHTRate: 0.3,
            securitiesAccountTaxThreshold: 1_000_000,
            badgePercent: {
                securitiesAccountTaxRate: 0.15,
                capitalGainsTaxRate: 10,
                reyndersTaxRate: 30,
                dividendWHTRate: 30,
            },
        },
        summaries: [],
        records: [
            {
                key: "portfolio_tax_adjustments_v1",
                value: null,
                expected: { exists: false },
            },
            {
                key: "portfolio_tax_classifications_v1",
                value: null,
                expected: { exists: false },
            },
        ],
        unconvertedCurrencies: [],
        incompleteFigures: [],
        ...overrides,
    };
}

/** The requested `year` query parameter (the live year default when absent). */
function requestedTaxYear(request: Request): number {
    const year = Number(new URL(request.url).searchParams.get("year"));
    return Number.isInteger(year) && year > 0 ? year : 2026;
}

/**
 * GET /api/belgian-tax/overview body for the given stored settings, as the route answers it
 * (same shared builder, JSON round-tripped).
 */
export function taxOverviewStub(
    settings: Record<string, unknown> = {},
    year?: number,
) {
    const { expected } = settingsWithBaselines(settings);
    const overview = buildTaxOverview(settings, expected, year);
    return JSON.parse(JSON.stringify(overview)) as typeof overview;
}

/**
 * GET /api/belgian-tax/overview built from whatever the current GET /api/settings handler
 * serves, so a test seeds the tax household through the settings it stores. `undefined` when
 * that settings read fails: the route reads the same table, so it fails too.
 */
async function taxOverviewFromSettings(request: Request) {
    // A request still in flight when the test file tears down MSW reaches the
    // real network and is refused; treat it like a failed settings read.
    const response = await fetch(
        `${API_BASE}/api/settings?withBaselines=true`,
    ).catch(() => undefined);
    if (!response?.ok) return undefined;
    const body = (await response.json()) as { data?: Record<string, unknown> };
    const data = body.data ?? {};
    const { settings, expected } =
        data.settings && data.expected
            ? (data as ReturnType<typeof settingsWithBaselines>)
            : settingsWithBaselines(data);
    const year = new URL(request.url).searchParams.get("year");
    const overview = buildTaxOverview(
        settings,
        expected,
        year ? Number(year) : undefined,
    );
    return JSON.parse(JSON.stringify(overview)) as typeof overview;
}

/** POST /api/belgian-tax/compute as the route answers it, from the shared engine. */
export function computeTaxStub(household: BelgianTaxHouseholdV2) {
    const result = computeHouseholdTax(household);
    return JSON.parse(
        JSON.stringify({
            result,
            calculation: toBelgianTaxCalculation(result, household),
        }),
    ) as {
        result: ReturnType<typeof computeHouseholdTax>;
        calculation: ReturnType<typeof toBelgianTaxCalculation>;
    };
}

/**
 * Default handlers cover the chatty boot-time endpoints so any page can render
 * without crashing. Tests override per-flow handlers via `server.use(...)`.
 */
export const defaultHandlers = [
    http.get(`${API_BASE}/api/settings`, ({ request }) => ok(new URL(request.url).searchParams.get("withBaselines") === "true" ? { settings: {}, expected: {} } : {})),
    http.get(`${API_BASE}/api/settings/:key`, ({ params }) => ok({ key: String(params.key), value: null, expected: { exists: false } })),
    // `res.ok(settingsRepository.set(...))` — routes/settings.js:328. The body
    // is the stored `{ key, value }` row (settingsRepository.js:98), never an
    // `{ok: true}` sentinel. Echo the key and value so per-flow overrides see
    // what the real route would answer. Every `saveSetting` caller today is
    // fire-and-forget, but the client types it `Promise<{ key, value }>`.
    http.put(`${API_BASE}/api/settings/:key`, async ({ params, request }) => {
        const body = (await request.json().catch(() => ({}))) as {
            value?: unknown;
        };
        return ok({ key: String(params.key), value: body.value ?? null, expected: { exists: true, value: body.value ?? null } });
    }),

    http.get(`${API_BASE}/api/info`, () =>
        ok({ version: "test", commit: "test", buildDate: "test" }),
    ),
    http.get(`${API_BASE}/api/info/health`, () => ok({ status: "ok" })),
    http.get(`${API_BASE}/api/belgian-tax/dashboard`, ({ request }) =>
        ok(taxDashboardStub(requestedTaxYear(request))),
    ),
    http.get(`${API_BASE}/api/belgian-tax/portfolio-dashboard`, ({ request }) =>
        ok(portfolioTaxDashboardStub(requestedTaxYear(request))),
    ),
    http.get(`${API_BASE}/api/belgian-tax/overview`, async ({ request }) => {
        const overview = await taxOverviewFromSettings(request);
        return overview
            ? ok(overview)
            : err(500, "Failed to read the Belgian tax settings");
    }),
    http.post(`${API_BASE}/api/belgian-tax/compute`, async ({ request }) => {
        const body = (await request.json()) as {
            household: BelgianTaxHouseholdV2;
        };
        return ok(computeTaxStub(body.household));
    }),

    http.get(`${API_BASE}/api/categories`, ({ request }) => {
        const params = new URL(request.url).searchParams;
        const paginated = params.has("limit") || params.has("offset");
        return ok({
            items: [],
            total: 0,
            ...(paginated ? { limit: 200, offset: 0 } : {}),
            links: [],
        });
    }),
    http.get(`${API_BASE}/api/categories/tree`, () =>
        ok({ items: [], total: 0 }),
    ),
    http.get(`${API_BASE}/api/recipients`, () =>
        ok({ items: [], total: 0, limit: 200, offset: 0, links: [] }),
    ),
    // Accounts API (ADR-088) — account pickers/filters now mount across the
    // transactions, portfolio, and net-worth surfaces. An empty list keeps those
    // fetches from leaking past teardown or tripping the unhandled-request guard.
    http.get(`${API_BASE}/api/accounts`, () =>
        ok({ items: [], total: 0, links: [] }),
    ),
    // Before /:id: server-computed hub totals (GET /api/accounts/totals).
    http.get(`${API_BASE}/api/accounts/totals`, ({ request }) =>
        ok(
            accountTotalsStub(
                new URL(request.url).searchParams.get("currency") ?? "EUR",
            ),
        ),
    ),
    http.get(`${API_BASE}/api/accounts/:id`, () => ok(ACCOUNT_STUB)),
    // Tags API — used by TagPicker inside dialogs/forms across the app.
    // Returning an empty list keeps async fetches from leaking past test
    // teardown and avoids "intercepted a request without a matching request
    // handler" warnings flooding the test output. Real route answers the
    // opt-in-pagination list body: `{items, total, links}` (no limit/offset
    // when the request did not paginate — routes/tags.js).
    http.get(`${API_BASE}/api/tags`, () =>
        ok({ items: [], total: 0, links: [] }),
    ),
    http.get(`${API_BASE}/api/transactions`, () =>
        ok({ items: [], total: 0, limit: 50, offset: 0, links: [] }),
    ),
    http.get(`${API_BASE}/api/planned`, () => ok([])),
    http.get(`${API_BASE}/api/planned-transactions`, () =>
        ok({ items: [], total: 0, limit: 1000, offset: 0, links: [] }),
    ),
    http.get(`${API_BASE}/api/investments`, () =>
        ok({ items: [], total: 0, limit: 100, offset: 0, links: [] }),
    ),
    http.get(`${API_BASE}/api/aggregations/monthly-summary`, () =>
        aggOk(
            {
                months: [],
                summary: {
                    total_spending: 0,
                    total_income: 0,
                    net_amount: 0,
                    transaction_count: 0,
                    period_start: "",
                    period_end: "",
                },
                unconverted_count: 0,
                unconverted_currencies: [],
            },
            "2025-01-01T00:00:00.000Z",
        ),
    ),
    http.get(`${API_BASE}/api/aggregations/recipient-insights`, () =>
        aggOk(
            {
                topMerchants: [],
                monthOverMonth: [],
                unconverted_count: 0,
                unconverted_currencies: [],
            },
            "2025-01-01T00:00:00.000Z",
        ),
    ),
    http.get(`${API_BASE}/api/aggregations/cashflow-comparison`, () =>
        aggOk({
            days_in_month: 31,
            current_day: 1,
            month: 1,
            year: 2025,
            without_planned: [],
            with_planned: [],
            unconverted_count: 0,
            unconverted_currencies: [],
        }),
    ),
    http.get(`${API_BASE}/api/aggregations/cashflow-forecast-accuracy`, () =>
        aggOk({ methods: [], limit_months: 0 }),
    ),
    http.get(`${API_BASE}/api/aggregations/cashflow-forecast-methods`, () =>
        aggOk({
            month: "2025-01",
            currency: "EUR",
            days_in_month: 31,
            current_day: 1,
            actual: [],
            scheduled_actual: [],
            methods: [],
            planned: [],
            diagnostics: null,
            history_months: 0,
            include_planned: false,
        }),
    ),
    http.get(`${API_BASE}/api/aggregations/cashflow-forecast-rolling`, () =>
        aggOk({
            window_start: "2025-01-01",
            window_end: "2025-01-31",
            today: "2025-01-15",
            currency: "EUR",
            days_back: 14,
            days_forward: 14,
            actual: [],
            scheduled_actual: [],
            methods: [],
            planned: [],
            diagnostics: null,
            history_months: 0,
            include_planned: false,
        }),
    ),
    http.get(`${API_BASE}/api/aggregations/category-pivot`, () =>
        aggOk({
            categoryPivot: {},
            unconverted_count: 0,
            unconverted_currencies: [],
        }),
    ),
    http.get(`${API_BASE}/api/aggregations/recipient-by-year`, () =>
        aggOk({
            recipientsByYear: {},
            unconverted_count: 0,
            unconverted_currencies: [],
        }),
    ),
    http.get(`${API_BASE}/api/aggregations/recipient-pivot`, () =>
        aggOk({
            recipientPivot: {},
            conversion: {
                usedHistoricalFallback: false,
                affectedCurrencies: [],
                unconvertedCount: 0,
                unconvertedCurrencies: [],
            },
        }),
    ),
    http.get(`${API_BASE}/api/aggregations/sankey`, () =>
        aggOk({
            nodes: [],
            links: [],
            year: 2025,
            unconverted_count: 0,
            unconverted_currencies: [],
        }),
    ),
    http.get(`${API_BASE}/api/aggregations/category-breakdown`, () =>
        aggOk({
            categories: [],
            unconverted_count: 0,
            unconverted_currencies: [],
        }),
    ),
    http.get(`${API_BASE}/api/aggregations/bank-balances`, () =>
        aggOk({
            accounts: [],
            total_net_position: 0,
            history: {},
            total_history: [],
            unconverted_count: 0,
            unconverted_currencies: [],
        }),
    ),
    http.get(`${API_BASE}/api/aggregations/average-vs-current`, () =>
        aggOk({
            past_6_months: {
                avg_daily_spending: 0,
                avg_monthly_spending: 0,
                months_counted: 0,
            },
            current_month: {
                daily_data: [],
                total_spending: 0,
                days_elapsed: 1,
                days_in_month: 30,
            },
            comparison: {
                projected_monthly_total: 0,
                avg_monthly_spending: 0,
                variance: 0,
                pace: 0,
            },
            unconverted_count: 0,
            unconverted_currencies: [],
        }),
    ),
    http.get(`${API_BASE}/api/aggregations/:name`, () => ok(null)),
    http.get(`${API_BASE}/api/portfolio/summary`, () =>
        ok({
            currency: "EUR",
            computed_at: "2025-01-01T00:00:00.000Z",
            totals: {
                totalPortfolioValue: 0,
                totalInvested: 0,
                totalGainLoss: 0,
                totalRealizedGain: 0,
                totalUnrealizedGain: 0,
                totalGain: 0,
                totalIncome: 0,
                totalFees: 0,
                totalTaxes: 0,
                totalReturnPct: 0,
            },
            summaries: [],
            byAccount: [],
            accountTotals: [],
        }),
    ),

    // routes/info/rates.ts GET /exchange-rates: no stored rates yet.
    http.get(`${API_BASE}/api/info/exchange-rates`, () =>
        ok({
            total_rates: 0,
            rates: [],
            source: "fallback",
            is_stale: true,
            last_fetched_at: null,
        }),
    ),
    http.get(`${API_BASE}/api/market/news`, () => ok({ items: [], total: 0 })),

    http.get(`${API_BASE}/api/import/batches`, () =>
        ok({ items: [], total: 0, limit: 50, offset: 0 }),
    ),
    http.get(`${API_BASE}/api/import/batches/:batchId/preview`, () =>
        ok({
            batch_id: 1,
            groups: [],
            totals: { exact: 0, fuzzy: 0, pattern: 0, new: 0, unresolved: 0 },
        }),
    ),

    // Real route answers listBody(items, total, page) plus the converted
    // `summary` (apps/node-backend/src/routes/splits.ts, GET /owed).
    http.get(`${API_BASE}/api/splits/owed`, () =>
        ok({ items: [], total: 0, summary: OWED_TOTALS_STUB }),
    ),

    http.get(`${API_BASE}/api/market/quote`, () => ok({ items: [], total: 0 })),
    // marketLookupService search: `{items}` without `total`.
    http.get(`${API_BASE}/api/market/search`, () => ok({ items: [] })),
    // Research aggregator endpoints (consumed by the Market Lookup Details tabs
    // — scorecard fires on load, analyst/news on tab-click). Default to an
    // unavailable envelope so component tests degrade gracefully; integration
    // tests override per-flow via server.use().
    http.get(`${API_BASE}/api/research/scorecard`, () =>
        ok(null, { provider: null, source: "unavailable" }),
    ),
    http.get(`${API_BASE}/api/research/analyst`, () =>
        ok(null, { provider: null, source: "unavailable" }),
    ),
    // routes/research.ts EMPTY_BY_TYPE: news degrades to `{articles: []}`.
    http.get(`${API_BASE}/api/research/news`, () =>
        ok({ articles: [] }, { provider: null, source: "unavailable" }),
    ),
    http.get(`${API_BASE}/api/watchlist`, () =>
        ok({ items: [], total: 0, limit: 50, offset: 0 }),
    ),

    // routes/ai.ts GET /status: every key is always sent.
    http.get(`${API_BASE}/api/ai/status`, () =>
        ok({
            ok: false,
            baseUrl: "",
            displayUrl: "",
            modelCount: 0,
            error: null,
            code: null,
            hint: null,
            defaultModel: "",
            enabled: false,
        }),
    ),
    // Always paginated (`parsePagination` defaults to limit 50).
    http.get(`${API_BASE}/api/ai/conversations`, () =>
        ok({ items: [], total: 0, limit: 50, offset: 0 }),
    ),

    // buildPortfolioPerformancePayload with no snapshots in range.
    http.get(`${API_BASE}/api/info/portfolio-performance`, () =>
        ok({
            currency: "EUR",
            start_date: "2025-01-01",
            end_date: "2025-01-31",
            snapshots: [],
            metrics: null,
            heatmap: { years: [], data: {}, maxAbsPct: 0 },
            breakdownSummary: [],
            totals: PORTFOLIO_SUMMARY_STUB.totals,
        }),
    ),
    http.get(`${API_BASE}/api/info/net-worth`, () =>
        ok({
            current: { liquid: 0, liabilities: 0, investments: 0, netWorth: 0 },
            monthlyChange: 0,
            monthlyChangePercent: 0,
            snapshots: [],
            unconvertedCurrencies: [],
        }),
    ),
    // netWorthByAccount.getNetWorthByAccount with no accounts or holdings.
    http.get(`${API_BASE}/api/info/net-worth/by-account`, () =>
        ok({ currency: "EUR", rows: [], total: 0, unconvertedAccountIds: [] }),
    ),
    // Live response shapes (these routes all return objects, not bare scalars/
    // arrays). The old scalar/array mocks let component tests run against
    // impossible API states (e.g. res.adapters undefined) and made the msw
    // contract suite pin a shape that contradicted the live-contracts suite.
    // (transaction-summary handler removed — Phase 9 deleted that route.)
    http.get(`${API_BASE}/api/info/transaction-count`, () =>
        ok({ total_transactions: 0 }),
    ),
    http.get(`${API_BASE}/api/info/recurring-patterns`, () =>
        ok({ patterns: [], total: 0 }),
    ),
    http.get(`${API_BASE}/api/info/insights-digest`, () =>
        ok({
            subscriptionCreep: { new: [], priceChanges: [] },
            categoryOutliers: [],
            cashForecast: null,
        }),
    ),
    http.get(`${API_BASE}/api/info/banks`, () => ok({ items: [], total: 0 })),
    http.get(`${API_BASE}/api/info/supported-adapters`, () =>
        ok({ items: [], total: 0 }),
    ),
    http.get(`${API_BASE}/api/info/inflation-rates`, () => ok([])),

    http.get(`${API_BASE}/api/admin/endpoint-liveness`, () =>
        ok({ items: [], total: 0 }),
    ),
    http.get(`${API_BASE}/api/admin/database/stats`, () =>
        ok({ tables: [], db_size: null }),
    ),
    http.get(`${API_BASE}/api/admin/providers/health`, () =>
        ok({ items: [], total: 0 }),
    ),
    http.get(`${API_BASE}/api/admin/metrics/requests`, () =>
        ok({ items: [], total: 0 }),
    ),
    http.get(`${API_BASE}/api/admin/endpoints`, () =>
        ok({ items: [], total: 0 }),
    ),

    // ── Mutation stubs ───────────────────────────────────────────────────────
    // These prevent onUnhandledFrame:"error" and are validated by contract
    // tests. Integration tests override them per-flow via server.use().

    // 201: routes/transactions.js:576.
    http.post(`${API_BASE}/api/transactions`, () =>
        ok201(TRANSACTION_CREATED_STUB),
    ),
    http.patch(`${API_BASE}/api/transactions/:id`, () => ok(TRANSACTION_STUB)),
    http.delete(`${API_BASE}/api/transactions/:id`, () => noContent()),

    http.post(`${API_BASE}/api/categories`, () => ok(CATEGORY_STUB)),
    http.patch(`${API_BASE}/api/categories/:id`, () => ok(CATEGORY_STUB)),
    http.delete(`${API_BASE}/api/categories/:id`, () => noContent()),
    http.post(`${API_BASE}/api/categories/tree`, () =>
        ok201({
            id: 1,
            name: "FOOD",
            parentId: null,
            pathIds: [1],
            path: ["FOOD"],
            category_name: "FOOD",
            depth: 1,
            is_active: true,
            hierarchyOnly: false,
            legacyCompatible: false,
        }),
    ),
    http.patch(`${API_BASE}/api/categories/tree/:id`, () =>
        ok({
            id: 1,
            name: "FOOD",
            parentId: null,
            pathIds: [1],
            path: ["FOOD"],
            category_name: "FOOD",
            depth: 1,
            is_active: true,
            hierarchyOnly: false,
            legacyCompatible: false,
        }),
    ),
    http.delete(`${API_BASE}/api/categories/tree/:id`, () => noContent()),
    http.post(`${API_BASE}/api/categories/tree/:id/merge`, () =>
        ok({
            id: 2,
            name: "TARGET",
            parentId: null,
            pathIds: [2],
            path: ["TARGET"],
            category_name: "TARGET",
            depth: 1,
            is_active: true,
            hierarchyOnly: false,
            legacyCompatible: false,
        }),
    ),

    http.post(`${API_BASE}/api/recipients`, () => ok(RECIPIENT_CREATED_STUB)),
    http.patch(`${API_BASE}/api/recipients/:id`, () => ok(RECIPIENT_STUB)),
    http.delete(`${API_BASE}/api/recipients/:id`, () => noContent()),

    // 201: services/investmentService.js:389.
    http.post(`${API_BASE}/api/investments`, () => ok201(INVESTMENT_STUB)),
    http.patch(`${API_BASE}/api/investments/:id`, () => ok(INVESTMENT_STUB)),
    http.delete(`${API_BASE}/api/investments/:id`, () => noContent()),

    // 201: routes/accounts.js:55.
    http.post(`${API_BASE}/api/accounts`, () => ok201(ACCOUNT_STUB)),
    http.patch(`${API_BASE}/api/accounts/:id`, () => ok(ACCOUNT_STUB)),
    http.delete(`${API_BASE}/api/accounts/:id`, () => noContent()),
    http.post(`${API_BASE}/api/accounts/:id/merge`, () =>
        ok({
            into: 1,
            merged: [2],
            reassigned: {
                transactions: 0,
                planned: 0,
                portfolio: 0,
                funding: 0,
            },
            stampsInterleaved: false,
            links: [],
        }),
    ),

    // 201: routes/plannedTransactions.js:443. The /:id/execute route below is
    // a plain 200 — it updates an existing row rather than creating one.
    http.post(`${API_BASE}/api/planned-transactions`, () =>
        ok201(PLANNED_TRANSACTION_STUB),
    ),
    http.patch(`${API_BASE}/api/planned-transactions/:id`, () =>
        ok(PLANNED_TRANSACTION_STUB),
    ),
    http.delete(`${API_BASE}/api/planned-transactions/:id`, () => noContent()),
    http.post(`${API_BASE}/api/planned-transactions/:id/execute`, () =>
        ok({ ...PLANNED_TRANSACTION_STUB, is_executed: true }),
    ),
    http.get(`${API_BASE}/api/planned-transactions/due-soon`, () =>
        ok({ items: [], total: 0, days: 7 }),
    ),
    http.get(`${API_BASE}/api/planned-transactions/match-suggestions`, () =>
        ok({ items: [], total: 0 }),
    ),
    http.get(`${API_BASE}/api/transactions/transfer-suggestions`, () =>
        ok({ items: [] }),
    ),
    http.post(`${API_BASE}/api/transactions/transfers`, () => noContent()),

    // ── Phase F1: full contract surface coverage ────────────────────────────

    // Admin
    http.get(`${API_BASE}/api/admin/update/check`, () =>
        ok({
            up_to_date: true,
            current_version: "test",
            latest_version: null,
            update_mode: "source",
        }),
    ),
    // `res.ok({ vacuumed: table ?? 'all' })` — routes/admin.js:282. There is no
    // `message` on this route; `lib/api/admin.ts::vacuumTable` reads `vacuumed`.
    http.post(`${API_BASE}/api/admin/database/vacuum`, () =>
        ok({ vacuumed: "all" }),
    ),

    // AI
    // The non-streaming turn returns the whole turn, not a single message:
    // `res.ok({ conversation, userMessage, toolMessages, assistantMessage,
    // usage, iterations })` — routes/ai.js:324-331 (`ChatTurnResponse` in
    // types/aiChat.ts). The frontend only uses /api/ai/chat/stream today.
    http.post(`${API_BASE}/api/ai/chat`, () =>
        ok({
            conversation: {
                id: "conv-1",
                title: "New Conversation",
                model: "llama3",
                createdAt: "2025-01-01T00:00:00Z",
                updatedAt: "2025-01-01T00:00:00Z",
            },
            userMessage: {
                id: "msg-1",
                conversationId: "conv-1",
                role: "user",
                content: "test",
                toolName: null,
                toolArgs: null,
                toolResult: null,
                status: "complete",
                createdAt: "2025-01-01T00:00:00Z",
            },
            toolMessages: [],
            assistantMessage: {
                id: "msg-2",
                conversationId: "conv-1",
                role: "assistant",
                content: "ok",
                toolName: null,
                toolArgs: null,
                toolResult: null,
                status: "complete",
                createdAt: "2025-01-01T00:00:00Z",
            },
            usage: {
                evalCount: null,
                promptEvalCount: null,
                totalDurationMs: null,
            },
            iterations: 1,
        }),
    ),
    // 201: routes/ai.js:273. The body really is `{conversation, messages}`:
    // routes/ai.js:272 names its local `conversation`, but the value comes from
    // `createEmptyConversation`, which returns `{ conversation, messages: [] }`
    // (services/aiChatService.js:468-475) — same shape as GET /:id.
    http.post(`${API_BASE}/api/ai/conversations`, () =>
        ok201({
            conversation: {
                id: "conv-1",
                title: "New Conversation",
                model: "llama3",
                createdAt: "2025-01-01T00:00:00Z",
                updatedAt: "2025-01-01T00:00:00Z",
            },
            messages: [],
        }),
    ),
    http.get(`${API_BASE}/api/ai/conversations/:id`, () =>
        ok({
            conversation: {
                id: "conv-1",
                title: "Test",
                model: "llama3",
                createdAt: "2025-01-01T00:00:00Z",
                updatedAt: "2025-01-01T00:00:00Z",
            },
            messages: [],
        }),
    ),
    http.delete(`${API_BASE}/api/ai/conversations/:id`, () => noContent()),
    http.get(`${API_BASE}/api/ai/models`, () => ok({ items: [], total: 0 })),

    // Attachments
    // `listBody(items, total)` — routes/attachments.ts.
    http.get(`${API_BASE}/api/attachments/transaction/:id`, () =>
        ok({ items: [], total: 0 }),
    ),
    // 201: routes/attachments.js:113. Body is `attachmentRepository.formatRow`
    // (attachmentRepository.js:19-29) — `size_bytes` (a number) and
    // `stored_path`, NOT `size`. `AttachmentPanel.tsx:61` renders
    // `attachment.size_bytes`. `id` is a BIGSERIAL, so pg sends its text.
    http.post(`${API_BASE}/api/attachments/transaction/:id`, () =>
        ok201({
            id: "1",
            transaction_id: 1,
            filename: "test.pdf",
            stored_path: "attachments/test.pdf",
            mime_type: "application/pdf",
            size_bytes: 1024,
            created_at: "2025-01-01T00:00:00Z",
        }),
    ),
    http.get(
        `${API_BASE}/api/attachments/:id`,
        () =>
            new Response(new Blob(["data"], { type: "application/pdf" }), {
                status: 200,
            }),
    ),
    http.delete(`${API_BASE}/api/attachments/:id`, () => noContent()),

    // Categories sub-routes
    http.post(`${API_BASE}/api/categories/:id/assign`, () =>
        ok({ message: "Assigned", count: 0 }),
    ),
    http.get(`${API_BASE}/api/categories/:id`, () => ok(CATEGORY_STUB)),

    // Imports
    // 201 on the auto-commit arm: routes/importRoutes.js:242 (/csv) and :283
    // (/csv/custom). The review arm answers 202 — see
    // `importCsvReviewRequiredHandlers` above.
    http.post(`${API_BASE}/api/import/csv`, () =>
        ok201(IMPORT_CSV_RESULT_STUB),
    ),
    http.post(`${API_BASE}/api/import/csv/custom`, () =>
        ok201(IMPORT_CSV_RESULT_STUB),
    ),
    // 201: routes/importRoutes.js:406 (categories), :388 (recipients). Both
    // answer `{ ...result, status }` where `result` is the CSV importer's
    // counter object (`dataImportService.js` — total_processed/imported/
    // skipped/errors, plus bank_account_errors on the recipients path) and
    // `status` is derived from `errors`. There is no `message`/`count`:
    // `SimpleImportCard`'s success toast reads imported/skipped/errors.
    http.post(`${API_BASE}/api/import/categories`, () =>
        ok201({
            total_processed: 0,
            imported: 0,
            skipped: 0,
            errors: 0,
            status: "completed",
        }),
    ),
    http.post(`${API_BASE}/api/import/recipients`, () =>
        ok201({
            total_processed: 0,
            imported: 0,
            skipped: 0,
            errors: 0,
            bank_account_errors: 0,
            status: "completed",
        }),
    ),
    http.post(`${API_BASE}/api/import/batches/:batchId/commit`, () =>
        ok({ message: "Committed", batch_id: 1, transactions_committed: 0 }),
    ),
    // POST, not PUT: routes/importRoutes.js:549. `lib/api/imports.ts:274`
    // posts, so the old `http.put` mock served a verb the backend does not
    // register. Body is `{ row_id, user_override_recipient_id }`, not a message.
    http.post(
        `${API_BASE}/api/import/batches/:batchId/rows/:rowId/override`,
        ({ params }) =>
            ok({
                row_id: Number(params.rowId),
                user_override_recipient_id: null,
            }),
    ),

    // Info / portfolio extras
    http.get(`${API_BASE}/api/info/portfolio-summary`, () =>
        ok(PORTFOLIO_SUMMARY_STUB),
    ),
    // `res.ok({ message: 'Exchange rates refreshed from ECB' })` —
    // routes/info/rates.js:94. The route counts nothing: there is no
    // `rates_updated` on the wire, and `lib/api/info.ts:364` reads `{message}`.
    http.post(`${API_BASE}/api/info/exchange-rates/refresh`, () =>
        ok({ message: "Exchange rates refreshed from ECB" }),
    ),
    http.post(`${API_BASE}/api/info/refresh-views`, () =>
        ok({ message: "Views refreshed" }),
    ),

    // Investments sub-routes
    http.get(`${API_BASE}/api/investments/providers`, () =>
        ok({ providers: [] }),
    ),
    // investmentService.refreshPrices with nothing to refresh.
    http.post(`${API_BASE}/api/investments/refresh-prices`, () =>
        ok({ updated: 0, message: "No investments with live price providers" }),
    ),
    http.get(`${API_BASE}/api/investments/transactions`, () =>
        ok({ items: [], total: 0, limit: 100, offset: 0, links: [] }),
    ),
    http.get(`${API_BASE}/api/investments/:id/transactions`, () =>
        ok({ items: [], total: 0, limit: 100, offset: 0, links: [] }),
    ),
    // 201: services/investmentService.js:612. The PATCH below is 200
    // (same controller, :682).
    http.post(`${API_BASE}/api/investments/:id/transactions`, () =>
        ok201(PORTFOLIO_TRANSACTION_STUB),
    ),
    http.patch(`${API_BASE}/api/investments/transactions/:id`, () =>
        ok(PORTFOLIO_TRANSACTION_STUB),
    ),
    http.delete(`${API_BASE}/api/investments/transactions/:id`, () =>
        noContent(),
    ),

    // Recipients sub-routes
    http.get(`${API_BASE}/api/recipients/clusters`, () => ok({ clusters: [] })),
    // Literal sub-routes above must stay ahead of this `:id` catch-all.
    http.get(`${API_BASE}/api/recipients/:id`, ({ params }) =>
        ok({ ...RECIPIENT_STUB, id: Number(params.id) }),
    ),
    http.get(`${API_BASE}/api/recipients/:id/aliases`, () =>
        ok({ aliases: [] }),
    ),
    // `res.ok({ primary, merged_ids, reassigned, aliases, patternSuggestion })`
    // — routes/recipients.js:157-163. `primary` is the re-read recipient row
    // (`{ ...updatedPrimary, links: [] }`), `reassigned` is
    // recipientMergeService's per-table repoint counters, and
    // `patternSuggestion` is `{ pattern, kind, matchCount, confidence }` or
    // null. There is no `message`/`merged_count`: the success toast
    // (useRecipients.ts:91) renders `merged_ids.length` and `primary.name`,
    // neither of which existed in the old `{message, merged_count}` mock.
    http.post(`${API_BASE}/api/recipients/:id/merge`, () =>
        ok({
            primary: { ...RECIPIENT_STUB },
            merged_ids: [2],
            reassigned: {
                transactions: 0,
                splits: 0,
                planned: 0,
                bankAccounts: 0,
            },
            aliases: [{ id: 2, name: "Merged Alias" }],
            patternSuggestion: null,
        }),
    ),
    // `res.ok({ ...recipient, links: [] })` — routes/recipients.js:172. The
    // route re-reads and returns the recipient; `lib/api/recipients.ts:61`
    // types it `Promise<Recipient>`. No `message` is ever sent.
    http.post(`${API_BASE}/api/recipients/:id/unmerge`, () =>
        ok({ ...RECIPIENT_STUB, primary_recipient_id: null }),
    ),
    http.get(`${API_BASE}/api/recipients/:id/patterns`, () =>
        ok({ items: [], total: 0 }),
    ),
    // 201: routes/recipients.js:201.
    http.post(`${API_BASE}/api/recipients/:id/patterns`, () =>
        ok201({
            id: 1,
            pattern: "TEST*",
            pattern_kind: "glob",
            case_sensitive: false,
            priority: 1,
            is_active: true,
            source: "user",
            notes: null,
            created_at: "2025-01-01T00:00:00Z",
            updated_at: "2025-01-01T00:00:00Z",
        }),
    ),
    http.patch(`${API_BASE}/api/recipients/:id/patterns/:patternId`, () =>
        ok({ patternId: 1 }),
    ),
    http.delete(`${API_BASE}/api/recipients/:id/patterns/:patternId`, () =>
        noContent(),
    ),
    // `previewPatternMatches` — routes/recipients.ts (`res.ok(result)`).
    http.post(`${API_BASE}/api/recipients/:id/patterns/preview`, () =>
        ok({ matchCount: 0, recipientIds: [] }),
    ),

    // Reports — routes/reports.ts (`res.ok(document)`, ADR-234).
    ...(["financial", "portfolio", "tax"] as const).map((type) =>
        http.post(`${API_BASE}/api/reports/${type}`, () =>
            ok({
                filename: `vision-${type}-2026-06-22.pdf`,
                html: "<!DOCTYPE html><html><body>Report</body></html>",
                footerTemplate: "<div></div>",
            }),
        ),
    ),

    // Saved charts
    http.get(`${API_BASE}/api/saved-charts`, () => ok({ items: [], total: 0 })),
    // 201: routes/savedCharts.js:175.
    http.post(`${API_BASE}/api/saved-charts`, () => ok201(SAVED_CHART_STUB)),
    http.patch(`${API_BASE}/api/saved-charts/:id`, () =>
        ok({ ...SAVED_CHART_STUB, name: "Updated" }),
    ),
    http.delete(`${API_BASE}/api/saved-charts/:id`, () => noContent()),

    // Splits sub-routes
    http.get(`${API_BASE}/api/splits/transaction/:id`, () => ok({ items: [], total: 0 })),
    // 201: routes/splits.js:298.
    http.post(`${API_BASE}/api/splits/batch`, () => ok201({ items: [] })),
    // NOTE: there is deliberately no `http.patch('/api/splits/:id')` handler.
    // routes/splits.js registers get/post/delete only — a PATCH there 404s in
    // production, and no frontend client sends one. Mocking it would resurrect
    // the dead route this pass removed.
    http.delete(`${API_BASE}/api/splits/:id`, () => noContent()),
    // 201: routes/splits.js:320 — /pay inserts a payment row, so it creates,
    // and answers with that row (`res.ok(payment)`, splits.js:321).
    // /settle only flips a flag: 200, and answers with the updated split
    // (`res.ok(split)`, splits.js:343). Neither sends a `{message}`.
    http.post(`${API_BASE}/api/splits/:id/pay`, () =>
        ok201(SPLIT_PAYMENT_STUB),
    ),
    http.post(`${API_BASE}/api/splits/:id/settle`, () =>
        ok({ ...SPLIT_STUB, is_settled: true }),
    ),
    // Real route answers listBody(splits, total, page) plus the converted
    // `summary`, never a `total_owed` field (routes/splits.ts, GET /owed/:id).
    http.get(`${API_BASE}/api/splits/owed/:recipientId`, () =>
        ok({ items: [], total: 0, summary: OWED_TOTALS_STUB }),
    ),
    http.post(`${API_BASE}/api/splits/owed/:recipientId/settle-all`, () =>
        ok({ message: "Settled", settled_count: 0 }),
    ),

    // Transactions sub-routes
    http.get(`${API_BASE}/api/transactions/:id`, () => ok(TRANSACTION_STUB)),
    http.get(
        `${API_BASE}/api/transactions/export/csv`,
        () =>
            new Response("date,amount\n", {
                status: 200,
                headers: { "Content-Type": "text/csv" },
            }),
    ),
    http.get(
        `${API_BASE}/api/transactions/export/json`,
        () =>
            new Response("[]\n", {
                status: 200,
                headers: { "Content-Type": "application/x-ndjson" },
            }),
    ),

    // Watchlist sub-routes
    // 201: routes/watchlist.js:196.
    http.post(`${API_BASE}/api/watchlist`, () =>
        ok201({
            id: 1,
            symbol: "TEST",
            name: "Test",
            asset_class: "stock",
            currency: "USD",
            target_price: 100,
            added_price: null,
            notes: null,
            price_provider_id: "TEST",
            created_at: "2025-01-01T00:00:00Z",
            updated_at: "2025-01-01T00:00:00Z",
        }),
    ),
    http.patch(`${API_BASE}/api/watchlist/:id`, () =>
        ok({
            id: 1,
            symbol: "TEST",
            name: "Test",
            asset_class: "stock",
            currency: "USD",
            target_price: 100,
            added_price: null,
            notes: null,
            price_provider_id: "TEST",
            created_at: "2025-01-01T00:00:00Z",
            updated_at: "2025-01-01T00:00:00Z",
        }),
    ),
    http.delete(`${API_BASE}/api/watchlist/:id`, () => noContent()),

    // Recipients delete (already handled above) — clusters, etc. covered

    // Market chart — canonical `{items, total}` collection body with the
    // symbol/currency metadata alongside.
    http.get(`${API_BASE}/api/market/chart`, () =>
        ok({ symbol: "TEST", currency: "USD", items: [], total: 0 }),
    ),
];
