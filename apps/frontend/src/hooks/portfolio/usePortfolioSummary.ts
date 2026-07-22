/**
 * Realtime portfolio summary hook.
 *
 * Single source of truth for total portfolio value, invested capital, gains,
 * and per-investment summaries — all pre-converted to the requested target
 * currency by the backend. Replaces the previous frontend-side reduce loop
 * over usePortfolioSummaries which diverged from the performance page because
 * each surface applied its own FX conversion at its own moment in time.
 */

import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import { portfolioKeys } from '@/lib/queryKeys';
import type { PortfolioSummaryResponse } from '@/lib/api/info';

export function usePortfolioSummaryQuery(currency: string) {
  return useQuery<PortfolioSummaryResponse>({
    queryKey: portfolioKeys.summary(currency),
    queryFn: () => apiClient.getPortfolioSummary({ currency }),
    staleTime: 60_000,
    gcTime: 5 * 60_000,
  });
}
