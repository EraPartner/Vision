import logger from "@/lib/logger";
import { ApiContractError, apiRequest } from "@/lib/api/client";
import { requestWithQuery } from "@/lib/api/helpers";
import type { NetWorthResponse } from "@/types/apiClient";
import type { components, operations } from "@/types/generated";
import {
    BankNameListSchema,
    BrokerPortfolioPerformanceSchema,
    DeductionCandidatesSchema,
    ExchangeRatesSchema,
    InfoMessageSchema,
    InfoTransactionCountSchema,
    InsightsCountSchema,
    InsightsDigestSchema,
    NetWorthByAccountSchema,
    NetWorthSchema,
    PortfolioPerformanceSchema,
    PortfolioSummarySchema,
    RecurringPatternListSchema,
    SupportedAdapterListSchema,
} from "@vision/types/contracts";
import type {
    AccountId,
    CategoryId,
    CurrencyCode,
    InvestmentId,
    RecipientId,
} from "@vision/types/brands";

type Schemas = components["schemas"];

// (Removed getStatistics — legacy GET /api/info was deleted in the Phase 9
// cutover; it had no callers. Use the aggregations endpoints instead.)

export interface SupportedAdapter {
    key: string;
    name: string;
    adapter_class?: string;
}

/** Canonical `{items, total}` collection body — callers only need the rows. */
export async function getSupportedParsers(): Promise<SupportedAdapter[]> {
    const { items } = await apiRequest<{
        items: SupportedAdapter[];
        total: number;
    }>("/api/info/supported-adapters", { schema: SupportedAdapterListSchema });
    return items;
}

/** Canonical `{items, total}` collection body — callers only need the rows. */
export async function getDistinctBankAccounts(): Promise<string[]> {
    const { items } = await apiRequest<{ items: string[]; total: number }>(
        "/api/info/banks",
        { schema: BankNameListSchema },
    );
    return items;
}

// (Removed getTransactionSummary — legacy GET /api/info/transaction-summary was
// deleted in the Phase 9 cutover; it had no callers.)

export function getTransactionCount(): Promise<{ total_transactions: number }> {
    return apiRequest("/api/info/transaction-count", {
        schema: InfoTransactionCountSchema,
    });
}

export async function getRecurringPatterns(): Promise<{
    patterns: Array<{
        recipientId: RecipientId;
        recipientName: string;
        /** Flow direction — a recipient can yield one pattern per direction. */
        direction: "income" | "expense";
        detectedPattern: string;
        intervalDays: number;
        consistency: number;
        occurrences: number;
        averageAmount: number;
        latestAmount: number;
        currency: CurrencyCode;
        categoryId: CategoryId | null;
        categoryName: string | null;
        bankAccount: string | null;
        accountId: AccountId | null;
        firstSeen: string;
        lastSeen: string;
        predictedNext: string;
        amountChanges: Array<{
            date: string;
            previousAmount: number;
            newAmount: number;
            percentChange: number;
            direction: string;
        }>;
        isAlreadyPlanned: boolean;
        confidence: number;
    }>;
    total: number;
}> {
    try {
        return await apiRequest<Awaited<ReturnType<typeof getRecurringPatterns>>>("/api/info/recurring-patterns", {
            schema: RecurringPatternListSchema,
        });
    } catch (err) {
        // A contract mismatch is a defect, not an outage: surface it.
        if (err instanceof ApiContractError) throw err;
        // Fail-soft: recurrence detection is optional UI enrichment.
        logger.warn("Recurring patterns unavailable; using empty result", err);
        return { patterns: [], total: 0 };
    }
}

/** New-subscription finding from the subscription-creep detector. */
export interface SubscriptionCreepNew {
    recipientId: RecipientId;
    recipientName: string;
    findingType: "new";
    latestAmount: number;
    currency: CurrencyCode;
    detectedPattern: string;
    intervalDays: number;
    predictedNext: string;
    confidence: number;
}

