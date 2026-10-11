// @vitest-environment node
/**
 * Response contracts (ADR-193) for the portfolio, market, research, AI
 * research, dossier, saved-chart, info and aggregation reads. Each row serves
 * one realistic synthetic wire body and checks that the client accepts it,
 * then serves a drifted body and checks that the client rejects it with
 * ApiContractError instead of handing it to a screen.
 */
import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw/server";
import {
    INVESTMENT_STUB,
    PORTFOLIO_SUMMARY_STUB,
    PORTFOLIO_TRANSACTION_STUB,
    SAVED_CHART_STUB,
} from "@/test/msw/handlers";
import { API_BASE } from "./clientTestHarness";

import {
    bulkRetagPortfolioTransactions,
    createInvestment,
    createPortfolioTransaction,
    getInvestmentPriceHistory,
    getInvestments,
    getPortfolioTransactions,
    getPortfolioTransactionsBulk,
    getSupportedPriceProviders,
    refreshInvestmentPrices,
    updateInvestment,
    updatePortfolioTransaction,
} from "@/lib/api/portfolio";
import { getPortfolioExposure } from "@/lib/api/portfolioExposure";
import {
    commitPortfolioImportBatch,
    createPortfolioParserConfig,
    getPortfolioImportPreview,
    importPortfolioCSVCustom,
    listPortfolioParserConfigs,
    overridePortfolioImportRow,
    overridePortfolioImportRows,
    rollbackPortfolioImportBatch,
    updatePortfolioParserConfig,
} from "@/lib/api/portfolioImports";
import {
    createWatchlistItem,
    getMarketChart,
    getMarketNews,
    getMarketQuotes,
    getWatchlist,
    searchMarket,
    updateWatchlistItem,
} from "@/lib/api/market";
import {
    auditResearchMappings,
    getMacroSeries,
    getPortfolioForecast,
    getResearchAnalyst,
    getResearchChart,
    getResearchMappings,
    getResearchNews,
    getResearchProviderKeys,
    getResearchScorecard,
    resolveResearchMappings,
    saveResearchMappings,
    searchMacro,
    searchResearch,
    setResearchProviderKey,
} from "@/lib/api/research";
import {
    cancelInvestigation,
    createDisclosureGrant,
    createInvestigation,
    deleteDisclosureRecords,
    getAgentCloakDesktopStatus,
    getAiResearchStatus,
    getInvestigation,
    listDisclosureGrants,
    listDisclosureRecords,
    listResearchDocuments,
    previewDisclosure,
    resumeInvestigation,
    revokeDisclosureGrant,
    setAgentCloakDesktopEnabled,
    uploadResearchDocument,
} from "@/lib/api/aiResearch";
import {
    createDossier,
    exportDossier,
    exportDossiers,
    getDossier,
    listDossiers,
    listDossierVersions,
    restoreDossierVersion,
    updateDossier,
} from "@/lib/api/dossiers";
import {
    createSavedChart,
    getSavedCharts,
    updateSavedChart,
} from "@/lib/api/charts";
import {
    getBrokerPortfolioPerformance,
    getDeductionCandidates,
    getDistinctBankAccounts,
    getExchangeRates,
    getInsightsCount,
    getNetWorth,
    getPortfolioPerformance,
    getPortfolioSummary,
    getSupportedParsers,
    getTransactionCount,
    refreshExchangeRates,
} from "@/lib/api/info";
import {
    getAggregationAverageVsCurrent,
    getAggregationBankBalances,
    getAggregationCategoryPivot,
    getAggregationMonthlySummary,
    getAggregationRecipientByYear,
    getAggregationRecipientInsights,
    getAggregationRecipientPivot,
    getAggregationTagPivot,
    getCashflowForecastAccuracy,
    getCashflowForecastMethods,
    getCashflowForecastRolling,
    getSankeyFlow,
} from "@/lib/api/aggregations";

afterEach(() => server.resetHandlers());

type Method = "get" | "post" | "put" | "patch" | "delete";

interface Row {
    /** `METHOD /path` as the route is documented. */
    route: string;
    method: Method;
    /** MSW path (relative to the API base). */
    path: string;
    status?: number;
    body: unknown;
    /** Envelope meta (the research data routes carry provenance here). */
    meta?: Record<string, unknown>;
    call: () => Promise<unknown>;
}

const TS = "2025-01-01T00:00:00.000Z";
const UUID = "00000000-0000-4000-8000-000000000001";
const SHA = "a".repeat(64);
const RESEARCH_META = { provider: "yahoo", source: "live" };

const aggregation = (data: unknown) => ({
    data,
    meta: { computedAt: TS, source: "live" },
});

const PARSER_CONFIG = {
    id: 1,
    name: "Broker export",
    kind: "portfolio",
    config: { format: "ibkr_transaction_history" },
    created_at: TS,
    updated_at: TS,
};

const WATCHLIST_ITEM = {
    id: 1,
    name: "Example Corp",
    symbol: "EXMP",
    asset_class: "stock",
    target_price: 100,
    added_price: 90,
    currency: "USD",
    notes: null,
    price_provider_id: "EXMP",
    created_at: TS,
    updated_at: TS,
};

const MAPPING = {
    id: 1,
    instrument_key: "XX0000000001",
    key_type: "isin",
    provider: "yahoo",
    provider_symbol: "EXMP",
    resolved_name: "Example Corp",
    exchange: null,
    currency: "USD",
    status: "confirmed",
    verified_at: null,
    created_at: TS,
    updated_at: TS,
};

const INVESTIGATION = {
    id: UUID,
    conversationId: null,
    question: "How did my spending change?",
    route: "local",
    model: null,
    depth: "quick",
    language: "en",
    state: "queued",
    scope: { scope: { workspaces: ["budgeting"] } },
    plan: null,
    checkpoint: {},
    result: null,
    error: null,
    grantId: null,
    cancelRequestedAt: null,
    startedAt: null,
    completedAt: null,
    createdAt: TS,
    updatedAt: TS,
};

