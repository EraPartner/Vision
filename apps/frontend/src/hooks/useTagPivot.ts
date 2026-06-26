import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAppSettings } from '@/contexts/AppSettingsContext';
import { getAggregationTagPivot, type TagPivotItem } from '@/lib/api/aggregations';
import type { SavedChart } from '@/lib/api/types';

export type { TagPivotItem };

export interface TagPeriodData {
    tagId: number;
    slug: string;
    months: Record<string, number>;
}

function buildTagPeriodData(
    pivot: Record<string, TagPivotItem[]>
): TagPeriodData[] {
    const tagMap: Record<number, TagPeriodData> = {};

    for (const [period, items] of Object.entries(pivot)) {
        for (const item of items) {
            if (!tagMap[item.tagId]) {
                tagMap[item.tagId] = {
                    tagId: item.tagId,
                    slug: item.slug,
                    months: {},
                };
            }
            tagMap[item.tagId].months[period] = item.total;
        }
    }

    return Object.values(tagMap);
}

export function useTagPivot(chart: SavedChart | null | undefined) {
    const { appSettings } = useAppSettings();
    const targetCurrency = appSettings.defaultCurrency || 'EUR';

    const allTags = !!chart?.all_tags;
    const enabled = !!(chart && (allTags || chart.tag_ids.length > 0));

    const query = useQuery({
        queryKey: [
            'aggregations',
            'tag-pivot',
            targetCurrency,
            chart?.time_bucket ?? 'monthly',
            chart?.date_range_start ?? null,
            chart?.date_range_end ?? null,
            // Narrowed per chart — the selected tags MUST key the cache so one
            // chart's payload isn't served to another with a different selection
            // (mirrors the recipient-pivot cache key, ADR-041 amendment). The
            // all-tags flag keys it too so an "all" chart and a narrowed chart
            // don't share an entry.
            allTags ? 'all' : (chart?.tag_ids ?? []),
        ],
        queryFn: () =>
            getAggregationTagPivot({
                currency: targetCurrency,
                bucket: chart!.time_bucket,
                start: chart!.date_range_start ?? undefined,
                end: chart!.date_range_end ?? undefined,
                all: allTags,
                tag_ids: allTags ? undefined : chart!.tag_ids,
            }),
        enabled,
        staleTime: 60_000,
    });

    const rawPivot = query.data?.data?.tagPivot;
    const tagIds = chart?.tag_ids;

    const filtered = useMemo(() => {
        const tagData = buildTagPeriodData(rawPivot ?? {});
        // "all tags" charts every returned tag; a narrowed chart keeps only its
        // explicit selection.
        if (allTags) return tagData;
        const selected = new Set(tagIds ?? []);
        return tagData.filter((tg) => selected.has(tg.tagId));
    }, [rawPivot, tagIds, allTags]);

    return { ...query, tagData: filtered };
}
