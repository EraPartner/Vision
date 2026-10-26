import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { taxKeys } from "@/lib/queryKeys";
import { computeBelgianTax } from "@/lib/api/belgianTax";
import { useBelgianTaxProfile } from "@/contexts/BelgianTaxProfileContext";
import { useBackgroundQueryCue } from "@/components/shared/BackgroundQueryIndicator";
import { resolveBelgianTaxHousehold } from "@/stores/belgianTaxStore";
import { EMPTY_BELGIAN_TAX_CALCULATION } from "@/lib/belgianTax/emptyCalculation";
import type { BelgianTaxCalculation } from "@/lib/belgianTax/types";
import type {
    BelgianTaxHouseholdV2,
    HouseholdTaxResult,
} from "@/lib/belgianTax/householdTypes";

/** Quiet period after the last household edit before the server computes it. */
export const TAX_COMPUTE_DEBOUNCE_MS = 300;

/**
 * The household, settled for `delay` ms after its last content change. A different tax year
 * (or the first household) passes through at once, so switching years never waits.
 */
function useSettledHousehold(
    household: BelgianTaxHouseholdV2 | null,
    delay: number,
): BelgianTaxHouseholdV2 | null {
    const [settled, setSettled] = useState(household);
    const latest = useRef(household);
    latest.current = household;
    const contentKey = household ? JSON.stringify(household) : "";
    const immediate =
        !household || !settled || household.taxYear !== settled.taxYear;
    useEffect(() => {
        if (immediate) {
            setSettled(latest.current);
            return;
        }
        const timer = setTimeout(() => setSettled(latest.current), delay);
        return () => clearTimeout(timer);
    }, [contentKey, immediate, delay]);
    return immediate ? household : settled;
}

const yearOfKey = (queryKey: readonly unknown[] | undefined) =>
    (queryKey?.[2] as BelgianTaxHouseholdV2 | undefined)?.taxYear;

/**
 * Server computation of a household (POST /api/belgian-tax/compute), debounced while it is
 * being edited. One cache entry per household content: a response for an older edit never
 * replaces the current one, and a superseded request is aborted. While a new edit computes,
 * the previous figures of the same tax year stay on screen. The household the overview
 * hydrated reuses the figures it came with.
 */
export function useHouseholdComputation(
    household: BelgianTaxHouseholdV2 | null,
) {
    const settled = useSettledHousehold(household, TAX_COMPUTE_DEBOUNCE_MS);
    const seed = useBelgianTaxProfile((state) => state.hydratedComputation);
    const year = settled?.taxYear;
    const query = useQuery({
        queryKey: taxKeys.compute(settled),
        queryFn: ({ signal }) =>
            computeBelgianTax(settled as BelgianTaxHouseholdV2, signal),
        enabled: settled != null,
        staleTime: Infinity,
        retry: 1,
        initialData:
            seed && settled && seed.household === settled
                ? seed.computation
                : undefined,
        placeholderData: (previous, previousQuery) =>
            yearOfKey(previousQuery?.queryKey) === year ? previous : undefined,
    });
    useBackgroundQueryCue(query.isFetching && query.isPlaceholderData);
    return query;
}

export interface TaxYearFiguresView {
    /** PIT figures of the year; all zero until the first server figures arrive. */
    calculation: BelgianTaxCalculation;
    /** Household result; `null` for a year frozen before results were stored, or until computed. */
    householdResult: HouseholdTaxResult | null;
    /** No figures yet for this year. */
    isPending: boolean;
    /** The server is computing newer figures than the ones shown. */
    isComputing: boolean;
    /** The last computation failed. */
    error: Error | null;
}

/**
 * Figures shown for `year`: the frozen ones when the year is frozen (ADR-059, never a
 * recompute), else the server's computation of the year's household (the live one, its
 * snapshot, or the live one moved to that year), following edits as they are made.
 */
export function useTaxYearFigures(year: number): TaxYearFiguresView {
    const { household, householdSnapshots, meta } = useBelgianTaxProfile(
        (state) => ({
            household: state.household,
            householdSnapshots: state.householdSnapshots,
            meta: state.snapshotMetas[year],
        }),
    );
    const frozenCalculation = meta?.frozenCalculation;
    const yearHousehold = useMemo(
        () =>
            frozenCalculation
                ? null
                : resolveBelgianTaxHousehold(
                      { household, householdSnapshots },
                      year,
                  ),
        [frozenCalculation, household, householdSnapshots, year],
    );
    const query = useHouseholdComputation(yearHousehold);
    if (frozenCalculation)
        return {
            calculation: frozenCalculation,
            householdResult: meta.frozenHouseholdResult ?? null,
            isPending: false,
            isComputing: false,
            error: null,
        };
    const data = query.data;
    return {
        calculation: data?.calculation ?? EMPTY_BELGIAN_TAX_CALCULATION,
        householdResult: data?.result ?? null,
        isPending: data === undefined,
        isComputing: query.isFetching || query.isPlaceholderData,
        error: query.error,
    };
}
