import { getAggregationRecipientPivot, type RecipientPivotItem } from '@/lib/api/aggregations';
import type { SavedChart } from '@/lib/api/types';
import { usePivotQuery, type PivotConfig } from './usePivotQuery';

export type { RecipientPivotItem };

export interface RecipientPeriodData {
    recipientId: number;
    name: string;
    months: Record<string, number>;
}

const config: PivotConfig<RecipientPivotItem, RecipientPeriodData> = {
    kind: 'recipient-pivot',
    fetchPivot: async ({ currency, bucket, start, end, all, ids }) => {
        const res = await getAggregationRecipientPivot({
            currency,
            bucket,
            start_date: start,
            end_date: end,
            // Fetch only the chart's selected recipients instead of the full
            // all-recipients pivot the client then discarded. For an "all
            // recipients" chart, omit the list so the server returns every
            // recipient.
            recipient_ids: all ? undefined : ids,
        });
        return res.data?.recipientPivot ?? {};
    },
    getItemId: (item) => item.recipientId,
    initRow: (item) => ({ recipientId: item.recipientId, name: item.name, months: {} }),
    getRowId: (row) => row.recipientId,
};

export function useRecipientPivot(chart: SavedChart | null | undefined) {
    const { query, rows } = usePivotQuery(chart, !!chart?.all_recipients, chart?.recipient_ids, config);
    return { ...query, recipientData: rows };
}