/** Price-change finding from the subscription-creep detector. */
export interface SubscriptionCreepPriceChange {
    recipientId: RecipientId;
    recipientName: string;
    findingType: "priceChange";
    previousAmount: number;
    newAmount: number;
    percentChange: number;
    direction: string;
    currency: CurrencyCode;
    confidence: number;
}

/** Current-month category overspend outlier vs the trailing baseline median. */
export interface CategoryOutlier {
    categoryId: CategoryId;
    categoryName: string;
    monthKey: string;
    comparisonEndDay: number;
    currentAmount: number;
    baselineMedian: number;
    deviation: number;
    direction: string;
}

export type CashForecastProminence = Schemas["CashForecastInsight"]["prominence"];

/** Zero-based month-end net-cashflow insight (not an account balance). */
export interface CashForecast {
    month: string;
    currency: CurrencyCode;
    monthEndNetCashflow: number;
    monthEndNetCashflowLow: number | null;
    monthEndNetCashflowHigh: number | null;
    movedSignificantly: boolean;
    prominence: CashForecastProminence;
    methodId: string;
}

export interface InsightsDigestResponse {
    subscriptionCreep: {
        new: SubscriptionCreepNew[];
        priceChanges: SubscriptionCreepPriceChange[];
    };
    categoryOutliers: CategoryOutlier[];
    cashForecast: CashForecast | null;
}

/** Pre-computed detection-layer findings for the Statistics insights panel (no LLM). */
export async function getInsightsDigest(): Promise<InsightsDigestResponse> {
    try {
        return await apiRequest<Awaited<ReturnType<typeof getInsightsDigest>>>("/api/info/insights-digest", {
            schema: InsightsDigestSchema,
        });
    } catch (err) {
        // A contract mismatch is a defect, not an outage: surface it.
        if (err instanceof ApiContractError) throw err;
        // Fail-soft: the insights digest is optional UI enrichment.
        logger.warn("Insights digest unavailable; using empty result", err);
        return {
            subscriptionCreep: { new: [], priceChanges: [] },
            categoryOutliers: [],
            cashForecast: null,
        };
    }
}

export type InsightsCountStatus = Schemas["InsightsCountData"]["status"];

export interface InsightsCountResponse {
    count: number | null;
    status: InsightsCountStatus;
    computed_at: string | null;
}

export function getInsightsCount(): Promise<InsightsCountResponse> {
    return apiRequest("/api/info/insights-count", {
        schema: InsightsCountSchema,
    });
}

export type InsightDismissalKind = Schemas["InsightDismissalRequest"]["kind"];

export type InsightDismissalRequest =
    | {
          kind: Exclude<InsightDismissalKind, "category_outlier">;
          recipient_id: RecipientId;
      }
    | { kind: Extract<InsightDismissalKind, "category_outlier">; category_id: CategoryId; month_key: string };

export function dismissInsight(
    request: InsightDismissalRequest,
): Promise<unknown> {
    return apiRequest("/api/info/insight-dismissals", {
        method: "PUT",
        body: JSON.stringify(request),
    });
}

/** One user category contributing to a deduction-type candidate group. */
export interface DeductionCandidateCategory {
    category: string;
    total: number;
    count: number;
}

/** One Belgian deduction type with its transaction-derived candidate total. */
export interface DeductionTypeGroup {
    deductionType: string;
    total: number;
    /**
     * The total split by account owner (ADR-201); the values add up to `total`. Optional so a
     * response from an older backend still parses: everything then counts as `me`.
     */
    byOwner?: { me: number; partner: number; joint: number };
    categoryCount: number;
    /** Contributing categories, sorted by total desc. */
    categories: DeductionCandidateCategory[];
}

export interface DeductionCandidatesResponse {
    year: number;
    from: string;
    to: string;
    currency: CurrencyCode;
    /** Sorted by total desc; empty when nothing classifies. */
    byDeductionType: DeductionTypeGroup[];
}

/** Transaction-derived Belgian deduction candidates for the tax review card. */
export function getDeductionCandidates(
    year: number,
): Promise<DeductionCandidatesResponse> {
    return apiRequest("/api/info/deduction-candidates?year=" + year, {
        schema: DeductionCandidatesSchema,
    });
}

