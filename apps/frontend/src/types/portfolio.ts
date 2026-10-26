/**
 * Portfolio investment types — shared between frontend components.
 */
import type { PortfolioTransaction, PriceProvider } from "./api";
import type { AssetClass } from "@vision/types/assetClasses";
import type { PortfolioTxnType as CanonicalPortfolioTxnType } from "@vision/types/portfolioTxnTypes";
import type { RecurrenceInterval } from "@vision/types/recurrence";
import type { CurrencyCode, InvestmentId } from "@vision/types/brands";
import { enumGuard } from "@/lib/enumGuard";
import type { TranslationKey } from "@/locales/keys";

// Derived from the canonical runtime array in @vision/types/assetClasses, so
// this union can no longer drift from the shared ASSET_CLASSES list.
export type { AssetClass };

/** Returns a translated label for an asset class. */
export function getAssetClassLabel(
    t: (key: TranslationKey) => string,
    assetClass: AssetClass,
): string {
    return t(`portfolio.assetClass.${assetClass}`);
}

/** Returns translated asset class groups for UI display. */
export function getAssetClassGroups(
    t: (key: TranslationKey) => string,
): Record<string, AssetClass[]> {
    return {
        [t("portfolio.assetGroup.stocksEtfs")]: ["stock", "etf"],
        [t("portfolio.assetGroup.crypto")]: ["crypto"],
        [t("portfolio.assetGroup.metals")]: ["metals"],
        [t("portfolio.assetGroup.realEstate")]: ["real_estate"],
        [t("portfolio.assetGroup.savingsBonds")]: ["savings", "bond"],
    };
}

// Deliberate UI-facing SUBSET of the canonical PORTFOLIO_TXN_TYPES list in
// @vision/types/portfolioTxnTypes: only the types with portfolio.txnType.*
// labels are offered in the transaction dialogs. Corporate actions
// (split/merger/spinoff/return_of_capital) stay importable via CSV but are not
// part of this union. The parity check below fails typecheck if this subset
// ever contains a value outside the canonical set.
export type PortfolioTxnType =
    | "buy"
    | "sell"
    | "dividend"
    | "fee"
    | "tax"
    | "interest"
    | "rent_income"
    | "appreciation"
    | "gift";
export const isPortfolioTxnType = enumGuard<PortfolioTxnType>({
    buy: true,
    sell: true,
    dividend: true,
    fee: true,
    tax: true,
    interest: true,
    rent_income: true,
    appreciation: true,
    gift: true,
});
type _TxnTypeSubsetParity = PortfolioTxnType extends CanonicalPortfolioTxnType
    ? true
    : never;
// Compile-time assertion only: fails to type-check if the subset drifts.
true satisfies _TxnTypeSubsetParity;

const TXN_TYPE_LABEL_KEYS: Record<PortfolioTxnType, TranslationKey> = {
    buy: "portfolio.txnType.buy",
    sell: "portfolio.txnType.sell",
    dividend: "portfolio.txnType.dividend",
    fee: "portfolio.txnType.fee",
    tax: "portfolio.txnType.tax",
    interest: "portfolio.txnType.interest",
    rent_income: "portfolio.txnType.rent_income",
    appreciation: "portfolio.txnType.appreciation",
    gift: "portfolio.txnType.gift",
};

/**
 * Returns a translated label for a portfolio transaction type. Types without a
 * label (corporate actions such as `split`, which arrive from the API) fall
 * back to the raw type string.
 */
export function getTxnTypeLabel(
    t: (key: TranslationKey) => string,
    type: string,
): string {
    return isPortfolioTxnType(type) ? t(TXN_TYPE_LABEL_KEYS[type]) : type;
}

// Was declared here verbatim a second time (the identical union also lived in
// ./api.ts). Both now derive from the canonical PORTFOLIO_RECURRENCE_INTERVALS
// tuple in @vision/types/recurrence; re-exported so the portfolio dialogs keep
// importing it from '@/types/portfolio'.
export type { RecurrenceInterval };

export const isRecurrenceInterval = enumGuard<RecurrenceInterval>({
    daily: true,
    weekly: true,
    biweekly: true,
    monthly: true,
    quarterly: true,
    yearly: true,
});

