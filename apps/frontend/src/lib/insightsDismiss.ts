/**
 * Client-side dismissal store for the AI-insights digest (Statistics page).
 *
 * Dismissals are a per-browser preference, so they live in localStorage (same
 * approach as RecurringDetectionPanel's dismissed patterns). Two record kinds,
 * mirroring the backend spec:
 *
 * - Subscription findings ({recipientId, findingType}) are suppressed
 *   PERMANENTLY — a dismissed "new subscription" or "price change" for a
 *   recipient never resurfaces (each findingType is dismissed independently).
 * - Category outliers ({categoryId, monthKey}) are suppressed for
 *   OUTLIER_SUPPRESSION_DAYS, UNLESS the finding worsens: a current deviation
 *   exceeding deviationAtDismiss + OUTLIER_REALERT_MARGIN re-alerts early.
 *
 * The cash forecast is a standing read, not a dismissible alert — filterDigest
 * passes it through untouched.
 *
 * All storage access is fault-tolerant: absent (SSR/node), disabled, or
 * malformed localStorage degrades to an empty dismiss state.
 */

import type {
    CashForecast,
    CategoryOutlier,
    InsightsDigestResponse,
    SubscriptionCreepNew,
    SubscriptionCreepPriceChange,
} from '@/lib/api/info';

export const DISMISSED_INSIGHTS_STORAGE_KEY = 'dismissed_insights_v1';

/** Days a dismissed category outlier stays hidden (mirrors the backend service). */
export const OUTLIER_SUPPRESSION_DAYS = 14;
/** Deviation increase past the dismissed value that re-alerts early (mirrors the backend service). */
export const OUTLIER_REALERT_MARGIN = 0.5;

const DAY_MS = 24 * 60 * 60 * 1000;

export type SubscriptionFindingType = 'new' | 'priceChange';

export interface SubscriptionDismissal {
    recipientId: number;
    findingType: SubscriptionFindingType;
}

export interface OutlierDismissal {
    categoryId: number;
    monthKey: string;
    /** ISO timestamp of the dismissal — starts the suppression window. */
    dismissedAt: string;
    /** Deviation at dismissal time — the re-alert baseline. */
    deviationAtDismiss: number;
}

export interface InsightsDismissState {
    subscriptions: SubscriptionDismissal[];
    outliers: OutlierDismissal[];
}

export interface FilteredDigest {
    newSubscriptions: SubscriptionCreepNew[];
    priceChanges: SubscriptionCreepPriceChange[];
    categoryOutliers: CategoryOutlier[];
    cashForecast: CashForecast | null;
}

function emptyState(): InsightsDismissState {
    return { subscriptions: [], outliers: [] };
}

function getStorage(): Storage | null {
    try {
        // globalThis: works in the browser and degrades to null in node-env tests.
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
}

function isSubscriptionDismissal(value: unknown): value is SubscriptionDismissal {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    return (
        typeof v.recipientId === 'number' &&
        (v.findingType === 'new' || v.findingType === 'priceChange')
    );
}

function isOutlierDismissal(value: unknown): value is OutlierDismissal {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    return (
        typeof v.categoryId === 'number' &&
        typeof v.monthKey === 'string' &&
        typeof v.dismissedAt === 'string' &&
        typeof v.deviationAtDismiss === 'number'
    );
}

/** Read the dismiss state from localStorage; malformed/absent storage → empty state. */
export function loadDismissState(): InsightsDismissState {
    try {
        const raw = getStorage()?.getItem(DISMISSED_INSIGHTS_STORAGE_KEY);
        if (!raw) return emptyState();
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null) return emptyState();
        const p = parsed as Record<string, unknown>;
        return {
            subscriptions: Array.isArray(p.subscriptions)
                ? p.subscriptions.filter(isSubscriptionDismissal)
                : [],
            outliers: Array.isArray(p.outliers)
                ? p.outliers.filter(isOutlierDismissal)
                : [],
        };
    } catch {
        // Malformed JSON or storage access denied — treat as nothing dismissed.
        return emptyState();
    }
}

function persist(state: InsightsDismissState): void {
    try {
        getStorage()?.setItem(DISMISSED_INSIGHTS_STORAGE_KEY, JSON.stringify(state));
    } catch {
        // Storage full/denied — dismissal still applies for this session via state.
    }
}