export type PortfolioPerformancePeriod = NonNullable<
    operations["getPortfolioPerformance"]["parameters"]["query"]
>["period"];

export function getPortfolioPerformance(params?: {
    currency?: CurrencyCode | undefined;
    period?: PortfolioPerformancePeriod | undefined;
}): Promise<{
    currency: CurrencyCode;
    start_date: string;
    end_date: string;
    snapshots: Array<{
        date: string;
        invested: number;
        value: number;
        stocks_etfs_value: number;
        crypto_value: number;
        metals_value: number;
        stocks_etfs_invested: number;
        crypto_invested: number;
        metals_invested: number;
        inflation_adjusted_value: number;
        gain_loss: number;
        return_pct: number;
        /** True for the newest returned point, which is intentionally not spike-smoothed yet. */
        is_provisional: boolean;
        /** Value at cost-weighted purchase-date FX rates. Absent until migration 0039 + a snapshot recompute. */
        value_fx_neutral?: number;
    }>;
    metrics: {
        currentValue: number;
        totalInvested: number;
        totalGainLoss: number;
        totalReturnPct: number;
        annualizedReturn: number;
        realReturnPct: number;
        cumulativeInflation: number;
    } | null;
    heatmap: {
        years: number[];
        data: Record<number, (number | null)[]>;
        maxAbsPct: number;
    };
    breakdownSummary: Array<{
        id: InvestmentId;
        name: string;
        symbol: string;
        assetClass: string;
        currency: CurrencyCode;
        currentValue: number;
        totalInvested: number;
        gainLoss: number;
        gainLossPercent: number;
        assetGain?: number;
        fxGain?: number;
        nativeCurrentValue?: number;
        usedFallbackRate?: boolean;
    }>;
    totals?: PortfolioSummaryTotals;
}> {
    return requestWithQuery("/api/info/portfolio-performance", params, {
        schema: PortfolioPerformanceSchema,
    });
}

export interface BrokerPerformanceRow {
    date: string;
    currency: CurrencyCode;
    accountKey: string;
    accountId: AccountId | null;
    accountName: string;
    assignment: PortfolioAccountAssignment;
    value: number;
    invested: number;
    gainLoss: number;
    computedAt: string;
}

export function getBrokerPortfolioPerformance(params?: {
    currency?: CurrencyCode | undefined;
    from?: string | undefined;
    to?: string | undefined;
}): Promise<{
    currency: CurrencyCode;
    startDate: string;
    endDate: string;
    dates: string[];
    series: Array<
        Pick<
            BrokerPerformanceRow,
            "accountKey" | "accountId" | "accountName" | "assignment"
        >
    >;
    rows: BrokerPerformanceRow[];
}> {
    return requestWithQuery(
        "/api/info/portfolio-performance/by-broker",
        params,
        { schema: BrokerPortfolioPerformanceSchema },
    );
}

export interface PortfolioSummaryTotals {
    totalPortfolioValue: number;
    totalInvested: number;
    totalGainLoss: number;
    totalRealizedGain: number;
    totalUnrealizedGain: number;
    totalGain: number;
    totalIncome: number;
    /** Read-only subtotal; already represented by units, excluded from totalIncome/gain. */
    totalInKindIncome?: number;
    totalFees: number;
    totalTaxes: number;
    /** Portion of totalGainLoss from native asset performance (at today's rates). */
    totalAssetGain: number;
    /** Portion of totalGainLoss from currency moves (totalGainLoss − totalAssetGain). */
    totalFxGain: number;
    totalReturnPct: number;
    /** True when some historical FX rate was missing and today's rate was used instead. */
    usedFallbackRate: boolean;
}

