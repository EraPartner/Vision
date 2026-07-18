import { getAggregationTagPivot, type TagPivotItem } from '@/lib/api/aggregations';
import type { SavedChart } from '@/lib/api/types';
import { usePivotQuery, type PivotConfig } from './usePivotQuery';

export type { TagPivotItem };

export interface TagPeriodData {
    tagId: number;
    slug: string;
    months: Record<string, number>;
}

const config: PivotConfig<TagPivotItem, TagPeriodData> = {
    kind: 'tag-pivot',
    fetchPivot: async ({ currency, bucket, start, end, all, ids }) => {
        const res = await getAggregationTagPivot({
            currency,
            bucket,
            start,
            end,
            // The tag endpoint takes an explicit all flag (unlike the recipient
            // one, where omitting the id list means "all").
            all,
            tag_ids: all ? undefined : ids,
        });
        return res.data?.tagPivot ?? {};
    },
    getItemId: (item) => item.tagId,
    initRow: (item) => ({ tagId: item.tagId, slug: item.slug, months: {} }),
    getRowId: (row) => row.tagId,
};

export function useTagPivot(chart: SavedChart | null | undefined) {
    const { query, rows } = usePivotQuery(chart, !!chart?.all_tags, chart?.tag_ids, config);
    return { ...query, tagData: rows };
}
