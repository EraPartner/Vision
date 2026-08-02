/**
 * Hidden-category list preload kickoff.
 *
 * Sibling of `lib/settingsPreload.ts`, for the same reason. The dashboard's
 * money queries are gated on `useExcludedIds`, which needs the category list to
 * know which categories are hidden — and `excludeHiddenCategories` defaults to
 * ON, so this fetch happens on essentially every boot. Fired from the hook's
 * `useQuery`, it could not start until the whole boot graph had parsed, executed
 * and React had mounted, putting a full round trip *after* the JS window instead
 * of inside it; the aggregation request then queued behind it.
 *
 * Starting it at module scope from `main.tsx` overlaps the round trip with the
 * remaining JS execution + mount, alongside (not behind) the settings preload.
 * `useExcludedIds` consumes the same promise, so no duplicate request is made.
 *
 * The promise is *taken* (cleared) by the first consumer: it seeds React Query's
 * first fetch only. Later refetches — after `staleTime`, or after a category
 * mutation invalidates the key — must hit the network, never replay a stale boot
 * response.
 */
import { apiClient } from '@/lib/api';
import type { Category } from '@/types/api';

// One limit for the whole app — see useExcludedIds for why this is uniform
// across every screen that resolves exclusions.
export const CATEGORY_FETCH_LIMIT = 1000;

/** Fetches the exclusion-resolution category list (single definition of the request). */
export async function fetchCategoriesForExclusions(): Promise<Category[]> {
    const res = await apiClient.getCategories({ limit: CATEGORY_FETCH_LIMIT });
    if (res.items.length >= CATEGORY_FETCH_LIMIT) {
        // Uniform across screens, but flag the (unlikely) truncation rather than hide it.
        console.warn(
            `useExcludedIds: category list hit the ${CATEGORY_FETCH_LIMIT} fetch cap; hidden-category exclusions may be incomplete.`,
        );
    }
    return res.items;
}

/**
 * Settled result: the stored promise must never reject on its own. Nothing is
 * attached to it at module scope, and when `excludeHiddenCategories` is off no
 * consumer ever takes it — a raw rejected promise would surface as an unhandled
 * rejection on every backend-down boot.
 */
type PreloadResult = { ok: true; items: Category[] } | { ok: false };

let preloadPromise: Promise<PreloadResult> | null = null;

/** Begin the category fetch (idempotent). Call as early as possible at boot. */
export function startCategoriesPreload(): Promise<PreloadResult> {
    if (!preloadPromise) {
        preloadPromise = fetchCategoriesForExclusions().then(
            (items) => ({ ok: true, items }) as const,
            // A boot-time failure (backend still coming up behind the splash) is
            // not final: the consumer retries on the live network path below.
            () => ({ ok: false }) as const,
        );
    }
    return preloadPromise;
}

/**
 * The boot preload's categories, or `null` if none was started or it was already
 * consumed. Clearing on read keeps the preload to exactly one fetch's worth of
 * data, so refetches are real refetches.
 */
export async function takeStartedCategoriesPreload(): Promise<Category[] | null> {
    const pending = preloadPromise;
    if (!pending) return null;
    preloadPromise = null;
    const result = await pending;
    return result.ok ? result.items : null;
}

/** Test-only: forget any started preload. */
export function resetCategoriesPreloadForTests(): void {
    preloadPromise = null;
}
