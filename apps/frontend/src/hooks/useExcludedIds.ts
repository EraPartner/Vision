import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { categoryKeys } from '@/lib/queryKeys';
import {
  CATEGORY_FETCH_LIMIT,
  fetchCategoriesForExclusions,
  takeStartedCategoriesPreload,
} from '@/lib/categoriesPreload';
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
// divergence) and the cap is logged rather than silently truncating. Defined in
// lib/categoriesPreload (which owns the request, so boot and hook issue exactly
// the same one); re-exported here, where it has always lived for consumers.
export { CATEGORY_FETCH_LIMIT };

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
  const { settings, isLoading: settingsLoading } = useSettings();

  const exclusionsApply =
    settings.exclusionScope === 'everywhere' || settings.exclusionScope === scope;

  // Only fetch the category list when hidden-category resolution is actually needed.
  const needsHidden = exclusionsApply && settings.excludeHiddenCategories;

  const categoriesQuery = useQuery({
    queryKey: categoryKeys.allForExclusions,
    queryFn: async () => {
      // The boot preload (main.tsx) has this request in flight — or already
      // answered — before React mounts. Adopt it for the first fetch; it is
      // taken once, so every later refetch goes to the network.
      const preloaded = await takeStartedCategoriesPreload();
      return preloaded ?? (await fetchCategoriesForExclusions());
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

  // Ready when settings are the user's own (not the store defaults) AND the
  // category fetch either isn't needed or has resolved.
  //
  // The settings half matters for money, not latency: until hydration lands,
  // `settings.excluded*Ids` are the empty defaults, so an exclusion set resolved
  // now can be missing categories the user actually excludes. Consumers embed
  // these arrays in their query keys, so such a fetch is not merely early — it
  // lands under a *different* key and renders totals that look final until
  // hydration swaps the key and refetches. Both preloads start at module scope,
  // so waiting for settings costs no round trip on the critical path; it just
  // stops the first paint of a number from being computed with the wrong set.
  const isReady = !settingsLoading && (!needsHidden || categoriesQuery.isSuccess);

  return { excludedCategoryIds, excludedRecipientIds, exclusionsApply, isReady };
}
