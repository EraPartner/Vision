import { QUERY_STALE_TIME_MS } from "@/lib/queryPolicies";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import type { SavedChart } from "@/types/apiClient";
import { aggregationKeys } from "@/lib/queryKeys";

/**
 * Static (module-level) part of a pivot-hook configuration. Keeping it out of
 * the hook body keeps the reshape memo below stable across renders.
 */
export interface PivotConfig<
    Item extends { total: number },
    Row extends { months: Record<string, number> },
    Metadata = unknown,
> {
    /** Cache-key segment naming the pivot, e.g. 'recipient-pivot'. */
    kind: string;
    /**
     * Fetch the pivot narrowed to the chart's selection. Receives the "all"
     * flag so variants whose API takes an explicit `all` param (tags) and
     * variants that just omit the id list (recipients) both fit.
     */
    fetchPivot: (params: {
        currency: string;
        bucket: SavedChart["time_bucket"];
        start?: string;
        end?: string;
        all: boolean;
        ids: number[];
    }) => Promise<{
        pivot: Record<string, Item[]>;
        metadata?: Metadata;
    }>;
    getItemId: (item: Item) => number;
    /** Build an output row for an item; `months` is filled by the shared reshape. */
    initRow: (item: Item) => Row;
    getRowId: (row: Row) => number;
}

function buildPeriodData<
    Item extends { total: number },
    Row extends { months: Record<string, number> },
>(
    pivot: Record<string, Item[]>,
    { getItemId, initRow }: PivotConfig<Item, Row>,
): Row[] {
    const map: Record<number, Row> = {};

    for (const [period, items] of Object.entries(pivot)) {
        for (const item of items) {
            const id = getItemId(item);
            if (!map[id]) {
                map[id] = initRow(item);
            }
            map[id].months[period] = item.total;
        }
    }

    return Object.values(map);
}

/**
 * Shared engine behind useRecipientPivot/useTagPivot: an online cache-keyed
 * query for a period-bucketed pivot plus the memoized reshape/filter to
 * per-entity rows.
 */
export function usePivotQuery<
    Item extends { total: number },
    Row extends { months: Record<string, number> },
    Metadata = unknown,
>(
    chart: SavedChart | null | undefined,
    /** Whether the chart selects every entity of this dimension. */
    all: boolean,
    /** The chart's explicitly selected entity ids for this dimension. */
    ids: number[] | undefined,
    config: PivotConfig<Item, Row, Metadata>,
) {
    const { appSettings } = useAppSettings();
    const targetCurrency = appSettings.defaultCurrency || "EUR";

    const enabled = !!(chart && (all || (ids?.length ?? 0) > 0));

    const query = useQuery({
        // The selected entities MUST key the cache (ADR-041 amendment) — see
        // aggregationKeys.pivot.
        queryKey: aggregationKeys.pivot(
            config.kind,
            targetCurrency,
            chart?.time_bucket ?? "monthly",
            chart?.date_range_start ?? null,
            chart?.date_range_end ?? null,
            all ? "all" : (ids ?? []),
        ),
        queryFn: () =>
            config.fetchPivot({
                currency: targetCurrency,
                bucket: chart!.time_bucket,
                start: chart!.date_range_start ?? undefined,
                end: chart!.date_range_end ?? undefined,
                all,
                ids: ids ?? [],
            }),
        enabled,
        staleTime: QUERY_STALE_TIME_MS.STANDARD,
    });

    const rawPivot = query.data?.pivot;

    // Filter to only the ids selected in the chart. Memoized so the
    // nested-loop reshape + filter only runs when the query data or selection
    // actually change, not on every consumer render. An "all entities" chart
    // keeps every returned row.
    const rows = useMemo(() => {
        const data = buildPeriodData(rawPivot ?? {}, config);
        if (all) return data;
        const selected = new Set(ids ?? []);
        return data.filter((row) => selected.has(config.getRowId(row)));
    }, [rawPivot, ids, all, config]);

    return { query, rows, metadata: query.data?.metadata };
}
