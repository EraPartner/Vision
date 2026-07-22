/**
 * Central React Query key factory (TODO Wave A3).
 *
 * Every builder returns the EXACT array shape its call sites used inline before
 * this file existed — same literals, same order, same param positions. React
 * Query matches keys structurally, so changing any shape here silently breaks
 * cache sharing and invalidation for that family. Un-migrated inline sites
 * (e.g. the planned-payments hook) still match because the shapes are
 * identical; treat this file as the single source of truth when adding keys.
 *
 * Naming conventions are historical and intentionally preserved verbatim
 * (camelCase `'monthlySummary'`, kebab-case `'net-worth'`, and the legacy
 * `'exchangeRates'` vs `'exchange-rates'` split) — do NOT "normalise" them.
 *
 * The `invalidate*` helpers at the bottom encapsulate the hand-maintained
 * cross-domain fan-out lists that previously lived in useTransactions,
 * useAccounts and useInvestments.
 */

import type { QueryClient } from '@tanstack/react-query';

// ── Transactions ────────────────────────────────────────────────────────────

export const transactionKeys = {
    /** Invalidation/snapshot prefix for every plain transaction list. */
    all: ['transactions'] as const,
    /** `useTransactions(params)` list cache (one entry per params object). */
    list: (params?: object) => ['transactions', params] as const,
    /** Account-detail sheet's scoped list. */
    accountDetail: (accountId: number | undefined) =>
        ['transactions', 'account-detail', accountId] as const,
    /** Owes page: per-recipient settlement group. */
    owesRecipientGroup: (recipientId: number) =>
        ['transactions', 'owes-recipient-group', recipientId] as const,
    /** Invalidation prefix for the virtualised transaction table. */
    virtualAll: ['transactions-virtual'] as const,
    /** Virtualised table first page (params = filter/sort/page object). */
    virtualList: (params: object) => ['transactions-virtual', params] as const,
};

// ── Recipients / categories / tags / accounts ───────────────────────────────

export const recipientKeys = {
    all: ['recipients'] as const,
    list: (params?: object) => ['recipients', params] as const,
    /** Settings → Statistics exclusion picker (full list snapshot). */
    allList: ['recipients', 'all'] as const,
    /** Merge-recipients dialog (full list snapshot). */
    mergeAll: ['recipients', 'merge-all'] as const,
    /** Virtualised recipients table first page. */
    virtualList: (params: object) => ['recipients', 'virtual', params] as const,
};

export const categoryKeys = {
    all: ['categories'] as const,
    list: (params?: object) => ['categories', params] as const,
    /** Settings → Statistics exclusion picker (full list snapshot). */
    allList: ['categories', 'all'] as const,
    /** useExcludedIds hidden-category resolution (full list snapshot). */
    allForExclusions: ['categories', 'all-for-exclusions'] as const,
};

export const tagKeys = {
    all: ['tags'] as const,
    /** `useTags` list — call as `tagKeys.list(params ?? {})` (never undefined). */
    list: (params: object) => ['tags', params] as const,
};

export const accountKeys = {
    all: ['accounts'] as const,
    list: (params?: object) => ['accounts', params] as const,
};

export const bankAccountKeys = {
    /** Distinct bank-account names (no params). */
    all: ['bankAccounts'] as const,
};

// ── Splits ──────────────────────────────────────────────────────────────────

export const splitKeys = {
    all: ['splits'] as const,
    owedSummary: ['splits', 'owed'] as const,
    owedByRecipient: (recipientId: number | null) => ['splits', 'owed', recipientId] as const,
    byTransaction: (transactionId: number | null) =>
        ['splits', 'transaction', transactionId] as const,
};

// ── Dashboard-derived stats ─────────────────────────────────────────────────

export const monthlySummaryKeys = {
    /** Invalidation prefix — what invalidateTransactionData refetches. */
    all: ['monthlySummary'] as const,
    summary: (currency: string, excludedCategoryIds: number[], excludedRecipientIds: number[]) =>
        ['monthlySummary', currency, excludedCategoryIds, excludedRecipientIds] as const,
};

