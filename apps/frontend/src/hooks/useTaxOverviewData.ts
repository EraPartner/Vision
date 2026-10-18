import { useCallback, useMemo } from "react";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { useBelgianTaxProfile } from "@/contexts/BelgianTaxProfileContext";
// By file path, not through the `@/lib/belgianTax` barrel, which re-exports the household engine.
import { computeBelgianPIT } from "@/lib/belgianTax/pit";
import { isApproximatedTaxYear } from "@/lib/belgianTax/constants";
import {
    calculateBelgianTaxHouseholdWithPatch,
    resolveBelgianTaxCalculation,
    resolveBelgianTaxHousehold,
    resolveBelgianTaxProfile,
} from "@/stores/belgianTaxStore";
// The household engine is already loaded on the tax pages; by file path, not the barrel.
import {
    computeHouseholdTax,
    toBelgianTaxCalculation,
} from "@/lib/belgianTax/household";
import {
    attributeToPartners,
    householdForRecordedIncome,
    householdHasPartnerB,
    type OwnerAmounts,
    type PartnerAmounts,
} from "@/lib/belgianTax/partnerAttribution";
import {
    recordedTaxesForYear,
    type PortfolioTaxInvestment,
} from "@/lib/belgianTax/portfolioTax";
import { useCurrencyConverter } from "@/hooks/useCurrencyConverter";
import { usePortfolio } from "@/hooks/usePortfolio";
import { useStatistics } from "@/hooks/useStatistics";
import { matchesCategorySelection } from "@/lib/categoryHierarchy";

/** One bar of the yearly income-vs-PIT chart. */
export interface YearlyIncomeDatum {
    year: string;
    income: number;
    estimatedTax: number;
    netAfterTax: number;
    isApproximated: boolean;
}

/** Adds owner amounts into `target` (partner / joint only; the rest is partner A's). */
function addOwnerAmounts(target: OwnerAmounts, amounts: OwnerAmounts | undefined) {
    if (!amounts) return;
    if (amounts.partner) target.partner = (target.partner ?? 0) + amounts.partner;
    if (amounts.joint) target.joint = (target.joint ?? 0) + amounts.joint;
}

/** One bar of the monthly income / PIT-reserve chart. */
export interface MonthlyIncomeTaxDatum {
    period: string;
    income: number;
    estimatedTax: number;
}

/**
 * Domain data for the budget-tax overview page (TaxOverviewPage).
 *
 * Owns the tax math — taxable-income aggregation by month/year, recorded
 * portfolio-tax accumulation, PIT estimation per gross/year, and the derived
 * chart series — so the page itself is pure composition. Formulas and memo
 * dependencies are moved verbatim from the page; rendered numbers are
 * unchanged.
 */
