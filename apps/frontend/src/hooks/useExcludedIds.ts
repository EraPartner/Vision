import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import { useSettings } from '@/contexts/SettingsContext';

/**
 * Single source of truth for "which category/recipient IDs are excluded from
 * money totals" on the dashboard and statistics surfaces.
 *
 * Previously this resolution was reimplemented in three places
 * (useFilteredDashboardStats, useStatistics, DashboardPage), each fetching the
 * full category list under a different cache key and — critically — a different
 * `limit` (500 vs 1000). A user with >500 categories therefore got a *different*
 * hidden-category set on Statistics vs the Dashboard, silently producing
 * different income/spending/net totals across screens. Centralizing the fetch
 * (one key, one limit) makes the exclusion set identical everywhere.
 */

// One limit for the whole app. Categories rarely number in the hundreds; if a
// deployment ever exceeds this, the fetch is uniform across screens (no per-screen
// divergence) and the cap is logged below rather than silently truncating.
export const CATEGORY_FETCH_LIMIT = 1000;

export type ExclusionScopeName = 'dashboard' | 'statistics';

export interface ExcludedIds {
  /** Settings exclusions + hidden categories, de-duplicated and sorted ascending. */
  excludedCategoryIds: number[];
  /** Settings recipient exclusions, sorted ascending. */
  excludedRecipientIds: number[];
  /** Whether exclusions apply to this scope at all (per settings.exclusionScope). */
  exclusionsApply: boolean;
  /** True once the data needed to resolve exclusions is available (or not needed). */
  isReady: boolean;
}

const EMPTY: number[] = [];

export function useExcludedIds(scope: ExclusionScopeName): ExcludedIds {
  const { settings } = useSettings();

  const exclusionsApply =
    settings.exclusionScope === 'everywhere' || settings.exclusionScope === scope;

  // Only fetch the category list when hidden-category resolution is actually needed.
  const needsHidden = exclusionsApply && settings.excludeHiddenCategories;

  const categoriesQuery = useQuery({
    queryKey: ['categories', 'all-for-exclusions'],
    queryFn: async () => {
      const res = await apiClient.getCategories({ limit: CATEGORY_FETCH_LIMIT });
      if (res.items.length >= CATEGORY_FETCH_LIMIT) {
        // Uniform across screens, but flag the (unlikely) truncation rather than hide it.
        console.warn(
          `useExcludedIds: category list hit the ${CATEGORY_FETCH_LIMIT} fetch cap; hidden-category exclusions may be incomplete.`,
        );
      }
      return res.items;
    },
    enabled: needsHidden,
    staleTime: 60_000,
  });

  const hiddenCategoryIds = useMemo(() => {
    if (!needsHidden || !categoriesQuery.data) return EMPTY;
    return categoriesQuery.data.filter((cat) => !cat.is_active).map((cat) => cat.id);
  }, [needsHidden, categoriesQuery.data]);

  const excludedCategoryIds = useMemo(() => {
    if (!exclusionsApply) return EMPTY;
    return [...new Set([...settings.excludedCategoryIds, ...hiddenCategoryIds])].sort((a, b) => a - b);
  }, [exclusionsApply, settings.excludedCategoryIds, hiddenCategoryIds]);

  const excludedRecipientIds = useMemo(() => {
    if (!exclusionsApply) return EMPTY;
    return [...settings.excludedRecipientIds].sort((a, b) => a - b);
  }, [exclusionsApply, settings.excludedRecipientIds]);

  // Ready when the category fetch isn't needed, or it has resolved.
  const isReady = !needsHidden || categoriesQuery.isSuccess;

  return { excludedCategoryIds, excludedRecipientIds, exclusionsApply, isReady };
}