export const dashboardKeys = {
    /** Invalidation prefix for the dashboard stat cards family. */
    filteredStatsAll: ['filteredDashboardStats'] as const,
    /** DB-total transaction count (filter/currency independent). */
    transactionCount: ['filteredDashboardStats', 'transactionCount'] as const,
    /** Invalidation prefix for the recent-transactions widget. */
    recentTransactionsAll: ['dashboardRecentTransactions'] as const,
    recentTransactions: (
        excludedCategoryIds: number[],
        excludedRecipientIds: number[],
        exclusionsApply: boolean,
    ) =>
        ['dashboardRecentTransactions', excludedCategoryIds, excludedRecipientIds, exclusionsApply] as const,
};

// ── Aggregations (Statistics page, pivots, sankey) ──────────────────────────

export const aggregationKeys = {
    /** Invalidation prefix for every server-side aggregation. */
    all: ['aggregations'] as const,
    monthlySummaryUnfiltered: (currency: string) =>
        ['aggregations', 'monthly-summary', 'unfiltered', currency] as const,
    monthlySummaryFiltered: (currency: string, excludedCategoryIds: number[], excludedRecipientIds: number[]) =>
        ['aggregations', 'monthly-summary', 'filtered', currency, excludedCategoryIds, excludedRecipientIds] as const,
    categoryPivotUnfiltered: (currency: string) =>
        ['aggregations', 'category-pivot', 'unfiltered', currency] as const,
    categoryPivotFiltered: (currency: string, excludedCategoryIds: number[], excludedRecipientIds: number[]) =>
        ['aggregations', 'category-pivot', 'filtered', currency, excludedCategoryIds, excludedRecipientIds] as const,
    recipientInsights: (currency: string) =>
        ['aggregations', 'recipient-insights', currency] as const,
    recipientInsightsFiltered: (currency: string, excludedCategoryIds: number[], excludedRecipientIds: number[]) =>
        ['aggregations', 'recipient-insights', 'filtered', currency, excludedCategoryIds, excludedRecipientIds] as const,
    /**
     * Recipient-insights tab variant — historical 5-element shape WITHOUT the
     * 'filtered' discriminator (distinct cache entry from the two above).
     */
    recipientInsightsWithExclusions: (
        currency: string,
        excludedCategoryIds: number[],
        excludedRecipientIds: number[],
    ) =>
        ['aggregations', 'recipient-insights', currency, excludedCategoryIds, excludedRecipientIds] as const,
    recipientByYearUnfiltered: (currency: string) =>
        ['aggregations', 'recipient-by-year', 'unfiltered', currency] as const,
    recipientByYearFiltered: (currency: string, excludedCategoryIds: number[], excludedRecipientIds: number[]) =>
        ['aggregations', 'recipient-by-year', 'filtered', currency, excludedCategoryIds, excludedRecipientIds] as const,
    sankey: (year: number, currency: string, excludedCategoryIds: number[], excludedRecipientIds: number[]) =>
        ['aggregations', 'sankey', year, currency, excludedCategoryIds, excludedRecipientIds] as const,
    /**
     * Chart-builder pivots. The selected entities MUST key the cache (ADR-041
     * amendment) — else one chart's narrowed payload would be served to a
     * different chart with a different selection; `'all'` keys the
     * all-entities payload so it isn't reused as a narrowed one.
     */
    pivot: (
        kind: string,
        currency: string,
        bucket: string,
        start: string | null,
        end: string | null,
        selection: 'all' | number[],
    ) => ['aggregations', kind, currency, bucket, start, end, selection] as const,
};

// ── Planned payments ────────────────────────────────────────────────────────

export const plannedKeys = {
    /** Shared so the planned-payments page can invalidate after a confirm. */
    matchSuggestions: ['plannedMatchSuggestions'] as const,
    /** Invalidation prefix (the hook keys per-day below it). */
    upcomingAll: ['upcomingPlannedPayments'] as const,
    upcoming: (dateYmd: string) => ['upcomingPlannedPayments', dateYmd] as const,
    /**
     * Invalidation prefix for usePlannedPayments' `['plannedTransactions',
     * showInactive]` caches (that hook still keys inline).
     */
    transactionsAll: ['plannedTransactions'] as const,
    recurringPatterns: ['recurringPatterns'] as const,
};

// ── Cash-flow forecast / bank balances ──────────────────────────────────────