// Computed view model returned by usePortfolio
export interface InvestmentSummary {
    id: InvestmentId;
    name: string;
    symbol?: string | undefined;
    assetClass: AssetClass;
    asset_class: AssetClass;
    /** Display currency of every monetary field below (the app's target currency). */
    currency: CurrencyCode;
    /** The investment's native currency, preserved for labelling (mirrors backend). */
    originalCurrency?: CurrencyCode;
    currentPrice?: number;
    current_price?: number | undefined;
    interestRate?: number;
    interest_rate?: number;
    maturityDate?: string | undefined;
    maturity_date?: string | undefined;
    location?: string;
    municipality?: string;
    cadastral_income?: number | null | undefined;
    municipality_tax_rate?: number | null | undefined;
    notes?: string;
    price_provider?: PriceProvider;
    price_provider_id?: string | undefined;
    price_provider_url?: string | undefined;
    price_provider_latest_url?: string | undefined;
    price_provider_latest_path?: string | undefined;
    price_provider_history_url?: string | undefined;
    price_provider_history_path?: string | undefined;
    price_provider_history_ts_path?: string | undefined;
    price_provider_history_price_path?: string | undefined;
    price_updated_at?: string;
    is_active: boolean;
    /** Whether this holding appears in the portfolio price ticker (default true). */
    show_in_ticker?: boolean;
    created_at: string;
    updated_at: string;

    // Computed - Core
    totalUnits: number;
    totalInvested: number; // Net capital deployed (buys - sells principal)
    totalFees: number; // fee tx-type rows + per-row fees columns
    totalTaxes: number; // tax tx-type rows + per-row taxes columns
    // Standalone fee/tax *transaction-type* totals only (NOT the per-row
    // fees/taxes columns, which buys/sells already fold into cost basis). Net-gain
    // cards must subtract these, never totalFees/totalTaxes, to avoid double-count.
    // Optional so existing test fixtures stay valid; production always sets them.
    feeTransactions?: number;
    taxTransactions?: number;
    totalDividends: number;
    totalIncome: number; // Ordinary income: dividends + interest + rent
    /** Literal income already represented by acquired units; excluded from gains. */
    totalInKindIncome?: number | undefined;
    currentValue: number;

    // Computed - Advanced
    avgCostBasis: number; // Weighted average cost per unit (for unit-based)
    realizedGain: number; // Profit/loss from sells
    unrealizedGain: number; // Paper profit/loss on current holdings
    totalGain: number; // realizedGain + unrealizedGain
    gainLoss: number; // Legacy: totalGain + income - fees - taxes
    gainLossPercent: number;

    // Fixed income specific
    accruedInterest: number; // Interest earned since last payout
    projectedAnnualInterest: number; // Expected annual interest
    totalAppreciation: number; // For real estate
    /** Server display figures (portfolio summary); optional for local fixtures. */
    feesAndTaxes?: number; // totalFees + totalTaxes
    propertyReturn?: number; // appreciation + income − fees − taxes
    /** Latest rent at the latest stored rate; null when no rate is stored. */
    monthlyRent?: number | null;
    /** unrealizedGain / cost of the units held, in percent. */
    unrealizedGainPercent?: number;

    // Cost tracking
    totalBuyCost: number; // Total spent on buys (including fees)
    totalSellProceeds: number; // Total received from sells
    /** False while any lot row remains unassigned to a broker account. */
    fullyAssigned?: boolean;
    /** Existing invalid partition data is clamped but surfaced for repair. */
    oversold?: boolean;
    /** Canonical summaries include custody; local summaries contain CRUD history only. */
    summarySource?: "canonical" | "local";

    transactions: PortfolioTransaction[];
    // ── Belgian tax classification (optional overrides used by the PortfolioTaxPage) ──
    /**
     * ETF accumulation/distribution flag — drives the TOB rate on `buy` legs.
     * `accumulating` → 1.32% (cap €4,000); `distributing` → 0.12% (cap €1,300).
     * When unset, the calc defaults to `accumulating` (more common in BE retail).
     */
    etfStructure?: "accumulating" | "distributing";
    /**
     * Explicit override for whether realised gains are subject to Reynders tax (30% on
     * the bond-attributable portion). When unset, the calc falls back to `assetClass === 'bond'`
     * — this default treats the `bond` asset class as a bond-fund proxy. Set explicitly:
     *   true  → bond fund / >10% bond mixed fund (apply Reynders to the interest portion)
     *   false → direct sovereign / corporate bond (no Reynders; from IY 2026 the gain is
     *           subject to the 10% CGT, before that exempt under normal management)
     */
    subjectToReynders?: boolean;
    /**
     * Share of the realised gain attributable to interest (Reynders base). Range [0, 1].
     * Default 1.0 — treats the full gain as interest, matching pure accumulating bond
     * funds. For mixed funds the user can lower this fraction; the remainder (1 - share)
     * is taxed under the 10% CGT regime from IY 2026 onwards.
     */
    reyndersInterestPortion?: number;
}
