import { http, HttpResponse } from "msw";

const API_BASE = "http://localhost:3002";

interface EnvelopeMeta {
    requestId?: string;
    total?: number;
    page?: number;
    limit?: number;
    [key: string]: unknown;
}

/** ADR-026 success envelope: { ok: true, data, meta? } */
export function ok<T>(data: T, meta?: EnvelopeMeta) {
    return HttpResponse.json({ ok: true, data, ...(meta ? { meta } : {}) });
}

/** ADR-026 failure envelope: { ok: false, error: { message, code? } } */
export function err(status: number, message: string, code?: string) {
    return HttpResponse.json(
        { ok: false, error: { message, ...(code ? { code } : {}) } },
        { status },
    );
}

const AGG_COMPUTED_AT = "2025-01-01T00:00:00Z";

/** Aggregation-endpoint envelope: ok({ data, meta: { computedAt, source: "live" } }). */
export function aggOk<T>(data: T, computedAt: string = AGG_COMPUTED_AT) {
    return ok({ data, meta: { computedAt, source: "live" as const } });
}

/**
 * Hard-delete stub: 204 No Content, no envelope.
 * See docs/reference/code-patterns.md, "DELETE responses".
 */
export function noContent() {
    return new HttpResponse(null, { status: 204 });
}

// ── Mutation fixture stubs — minimal valid shapes matching backend formatters ─

export const TRANSACTION_STUB = {
    id: 1,
    transaction_date: "2025-01-15",
    date: "2025-01-15",
    bank_account: "BE12345678901234",
    recipient_id: 1,
    recipient_name: "Test Recipient",
    memo: "Test memo",
    amount: -25.5,
    currency: "EUR",
    balance: null,
    category_id: 1,
    category_name: "FOOD:GROCERIES",
    comment: null,
    is_active: true,
    created_at: "2025-01-15T10:00:00.000Z",
    updated_at: null,
};

export const CATEGORY_STUB = {
    id: 1,
    general: "FOOD",
    detail: "GROCERIES",
    description: null,
    is_active: true,
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: null,
    category_name: "FOOD:GROCERIES",
    links: [],
};

export const RECIPIENT_STUB = {
    id: 1,
    name: "Test Recipient",
    normalized_name: "test recipient",
    default_category_id: null,
    primary_recipient_id: null,
    notes: null,
    is_active: true,
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: null,
    links: [],
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
    is_active: true,
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: null,
    links: [],
};

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
    statement_balance: null,
    statement_balance_date: null,
    computed_balance: 0,
    drift: null,
    is_active: true,
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: null,
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
 * `respondReviewRequired`); the default handler models the completed one, so a
 * test that needs the review branch overrides it via `server.use(...)`.
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
 * Default handlers cover the chatty boot-time endpoints so any page can render
 * without crashing. Tests override per-flow handlers via `server.use(...)`.
 */
