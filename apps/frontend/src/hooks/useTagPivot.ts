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

    const enabled = !!(chart && chart.tag_ids.length > 0);

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
            // (mirrors the recipient-pivot cache key, ADR-041 amendment).
            chart?.tag_ids ?? [],
        ],
        queryFn: () =>
            getAggregationTagPivot({
                currency: targetCurrency,
                bucket: chart!.time_bucket,
                start: chart!.date_range_start ?? undefined,
                end: chart!.date_range_end ?? undefined,
                tag_ids: chart!.tag_ids,
            }),
        enabled,
        staleTime: 60_000,
    });

    const rawPivot = query.data?.data?.tagPivot;
    const tagIds = chart?.tag_ids;

    const filtered = useMemo(() => {
        const tagData = buildTagPeriodData(rawPivot ?? {});
        const selected = new Set(tagIds ?? []);
        return tagData.filter((tg) => selected.has(tg.tagId));
    }, [rawPivot, tagIds]);

    return { ...query, tagData: filtered };
}