const GRANT = {
    id: UUID,
    route: "openai-api",
    mode: "cloud-plan-public",
    purpose: "Plan a public question",
    preview_payload_sha256: SHA,
    allowed_fields_json: ["question"],
    max_requests: 1,
    max_input_characters: 1000,
    max_output_tokens: 900,
    max_cost_micros: "1000",
    max_disclosure_units: 1,
    used_requests: 0,
    used_input_characters: "0",
    used_output_tokens: "0",
    used_cost_micros: "0",
    policy_version: 1,
    retain_exact_payload: false,
    expires_at: TS,
    revoked_at: null,
    created_at: TS,
    updated_at: TS,
};

const RESEARCH_DOCUMENT = {
    id: UUID,
    title: "Notes",
    sourceName: "notes.md",
    mediaType: "text/markdown",
    contentSha256: SHA,
    version: 1,
    extractionStatus: "ready",
    extractionError: null,
    createdAt: TS,
    updatedAt: TS,
};

const DOSSIER_CONTENT = {
    title: "Rebalance review",
    workspace: "portfolio",
    question: "Should the allocation change?",
    userThesis: "",
    assumptions: [],
    openQuestions: [],
    conclusion: "",
    reviewDate: null,
    evidence: [
        {
            id: UUID,
            stance: "context",
            origin: "user",
            claim: "Allocation drifted.",
            source: {
                title: "Statement",
                reference: "statement-1",
                sourceDate: "2025-01-01",
                accessedAt: null,
            },
            notes: "",
        },
    ],
    links: { categoryIds: [], investmentIds: [1], savedAnalysisIds: [] },
};

const DOSSIER = {
    id: UUID,
    version: 1,
    ...DOSSIER_CONTENT,
    linkDetails: [
        {
            kind: "investment",
            historicalId: "1",
            labelSnapshot: "Example Corp",
            liveId: 1,
            status: "live",
        },
    ],
    createdAt: TS,
    updatedAt: TS,
};

const DOSSIER_VERSION = {
    version: 1,
    snapshot: DOSSIER_CONTENT,
    createdAt: TS,
};

const EXPOSURE_DIMENSION = {
    rows: [
        {
            id: "issuer-1",
            label: "Example Corp",
            amount: 100,
            weightPercent: 100,
            contributions: [
                {
                    sourceType: "direct",
                    investmentId: 1,
                    investmentName: "Example Corp",
                    sourceFundName: null,
                    amount: 100,
                    sourceAsOfDate: null,
                    stale: false,
                },
            ],
        },
    ],
    classifiedValue: 100,
    classifiedWeightPercent: 100,
    unclassifiedValue: 0,
    unclassifiedWeightPercent: 0,
};

const FORECAST_BAND = { p10: 90, p25: 95, p50: 100, p75: 105, p90: 110 };

const PERFORMANCE_SNAPSHOT = {
    date: "2025-01-01",
    invested: 100,
    value: 110,
    stocks_etfs_value: 110,
    crypto_value: 0,
    metals_value: 0,
    stocks_etfs_invested: 100,
    crypto_invested: 0,
    metals_invested: 0,
    inflation_adjusted_value: 108,
    gain_loss: 10,
    return_pct: 10,
    is_provisional: false,
};

const FORECAST_PAYLOAD = {
    currency: "EUR",
    actual: [{ date: "2025-01-01", net: -10, cumulative: -10 }],
    scheduled_actual: [{ date: "2025-01-01", net: 0 }],
    methods: [
        {
            id: "seasonal",
            label: "Seasonal",
            daily: [{ date: "2025-01-02", value: -5 }],
            cumulative: [{ date: "2025-01-02", value: -15 }],
            bands: null,
            error: null,
        },
    ],
    planned: [],
    diagnostics: null,
    history_months: 6,
    include_planned: false,
};

const file = () => new File(["a,b\n"], "upload.csv", { type: "text/csv" });