type DismissListener = (state: InsightsDismissState) => void;
const listeners = new Set<DismissListener>();

/**
 * Subscribe to dismissal changes made anywhere in this tab (panel → nav badge
 * sync; localStorage alone is not reactive). Returns an unsubscribe fn.
 */
export function subscribeToDismissals(listener: DismissListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function commit(state: InsightsDismissState): InsightsDismissState {
    persist(state);
    listeners.forEach((listener) => listener(state));
    return state;
}

/** Permanently dismiss one subscription finding (independent per findingType). */
export function dismissSubscription(
    recipientId: number,
    findingType: SubscriptionFindingType,
): InsightsDismissState {
    const state = loadDismissState();
    const already = state.subscriptions.some(
        (s) => s.recipientId === recipientId && s.findingType === findingType,
    );
    if (already) return commit(state);
    return commit({
        ...state,
        subscriptions: [...state.subscriptions, { recipientId, findingType }],
    });
}

/** Dismiss a category outlier for OUTLIER_SUPPRESSION_DAYS (re-alerts early if it worsens). */
export function dismissOutlier(outlier: CategoryOutlier, now: Date = new Date()): InsightsDismissState {
    const state = loadDismissState();
    const record: OutlierDismissal = {
        categoryId: outlier.categoryId,
        monthKey: outlier.monthKey,
        dismissedAt: now.toISOString(),
        deviationAtDismiss: outlier.deviation,
    };
    return commit({
        ...state,
        outliers: [
            ...state.outliers.filter(
                (o) => !(o.categoryId === outlier.categoryId && o.monthKey === outlier.monthKey),
            ),
            record,
        ],
    });
}

function isSubscriptionSuppressed(
    state: InsightsDismissState,
    recipientId: number,
    findingType: SubscriptionFindingType,
): boolean {
    return state.subscriptions.some(
        (s) => s.recipientId === recipientId && s.findingType === findingType,
    );
}

function isOutlierSuppressed(
    outlier: CategoryOutlier,
    state: InsightsDismissState,
    now: Date,
): boolean {
    const record = state.outliers.find(
        (o) => o.categoryId === outlier.categoryId && o.monthKey === outlier.monthKey,
    );
    if (!record) return false;
    // Worsened past the margin → re-alert regardless of the window.
    if (outlier.deviation > record.deviationAtDismiss + OUTLIER_REALERT_MARGIN) return false;
    const dismissedAt = Date.parse(record.dismissedAt);
    if (Number.isNaN(dismissedAt)) return false;
    return now.getTime() - dismissedAt < OUTLIER_SUPPRESSION_DAYS * DAY_MS;
}

/** The digest with dismissed findings removed. The cash forecast passes through untouched. */
export function filterDigest(
    digest: InsightsDigestResponse | undefined,
    state: InsightsDismissState,
    now: Date = new Date(),
): FilteredDigest {
    if (!digest) {
        return { newSubscriptions: [], priceChanges: [], categoryOutliers: [], cashForecast: null };
    }
    return {
        newSubscriptions: digest.subscriptionCreep.new.filter(
            (f) => !isSubscriptionSuppressed(state, f.recipientId, 'new'),
        ),
        priceChanges: digest.subscriptionCreep.priceChanges.filter(
            (f) => !isSubscriptionSuppressed(state, f.recipientId, 'priceChange'),
        ),
        categoryOutliers: digest.categoryOutliers.filter(
            (o) => !isOutlierSuppressed(o, state, now),
        ),
        cashForecast: digest.cashForecast,
    };
}

/**
 * Undismissed finding count for the nav badge: every visible subscription and
 * outlier row, plus 1 when the cash forecast demands attention ('alert').
 */
export function countUndismissed(
    digest: InsightsDigestResponse | undefined,
    state: InsightsDismissState,
    now: Date = new Date(),
): number {
    const filtered = filterDigest(digest, state, now);
    return (
        filtered.newSubscriptions.length +
        filtered.priceChanges.length +
        filtered.categoryOutliers.length +
        (filtered.cashForecast?.prominence === 'alert' ? 1 : 0)
    );
}
