import { useQuery } from '@tanstack/react-query';
import { useSettings } from '@/contexts/SettingsContext';
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
    const { settings } = useSettings();
    const targetCurrency = settings?.currency ?? 'EUR';

    const enabled = !!(chart && chart.recipient_ids.length > 0);

    const query = useQuery({
        queryKey: [
            'aggregations',
            'recipient-pivot',
            targetCurrency,
            chart?.time_bucket ?? 'monthly',
            chart?.date_range_start ?? null,
            chart?.date_range_end ?? null,
        ],
        queryFn: () =>
            getAggregationRecipientPivot({
                currency: targetCurrency,
                bucket: chart!.time_bucket,
                start: chart!.date_range_start ?? undefined,
                end: chart!.date_range_end ?? undefined,
            }),
        enabled,
        staleTime: 60_000,
    });

    const rawPivot = query.data?.data?.recipientPivot ?? {};
    const recipientData = buildRecipientPeriodData(rawPivot);

    // Filter to only the recipient IDs selected in the chart
    const selected = new Set(chart?.recipient_ids ?? []);
    const filtered = recipientData.filter((r) => selected.has(r.recipientId));

    return { ...query, recipientData: filtered };
}
