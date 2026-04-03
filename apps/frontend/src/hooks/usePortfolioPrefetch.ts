import { useEffect, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { useAppSettings } from "@/contexts/AppSettingsContext";

const PREFETCH_STALE_TIME = 120_000; // 2min - don't re-prefetch if already cached

/**
 * Prefetches heavy portfolio endpoints (net-worth, portfolio-performance)
 * so they are warm when the user navigates to those pages.
 *
 * - On mount (when workspace = portfolio): kicks off both fetches immediately.
 * - Exposes `prefetchNetWorth` / `prefetchPerformance` for hover-triggered warming.
 */
export function usePortfolioPrefetch(workspace: string) {
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

  // Eagerly prefetch when entering the portfolio workspace
  useEffect(() => {
    if (workspace !== "portfolio") return;
    // Small delay to let critical UI settle first
    const timer = setTimeout(() => {
      prefetchNetWorth();
      prefetchPerformance();
    }, 300);
    return () => clearTimeout(timer);
  }, [workspace, prefetchNetWorth, prefetchPerformance]);

  return { prefetchNetWorth, prefetchPerformance };
}
