/**
 * useAvailableTaxYears
 *
 * Produces the list of income years that should appear in the historical-tax-year switcher.
 * Sources unioned (sorted descending by year):
 *  - The live profile's active year (always present, marked `isCurrent`).
 *  - Every year that has a saved profile snapshot.
 *  - Every year that has portfolio transactions with taxes or fees recorded.
 *  - Every year with at least one transaction in a category the user flagged as
 *    taxable income (via `profile.taxIncomeCategoryIds`).
 *
 * Pure derivation — no fetching. Consumers must mount under both
 * `BelgianTaxProfileProvider` and the providers that back `usePortfolio` / `useStatistics`.
 */
import { useMemo } from "react";
import { useBelgianTaxProfile } from "@/contexts/BelgianTaxProfileContext";
import { usePortfolio } from "@/hooks/usePortfolio";
import { useStatistics } from "@/hooks/useStatistics";

export interface AvailableTaxYear {
    year: number;
    isCurrent: boolean;
    hasSnapshot: boolean;
    hasTransactions: boolean;
    /** True when the year has a `filing` meta record (ADR-059). */
    isFiled: boolean;
    /** True when the year has a `frozenCalculation` (ADR-059). */
    hasFrozenCalculation: boolean;
}

function yearFromIsoDate(date: string | undefined | null): number | null {
    if (!date) return null;
    const parsed = Number.parseInt(date.slice(0, 4), 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function yearFromMonthKey(period: string | undefined | null): number | null {
    if (!period) return null;
    const parsed = Number.parseInt(period.slice(0, 4), 10);
    return Number.isFinite(parsed) ? parsed : null;
}

export function useAvailableTaxYears(): AvailableTaxYear[] {
    const { currentYear, configuredCategoryIds, snapshots, snapshotMetas } =
        useBelgianTaxProfile((state) => ({
            currentYear: state.profile.taxYear,
            configuredCategoryIds: state.profile.taxIncomeCategoryIds,
            snapshots: state.snapshots,
            snapshotMetas: state.snapshotMetas,
        }));
    const { summaries } = usePortfolio();
    const stats = useStatistics();

    const taxIncomeCategoryIds = useMemo(
        () => new Set(configuredCategoryIds ?? []),
        [configuredCategoryIds],
    );

    const portfolioTaxFeeYears = useMemo(() => {
        const years = new Set<number>();
        for (const inv of summaries ?? []) {
            for (const txn of inv.transactions ?? []) {
                const hasTaxOrFee =
                    (Number(txn.taxes) || 0) > 0 ||
                    (Number(txn.fees) || 0) > 0 ||
                    txn.type === "tax" ||
                    txn.type === "fee";
                if (!hasTaxOrFee) continue;
                const y = yearFromIsoDate(txn.date);
                if (y != null) years.add(y);
            }
        }
        return years;
    }, [summaries]);

    const taxableIncomeYears = useMemo(() => {
        const years = new Set<number>();
        const pivot = stats.data?.categoryPivot ?? [];
        if (taxIncomeCategoryIds.size === 0) return years;
        for (const cat of pivot) {
            if (
                cat.categoryId == null ||
                !taxIncomeCategoryIds.has(cat.categoryId)
            )
                continue;
            for (const [period, amount] of Object.entries(cat.incomeMonths)) {
                if (amount <= 0) continue;
                const y = yearFromMonthKey(period);
                if (y != null) years.add(y);
            }
        }
        return years;
    }, [stats.data?.categoryPivot, taxIncomeCategoryIds]);

    return useMemo(() => {
        const snapshotYears = Object.keys(snapshots)
            .map((k) => Number(k))
            .filter(Number.isFinite);
        const metaYears = Object.keys(snapshotMetas)
            .map((k) => Number(k))
            .filter(Number.isFinite);
        const transactionYears = new Set<number>([
            ...portfolioTaxFeeYears,
            ...taxableIncomeYears,
        ]);
        const allYears = new Set<number>([
            currentYear,
            ...snapshotYears,
            ...metaYears,
            ...transactionYears,
        ]);

        return Array.from(allYears)
            .sort((a, b) => b - a)
            .map((year) => {
                const meta = snapshotMetas[year];
                return {
                    year,
                    isCurrent: year === currentYear,
                    hasSnapshot: Object.prototype.hasOwnProperty.call(
                        snapshots,
                        year,
                    ),
                    hasTransactions: transactionYears.has(year),
                    isFiled: !!meta?.filing,
                    hasFrozenCalculation: !!meta?.frozenCalculation,
                };
            });
    }, [
        currentYear,
        snapshots,
        snapshotMetas,
        portfolioTaxFeeYears,
        taxableIncomeYears,
    ]);
}
