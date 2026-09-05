import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router";
import { useBelgianTaxProfile } from "@/contexts/BelgianTaxProfileContext";

/** Oldest income year a `?year=` param may address, relative to the live year. */
const MAX_YEARS_BACK = 30;

function parseYearParam(raw: string | null): number | undefined {
    if (!raw || !/^\d{4}$/.test(raw)) return undefined;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Mirrors the tax provider's `viewedYear` into a `?year=` search param.
 *
 * `viewedYear` is transient provider state, so reloading `/tax` or
 * `/portfolio/tax` while reviewing a historical year silently snapped back to
 * the live year — easy to miss behind the historical banner, and the figures
 * differ. Mounting this hook on those two routes makes the viewed year
 * survive reload and makes "taxes 2023" shareable/bookmarkable.
 *
 * Route-scoped on purpose: the provider itself wraps the whole app, so syncing
 * there would write `?year=` onto every unrelated route.
 *
 * Adoption runs once, after the provider has loaded its profile and snapshots.
 * A year is accepted when it has a stored snapshot, is the live year, or falls
 * within a sane window around the live year — the switcher itself allows
 * viewing years with no snapshot yet (it offers to create one), so membership
 * in the available-years list is a preference, not a requirement. Validating
 * against snapshots + range rather than the full `useAvailableTaxYears()` list
 * also avoids a race: the portfolio/statistics-derived years in that list
 * arrive asynchronously and would bounce a legitimate deep link to the live
 * year before the data landed. Anything else falls back to the live year.
 */
export function useTaxYearParam(): void {
    const [searchParams, setSearchParams] = useSearchParams();
    const {
        viewedYear,
        setViewedYear,
        liveYear,
        snapshotExistsForYear,
        isLoading,
    } = useBelgianTaxProfile((state) => ({
        viewedYear: state.viewedYear,
        setViewedYear: state.setViewedYear,
        liveYear: state.profile.taxYear,
        snapshotExistsForYear: state.snapshotExistsForYear,
        isLoading: state.isLoading,
    }));

    const hasAdopted = useRef(false);
    // Year handed to `setViewedYear` that the provider has not reported back
    // yet. Both effects run in the same commit, so without this the mirror
    // would see the pre-adoption `viewedYear` and overwrite the incoming
    // `?year=` with the live year before the adoption landed.
    const pendingYear = useRef<number | undefined>(undefined);

    const paramYear = parseYearParam(searchParams.get("year"));
    useEffect(() => {
        if (hasAdopted.current || isLoading) return;
        hasAdopted.current = true;
        if (paramYear === undefined) return;
        const isValid =
            snapshotExistsForYear(paramYear) ||
            (paramYear >= liveYear - MAX_YEARS_BACK &&
                paramYear <= liveYear + 1);
        if (isValid && paramYear !== viewedYear) {
            pendingYear.current = paramYear;
            setViewedYear(paramYear);
        }
        // Invalid years fall through: the mirror effect below rewrites the
        // param to whatever year is actually being viewed (the live year).
    }, [
        isLoading,
        paramYear,
        liveYear,
        viewedYear,
        setViewedYear,
        snapshotExistsForYear,
    ]);

    useEffect(() => {
        // Hold the URL steady until adoption has run, otherwise the live-year
        // default would overwrite the incoming `?year=` before it is read.
        if (!hasAdopted.current) return;
        if (pendingYear.current !== undefined) {
            if (viewedYear !== pendingYear.current) return;
            pendingYear.current = undefined;
        }
        if (paramYear === viewedYear) return;
        setSearchParams(
            (prev) => {
                const next = new URLSearchParams(prev);
                next.set("year", String(viewedYear));
                return next;
            },
            { replace: true },
        );
    }, [viewedYear, paramYear, setSearchParams]);
}