export interface PortfolioSummaryItem {
    id: InvestmentId;
    name: string;
    symbol?: string;
    asset_class: string;
    assetClass: string;
    is_active: boolean;
    created_at: string;
    updated_at: string;
    notes?: string;
    location?: string;
    municipality?: string;
    /** NUMERIC passthrough from `SELECT i.*`: a decimal string. */
    cadastral_income: string | null;
    /** NUMERIC passthrough from `SELECT i.*`: a decimal string. */
    municipality_tax_rate: string | null;
    /** A serialized local-midnight Date (ISO timestamp), not a calendar day. */
    maturity_date: string | null;
    /** Same value as `maturity_date`. */
    maturityDate: string | null;
    price_provider?: string;
    price_provider_id?: string;
    price_updated_at?: string;
    /** Display currency — every monetary field on this object is in this currency. */
    currency: CurrencyCode;
    /** The investment's native currency (for label display only). */
    originalCurrency: CurrencyCode;
    totalUnits: number;
    currentPrice: number;
    current_price: number;
    interestRate: number;
    interest_rate: number;
    totalInvested: number;
    totalBuyCost: number;
    totalSellProceeds: number;
    currentValue: number;
    totalFees: number;
    totalTaxes: number;
    totalDividends: number;
    totalIncome: number;
    totalInKindIncome?: number;
    avgCostBasis: number;
    realizedGain: number;
    unrealizedGain: number;
    totalGain: number;
    gainLoss: number;
    gainLossPercent: number;
    /** gainLoss = assetGain (native performance at today's rate) + fxGain (currency effect). */
    assetGain: number;
    fxGain: number;
    /** Current value in the investment's own currency, untouched by FX. */
    nativeCurrentValue: number;
    /** True when a historical FX rate was missing and today's rate was used instead. */
    usedFallbackRate: boolean;
    accruedInterest: number;
    projectedAnnualInterest: number;
    totalAppreciation: number;
    /** totalFees + totalTaxes. */
    feesAndTaxes: number;
    /** Real Estate return: totalAppreciation + totalIncome − totalFees − totalTaxes. */
    propertyReturn: number;
    /** Latest rent at the latest stored rate; 0 without rent, null without a rate. */
    monthlyRent: number | null;
    /** unrealizedGain / cost of the units held, in percent. */
    unrealizedGainPercent: number;
    fullyAssigned: boolean;
    oversold: boolean;
    byAccount: PortfolioSummaryByAccountItem[];
    /** This holding's server figures per broker account (broker filter). */
    accountTotals: PortfolioSummaryAccountTotals[];
}

/** Server totals of a set of holdings (sums of the rounded summary figures). */
export interface PortfolioHoldingTotals {
    holdingCount: number;
    totalPortfolioValue: number;
    /** Σ totalBuyCost, as `totals.totalInvested`. */
    totalInvested: number;
    totalGainLoss: number;
    totalRealizedGain: number;
    totalUnrealizedGain: number;
    totalIncome: number;
    totalDividends: number;
    totalInKindIncome: number;
    totalFees: number;
    totalTaxes: number;
    totalFeesAndTaxes: number;
    /** Σ (gainLoss − totalIncome). */
    netReturnExcludingIncome: number;
    /** Σ (gainLoss − totalIncome + totalDividends). */
    netReturnWithDividends: number;
    totalAppreciation: number;
    totalPropertyReturn: number;
    totalAccruedInterest: number;
    totalProjectedAnnualInterest: number;
    /** Value-weighted interest rate, in percent. */
    valueWeightedInterestRate: number;
    estimatedMonthlyRent: number;
    monthlyRentRateMissing: boolean;
    usedFallbackRate: boolean;
}

export interface PortfolioAssetClassTotals extends PortfolioHoldingTotals {
    assetClass: string;
}

export type PortfolioAssetGroup = Schemas["PortfolioAssetGroupTotals"]["group"];

export interface PortfolioAssetGroupTotals extends PortfolioHoldingTotals {
    group: PortfolioAssetGroup;
    assetClasses: string[];
}

export type PortfolioAccountAssignment =
    Schemas["PortfolioSummaryByAccountItem"]["assignment"];
export type PortfolioContributionKind =
    Schemas["PortfolioSummaryByAccountItem"]["contribution_kind"];

