/**
 * Insights digest (detection layer, no LLM) for the Statistics page.
 *
 * Shared react-query wrapper around GET /api/info/insights-digest so the
 * Statistics panel and any badge reading the counts hit one cache entry.
 * The API client fails soft to an empty digest, so consumers never need an
 * error branch — an outage just renders as "no findings".
 */

import { useQuery } from '@tanstack/react-query';
import { getInsightsDigest, type InsightsDigestResponse } from '@/lib/api/info';
import { insightsKeys } from '@/lib/queryKeys';

export function useInsightsDigest() {
  return useQuery<InsightsDigestResponse>({
    queryKey: insightsKeys.digest,
    queryFn: getInsightsDigest,
    // 3 min: fresh enough for a per-visit digest, long enough that a badge
    // mounted elsewhere doesn't refetch on every navigation.
    staleTime: 3 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
