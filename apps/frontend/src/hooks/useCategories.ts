import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {apiClient} from '@/lib/api';
import {categoryKeys} from '@/lib/queryKeys';
import {
    fetchCategoriesForExclusions,
    takeStartedCategoriesPreload,
} from '@/lib/categoriesPreload';
import type {CategoryCreate, CategoryUpdate} from '@/types/api';
import {toast} from 'sonner';
import { apiErrorToMessage } from '@/lib/api/errorMessage';
import {useLanguage} from '@/stores/hydration/LanguageHydration';
import {useBackgroundQueryCue} from '@/components/shared/BackgroundQueryIndicator';

export function useCategories(params?: {
    limit?: number;
    offset?: number;
    general?: string;
    detail?: string;
    active?: boolean;
    search?: string;
}) {
    const query = useQuery({
        queryKey: categoryKeys.list(params),
        queryFn: () => apiClient.getCategories(params),
        staleTime: 2 * 60_000, // categories rarely change - 2min stale
        placeholderData: (prev) => prev,
    });
    useBackgroundQueryCue(query.isFetching && query.isPlaceholderData);
    return query;
}

/**
 * The whole category list, as one cache entry shared by every consumer that
 * needs "all categories" rather than a paged/filtered slice.
 *
 * Two call sites used to fetch this list under two different keys
 * (`['categories','all']` for the Settings exclusion picker,
 * `['categories','all-for-exclusions']` for useExcludedIds), issuing the same
 * `getCategories({ limit: CATEGORY_FETCH_LIMIT })` request twice and keeping
 * two copies of the answer. One key means React Query dedupes the request and
 * each consumer derives its own shape from the shared `Category[]`.
 *
 * The query function adopts the boot preload (see lib/categoriesPreload) for
 * its first fetch — whichever consumer mounts first takes it — so refetches
 * after `staleTime` or a category mutation still hit the network.
 *
 * `enabled` lets a consumer read the shared entry without being the one that
 * triggers the fetch (useExcludedIds only needs it when hidden-category
 * exclusions are switched on).
 */
export function useAllCategories(enabled = true) {
    return useQuery({
        queryKey: categoryKeys.allList,
        queryFn: async () => {
            const preloaded = await takeStartedCategoriesPreload();
            return preloaded ?? (await fetchCategoriesForExclusions());
        },
        enabled,
        staleTime: 60_000,
    });
}

export function useCreateCategory() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    return useMutation({
        mutationFn: (category: CategoryCreate) => apiClient.createCategory(category),
        onSuccess: (data) => {
            queryClient.invalidateQueries({queryKey: categoryKeys.all});
            if (data.wasCreated) {
                toast.success(t('categories.created'));
            } else {
                toast.info(t('categories.exists'));
            }
        },
        onError: (error: Error) => {
            toast.error(t('categories.createFailedTitle'), { description: apiErrorToMessage(error, t) });
        },
    });
}

export function useUpdateCategory() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    return useMutation({
        mutationFn: ({id, data}: { id: number; data: CategoryUpdate }) =>
            apiClient.updateCategory(id, data),
        onSuccess: () => {
            queryClient.invalidateQueries({queryKey: categoryKeys.all});
            toast.success(t('categories.updated'));
        },
        onError: (error: Error) => {
            toast.error(t('categories.updateFailedTitle'), { description: apiErrorToMessage(error, t) });
        },
    });
}

export function useDeleteCategory() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    return useMutation({
        mutationFn: (id: number) => apiClient.deleteCategory(id),
        onSuccess: () => {
            queryClient.invalidateQueries({queryKey: categoryKeys.all});
        },
        onError: (error: Error) => {
            toast.error(t('categories.deleteFailedTitle'), { description: apiErrorToMessage(error, t) });
        },
    });
}