export const defaultHandlers = [
    http.get(`${API_BASE}/api/settings`, () => ok({})),
    http.get(`${API_BASE}/api/settings/:key`, () => ok(null)),
    http.put(`${API_BASE}/api/settings/:key`, () => ok({ ok: true })),

    http.get(`${API_BASE}/api/info`, () =>
        ok({ version: "test", commit: "test", buildDate: "test" }),
    ),
    http.get(`${API_BASE}/api/info/health`, () => ok({ status: "ok" })),

    http.get(`${API_BASE}/api/categories`, () =>
        ok({ items: [], total: 0, limit: 200, offset: 0, links: [] }),
    ),
    http.get(`${API_BASE}/api/recipients`, () =>
        ok({ items: [], total: 0, limit: 200, offset: 0, links: [] }),
    ),
    // Accounts API (ADR-088) — account pickers/filters now mount across the
    // transactions, portfolio, and net-worth surfaces. An empty list keeps those
    // fetches from leaking past teardown or tripping the unhandled-request guard.
    http.get(`${API_BASE}/api/accounts`, () => ok({ items: [], total: 0, links: [] })),
    http.get(`${API_BASE}/api/accounts/:id`, () => ok(ACCOUNT_STUB)),
    // Tags API — used by TagPicker inside dialogs/forms across the app.
    // Returning an empty list keeps async fetches from leaking past test
    // teardown and avoids "intercepted a request without a matching request
    // handler" warnings flooding the test output.
    http.get(`${API_BASE}/api/tags`, () => ok([])),
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
        aggOk({
            months: [],
            summary: {
                total_spending: 0,
                total_income: 0,
                net_amount: 0,
                transaction_count: 0,
                period_start: "",
                period_end: "",
            },
        }, "2025-01-01T00:00:00.000Z"),
    ),
    http.get(`${API_BASE}/api/aggregations/recipient-insights`, () =>
        aggOk({ topMerchants: [], monthOverMonth: [] }, "2025-01-01T00:00:00.000Z"),
    ),
    http.get(`${API_BASE}/api/aggregations/cashflow-comparison`, () =>
        aggOk({
            days_in_month: 31,
            current_day: 1,
            month: 1,
            year: 2025,
            without_planned: [],
            with_planned: [],
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
            methods: [],
            planned: [],
            diagnostics: null,
            history_months: 0,
            include_planned: false,
        }),
    ),
    http.get(`${API_BASE}/api/aggregations/category-pivot`, () =>
        aggOk({ categoryPivot: {} }),
    ),
    http.get(`${API_BASE}/api/aggregations/recipient-by-year`, () =>
        aggOk({ recipientsByYear: {} }),
    ),
    http.get(`${API_BASE}/api/aggregations/recipient-pivot`, () =>
        aggOk({ recipientPivot: {} }),
    ),
    http.get(`${API_BASE}/api/aggregations/sankey`, () =>
        aggOk({ nodes: [], links: [], year: 2025 }),
    ),
    http.get(`${API_BASE}/api/aggregations/category-breakdown`, () =>
        aggOk({ categories: [] }),
    ),
    http.get(`${API_BASE}/api/aggregations/bank-balances`, () =>
        aggOk({
            accounts: [],
            total_net_position: 0,
            history: {},
            total_history: [],
        }),
    ),
    http.get(`${API_BASE}/api/aggregations/average-vs-current`, () =>
        aggOk({ months: [] }),
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
        }),
    ),

    http.get(`${API_BASE}/api/info/exchange-rates`, () =>
        ok({ rates: [], fallback_rates: {}, base: "EUR", date: "2025-01-01" }),
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

    http.get(`${API_BASE}/api/splits/owed`, () => ok({ items: [] })),

    http.get(`${API_BASE}/api/market/quote`, () => ok({ items: [], total: 0 })),
    http.get(`${API_BASE}/api/market/search`, () => ok({ results: [] })),
    // Research aggregator endpoints (consumed by the Market Lookup Details tabs
    // — scorecard fires on load, analyst/news on tab-click). Default to an
    // unavailable envelope so component tests degrade gracefully; integration
    // tests override per-flow via server.use().
    http.get(`${API_BASE}/api/research/scorecard`, () => ok(null, { provider: null, source: "unavailable" })),
    http.get(`${API_BASE}/api/research/analyst`, () => ok(null, { provider: null, source: "unavailable" })),
    http.get(`${API_BASE}/api/research/news`, () => ok(null, { provider: null, source: "unavailable" })),
    http.get(`${API_BASE}/api/watchlist`, () =>
        ok({ items: [], total: 0, limit: 50, offset: 0 }),
    ),

    http.get(`${API_BASE}/api/ai/status`, () =>
        ok({ ok: false, baseUrl: "", defaultModel: "", enabled: false }),
    ),
    http.get(`${API_BASE}/api/ai/conversations`, () => ok({ items: [], total: 0 })),

    http.get(`${API_BASE}/api/info/portfolio-performance`, () =>
        ok({
            snapshots: [],
            currency: "EUR",
            start_value: 0,
            end_value: 0,
            absolute_return: 0,
            percentage_return: 0,
        }),
    ),
    http.get(`${API_BASE}/api/info/net-worth`, () =>
        ok({
            current: { liquid: 0, investments: 0, netWorth: 0 },
            monthlyChange: 0,
            monthlyChangePercent: 0,
            snapshots: [],
        }),
    ),
    // Live response shapes (these routes all return objects, not bare scalars/
    // arrays). The old scalar/array mocks let component tests run against
    // impossible API states (e.g. res.adapters undefined) and made the msw
    // contract suite pin a shape that contradicted the live-contracts suite.
    // (transaction-summary handler removed — Phase 9 deleted that route.)
    http.get(`${API_BASE}/api/info/transaction-count`, () => ok({ total_transactions: 0 })),
    http.get(`${API_BASE}/api/info/recurring-patterns`, () => ok({ patterns: [], total: 0 })),
    http.get(`${API_BASE}/api/info/insights-digest`, () =>
        ok({
            subscriptionCreep: { new: [], priceChanges: [] },
            categoryOutliers: [],
            cashForecast: null,
        }),
    ),
    http.get(`${API_BASE}/api/info/banks`, () => ok({ items: [], total: 0 })),
    http.get(`${API_BASE}/api/info/supported-adapters`, () => ok({ items: [], total: 0 })),
    http.get(`${API_BASE}/api/info/inflation-rates`, () => ok([])),

    http.get(`${API_BASE}/api/admin/endpoint-liveness`, () => ok({ items: [], total: 0 })),
    http.get(`${API_BASE}/api/admin/database/stats`, () =>
        ok({ tables: [], db_size: null }),
    ),
    http.get(`${API_BASE}/api/admin/providers/health`, () => ok({ items: [], total: 0 })),
    http.get(`${API_BASE}/api/admin/metrics/requests`, () => ok({ items: [], total: 0 })),
    http.get(`${API_BASE}/api/admin/endpoints`, () => ok({ items: [], total: 0 })),

    // ── Mutation stubs ───────────────────────────────────────────────────────
    // These prevent onUnhandledRequest:"error" and are validated by contract
    // tests. Integration tests override them per-flow via server.use().

    http.post(`${API_BASE}/api/transactions`, () => ok(TRANSACTION_STUB)),
    http.patch(`${API_BASE}/api/transactions/:id`, () => ok(TRANSACTION_STUB)),
    http.delete(`${API_BASE}/api/transactions/:id`, () => noContent()),

    http.post(`${API_BASE}/api/categories`, () => ok(CATEGORY_STUB)),
    http.patch(`${API_BASE}/api/categories/:id`, () => ok(CATEGORY_STUB)),
    http.delete(`${API_BASE}/api/categories/:id`, () => noContent()),

    http.post(`${API_BASE}/api/recipients`, () => ok(RECIPIENT_STUB)),
    http.patch(`${API_BASE}/api/recipients/:id`, () => ok(RECIPIENT_STUB)),
    http.delete(`${API_BASE}/api/recipients/:id`, () => noContent()),

    http.post(`${API_BASE}/api/investments`, () => ok(INVESTMENT_STUB)),
    http.patch(`${API_BASE}/api/investments/:id`, () => ok(INVESTMENT_STUB)),
    http.delete(`${API_BASE}/api/investments/:id`, () => noContent()),

    http.post(`${API_BASE}/api/accounts`, () => ok(ACCOUNT_STUB)),
    http.patch(`${API_BASE}/api/accounts/:id`, () => ok(ACCOUNT_STUB)),
    http.delete(`${API_BASE}/api/accounts/:id`, () => noContent()),
    http.post(`${API_BASE}/api/accounts/:id/merge`, () =>
        ok({ into: 1, merged: [2], reassigned: { transactions: 0, planned: 0, portfolio: 0, funding: 0 } }),
    ),

    http.post(`${API_BASE}/api/planned-transactions`, () => ok(PLANNED_TRANSACTION_STUB)),
    http.patch(`${API_BASE}/api/planned-transactions/:id`, () => ok(PLANNED_TRANSACTION_STUB)),
    http.delete(`${API_BASE}/api/planned-transactions/:id`, () => noContent()),
    http.post(`${API_BASE}/api/planned-transactions/:id/execute`, () =>
        ok({ ...PLANNED_TRANSACTION_STUB, is_executed: true }),
    ),
    http.get(`${API_BASE}/api/planned-transactions/due-soon`, () => ok({ items: [], total: 0, days: 7 })),

    // ── Phase F1: full contract surface coverage ────────────────────────────

    // Admin
    http.get(`${API_BASE}/api/admin/update/check`, () =>
        ok({ available: false, current: "test", latest: "test" }),
    ),
    http.post(`${API_BASE}/api/admin/database/vacuum`, () =>
        ok({ message: "Vacuum complete" }),
    ),

    // AI
    http.post(`${API_BASE}/api/ai/chat`, () =>
        ok({ id: "msg-1", conversationId: "conv-1", role: "assistant", content: "ok", createdAt: "2025-01-01T00:00:00Z" }),
    ),
    http.post(`${API_BASE}/api/ai/conversations`, () =>
        ok({
            conversation: { id: "conv-1", title: "New Conversation", model: "llama3", createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z" },
            messages: [],
        }),
    ),
    http.get(`${API_BASE}/api/ai/conversations/:id`, () =>
        ok({
            conversation: { id: "conv-1", title: "Test", model: "llama3", createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z" },
            messages: [],
        }),
    ),
    http.delete(`${API_BASE}/api/ai/conversations/:id`, () => noContent()),
    http.get(`${API_BASE}/api/ai/models`, () => ok({ items: [], total: 0 })),

    // Attachments
    http.get(`${API_BASE}/api/attachments/transaction/:id`, () => ok({ items: [] })),
    http.post(`${API_BASE}/api/attachments/transaction/:id`, () =>
        ok({ id: 1, transaction_id: 1, filename: "test.pdf", mime_type: "application/pdf", size: 1024, created_at: "2025-01-01T00:00:00Z" }),
    ),
    http.get(`${API_BASE}/api/attachments/:id`, () =>
        new Response(new Blob(["data"], { type: "application/pdf" }), { status: 200 }),
    ),
    http.delete(`${API_BASE}/api/attachments/:id`, () => noContent()),

    // Categories sub-routes
    http.post(`${API_BASE}/api/categories/assign`, () =>
        ok({ message: "Assigned", count: 0 }),
    ),
    http.post(`${API_BASE}/api/categories/:id/assign`, () =>
        ok({ message: "Assigned", count: 0 }),
    ),
    http.get(`${API_BASE}/api/categories/:id`, () => ok(CATEGORY_STUB)),

    // Imports
    http.post(`${API_BASE}/api/import/csv`, () => ok(IMPORT_CSV_RESULT_STUB)),
    http.post(`${API_BASE}/api/import/csv/custom`, () => ok(IMPORT_CSV_RESULT_STUB)),
    http.post(`${API_BASE}/api/import/categories`, () =>
        ok({ message: "Imported", count: 0 }),
    ),
    http.post(`${API_BASE}/api/import/recipients`, () =>
        ok({ message: "Imported", count: 0 }),
    ),
    http.post(`${API_BASE}/api/import/batches/:batchId/commit`, () =>
        ok({ message: "Committed", batch_id: 1, transactions_committed: 0 }),
    ),
    http.put(`${API_BASE}/api/import/batches/:batchId/rows/:rowId/override`, () =>
        ok({ message: "Override applied" }),
    ),

    // Info / portfolio extras
    http.get(`${API_BASE}/api/info/portfolio-summary`, () =>
        ok({
            currency: "EUR",
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
        }),
    ),
    http.post(`${API_BASE}/api/info/exchange-rates/refresh`, () =>
        ok({ message: "Rates refreshed", rates_updated: 0 }),
    ),
    http.post(`${API_BASE}/api/info/refresh-views`, () =>
        ok({ message: "Views refreshed" }),
    ),

    // Investments sub-routes
    http.get(`${API_BASE}/api/investments/providers`, () => ok({ providers: [] })),
    http.post(`${API_BASE}/api/investments/refresh-prices`, () =>
        ok({
            message: "Prices refreshed",
            updated_count: 0,
            stale_count: 0,
            cached_count: 0,
            live: true,
        }),
    ),
    http.get(`${API_BASE}/api/investments/transactions`, () =>
        ok({ items: [], total: 0, limit: 100, offset: 0, links: [] }),
    ),
    http.get(`${API_BASE}/api/investments/:id/transactions`, () =>
        ok({ items: [], total: 0 }),
    ),
    http.post(`${API_BASE}/api/investments/:id/transactions`, () =>
        ok({ id: 1, investment_id: 1, type: "buy", date: "2025-01-01", amount: 100, units: 1, price_per_unit: 100, currency: "EUR", is_recurring: false, created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-01T00:00:00Z" }),
    ),
    http.patch(`${API_BASE}/api/investments/transactions/:id`, () =>
        ok({ id: 1, investment_id: 1, type: "buy", date: "2025-01-01", amount: 100, units: 1, price_per_unit: 100, currency: "EUR", is_recurring: false, created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-01T00:00:00Z" }),
    ),
    http.delete(`${API_BASE}/api/investments/transactions/:id`, () => noContent()),

    // Recipients sub-routes
    http.get(`${API_BASE}/api/recipients/clusters`, () => ok({ clusters: [] })),
    http.get(`${API_BASE}/api/recipients/:id/aliases`, () => ok({ aliases: [] })),
    http.post(`${API_BASE}/api/recipients/:id/merge`, () =>
        ok({ message: "Merged", merged_count: 0 }),
    ),
    http.post(`${API_BASE}/api/recipients/:id/unmerge`, () =>
        ok({ message: "Unmerged" }),
    ),
    http.get(`${API_BASE}/api/recipients/:id/patterns`, () =>
        ok({ items: [], total: 0 }),
    ),
    http.post(`${API_BASE}/api/recipients/:id/patterns`, () =>
        ok({ id: 1, pattern: "TEST*", pattern_kind: "glob", case_sensitive: false, priority: 1, is_active: true, source: "user", notes: null, created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-01T00:00:00Z" }),
    ),
    http.patch(`${API_BASE}/api/recipients/:id/patterns/:patternId`, () =>
        ok({ patternId: 1 }),
    ),
    http.delete(`${API_BASE}/api/recipients/:id/patterns/:patternId`, () => noContent()),
    http.post(`${API_BASE}/api/recipients/:id/patterns/preview`, () =>
        ok({ matches: [] }),
    ),

    // Reports
    http.post(`${API_BASE}/api/reports/financial`, () =>
        new Response(new Blob(["PDF"], { type: "application/pdf" }), { status: 200 }),
    ),
    http.post(`${API_BASE}/api/reports/portfolio`, () =>
        new Response(new Blob(["PDF"], { type: "application/pdf" }), { status: 200 }),
    ),
    http.post(`${API_BASE}/api/reports/tax`, () =>
        new Response(new Blob(["PDF"], { type: "application/pdf" }), { status: 200 }),
    ),

    // Saved charts
    http.get(`${API_BASE}/api/saved-charts`, () => ok({ items: [], total: 0 })),
    http.post(`${API_BASE}/api/saved-charts`, () =>
        ok({ id: 1, name: "Test chart", config: {}, created_at: "2025-01-01T00:00:00Z" }),
    ),
    http.patch(`${API_BASE}/api/saved-charts/:id`, () =>
        ok({ id: 1, name: "Updated", config: {}, created_at: "2025-01-01T00:00:00Z" }),
    ),
    http.delete(`${API_BASE}/api/saved-charts/:id`, () => noContent()),

    // Splits sub-routes
    http.get(`${API_BASE}/api/splits/transaction/:id`, () => ok({ items: [] })),
    http.post(`${API_BASE}/api/splits/batch`, () => ok({ items: [] })),
    http.patch(`${API_BASE}/api/splits/:id`, () =>
        ok({ id: 1, transaction_id: 1, recipient_id: 1, amount: 0, note: null, is_paid: false, paid_at: null, created_at: "2025-01-01T00:00:00Z" }),
    ),
    http.delete(`${API_BASE}/api/splits/:id`, () => noContent()),
    http.post(`${API_BASE}/api/splits/:id/pay`, () =>
        ok({ message: "Paid" }),
    ),
    http.post(`${API_BASE}/api/splits/:id/settle`, () =>
        ok({ message: "Settled" }),
    ),
    http.get(`${API_BASE}/api/splits/owed/:recipientId`, () =>
        ok({ items: [], total_owed: 0 }),
    ),
    http.post(`${API_BASE}/api/splits/owed/:recipientId/settle-all`, () =>
        ok({ message: "Settled", settled_count: 0 }),
    ),

    // Transactions sub-routes
    http.get(`${API_BASE}/api/transactions/:id`, () => ok(TRANSACTION_STUB)),
    http.get(`${API_BASE}/api/transactions/export/csv`, () =>
        new Response("date,amount\n", {
            status: 200,
            headers: { "Content-Type": "text/csv" },
        }),
    ),
    http.get(`${API_BASE}/api/transactions/export/json`, () =>
        new Response("[]\n", {
            status: 200,
            headers: { "Content-Type": "application/x-ndjson" },
        }),
    ),

    // Watchlist sub-routes
    http.post(`${API_BASE}/api/watchlist`, () =>
        ok({ id: 1, symbol: "TEST", name: "Test", asset_class: "stock", currency: "USD", target_price: 100, notes: null, price_provider_id: "TEST", created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-01T00:00:00Z" }),
    ),
    http.patch(`${API_BASE}/api/watchlist/:id`, () =>
        ok({ id: 1, symbol: "TEST", name: "Test", asset_class: "stock", currency: "USD", target_price: 100, notes: null, price_provider_id: "TEST", created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-01T00:00:00Z" }),
    ),
    http.delete(`${API_BASE}/api/watchlist/:id`, () => noContent()),

    // Recipients delete (already handled above) — clusters, etc. covered

    // Market chart — canonical `{items, total}` collection body with the
    // symbol/currency metadata alongside.
    http.get(`${API_BASE}/api/market/chart`, () =>
        ok({ symbol: "TEST", currency: "USD", items: [], total: 0 }),
    ),
];
