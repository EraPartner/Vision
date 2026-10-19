import { useMemo } from "react";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { useBelgianTaxProfile } from "@/contexts/BelgianTaxProfileContext";
import { resolveBelgianTaxProfile } from "@/stores/belgianTaxStore";
import { useTaxYearFigures } from "@/hooks/useBelgianTaxComputation";
import { usePortfolioTaxDashboardQuery } from "@/hooks/useBelgianTaxDashboards";
import type { BelgianPortfolioTaxDashboard } from "@/lib/api/belgianTax";
import { getAssetClassLabel, type AssetClass } from "@/types/portfolio";
import { asInvestmentId } from "@vision/types/brands";
import type { InvestmentId } from "@vision/types/brands";
import { DEFAULT_CURRENCY } from "@/utils/currency";

/** One row of the per-tax-type / per-fee-type breakdown lists. */
export interface CostBreakdownEntry {
    name: string;
    value: number;
}

/** One row of the tax-by-asset-class chart. */
export interface AssetClassTaxDatum {
    name: string;
    taxes: number;
    fees: number;
    total: number;
}

/** One month of the yearly tax/fee trend chart. */
export interface MonthlyCostDatum {
    period: string;
    taxes: number;
    fees: number;
}

/** One row of the per-investment cost table; amounts are in the response currency. */
export interface InvestmentCostRow {
    id: InvestmentId;
    name: string;
    symbol: string | undefined;
    assetClass: string;
    recordedTaxes: number;
    recordedFees: number;
    manualTaxes: number;
    manualFees: number;
    taxes: number;
    fees: number;
    total: number;
    realizedGain: number;
    currency: string;
}

/** Investment identity for the manual-adjustments dialog. */
export interface PortfolioTaxInvestmentSummary {
    id: InvestmentId;
    name: string;
    symbol: string | undefined;
    assetClass: AssetClass;
    currency: string;
}

/**
 * Domain data for the portfolio-tax page (PortfolioTaxPage).
 *
 * Every cost, breakdown and estimate (per-investment cost enrichment, tax/fee
 * breakdowns, TOB / TACR / Reynders / CGT / dividend-WHT estimates, totals) comes
 * from GET /api/belgian-tax/portfolio-dashboard, which reads the stored manual
 * adjustments and classifications. This hook only localizes labels; the viewed
 * year's profile for the profile-inputs card stays on the household store, which the
 * profile dialog edits live, and its figures come from POST /api/belgian-tax/compute
 * (or the frozen figures).
 */
export function usePortfolioTaxData() {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const { liveProfile, snapshots, viewedYear, isProfileLoading } =
        useBelgianTaxProfile((state) => ({
            liveProfile: state.profile,
            snapshots: state.snapshots,
            viewedYear: state.viewedYear,
            isProfileLoading: state.isLoading,
        }));
    const profile = useMemo(
        () =>
            resolveBelgianTaxProfile(
                { profile: liveProfile, snapshots },
                viewedYear,
            ),
        [liveProfile, snapshots, viewedYear],
    );
    const { calculation } = useTaxYearFigures(viewedYear);

    const dashboardQuery = usePortfolioTaxDashboardQuery({
        year: viewedYear,
        currency: appSettings.defaultCurrency || DEFAULT_CURRENCY,
        enabled: !isProfileLoading,
    });
    const view = useMemo(
        () =>
            dashboardQuery.data
                ? localizeDashboard(dashboardQuery.data, t)
                : undefined,
        [dashboardQuery.data, t],
    );

    const hasProfile =
        liveProfile.profileConfigured || liveProfile.grossAnnualIncome > 0;

    return {
        /** Portfolio-dashboard query state — pages use `isPending` / `isError` / `refetch`. */
        dashboardQuery,
        /** Localized server dashboard; undefined until the query succeeds. */
        view,
        /** Profile for the viewed year (live or snapshot). */
        profile,
        /** Display PIT calculation for the viewed year (frozen "as-filed" when present). */
        calculation,
        txYear: viewedYear,
        viewedYear,
        hasProfile,
    };
}

function localizeDashboard(
    dashboard: BelgianPortfolioTaxDashboard,
    t: (key: string) => string,
) {
    const entries = (rows: BelgianPortfolioTaxDashboard["taxBreakdown"]) =>
        rows.map(
            (row): CostBreakdownEntry => ({
                name: t(row.nameKey),
                value: row.value,
            }),
        );
    const taxByAssetClass = dashboard.taxByAssetClass.map(
        (row): AssetClassTaxDatum => ({
            name: getAssetClassLabel(t, row.assetClass as AssetClass) ||
                row.assetClass,
            taxes: row.taxes,
            fees: row.fees,
            total: row.total,
        }),
    );
    const investmentBreakdown = dashboard.investmentBreakdown.map(
        (row): InvestmentCostRow => ({
            ...row,
            id: asInvestmentId(row.id),
            symbol: row.symbol ?? undefined,
            assetClass: getAssetClassLabel(t, row.assetClass as AssetClass),
        }),
    );
    const summaries = dashboard.summaries.map(
        (row): PortfolioTaxInvestmentSummary => ({
            ...row,
            id: asInvestmentId(row.id),
            symbol: row.symbol ?? undefined,
            assetClass: row.assetClass as AssetClass,
        }),
    );
    const yearlyCostTrend: MonthlyCostDatum[] = dashboard.yearlyCostTrend;
    return {
        ...dashboard.totals,
        ...dashboard.dividend,
        ...dashboard.estimates,
        taxTable: dashboard.taxTable,
        isEmpty: dashboard.isEmpty,
        hasInKindIncomeUnclassified: dashboard.hasInKindIncomeUnclassified,
        unconvertedCurrencies: dashboard.unconvertedCurrencies,
        taxBreakdown: entries(dashboard.taxBreakdown),
        feeBreakdown: entries(dashboard.feeBreakdown),
        taxByAssetClass,
        investmentBreakdown,
        yearlyCostTrend,
        summaries,
    };
}