export interface PortfolioSummaryByAccountItem {
    account_id: AccountId | null;
    /** Machine-readable identity; clients localize `unassigned` for display. */
    assignment: PortfolioAccountAssignment;
    /** Lot-bearing position row or standalone income/adjustment row. */
    contribution_kind: PortfolioContributionKind;
    oversold: boolean;
    currentValue: number;
    totalInvested: number;
    realizedGain: number;
    unrealizedGain: number;
    gainLoss: number;
}

/** One broker account's figures, every contribution kind summed on the server. */
export type PortfolioSummaryAccountTotals = Omit<
    PortfolioSummaryByAccountItem,
    "contribution_kind"
>;

export interface PortfolioSummaryResponse {
    currency: CurrencyCode;
    computed_at: string;
    totals: PortfolioSummaryTotals;
    summaries: PortfolioSummaryItem[];
    byAccount: PortfolioSummaryByAccountItem[];
    /** Portfolio-wide figures per broker account (broker filter subtotals). */
    accountTotals: PortfolioSummaryAccountTotals[];
    /** Totals per asset class present in `summaries`. */
    byAssetClass: PortfolioAssetClassTotals[];
    /** Totals per asset page group, all five groups always present. */
    byAssetGroup: PortfolioAssetGroupTotals[];
    /** Source-owned account fees, separate from security fees and investment returns. */
    brokerageCashFees?: {
        total: number;
        gainAfterFees: number;
        usedFallbackRate: boolean;
        byAccount: Array<{ account_id: AccountId; total: number }>;
    };
    /** Dated, target-currency in-kind income of archived holdings. */
    archivedInKindIncome?: Array<{ id: InvestmentId; totalInKindIncome: number }>;
}

export function getPortfolioSummary(params?: {
    currency?: CurrencyCode | undefined;
    /** false: summaries for every holding, archived ones included. */
    active?: boolean | undefined;
}): Promise<PortfolioSummaryResponse> {
    return requestWithQuery("/api/info/portfolio-summary", params, {
        schema: PortfolioSummarySchema,
    });
}

export function getNetWorth(params?: {
    currency?: CurrencyCode | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
}): Promise<NetWorthResponse> {
    return requestWithQuery("/api/info/net-worth", params, {
        schema: NetWorthSchema,
    });
}

export interface NetWorthByAccountRow {
    /** null for holdings not assigned to an account. */
    accountId: AccountId | null;
    /** display_name or name; null for the unassigned row or an unknown account. */
    name: string | null;
    type: string | null;
    cashCurrency: CurrencyCode | null;
    /** Cash at the latest stored rate; null when the currency has no rate. */
    cash: number | null;
    holdings: number;
    total: number | null;
    unconverted: boolean;
}

export interface NetWorthByAccountResponse {
    currency: CurrencyCode;
    rows: NetWorthByAccountRow[];
    /** Σ row totals; null while any cash balance is unconverted. */
    total: number | null;
    unconvertedAccountIds: number[];
}

export function getNetWorthByAccount(params?: {
    currency?: CurrencyCode | undefined;
}): Promise<NetWorthByAccountResponse> {
    return requestWithQuery("/api/info/net-worth/by-account", params, {
        schema: NetWorthByAccountSchema,
    });
}

export interface ExchangeRate {
    currency: CurrencyCode;
    rate_to_eur: number;
    rate_date: string;
    fetched_at: string;
}

export type ExchangeRatesSource = Schemas["ExchangeRates"]["source"];

export interface ExchangeRatesData {
    total_rates: number;
    rates: ExchangeRate[];
    source?: ExchangeRatesSource;
    is_stale?: boolean;
    last_fetched_at?: string | null;
}

export function getExchangeRates(
    options: { dbOnly?: boolean } = {},
): Promise<ExchangeRatesData> {
    const qs = options.dbOnly ? "?db_only=true" : "";
    return apiRequest(`/api/info/exchange-rates${qs}`, {
        schema: ExchangeRatesSchema,
    });
}

export function refreshExchangeRates(): Promise<{ message: string }> {
    return apiRequest("/api/info/exchange-rates/refresh", {
        method: "POST",
        schema: InfoMessageSchema,
    });
}
