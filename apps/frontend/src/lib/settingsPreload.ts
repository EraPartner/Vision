/**
 * Settings preload kickoff.
 *
 * `GET /api/settings` gates the first dashboard data render (the settings hydrate
 * before the excluded-category / dashboard-stats queries can run). When the fetch
 * fired only from a post-mount effect, it couldn't start until the whole boot
 * graph had parsed, executed, and React had mounted — each an unavoidable serial
 * hop. Starting it at module scope from `main.tsx` lets the round trip overlap
 * the remaining JS execution + mount instead of following it.
 *
 * `SettingsPreloadProvider` awaits the same shared promise, so no duplicate
 * request is made. If the preload was never started (e.g. in unit tests that
 * render the provider directly), the provider transparently starts it on mount —
 * identical to the previous behaviour, just not earlier.
 */
import { apiClient } from '@/lib/api';

let preloadPromise: Promise<unknown> | null = null;

/** Begin the settings fetch (idempotent). Call as early as possible at boot. */
export function startSettingsPreload(): Promise<unknown> {
    if (!preloadPromise) {
        preloadPromise = apiClient.getSettings();
    }
    return preloadPromise;
}

/**
 * The in-flight/resolved preload promise if one was started, else `null`.
 * The provider prefers it when present (so the boot fetch is shared, not
 * duplicated) and otherwise fetches itself — the latter is the path unit tests
 * take, since they never call `startSettingsPreload()`.
 */
export function getStartedSettingsPreload(): Promise<unknown> | null {
    return preloadPromise;
}