export function useTaxOverviewData() {
    const { appSettings } = useAppSettings();
    const {
        profile: liveProfile,
        snapshots,
        household,
        householdSnapshots,
        snapshotMetas,
        isLoading: isProfileLoading,
        viewedYear,
        isViewingHistorical,
    } = useBelgianTaxProfile((state) => ({
        profile: state.profile,
        snapshots: state.snapshots,
        household: state.household,
        householdSnapshots: state.householdSnapshots,
        snapshotMetas: state.snapshotMetas,
        isLoading: state.isLoading,
        viewedYear: state.viewedYear,
        isViewingHistorical: state.isViewingHistorical,
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
    // Use the display calc — falls back to the frozen "as-filed" value when present so
    // engine drift doesn't retroactively change filed numbers (ADR-059).
    const calculation = useMemo(
        () =>
            resolveBelgianTaxCalculation(
                {
                    profile: liveProfile,
                    snapshots,
                    household,
                    householdSnapshots,
                    snapshotMetas,
                },
                viewedYear,
            ),
        [
            liveProfile,
            snapshots,
            household,
            householdSnapshots,
            snapshotMetas,
            viewedYear,
        ],
    );
    const stats = useStatistics();
    const portfolioQuery = usePortfolio({ completeHistory: true });
    const { allSummaries: summaries } = portfolioQuery;
    const { convertToTarget } = useCurrencyConverter(
        appSettings.defaultCurrency || "EUR",
    );

    const totalIncome = stats.data?.totalIncome ?? 0;
    const monthlyData = stats.data?.monthlyData;
    const yearlyData = stats.data?.yearlyComparison;
    const categoryPivot = stats.data?.categoryPivot;

    // Categories the user has flagged as taxable income (the "salary-like" filter).
    // Without this, the graphs would treat every positive transaction as PIT-able income.
    const taxIncomeCategoryIds = useMemo(
        () => new Set(profile.taxIncomeCategoryIds ?? []),
        [profile.taxIncomeCategoryIds],
    );
    const hasIncomeSources = taxIncomeCategoryIds.size > 0;

    /**
     * Per-period taxable income map ("YYYY-MM" → EUR), summed only over categories the user
     * marked as taxable income. Same source of truth as the green bars and the orange reserve.
     */
    const taxableIncomeByMonth = useMemo(() => {
        const result = new Map<string, number>();
        if (!hasIncomeSources || !categoryPivot) return result;
        for (const cat of categoryPivot) {
            if (!matchesCategorySelection(cat, taxIncomeCategoryIds)) continue;
            for (const [period, amount] of Object.entries(cat.incomeMonths)) {
                result.set(period, (result.get(period) ?? 0) + amount);
            }
        }
        return result;
    }, [categoryPivot, hasIncomeSources, taxIncomeCategoryIds]);

    /**
     * Per-period part of the taxable income booked on partner / joint accounts (ADR-201), from
     * the same categories as `taxableIncomeByMonth`. Empty when no income is on such accounts.
     */
    const taxableOwnerIncomeByMonth = useMemo(() => {
        const result = new Map<string, OwnerAmounts>();
        if (!hasIncomeSources || !categoryPivot) return result;
        for (const cat of categoryPivot) {
            if (!cat.incomeByOwnerMonths) continue;
            if (!matchesCategorySelection(cat, taxIncomeCategoryIds)) continue;
            for (const [period, amounts] of Object.entries(cat.incomeByOwnerMonths)) {
                const entry = result.get(period) ?? {};
                addOwnerAmounts(entry, amounts);
                result.set(period, entry);
            }
        }
        return result;
    }, [categoryPivot, hasIncomeSources, taxIncomeCategoryIds]);

    /** Owner amounts summed over the given periods (all periods of a year, or a window). */
    const ownerIncomeFor = useCallback(
        (periods: Iterable<string>): OwnerAmounts => {
            const total: OwnerAmounts = {};
            for (const period of periods)
                addOwnerAmounts(total, taxableOwnerIncomeByMonth.get(period));
            return total;
        },
        [taxableOwnerIncomeByMonth],
    );
    const ownerIncomeForYear = useCallback(
        (year: number): OwnerAmounts =>
            ownerIncomeFor(
                [...taxableOwnerIncomeByMonth.keys()].filter((period) =>
                    period.startsWith(`${year}-`),
                ),
            ),
        [ownerIncomeFor, taxableOwnerIncomeByMonth],
    );

    /** Per-year taxable income, summed from the monthly map. */
    const taxableIncomeByYear = useMemo(() => {
        const result = new Map<number, number>();
        for (const [period, amount] of taxableIncomeByMonth) {
            const year = Number.parseInt(period.slice(0, 4), 10);
            if (Number.isNaN(year)) continue;
            result.set(year, (result.get(year) ?? 0) + amount);
        }
        return result;
    }, [taxableIncomeByMonth]);

    // Shared with PortfolioTaxPage via the pure recordedTaxesForYear helper so both
    // pages accumulate recorded portfolio taxes identically (see lib/belgianTax/portfolioTax.ts).
    const portfolioTaxesForYear = useMemo(
        () =>
            summaries.reduce(
                (sum, inv) =>
                    sum +
                    recordedTaxesForYear(
                        inv as PortfolioTaxInvestment,
                        viewedYear,
                        convertToTarget,
                    ),
                0,
            ),
        [summaries, viewedYear, convertToTarget],
    );

    const totalTaxIncludingPortfolio =
        calculation.totalPIT + portfolioTaxesForYear;
    // include estimated property tax in an alternate total (informational)
    const totalTaxIncludingPropertyEstimate =
        totalTaxIncludingPortfolio + calculation.propertyTaxEstimate;

    /**
     * Run PIT for a given gross + tax year. Picks each year's snapshot household when one exists
     * (so the historical bars reflect the inputs the user actually had at the time); otherwise
     * falls back to the live household applied to that year's tax tables. The bar's gross
     * replaces partner A's primary activity income and the household engine computes the year,
     * like the overview; `computeBelgianPIT` on the v1 projection serves only before hydration.
     * With partner B in that year's household and any of `owners` recorded on a partner or joint
     * account, the gross is attributed between the partners (ADR-201) and each partner is taxed
     * on their own share, including a share of 0; without such income partner A receives the
     * whole gross and partner B keeps the entered gross.
     */
    const pitForGross = useCallback(
        (gross: number, year: number, owners?: OwnerAmounts): number => {
            if (gross <= 0) return 0;
            // For years whose calculation is frozen, scale the frozen PIT proportionally to the
            // bar's gross relative to the frozen gross — this keeps historical filed numbers in the
            // chart aligned with the "as-filed" calc instead of falling back to a live recompute.
            const frozen = snapshotMetas[year]?.frozenCalculation;
            if (frozen && frozen.grossIncome > 0) {
                const ratio = gross / frozen.grossIncome;
                return frozen.totalPIT * ratio;
            }
            const yearHousehold = resolveBelgianTaxHousehold(
                { household, householdSnapshots },
                year,
            );
            const attributed = householdForRecordedIncome(
                yearHousehold,
                gross,
                owners,
            );
            if (attributed) {
                const next = { ...attributed, taxYear: year };
                return toBelgianTaxCalculation(computeHouseholdTax(next), next)
                    .totalPIT;
            }
            const householdCalculation = calculateBelgianTaxHouseholdWithPatch(
                { household, householdSnapshots },
                year,
                { grossAnnualIncome: gross },
            );
            if (householdCalculation) return householdCalculation.totalPIT;
            const baseProfile = resolveBelgianTaxProfile(
                { profile: liveProfile, snapshots },
                year,
            );
            return computeBelgianPIT({
                ...baseProfile,
                grossAnnualIncome: gross,
                taxYear: year,
            }).totalPIT;
        },
        [liveProfile, snapshots, household, householdSnapshots, snapshotMetas],
    );

    /**
     * Yearly chart series. Uses transaction-derived taxable income (filtered by the user's
     * selected categories) when available; falls back to total income otherwise (rare,
     * triggers the empty-state CTA on the chart below).
     */
    const yearlyIncome = useMemo<YearlyIncomeDatum[]>(
        () =>
            (yearlyData ?? [])
                .map((y) => {
                    const incomeForYear = hasIncomeSources
                        ? (taxableIncomeByYear.get(y.year) ?? 0)
                        : y.totalIncome;
                    const estimatedPIT = pitForGross(
                        incomeForYear,
                        y.year,
                        hasIncomeSources ? ownerIncomeForYear(y.year) : undefined,
                    );
                    return {
                        year: y.year.toString(),
                        income: incomeForYear,
                        estimatedTax: estimatedPIT,
                        netAfterTax: Math.max(incomeForYear - estimatedPIT, 0),
                        isApproximated: isApproximatedTaxYear(y.year),
                    };
                })
                .filter((y) => y.income > 0),
        [
            yearlyData,
            pitForGross,
            hasIncomeSources,
            taxableIncomeByYear,
            ownerIncomeForYear,
        ],
    );

    /**
     * Monthly reserve series.
     *  - Live mode: trailing 12 months of taxable income; annual PIT computed once on that total
     *    and prorated per month by income share. Sum of monthly reserves equals annual PIT.
     *  - Historical mode: only months *within* the viewed year. Same proration approach against
     *    that year's total. Keeps the chart semantically aligned with the rest of the historical
     *    surface.
     */
    const monthlyIncomeTax = useMemo<MonthlyIncomeTaxDatum[]>(() => {
        if (!monthlyData?.length) return [];

        const filtered = monthlyData
            .filter((m) =>
                hasIncomeSources
                    ? taxableIncomeByMonth.has(m.period)
                    : m.income > 0,
            )
            .filter((m) => {
                if (!isViewingHistorical) return true;
                const monthYear = Number.parseInt(m.period.slice(0, 4), 10);
                return monthYear === viewedYear;
            });

        const windowed = isViewingHistorical ? filtered : filtered.slice(-12);
        const series = windowed
            .map((m) => ({
                period: m.period,
                income: hasIncomeSources
                    ? (taxableIncomeByMonth.get(m.period) ?? 0)
                    : m.income,
            }))
            .filter((m) => m.income > 0);

        const yearlyTaxable = series.reduce((sum, m) => sum + m.income, 0);
        const latest = series.at(-1);
        if (yearlyTaxable <= 0 || latest === undefined) return [];

        const referenceYear = isViewingHistorical
            ? viewedYear
            : Number.parseInt(latest.period.slice(0, 4), 10);
        const annualPIT = pitForGross(
            yearlyTaxable,
            referenceYear,
            hasIncomeSources
                ? ownerIncomeFor(series.map((m) => m.period))
                : undefined,
        );

        return series.map((m) => ({
            period: m.period,
            income: m.income,
            estimatedTax: annualPIT * (m.income / yearlyTaxable),
        }));
    }, [
        monthlyData,
        pitForGross,
        hasIncomeSources,
        taxableIncomeByMonth,
        isViewingHistorical,
        viewedYear,
        ownerIncomeFor,
    ]);

    /**
     * Taxable income recorded in transactions for the viewed year, per partner (ADR-201):
     * `undefined` without income categories or without partner B in that year's household.
     */
    const recordedIncomeByPartner = useMemo<PartnerAmounts | undefined>(() => {
        if (!hasIncomeSources) return undefined;
        const yearHousehold = resolveBelgianTaxHousehold(
            { household, householdSnapshots },
            viewedYear,
        );
        if (!householdHasPartnerB(yearHousehold)) return undefined;
        return attributeToPartners(
            taxableIncomeByYear.get(viewedYear) ?? 0,
            ownerIncomeForYear(viewedYear),
            true,
        );
    }, [
        hasIncomeSources,
        household,
        householdSnapshots,
        viewedYear,
        taxableIncomeByYear,
        ownerIncomeForYear,
    ]);

    const hasProfile =
        liveProfile.profileConfigured ||
        liveProfile.grossAnnualIncome > 0 ||
        liveProfile.otherTaxableIncome > 0 ||
        liveProfile.cadastralIncome > 0 ||
        liveProfile.dependentChildren > 0 ||
        liveProfile.dependentOtherPersons > 0;
    const hasStatsData =
        totalIncome > 0 || (monthlyData ?? []).some((m) => m.income > 0);
    // Only treat "no data" as the setup-prompt empty state when the stats fetch
    // actually succeeded. On a stats error, a user who simply hasn't filled in the
    // profile yet (but has real transaction-derived income) would otherwise see
    // "set up your tax profile" instead of the real error.
    const isEmpty =
        !isProfileLoading && !stats.isError && !hasProfile && !hasStatsData;

    return {
        /** react-query statistics result — pages use `isLoading` / `isError` / `error`. */
        stats: {
            ...stats,
            isLoading: stats.isLoading || portfolioQuery.isLoading,
            isError: stats.isError || portfolioQuery.isError,
            error: stats.error || portfolioQuery.error,
        },
        /** Profile for the viewed year (live or snapshot). */
        profile,
        /** Display PIT calculation for the viewed year (frozen "as-filed" when present). */
        calculation,
        isProfileLoading,
        viewedYear,
        hasIncomeSources,
        portfolioTaxesForYear,
        totalTaxIncludingPortfolio,
        totalTaxIncludingPropertyEstimate,
        yearlyIncome,
        monthlyIncomeTax,
        /** Viewed year's recorded taxable income per partner; only with partner B. */
        recordedIncomeByPartner,
        hasProfile,
        isEmpty,
    };
}
