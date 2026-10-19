import { useMemo } from "react";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { useBelgianTaxProfile } from "@/contexts/BelgianTaxProfileContext";
import { resolveBelgianTaxProfile } from "@/stores/belgianTaxStore";
import { useTaxYearFigures } from "@/hooks/useBelgianTaxComputation";
import type { PartnerAmounts } from "@/lib/belgianTax/partnerAttribution";
import type {
    BelgianTaxDashboardSuggestion,
    BelgianTaxDashboardYear,
} from "@/lib/api/belgianTax";
import { useTaxDashboardQuery } from "@/hooks/useBelgianTaxDashboards";

/** One bar of the yearly income-vs-PIT chart. */
export interface YearlyIncomeDatum {
    year: string;
    income: number;
    estimatedTax: number;
    netAfterTax: number;
    isApproximated: boolean;
}

/** One bar of the monthly income / PIT-reserve chart. */
export interface MonthlyIncomeTaxDatum {
    period: string;
    income: number;
    estimatedTax: number;
}

const NO_YEARLY_INCOME: YearlyIncomeDatum[] = [];
const NO_MONTHLY_INCOME: MonthlyIncomeTaxDatum[] = [];
const NO_YEARS: BelgianTaxDashboardYear[] = [];
const NO_CURRENCIES: string[] = [];

/**
 * Domain data for the budget-tax overview page (TaxOverviewPage).
 *
 * The transaction-derived figures (taxable income by month and year, PIT per bar,
 * the monthly reserve, recorded portfolio taxes, recorded income per partner, the
 * per-year calculations and the deduction suggestions) come from
 * GET /api/belgian-tax/dashboard. The viewed year's profile stays on the household
 * store, which the profile dialog edits live; its figures come from
 * POST /api/belgian-tax/compute on that household as it is edited (or the frozen
 * figures). The dashboard reads the stored household and is refetched after each
 * acknowledged save.
 */
export function useTaxOverviewData() {
    const { appSettings } = useAppSettings();
    const {
        profile: liveProfile,
        snapshots,
        isLoading: isProfileLoading,
        viewedYear,
    } = useBelgianTaxProfile((state) => ({
        profile: state.profile,
        snapshots: state.snapshots,
        isLoading: state.isLoading,
        viewedYear: state.viewedYear,
    }));
    // `profile`/`calculation` reflect the year currently being viewed (live or snapshot/estimate).
    // We keep `liveProfile` separately for the empty-state check and the editable dialog target.
    const profile = useMemo(
        () =>
            resolveBelgianTaxProfile(
                { profile: liveProfile, snapshots },
                viewedYear,
            ),
        [liveProfile, snapshots, viewedYear],
    );
    // The frozen "as-filed" figures when present, so engine drift doesn't retroactively
    // change filed numbers (ADR-059); else the server's figures for the viewed household.
    const figures = useTaxYearFigures(viewedYear);
    const { calculation } = figures;

    const dashboardQuery = useTaxDashboardQuery({
        year: viewedYear,
        currency: appSettings.defaultCurrency || "EUR",
        enabled: !isProfileLoading,
    });
    const dashboard = dashboardQuery.data;

    const portfolioTaxesForYear = dashboard?.portfolioTaxesForYear ?? 0;
    // Summed against the viewed year's displayed calculation, so the totals stay in
    // step with the PIT figures shown beside them while the profile is being edited.
    const totalTaxIncludingPortfolio =
        calculation.totalPIT + portfolioTaxesForYear;
    // include estimated property tax in an alternate total (informational)
    const totalTaxIncludingPropertyEstimate =
        totalTaxIncludingPortfolio + calculation.propertyTaxEstimate;

    const hasProfile =
        liveProfile.profileConfigured ||
        liveProfile.grossAnnualIncome > 0 ||
        liveProfile.otherTaxableIncome > 0 ||
        liveProfile.cadastralIncome > 0 ||
        liveProfile.dependentChildren > 0 ||
        liveProfile.dependentOtherPersons > 0;
    // Only treat "no data" as the setup-prompt empty state once the dashboard answered:
    // on an error the page shows the error, and while loading it shows a loader.
    const isEmpty =
        !isProfileLoading &&
        dashboard !== undefined &&
        !hasProfile &&
        !dashboard.hasStatsData;
    const recordedIncomeByPartner: PartnerAmounts | undefined =
        dashboard?.recordedIncomeByPartner ?? undefined;
    const suggestions: BelgianTaxDashboardSuggestion[] | undefined =
        dashboard?.suggestions;

    return {
        /** Dashboard query state — pages use `isLoading` / `isError` / `error`. */
        stats: {
            isLoading: dashboardQuery.isPending,
            isError: dashboardQuery.isError,
            error: dashboardQuery.error,
        },
        /** Profile for the viewed year (live or snapshot). */
        profile,
        /** Display PIT calculation for the viewed year (frozen "as-filed" when present). */
        calculation,
        /** Server computation state of `calculation` (pending, refreshing, failed). */
        figures,
        isProfileLoading,
        viewedYear,
        hasIncomeSources: dashboard?.hasIncomeSources ?? false,
        portfolioTaxesForYear,
        totalTaxIncludingPortfolio,
        totalTaxIncludingPropertyEstimate,
        yearlyIncome: dashboard?.yearlyIncome ?? NO_YEARLY_INCOME,
        monthlyIncomeTax: dashboard?.monthlyIncomeTax ?? NO_MONTHLY_INCOME,
        /** Viewed year's recorded taxable income per partner; only with partner B. */
        recordedIncomeByPartner,
        /** Per-year calculations for the trend strip and year comparison. */
        yearCalculations: dashboard?.yearCalculations ?? NO_YEARS,
        /** Deduction suggestions for the live profile; undefined while loading. */
        suggestions,
        hasProfile,
        isEmpty,
        /** Currencies left out of the dashboard figures for want of a stored rate. */
        unconvertedCurrencies:
            dashboard?.unconvertedCurrencies ?? NO_CURRENCIES,
    };
}
