import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api";
import { importKeys } from "@/lib/queryKeys";
import { useBackgroundQueryCue } from "@/components/shared/BackgroundQueryIndicator";

const PAGE_SIZE = 10;

export function useImportBatches(offset: number) {
    const query = useQuery({
        queryKey: importKeys.batches(offset),
        queryFn: () => apiClient.listImportBatches(PAGE_SIZE, offset),
        placeholderData: keepPreviousData,
    });
    useBackgroundQueryCue(query.isFetching && query.isPlaceholderData);
    return query;
}
