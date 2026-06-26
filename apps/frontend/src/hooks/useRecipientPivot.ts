import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAppSettings } from '@/contexts/AppSettingsContext';
import { getAggregationRecipientPivot, type RecipientPivotItem } from '@/lib/api/aggregations';
import type { SavedChart } from '@/lib/api/types';

export type { RecipientPivotItem };

export interface RecipientPeriodData {
    recipientId: number;
    name: string;
    months: Record<string, number>;
}

function buildRecipientPeriodData(
    pivot: Record<string, RecipientPivotItem[]>
): RecipientPeriodData[] {
    const recipientMap: Record<number, RecipientPeriodData> = {};

    for (const [period, items] of Object.entries(pivot)) {
        for (const item of items) {
            if (!recipientMap[item.recipientId]) {
                recipientMap[item.recipientId] = {
                    recipientId: item.recipientId,
                    name: item.name,
                    months: {},
                };
            }
            recipientMap[item.recipientId].months[period] = item.total;
        }
    }

    return Object.values(recipientMap);
}

export function useRecipientPivot(chart: SavedChart | null | undefined) {
    const { appSettings } = useAppSettings();
    const targetCurrency = appSettings.defaultCurrency || 'EUR';

    const allRecipients = !!chart?.all_recipients;
    const enabled = !!(chart && (allRecipients || chart.recipient_ids.length > 0));

    const query = useQuery({
        queryKey: [
            'aggregations',
            'recipient-pivot',
            targetCurrency,
            chart?.time_bucket ?? 'monthly',
            chart?.date_range_start ?? null,
            chart?.date_range_end ?? null,
            // Narrowed per chart now, so the selected recipients MUST key the cache
            // (ADR-041 amendment) — else one chart's narrowed payload would be
            // served to a different chart with different recipients. The all flag
            // keys it too so the all-recipients payload isn't reused as a narrowed
            // one.
            allRecipients ? 'all' : (chart?.recipient_ids ?? []),
        ],
        queryFn: () =>
            getAggregationRecipientPivot({
                currency: targetCurrency,
                bucket: chart!.time_bucket,
                start: chart!.date_range_start ?? undefined,
                end: chart!.date_range_end ?? undefined,
                // Fetch only the chart's selected recipients instead of the full
                // all-recipients pivot the client then discarded. For an "all
                // recipients" chart, omit the list so the server returns every
                // recipient.
                recipient_ids: allRecipients ? undefined : chart!.recipient_ids,
            }),
        enabled,
        staleTime: 60_000,
    });

    const rawPivot = query.data?.data?.recipientPivot;
    const recipientIds = chart?.recipient_ids;

    // Filter to only the recipient IDs selected in the chart. Memoized so the
    // nested-loop reshape + filter only runs when the query data or selected
    // recipient ids actually change, not on every consumer render. An "all
    // recipients" chart keeps every returned recipient.
    const filtered = useMemo(() => {
        const recipientData = buildRecipientPeriodData(rawPivot ?? {});
        if (allRecipients) return recipientData;
        const selected = new Set(recipientIds ?? []);
        return recipientData.filter((r) => selected.has(r.recipientId));
    }, [rawPivot, recipientIds, allRecipients]);

    return { ...query, recipientData: filtered };
}