export const cashflowKeys = {
    bankBalancesAll: ['bankBalances'] as const,
    bankBalances: (currency: string) => ['bankBalances', currency] as const,
    forecastMethodsAll: ['cashflowForecastMethods'] as const,
    forecastMethods: (
        currency: string,
        excludedCategoryIds: number[],
        excludedRecipientIds: number[],
        includePlanned: boolean,
    ) =>
        ['cashflowForecastMethods', currency, excludedCategoryIds, excludedRecipientIds, includePlanned] as const,
    forecastRollingAll: ['cashflowForecastRolling'] as const,
    forecastRolling: (
        currency: string,
        excludedCategoryIds: number[],
        excludedRecipientIds: number[],
        includePlanned: boolean,
        rollingDays: number,
    ) =>
        ['cashflowForecastRolling', currency, excludedCategoryIds, excludedRecipientIds, includePlanned, rollingDays] as const,
    forecastRollingDiagnosticsAll: ['cashflowForecastRollingDiagnostics'] as const,
    forecastRollingDiagnostics: (
        currency: string,
        excludedCategoryIds: number[],
        excludedRecipientIds: number[],
        includePlanned: boolean,
        rollingDays: number,
    ) =>
        ['cashflowForecastRollingDiagnostics', currency, excludedCategoryIds, excludedRecipientIds, includePlanned, rollingDays] as const,
    forecastAccuracy: ['cashflow-forecast-accuracy'] as const,
};

// ── Net worth ───────────────────────────────────────────────────────────────

export const netWorthKeys = {
    all: ['net-worth'] as const,
    byCurrency: (currency: string) => ['net-worth', currency] as const,
    table: (params: object) => ['net-worth', 'table', params] as const,
};

// ── Portfolio ───────────────────────────────────────────────────────────────

export const portfolioKeys = {
    investments: ['investments'] as const,
    transactionsAll: ['portfolio-transactions'] as const,
    transactions: (investmentIdsCsv: string) =>
        ['portfolio-transactions', investmentIdsCsv] as const,
    summaryAll: ['portfolio-summary'] as const,
    summary: (currency: string) => ['portfolio-summary', currency] as const,
    performanceAll: ['portfolio-performance'] as const,
    performance: (currency: string, period: string) =>
        ['portfolio-performance', currency, period] as const,
};

// ── Exchange rates ──────────────────────────────────────────────────────────

export const exchangeRateKeys = {
    /**
     * Shared FX cache: useExchangeRates, useCurrencyConverter and the admin
     * ExchangeRatesPage all read/invalidate this one namespace.
     */
    all: ['exchange-rates'] as const,
    /**
     * Legacy camelCase namespace used only by the FX status banner — a
     * DISTINCT cache family from `all`; do not merge them.
     */
    fxStatus: ['exchangeRates', { dbOnly: true }] as const,
};

// ── AI chat / Ollama ────────────────────────────────────────────────────────

export const aiKeys = {
    conversations: ['ai', 'conversations'] as const,
    conversation: (id: string | null) => ['ai', 'conversations', id] as const,
    /** Invalidation prefix covering both Ollama status and models. */
    ollamaAll: ['ai', 'ollama'] as const,
    ollamaStatus: ['ai', 'ollama', 'status'] as const,
    ollamaModels: ['ai', 'ollama', 'models'] as const,
};

// ── Imports ─────────────────────────────────────────────────────────────────

export const importKeys = {
    batchesAll: ['importBatches'] as const,
    batches: (offset: number) => ['importBatches', offset] as const,
    preview: (batchId: number) => ['import-preview', batchId] as const,
    supportedParsers: ['supported-parsers'] as const,
    customParserConfigs: ['custom-parser-configs'] as const,
    portfolioParserConfigs: ['portfolio-parser-configs'] as const,
};

// ── Settings-backed values ──────────────────────────────────────────────────

export const settingKeys = {
    /** Single key-value setting (note singular `'setting'` root). */
    byKey: (key: string) => ['setting', key] as const,
    /** Rebalance plans persisted under the generic settings store (ADR-098). */
    rebalancePlans: ['settings', 'rebalance_plans'] as const,
};

// ── Misc singletons ─────────────────────────────────────────────────────────

export const savedChartKeys = {
    all: ['saved-charts'] as const,
};

export const watchlistKeys = {
    all: ['watchlist'] as const,
};

export const researchKeys = {
    providerKeys: ['research-provider-keys'] as const,
};

// ── Admin ───────────────────────────────────────────────────────────────────

export const adminKeys = {
    endpoints: ['admin', 'endpoints'] as const,
    requestMetrics: ['admin', 'request-metrics'] as const,
    dbStats: ['admin', 'db-stats'] as const,
    providerHealth: ['admin', 'provider-health'] as const,
    dbTableAll: (table: string) => ['admin', 'db-table', table] as const,
    dbTable: (table: string, page: number, sort: unknown, filters: unknown) =>
        ['admin', 'db-table', table, page, sort, filters] as const,
};

