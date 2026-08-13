import { useCallback } from "react";
import { useSearchParams } from "react-router";

/**
 * Binds a page-level `<Tabs>` to a URL search param so the active tab survives
 * reload/Back and can be shared or bookmarked.
 *
 * Uncontrolled `<Tabs defaultValue>` loses the tab on every remount: drilling
 * from Statistics -> Categories into a transaction and pressing Back used to
 * land on Overview, discarding the user's analysis context.
 *
 * Writes use `{ replace: true }` (same as the `forecastMode`/`rollingDays`
 * pattern in `features/dashboard/CashFlowForecastChart.tsx`) so flipping
 * through tabs does not push an entry per click onto the history stack — Back
 * still leaves the page rather than walking back through every tab visited.
 *
 * Unknown or absent param values fall back to `defaultTab`, so a hand-edited or
 * stale URL renders the default tab instead of an empty panel.
 */
export function useTabParam<T extends string>(
    tabs: readonly T[],
    defaultTab: T,
    paramKey = "tab",
): [T, (value: string) => void] {
    const [searchParams, setSearchParams] = useSearchParams();

    const raw = searchParams.get(paramKey);
    const active = (tabs as readonly string[]).includes(raw ?? "") ? (raw as T) : defaultTab;

    const setActive = useCallback(
        (value: string) => {
            setSearchParams(
                (prev) => {
                    const next = new URLSearchParams(prev);
                    next.set(paramKey, value);
                    return next;
                },
                { replace: true },
            );
        },
        [setSearchParams, paramKey],
    );

    return [active, setActive];
}