const ROWS: Row[] = [
    // ── Portfolio ───────────────────────────────────────────────────────────
    {
        route: "GET /api/investments",
        method: "get",
        path: "/api/investments",
        body: {
            items: [INVESTMENT_STUB],
            total: 1,
            limit: 100,
            offset: 0,
            links: [],
        },
        call: () => getInvestments(),
    },
    {
        route: "POST /api/investments",
        method: "post",
        path: "/api/investments",
        status: 201,
        body: INVESTMENT_STUB,
        call: () => createInvestment({ name: "x" } as never),
    },
    {
        route: "PATCH /api/investments/:id",
        method: "patch",
        path: "/api/investments/1",
        body: { ...INVESTMENT_STUB, show_in_ticker: true },
        call: () => updateInvestment(1, {}),
    },
    {
        route: "GET /api/investments/providers",
        method: "get",
        path: "/api/investments/providers",
        body: {
            providers: [{ key: "yahoo", name: "Yahoo", description: "Quotes" }],
        },
        call: () => getSupportedPriceProviders(),
    },
    {
        route: "POST /api/investments/refresh-prices",
        method: "post",
        path: "/api/investments/refresh-prices",
        body: {
            updated: 1,
            total: 1,
            prices: { "1": 95.5 },
            priceSources: { "1": "live" },
        },
        call: () => refreshInvestmentPrices(),
    },
    {
        route: "GET /api/investments/:id/price-history",
        method: "get",
        path: "/api/investments/1/price-history",
        body: {
            investment_id: 1,
            provider: "yahoo",
            points: [{ timestampMs: 1735689600000, price: 95.5 }],
        },
        call: () => getInvestmentPriceHistory(1),
    },
    {
        route: "GET /api/investments/:id/transactions",
        method: "get",
        path: "/api/investments/1/transactions",
        body: {
            items: [PORTFOLIO_TRANSACTION_STUB],
            total: 1,
            limit: 100,
            offset: 0,
            links: [],
        },
        call: () => getPortfolioTransactions(1),
    },
    {
        route: "GET /api/investments/transactions",
        method: "get",
        path: "/api/investments/transactions",
        body: {
            items: [{ ...PORTFOLIO_TRANSACTION_STUB, import_batch_id: "7" }],
            total: 1,
            limit: 1,
            offset: 0,
            links: [],
        },
        call: () => getPortfolioTransactionsBulk({ investment_ids: "1" }),
    },
    {
        route: "POST /api/investments/:id/transactions",
        method: "post",
        path: "/api/investments/1/transactions",
        status: 201,
        body: PORTFOLIO_TRANSACTION_STUB,
        call: () => createPortfolioTransaction(1, {} as never),
    },
    {
        route: "PATCH /api/investments/transactions/:id",
        method: "patch",
        path: "/api/investments/transactions/1",
        body: PORTFOLIO_TRANSACTION_STUB,
        call: () => updatePortfolioTransaction(1, {}),
    },
    {
        route: "PUT /api/investments/transactions/broker",
        method: "put",
        path: "/api/investments/transactions/broker",
        body: {
            receipt_id: 1,
            idempotency_key: "key-1",
            from_account_id: null,
            to_account_id: 2,
            transaction_ids: [1],
            previous_assignments: [{ transaction_id: 1, account_id: null }],
            selected_count: 1,
            changed_count: 1,
            created_at: TS,
            replayed: false,
        },
        call: () => bulkRetagPortfolioTransactions({} as never),
    },
    {
        route: "GET /api/investments/exposure",
        method: "get",
        path: "/api/investments/exposure",
        body: {
            currency: "EUR",
            computedAt: TS,
            totalValue: 100,
            uncoveredValue: 0,
            uncoveredWeightPercent: 0,
            coveredCashValue: 0,
            coveredCashWeightPercent: 0,
            fundSources: [],
            issuer: EXPOSURE_DIMENSION,
            sector: EXPOSURE_DIMENSION,
            issuerCountry: EXPOSURE_DIMENSION,
            warnings: [
                { code: "AMBIGUOUS_CONSTITUENT_MAPPING", investmentId: 1 },
            ],
            scopeNotes: [],
        },
        call: () => getPortfolioExposure("EUR"),
    },
    // ── Portfolio imports ───────────────────────────────────────────────────
    {
        route: "GET /api/portfolio/import/parsers",
        method: "get",
        path: "/api/portfolio/import/parsers",
        body: { items: [PARSER_CONFIG], total: 1 },
        call: () => listPortfolioParserConfigs(),
    },
    {
        route: "POST /api/portfolio/import/parsers",
        method: "post",
        path: "/api/portfolio/import/parsers",
        status: 201,
        body: PARSER_CONFIG,
        call: () => createPortfolioParserConfig("Broker export", {} as never),
    },
    {
        route: "PATCH /api/portfolio/import/parsers/:id",
        method: "patch",
        path: "/api/portfolio/import/parsers/1",
        body: PARSER_CONFIG,
        call: () => updatePortfolioParserConfig(1, { name: "Broker export" }),
    },
    {
        route: "GET /api/portfolio/import/batches/:id/preview",
        method: "get",
        path: "/api/portfolio/import/batches/1/preview",
        body: {
            batch_id: 1,
            account_id: null,
            account_name: null,
            account_valid: true,
            groups: [
                {
                    is_cash: false,
                    investment_id: 1,
                    investment_name: "Example Corp",
                    investment_symbol: "EXMP",
                    investment_asset_class: "stock",
                    raw_symbol: "EXMP",
                    raw_name: "Example Corp",
                    row_count: 1,
                    rows: [
                        {
                            id: "12",
                            row_index: 0,
                            status: "matched",
                            route: null,
                            tx_date: "2025-01-01",
                            type: "buy",
                            type_raw: "BUY",
                            symbol_raw: "EXMP",
                            name_raw: "Example Corp",
                            units: "1.5000",
                            price_per_unit: "10.00",
                            amount: "15.00",
                            fees: null,
                            taxes: null,
                            currency: "USD",
                            fx_rate_to_eur: null,
                            note: null,
                            match_source: "symbol",
                            error_message: null,
                            user_override_investment_id: null,
                        },
                    ],
                },
            ],
            totals: { symbol: 1, name_exact: 0, unresolved: 0, error: 0 },
        },
        call: () => getPortfolioImportPreview(1),
    },
    {
        route: "POST /api/portfolio/import/batches/:id/rows/:rowId/investment-override",
        method: "post",
        path: "/api/portfolio/import/batches/1/rows/2/investment-override",
        body: { row_id: 2, user_override_investment_id: 1 },
        call: () => overridePortfolioImportRow(1, 2, { investmentId: 1 }),
    },
    {
        route: "POST /api/portfolio/import/batches/:id/rows/investment-override",
        method: "post",
        path: "/api/portfolio/import/batches/1/rows/investment-override",
        body: { investment_id: 1, created: false, resolved: 2 },
        call: () => overridePortfolioImportRows(1, [2, 3], { investmentId: 1 }),
    },
    {
        route: "POST /api/portfolio/import/batches/:id/commit",
        method: "post",
        path: "/api/portfolio/import/batches/1/commit",
        body: { batch_id: 1, total: 2, imported: 2, duplicates: 0, errors: 0 },
        call: () => commitPortfolioImportBatch(1),
    },
    {
        route: "DELETE /api/portfolio/import/batches/:id",
        method: "delete",
        path: "/api/portfolio/import/batches/1",
        body: { deleted: 2 },
        call: () => rollbackPortfolioImportBatch(1),
    },
    {
        route: "POST /api/portfolio/import/csv/custom",
        method: "post",
        path: "/api/portfolio/import/csv/custom",
        status: 201,
        body: {
            batch_id: 1,
            total: 2,
            skipped: 0,
            imported: 2,
            duplicates: 0,
            errors: 0,
        },
        call: () => importPortfolioCSVCustom(file(), {} as never, "custom"),
    },
    // ── Market ──────────────────────────────────────────────────────────────
    {
        route: "GET /api/market/news",
        method: "get",
        path: "/api/market/news",
        body: {
            items: [
                {
                    title: "Headline",
                    link: "https://example.invalid/a",
                    publisher: "Wire",
                    publishedAt: 1735689600000,
                    thumbnail: null,
                    relatedSymbols: ["EXMP"],
                },
            ],
            total: 1,
        },
        call: () => getMarketNews(["EXMP"]),
    },
    {
        route: "GET /api/market/quote",
        method: "get",
        path: "/api/market/quote",
        body: {
            items: [
                {
                    symbol: "EXMP",
                    name: "Example Corp",
                    price: 101,
                    change: 1,
                    changePercent: 1,
                    currency: "USD",
                    exchange: "NMS",
                    type: "EQUITY",
                    volume: undefined,
                },
            ],
            total: 1,
        },
        call: () => getMarketQuotes("EXMP"),
    },
    {
        route: "GET /api/market/chart",
        method: "get",
        path: "/api/market/chart",
        body: {
            symbol: "EXMP",
            currency: "USD",
            items: [
                {
                    time: 1735689600000,
                    close: 101,
                    high: 102,
                    low: 99,
                    volume: 1000,
                },
            ],
            total: 1,
        },
        call: () => getMarketChart("EXMP", "1mo", "1d"),
    },
    {
        route: "GET /api/market/search",
        method: "get",
        path: "/api/market/search",
        body: {
            items: [
                {
                    symbol: "EXMP",
                    name: "Example Corp",
                    type: "EQUITY",
                    exchange: "NMS",
                },
            ],
        },
        call: () => searchMarket("exmp"),
    },
    {
        route: "GET /api/watchlist",
        method: "get",
        path: "/api/watchlist",
        body: { items: [WATCHLIST_ITEM], total: 1, limit: 50, offset: 0 },
        call: () => getWatchlist(),
    },
    {
        route: "POST /api/watchlist",
        method: "post",
        path: "/api/watchlist",
        status: 201,
        body: WATCHLIST_ITEM,
        call: () => createWatchlistItem({} as never),
    },
    {
        route: "PATCH /api/watchlist/:id",
        method: "patch",
        path: "/api/watchlist/1",
        body: WATCHLIST_ITEM,
        call: () => updateWatchlistItem(1, {}),
    },
    // ── Research data ───────────────────────────────────────────────────────
    {
        route: "GET /api/research/search",
        method: "get",
        path: "/api/research/search",
        meta: RESEARCH_META,
        body: {
            items: [
                {
                    symbol: "EXMP",
                    name: "Example Corp",
                    type: "EQUITY",
                    exchange: "",
                },
            ],
        },
        call: () => searchResearch("exmp"),
    },
    {
        route: "GET /api/research/chart",
        method: "get",
        path: "/api/research/chart",
        meta: RESEARCH_META,
        body: {
            symbol: "EXMP",
            currency: "USD",
            points: [
                {
                    time: 1735689600000,
                    close: 101,
                    high: 102,
                    low: 99,
                    volume: 1000,
                },
            ],
        },
        call: () => getResearchChart("EXMP", "1mo"),
    },
    {
        route: "GET /api/research/analyst",
        method: "get",
        path: "/api/research/analyst",
        meta: RESEARCH_META,
        body: {
            symbol: "EXMP",
            consensus: {
                strongBuy: 1,
                buy: 2,
                hold: 3,
                sell: 0,
                strongSell: 0,
            },
            targetMean: 120,
            targetHigh: 130,
            targetLow: 100,
            numberOfAnalysts: 6,
            recentActions: [
                {
                    date: 1735689600,
                    firm: "Desk",
                    toGrade: "Buy",
                    action: "up",
                },
            ],
        },
        call: () => getResearchAnalyst("EXMP"),
    },
    {
        route: "GET /api/research/news",
        method: "get",
        path: "/api/research/news",
        meta: RESEARCH_META,
        body: {
            articles: [
                {
                    title: "Headline",
                    link: "https://example.invalid/a",
                    publisher: "Wire",
                    publishedAt: 1735689600000,
                    thumbnail: "https://example.invalid/t.png",
                    relatedSymbols: ["EXMP"],
                },
            ],
        },
        call: () => getResearchNews("EXMP"),
    },
    {
        route: "GET /api/research/macro/search",
        method: "get",
        path: "/api/research/macro/search",
        meta: { provider: null, source: "live" },
        body: {
            items: [
                {
                    provider: "fred",
                    seriesId: "CPIAUCSL",
                    title: "Consumer prices",
                    units: "Index",
                    frequency: "Monthly",
                    source: "FRED",
                },
            ],
        },
        call: () => searchMacro("cpi"),
    },
    {
        route: "GET /api/research/macro/series",
        method: "get",
        path: "/api/research/macro/series",
        meta: { provider: "fred", source: "live" },
        body: {
            provider: "fred",
            seriesId: "CPIAUCSL",
            title: "Consumer prices",
            points: [{ time: 1735689600000, close: 310.2 }],
        },
        call: () => getMacroSeries("fred", "CPIAUCSL", "5y"),
    },
    {
        route: "GET /api/research/scorecard",
        method: "get",
        path: "/api/research/scorecard",
        meta: RESEARCH_META,
        body: {
            symbol: "EXMP",
            fundamentals: { symbol: "EXMP", pe: 20 },
            scorecard: {
                score: 85,
                grade: "strong",
                evaluated: 1,
                counts: { ok: 1, caution: 0, warn: 0, risk: 0 },
                flags: [
                    {
                        metric: "pe",
                        category: "valuation",
                        better: "lower",
                        value: 20,
                        severity: "ok",
                        code: "pe.ok",
                        reasonKey: "pe.fair",
                        reason: "Fair valuation",
                        benchmark: "< 25",
                    },
                ],
            },
        },
        call: () => getResearchScorecard("EXMP"),
    },
    {
        route: "POST /api/research/portfolio-forecast",
        method: "post",
        path: "/api/research/portfolio-forecast",
        body: {
            available: true,
            currency: "EUR",
            method: "parametric",
            horizonMonths: 1,
            paths: 100,
            seed: "pf:EUR:1",
            historyDays: 90,
            flowArtifactDays: 0,
            lowConfidence: false,
            startValue: 100,
            startInvested: 90,
            monthlyContribution: 0,
            totalContributions: 0,
            netInvested: 90,
            expectedAnnualReturn: 0.05,
            historicalAnnualReturn: 0.05,
            annualVolatility: 0.1,
            forwardBlend: 0,
            usedForward: false,
            forwardHoldings: [],
            projected: { mean: 100, ...FORECAST_BAND },
            probBelowInvested: 0.1,
            points: [
                {
                    monthIndex: 1,
                    date: "2025-02-01",
                    netInvested: 90,
                    ...FORECAST_BAND,
                },
            ],
        },
        call: () => getPortfolioForecast({ horizonMonths: 1 }),
    },
    {
        route: "GET /api/research/mappings",
        method: "get",
        path: "/api/research/mappings",
        body: { items: [MAPPING], total: 1 },
        call: () => getResearchMappings("XX0000000001"),
    },
    {
        route: "POST /api/research/mappings/resolve",
        method: "post",
        path: "/api/research/mappings/resolve",
        body: {
            instrument_key: "XX0000000001",
            key_type: "isin",
            proposals: [
                {
                    provider: "yahoo",
                    status: "auto",
                    providerSymbol: "EXMP",
                    resolvedName: "Example Corp",
                    exchange: "NMS",
                    candidates: [
                        {
                            symbol: "EXMP",
                            name: "Example Corp",
                            type: "EQUITY",
                            exchange: "NMS",
                        },
                    ],
                },
                { provider: "fmp", status: "unavailable" },
            ],
            existing: [MAPPING],
        },
        call: () =>
            resolveResearchMappings({
                instrument_key: "XX0000000001",
                query: "exmp",
            }),
    },
    {
        route: "POST /api/research/mappings",
        method: "post",
        path: "/api/research/mappings",
        body: { items: [MAPPING], total: 1 },
        call: () =>
            saveResearchMappings({
                instrument_key: "XX0000000001",
                mappings: [{ provider: "yahoo", providerSymbol: "EXMP" }],
            }),
    },
    {
        route: "POST /api/research/mappings/audit",
        method: "post",
        path: "/api/research/mappings/audit",
        body: {
            ok: true,
            quotes: [
                { provider: "yahoo", currency: "USD", price: 101 },
                { provider: "fmp", skipped: "quota" },
            ],
            discrepancies: [],
        },
        call: () => auditResearchMappings({ instrument_key: "XX0000000001" }),
    },
    {
        route: "GET /api/research/provider-keys",
        method: "get",
        path: "/api/research/provider-keys",
        body: {
            items: [
                {
                    provider: "fmp",
                    label: "FMP",
                    envVar: "FMP_API_KEY",
                    configured: true,
                    source: "settings",
                    masked: "••••abcd",
                },
                {
                    provider: "fred",
                    label: "FRED",
                    envVar: "FRED_API_KEY",
                    configured: false,
                    source: "none",
                },
            ],
            total: 2,
        },
        call: () => getResearchProviderKeys(),
    },
    {
        route: "PUT /api/research/provider-keys/:provider",
        method: "put",
        path: "/api/research/provider-keys/fmp",
        body: { items: [], total: 0 },
        call: () => setResearchProviderKey("fmp", "synthetic-key"),
    },
    // ── AI research ─────────────────────────────────────────────────────────
    {
        route: "GET /api/ai-research/status",
        method: "get",
        path: "/api/ai-research/status",
        body: {
            defaultRoute: "local",
            providers: [
                {
                    id: "ollama",
                    route: "local",
                    status: "available",
                    models: [],
                },
            ],
            openai: {
                enabled: true,
                model: "model-a",
                models: [
                    {
                        id: "model-a",
                        label: "Model A",
                        inputMicrosPerMillion: 1,
                        outputMicrosPerMillion: 2,
                        isDefault: true,
                    },
                ],
                storageRequested: false,
                hostedToolsEnabled: false,
                disclosureModes: [
                    {
                        id: "selected-summary",
                        capability: "cloud-planning-local-synthesis",
                        disclosedField: "selectedSummary",
                    },
                ],
                monthlyBudgetMicros: 1000,
                reversibleReferences: {
                    configured: true,
                    markerSyntax: "[[vision-ref:type|value]]",
                    classification: "pseudonymized-not-anonymous",
                },
                agentCloakPreflight: {
                    enabled: true,
                    mode: "protect-and-block",
                    location: "desktop-loopback",
                },
            },
            web: { enabled: false },
            localDocuments: {
                supportedMediaTypes: ["text/plain"],
                pdfSupported: false,
            },
            orchestration: { maxConcurrentJobs: 1 },
        },
        call: () => getAiResearchStatus(),
    },
    {
        route: "GET /api/ai-research/agentcloak-desktop",
        method: "get",
        path: "/api/ai-research/agentcloak-desktop",
        body: {
            enabled: false,
            available: false,
            mappingKeyConfigured: false,
            openAiEnabled: false,
        },
        call: () => getAgentCloakDesktopStatus(),
    },
    {
        route: "PUT /api/ai-research/agentcloak-desktop",
        method: "put",
        path: "/api/ai-research/agentcloak-desktop",
        body: {
            enabled: true,
            available: true,
            mappingKeyConfigured: true,
            openAiEnabled: true,
        },
        call: () => setAgentCloakDesktopEnabled(true),
    },
    {
        route: "POST /api/ai-research/investigations",
        method: "post",
        path: "/api/ai-research/investigations",
        status: 202,
        body: INVESTIGATION,
        call: () => createInvestigation({} as never),
    },
    {
        route: "GET /api/ai-research/investigations/:id",
        method: "get",
        path: `/api/ai-research/investigations/${UUID}`,
        body: {
            ...INVESTIGATION,
            state: "running",
            steps: [
                {
                    stepId: "balances",
                    state: "completed",
                    attempt: 1,
                    result: { ok: true },
                    error: null,
                    startedAt: TS,
                    completedAt: TS,
                },
            ],
        },
        call: () => getInvestigation(UUID),
    },
    {
        route: "POST /api/ai-research/investigations/:id/cancel",
        method: "post",
        path: `/api/ai-research/investigations/${UUID}/cancel`,
        body: { ...INVESTIGATION, cancelRequestedAt: TS },
        call: () => cancelInvestigation(UUID),
    },
    {
        route: "POST /api/ai-research/investigations/:id/resume",
        method: "post",
        path: `/api/ai-research/investigations/${UUID}/resume`,
        status: 202,
        body: INVESTIGATION,
        call: () => resumeInvestigation(UUID, "Q1 2025", {} as never),
    },
    {
        route: "POST /api/ai-research/disclosures/preview",
        method: "post",
        path: "/api/ai-research/disclosures/preview",
        body: {
            payload: { model: "model-a" },
            payloadSha256: SHA,
            payloadBytes: 10,
            inputCharacters: 10,
            fieldManifest: ["question"],
            disclosureUnits: [`question:${SHA}`],
            referenceScope: null,
            outboundRequest: { route: "openai-api" },
            agentCloakPreflight: { enabled: false },
        },
        call: () => previewDisclosure({} as never),
    },
    {
        route: "POST /api/ai-research/disclosures/grants",
        method: "post",
        path: "/api/ai-research/disclosures/grants",
        status: 201,
        body: GRANT,
        call: () => createDisclosureGrant({}),
    },
    {
        route: "GET /api/ai-research/disclosures/grants",
        method: "get",
        path: "/api/ai-research/disclosures/grants",
        body: { items: [GRANT], total: 1 },
        call: () => listDisclosureGrants(),
    },
    {
        route: "POST /api/ai-research/disclosures/grants/:id/revoke",
        method: "post",
        path: `/api/ai-research/disclosures/grants/${UUID}/revoke`,
        body: { revoked: true },
        call: () => revokeDisclosureGrant(UUID),
    },
    {
        route: "GET /api/ai-research/disclosures/records",
        method: "get",
        path: "/api/ai-research/disclosures/records",
        body: {
            items: [
                {
                    id: UUID,
                    grant_id: UUID,
                    job_id: null,
                    route: "openai-api",
                    mode: "cloud-plan-public",
                    purpose: "Plan a public question",
                    field_manifest_json: ["question"],
                    disclosure_units_json: [],
                    payload_sha256: SHA,
                    payload_bytes: 10,
                    reserved_output_tokens: 900,
                    reserved_cost_micros: "10",
                    actual_input_tokens: null,
                    actual_output_tokens: null,
                    actual_cost_micros: null,
                    status: "reserved",
                    provider_request_id: null,
                    policy_snapshot_json: {},
                    error_code: null,
                    created_at: TS,
                    completed_at: null,
                },
            ],
            total: 1,
        },
        call: () => listDisclosureRecords(),
    },
    {
        route: "DELETE /api/ai-research/disclosures/records",
        method: "delete",
        path: "/api/ai-research/disclosures/records",
        body: { deleted: { records: 1, grants: 1 } },
        call: () => deleteDisclosureRecords(),
    },
    {
        route: "GET /api/ai-research/documents",
        method: "get",
        path: "/api/ai-research/documents",
        body: { items: [RESEARCH_DOCUMENT], total: 1 },
        call: () => listResearchDocuments(),
    },
    {
        route: "POST /api/ai-research/documents",
        method: "post",
        path: "/api/ai-research/documents",
        status: 201,
        body: RESEARCH_DOCUMENT,
        call: () => uploadResearchDocument(file()),
    },
    // ── Research dossiers ───────────────────────────────────────────────────
    {
        route: "GET /api/research-dossiers",
        method: "get",
        path: "/api/research-dossiers",
        body: {
            items: [
                {
                    id: UUID,
                    version: 1,
                    workspace: "portfolio",
                    title: "Rebalance review",
                    question: null,
                    reviewDate: null,
                    createdAt: TS,
                    updatedAt: TS,
                },
            ],
            total: 1,
            limit: 500,
            offset: 0,
        },
        call: () => listDossiers(),
    },
    {
        route: "GET /api/research-dossiers/:id",
        method: "get",
        path: `/api/research-dossiers/${UUID}`,
        body: DOSSIER,
        call: () => getDossier(UUID),
    },
    {
        route: "POST /api/research-dossiers",
        method: "post",
        path: "/api/research-dossiers",
        status: 201,
        body: DOSSIER,
        call: () => createDossier(DOSSIER_CONTENT as never),
    },
    {
        route: "PUT /api/research-dossiers/:id",
        method: "put",
        path: `/api/research-dossiers/${UUID}`,
        body: { ...DOSSIER, version: 2 },
        call: () => updateDossier(UUID, DOSSIER_CONTENT as never, 1),
    },
    {
        route: "GET /api/research-dossiers/:id/versions",
        method: "get",
        path: `/api/research-dossiers/${UUID}/versions`,
        body: { items: [DOSSIER_VERSION] },
        call: () => listDossierVersions(UUID),
    },
    {
        route: "POST /api/research-dossiers/:id/restore",
        method: "post",
        path: `/api/research-dossiers/${UUID}/restore`,
        body: { ...DOSSIER, version: 3 },
        call: () => restoreDossierVersion(UUID, 1, 2),
    },
    {
        route: "GET /api/research-dossiers/export",
        method: "get",
        path: "/api/research-dossiers/export",
        body: {
            schemaVersion: 1,
            exportedAt: TS,
            dossiers: [{ ...DOSSIER, versions: [DOSSIER_VERSION] }],
        },
        call: () => exportDossiers(),
    },
    {
        route: "GET /api/research-dossiers/:id/export",
        method: "get",
        path: `/api/research-dossiers/${UUID}/export`,
        body: {
            schemaVersion: 1,
            exportedAt: TS,
            dossiers: [{ ...DOSSIER, versions: [DOSSIER_VERSION] }],
        },
        call: () => exportDossier(UUID),
    },
    // ── Saved charts ────────────────────────────────────────────────────────
    {
        route: "GET /api/saved-charts",
        method: "get",
        path: "/api/saved-charts",
        body: { items: [SAVED_CHART_STUB], total: 1 },
        call: () => getSavedCharts(),
    },
    {
        route: "POST /api/saved-charts",
        method: "post",
        path: "/api/saved-charts",
        status: 201,
        body: SAVED_CHART_STUB,
        call: () => createSavedChart({} as never),
    },
    {
        route: "PATCH /api/saved-charts/:id",
        method: "patch",
        path: "/api/saved-charts/1",
        body: { ...SAVED_CHART_STUB, date_range_start: "2025-01-01" },
        call: () => updateSavedChart(1, {}),
    },
    // ── Info ────────────────────────────────────────────────────────────────
    {
        route: "GET /api/info/supported-adapters",
        method: "get",
        path: "/api/info/supported-adapters",
        body: { items: [{ key: "generic", name: "Generic CSV" }], total: 1 },
        call: () => getSupportedParsers(),
    },
    {
        route: "GET /api/info/banks",
        method: "get",
        path: "/api/info/banks",
        body: { items: ["Checking"], total: 1 },
        call: () => getDistinctBankAccounts(),
    },
    {
        route: "GET /api/info/transaction-count",
        method: "get",
        path: "/api/info/transaction-count",
        body: { total_transactions: 3 },
        call: () => getTransactionCount(),
    },
    {
        route: "GET /api/info/insights-count",
        method: "get",
        path: "/api/info/insights-count",
        body: { count: null, status: "pending", computed_at: null },
        call: () => getInsightsCount(),
    },
    {
        route: "GET /api/info/deduction-candidates",
        method: "get",
        path: "/api/info/deduction-candidates",
        body: {
            year: 2025,
            from: "2025-01-01",
            to: "2025-12-31",
            currency: "EUR",
            byDeductionType: [
                {
                    deductionType: "childcare",
                    total: 50,
                    categoryCount: 1,
                    categories: [{ category: "Daycare", total: 50, count: 2 }],
                },
            ],
        },
        call: () => getDeductionCandidates(2025),
    },
    {
        route: "GET /api/info/portfolio-performance",
        method: "get",
        path: "/api/info/portfolio-performance",
        body: {
            currency: "EUR",
            start_date: "2025-01-01",
            end_date: "2025-01-31",
            snapshots: [PERFORMANCE_SNAPSHOT],
            metrics: {
                currentValue: 110,
                totalInvested: 100,
                totalGainLoss: 10,
                totalReturnPct: 10,
                annualizedReturn: 10,
                realReturnPct: 8,
                cumulativeInflation: 2,
            },
            heatmap: {
                years: [2025],
                data: { "2025": [10, null] },
                maxAbsPct: 10,
            },
            breakdownSummary: [],
            totals: PORTFOLIO_SUMMARY_STUB.totals,
        },
        call: () => getPortfolioPerformance(),
    },
    {
        route: "GET /api/info/portfolio-performance/by-broker",
        method: "get",
        path: "/api/info/portfolio-performance/by-broker",
        body: {
            currency: "EUR",
            startDate: "2025-01-01",
            endDate: "2025-01-31",
            dates: ["2025-01-01"],
            series: [
                {
                    accountKey: "a1",
                    accountId: 1,
                    accountName: "Broker",
                    assignment: "account",
                },
            ],
            rows: [
                {
                    accountKey: "a1",
                    accountId: 1,
                    accountName: "Broker",
                    assignment: "account",
                    date: "2025-01-01",
                    currency: "EUR",
                    value: 110,
                    invested: 100,
                    gainLoss: 10,
                    computedAt: TS,
                },
            ],
        },
        call: () => getBrokerPortfolioPerformance(),
    },
    {
        route: "GET /api/info/portfolio-summary",
        method: "get",
        path: "/api/info/portfolio-summary",
        body: PORTFOLIO_SUMMARY_STUB,
        call: () => getPortfolioSummary(),
    },
    {
        route: "GET /api/info/net-worth",
        method: "get",
        path: "/api/info/net-worth",
        body: {
            current: {
                liquid: 10,
                liabilities: 0,
                investments: 5,
                netWorth: 15,
            },
            monthlyChange: 1,
            monthlyChangePercent: 7.1,
            snapshots: [
                {
                    date: "2025-01-01",
                    liquid: 9,
                    liabilities: 0,
                    investments: 5,
                    netWorth: 14,
                },
            ],
            snapshotsTotal: 1,
            snapshotsLimit: 10,
            snapshotsOffset: 0,
        },
        call: () => getNetWorth({ limit: 10, offset: 0 }),
    },
    {
        route: "GET /api/info/exchange-rates",
        method: "get",
        path: "/api/info/exchange-rates",
        body: {
            total_rates: 1,
            rates: [
                {
                    currency: "USD",
                    rate_to_eur: 0.9,
                    rate_date: "2025-01-01",
                    fetched_at: TS,
                },
            ],
            fallback_rates: { USD: 0.9 },
            source: "database",
            is_stale: false,
            last_fetched_at: TS,
        },
        call: () => getExchangeRates(),
    },
    {
        route: "POST /api/info/exchange-rates/refresh",
        method: "post",
        path: "/api/info/exchange-rates/refresh",
        body: { message: "Exchange rates refreshed from ECB" },
        call: () => refreshExchangeRates(),
    },
    // ── Aggregations ────────────────────────────────────────────────────────
    {
        route: "GET /api/aggregations/monthly-summary",
        method: "get",
        path: "/api/aggregations/monthly-summary",
        body: aggregation({
            months: [
                {
                    month: 1,
                    year: 2025,
                    period_start: "2025-01-01",
                    period_end: "2025-01-31",
                    total_spending: 10,
                    total_income: 20,
                    net_amount: 10,
                    transaction_count: 2,
                },
            ],
            summary: {
                total_spending: 10,
                total_income: 20,
                net_amount: 10,
                transaction_count: 2,
            },
        }),
        call: () => getAggregationMonthlySummary(),
    },
    {
        route: "GET /api/aggregations/recipient-insights",
        method: "get",
        path: "/api/aggregations/recipient-insights",
        body: aggregation({
            topMerchants: [
                {
                    recipientId: 1,
                    name: "Grocer",
                    totalSpend: 10,
                    transactionCount: 1,
                    avgAmount: 10,
                    firstSeen: "2025-01-01",
                    lastSeen: "2025-01-01",
                },
            ],
            monthOverMonth: [],
        }),
        call: () => getAggregationRecipientInsights(),
    },
    {
        route: "GET /api/aggregations/average-vs-current",
        method: "get",
        path: "/api/aggregations/average-vs-current",
        body: aggregation({
            past_6_months: {
                avg_daily_spending: 1,
                avg_monthly_spending: 30,
                months_counted: 6,
            },
            current_month: {
                daily_data: [{ date: "2025-01-01", spending: 1, income: 0 }],
                total_spending: 1,
                days_elapsed: 1,
                days_in_month: 31,
            },
            comparison: {
                projected_monthly_total: 31,
                avg_monthly_spending: 30,
                variance: 1,
                pace: null,
            },
        }),
        call: () => getAggregationAverageVsCurrent(),
    },
    {
        route: "GET /api/aggregations/bank-balances",
        method: "get",
        path: "/api/aggregations/bank-balances",
        body: aggregation({
            accounts: [
                {
                    account_id: 1,
                    bank_account: "Checking",
                    display_name: "Checking",
                    balance: 10,
                    transaction_count: 1,
                    first_transaction: "2025-01-01",
                    last_transaction: "2025-01-01",
                },
            ],
            total_net_position: 10,
            history: { Checking: [{ date: "2025-01-01", balance: 10 }] },
            total_history: [{ date: "2025-01-01", balance: 10 }],
        }),
        call: () => getAggregationBankBalances(),
    },
    {
        route: "GET /api/aggregations/category-pivot",
        method: "get",
        path: "/api/aggregations/category-pivot",
        body: aggregation({
            categoryPivot: {
                "2025": [
                    {
                        categoryId: null,
                        categoryName: "Uncategorized",
                        categoryPathIds: [],
                        categoryPathSegments: [],
                        total: -10,
                        income: 0,
                        expense: 10,
                        transactionCount: 1,
                    },
                ],
            },
        }),
        call: () => getAggregationCategoryPivot(),
    },
    {
        route: "GET /api/aggregations/recipient-by-year",
        method: "get",
        path: "/api/aggregations/recipient-by-year",
        body: aggregation({
            recipientsByYear: {
                "2025": [
                    {
                        recipientId: 1,
                        name: "Grocer",
                        totalSpend: 10,
                        transactionCount: 1,
                    },
                ],
            },
        }),
        call: () => getAggregationRecipientByYear(),
    },
    {
        route: "GET /api/aggregations/recipient-pivot",
        method: "get",
        path: "/api/aggregations/recipient-pivot",
        body: aggregation({
            recipientPivot: {
                "2025": [
                    {
                        recipientId: 1,
                        name: "Grocer",
                        total: -10,
                        transactionCount: 1,
                    },
                ],
            },
            conversion: {
                usedHistoricalFallback: false,
                affectedCurrencies: [],
            },
        }),
        call: () => getAggregationRecipientPivot(),
    },
    {
        route: "GET /api/aggregations/tag-pivot",
        method: "get",
        path: "/api/aggregations/tag-pivot",
        body: aggregation({
            tagPivot: {
                "2025": [
                    { tagId: 1, slug: "trip", total: -10, transactionCount: 1 },
                ],
            },
        }),
        call: () => getAggregationTagPivot(),
    },
    {
        route: "GET /api/aggregations/cashflow-forecast-methods",
        method: "get",
        path: "/api/aggregations/cashflow-forecast-methods",
        body: aggregation({
            ...FORECAST_PAYLOAD,
            month: "2025-01",
            days_in_month: 31,
            current_day: 1,
        }),
        call: () => getCashflowForecastMethods(),
    },
    {
        route: "GET /api/aggregations/cashflow-forecast-rolling",
        method: "get",
        path: "/api/aggregations/cashflow-forecast-rolling",
        body: aggregation({
            ...FORECAST_PAYLOAD,
            window_start: "2024-12-18",
            window_end: "2025-01-15",
            today: "2025-01-01",
            days_back: 14,
            days_forward: 14,
        }),
        call: () => getCashflowForecastRolling(),
    },
    {
        route: "GET /api/aggregations/cashflow-forecast-accuracy",
        method: "get",
        path: "/api/aggregations/cashflow-forecast-accuracy",
        body: {
            data: {
                methods: [
                    {
                        method_id: "seasonal",
                        as_of_month: "2025-01",
                        mae: 1,
                        rmse: 1,
                        mape: null,
                        sample_days: 31,
                        history: [],
                    },
                ],
                limit_months: 12,
            },
            meta: { source: "db", userId: 1 },
        },
        call: () => getCashflowForecastAccuracy(),
    },
    {
        route: "GET /api/aggregations/sankey",
        method: "get",
        path: "/api/aggregations/sankey",
        body: aggregation({
            nodes: [{ id: "income", label: "Income", value: 10 }],
            links: [{ source: "income", target: "expense", value: 10 }],
            year: 2025,
        }),
        call: () => getSankeyFlow(),
    },
];

function serve(row: Row, body: unknown) {
    server.use(
        http[row.method](`${API_BASE}${row.path}`, () =>
            HttpResponse.json(
                {
                    ok: true,
                    data: body,
                    ...(row.meta ? { meta: row.meta } : {}),
                },
                { status: row.status ?? 200 },
            ),
        ),
    );
}

describe("portfolio/market/research/info/aggregation response contracts", () => {
    it.each(ROWS.map((row) => [row.route, row] as const))(
        "%s accepts the wire body",
        async (_route, row) => {
            serve(row, row.body);
            await expect(row.call()).resolves.toBeDefined();
        },
    );

    it.each(ROWS.map((row) => [row.route, row] as const))(
        "%s rejects a drifted body with ApiContractError",
        async (_route, row) => {
            serve(row, { unexpected: true });
            await expect(row.call()).rejects.toMatchObject({
                name: "ApiContractError",
            });
        },
    );
});