// ── Cross-domain invalidation fan-out helpers ───────────────────────────────

/**
 * Everything derived from the transaction set.
 *
 * Dashboard stat cards (['filteredDashboardStats']), the Statistics page
 * (['aggregations', …]) and the dashboard recent-transactions widget
 * (['dashboardRecentTransactions', …]) all derive from transactions but were
 * historically never invalidated, so they served stale data (deleted/imported
 * rows still showing) until staleTime expired. Window-focus refetch is
 * disabled globally, so only explicit invalidation refreshes them.
 */
export function invalidateTransactionData(queryClient: QueryClient) {
    queryClient.invalidateQueries({ queryKey: transactionKeys.all });
    queryClient.invalidateQueries({ queryKey: transactionKeys.virtualAll });
    queryClient.invalidateQueries({ queryKey: monthlySummaryKeys.all });
    queryClient.invalidateQueries({ queryKey: dashboardKeys.filteredStatsAll });
    queryClient.invalidateQueries({ queryKey: aggregationKeys.all });
    queryClient.invalidateQueries({ queryKey: dashboardKeys.recentTransactionsAll });
}

/**
 * Account CRUD changes balances/in_net_worth flags, so the net-worth view
 * must refetch too — NetWorthPage keeps its query at a 2-minute staleTime,
 * so a missed invalidation shows a stale total for up to 2 minutes.
 */
export function invalidateAccountDerived(queryClient: QueryClient) {
    queryClient.invalidateQueries({ queryKey: accountKeys.all });
    queryClient.invalidateQueries({ queryKey: netWorthKeys.all });
}

/**
 * A merge or close repoints transactions / planned / holdings / funding from
 * one account onto another, so it touches more than the account-derived views:
 * the transaction lists, planned-payment surfaces and the portfolio trees all
 * restate. This is the targeted replacement for a blanket
 * `queryClient.invalidateQueries()` — it refetches exactly those trees and
 * leaves unrelated caches (categories, recipients, market data, exchange
 * rates, …) untouched so a merge/close no longer triggers a whole-app refetch
 * storm.
 */
export function invalidateAccountRepoint(queryClient: QueryClient) {
    invalidateAccountDerived(queryClient);
    invalidateTransactionData(queryClient);
    // The dashboard bank-balances widget (history + net-position) and the
    // cash-flow forecast both key off account balances, so a repoint restates them.
    queryClient.invalidateQueries({ queryKey: cashflowKeys.bankBalancesAll });
    queryClient.invalidateQueries({ queryKey: cashflowKeys.forecastMethodsAll });
    queryClient.invalidateQueries({ queryKey: cashflowKeys.forecastRollingAll });
    queryClient.invalidateQueries({ queryKey: cashflowKeys.forecastRollingDiagnosticsAll });
    // Planned payments can reference the merged/closed account.
    queryClient.invalidateQueries({ queryKey: plannedKeys.upcomingAll });
    queryClient.invalidateQueries({ queryKey: plannedKeys.transactionsAll });
    queryClient.invalidateQueries({ queryKey: plannedKeys.matchSuggestions });
    // Holdings move across accounts (in-specie), so the portfolio trees restate.
    queryClient.invalidateQueries({ queryKey: portfolioKeys.investments });
    queryClient.invalidateQueries({ queryKey: portfolioKeys.transactionsAll });
    queryClient.invalidateQueries({ queryKey: portfolioKeys.summaryAll });
    queryClient.invalidateQueries({ queryKey: portfolioKeys.performanceAll });
}

/**
 * Everything derived from investments / portfolio transactions. Investment
 * CRUD also moves the net-worth total; the net-worth query sits at a
 * 2-minute staleTime on NetWorthPage, so without this it shows stale figures.
 */
export function invalidateInvestmentData(queryClient: QueryClient) {
    queryClient.invalidateQueries({ queryKey: portfolioKeys.investments });
    queryClient.invalidateQueries({ queryKey: portfolioKeys.transactionsAll });
    queryClient.invalidateQueries({ queryKey: portfolioKeys.summaryAll });
    queryClient.invalidateQueries({ queryKey: portfolioKeys.performanceAll });
    queryClient.invalidateQueries({ queryKey: netWorthKeys.all });
}
