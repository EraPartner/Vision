import { useEffect, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { useAppSettings } from "@/contexts/AppSettingsContext";

const PREFETCH_STALE_TIME = 300_000; // 5min – match backend cache TTL

/**
 * Prefetches heavy portfolio endpoints (net-worth, portfolio-performance)
 * so they are warm when the user navigates to those pages.
 *
 * - On mount: kicks off both fetches **immediately** (no workspace gate).
 * - Exposes `prefetchNetWorth` / `prefetchPerformance` for hover-triggered warming.
 */
export function usePortfolioPrefetch(_workspace?: string) {
  const queryClient = useQueryClient();
  const { appSettings } = useAppSettings();
  const currency = appSettings.defaultCurrency || "EUR";

  const prefetchNetWorth = useCallback(() => {
    queryClient.prefetchQuery({
      queryKey: ["net-worth", currency],
      queryFn: () => apiClient.getNetWorth({ currency }),
      staleTime: PREFETCH_STALE_TIME,
    });
  }, [queryClient, currency]);

  const prefetchPerformance = useCallback(() => {
    queryClient.prefetchQuery({
      queryKey: ["portfolio-performance", currency],
      queryFn: () => apiClient.getPortfolioPerformance({ currency }),
      staleTime: PREFETCH_STALE_TIME,
    });
  }, [queryClient, currency]);

  // Fire both prefetches immediately on mount – no delay, no workspace check.
  // The backend warms these caches on startup so the response should be instant.
  useEffect(() => {
    prefetchNetWorth();
    prefetchPerformance();
  }, [prefetchNetWorth, prefetchPerformance]);

  return { prefetchNetWorth, prefetchPerformance };
}
