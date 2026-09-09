/**
 * Minimal browser-store boundary retained while legacy insight dismissals are
 * migrated to the backend. Unrelated client-side dismissal behavior has been
 * retired; the migration gate is the only production consumer.
 */

export const DISMISSED_INSIGHTS_STORAGE_KEY = "dismissed_insights_v1";

interface SubscriptionDismissal {
    recipientId: number;
    findingType: "new" | "priceChange";
}

interface OutlierDismissal {
    categoryId: number;
    monthKey: string;
    dismissedAt: string;
    deviationAtDismiss: number;
}

export interface InsightsDismissState {
    subscriptions: SubscriptionDismissal[];
    outliers: OutlierDismissal[];
}

function emptyState(): InsightsDismissState {
    return { subscriptions: [], outliers: [] };
}

function getStorage(): Storage | null {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
}

function isSubscriptionDismissal(
    value: unknown,
): value is SubscriptionDismissal {
    if (typeof value !== "object" || value === null) return false;
    const record = value as Record<string, unknown>;
    return (
        typeof record.recipientId === "number" &&
        (record.findingType === "new" || record.findingType === "priceChange")
    );
}

function isOutlierDismissal(value: unknown): value is OutlierDismissal {
    if (typeof value !== "object" || value === null) return false;
    const record = value as Record<string, unknown>;
    return (
        typeof record.categoryId === "number" &&
        typeof record.monthKey === "string" &&
        typeof record.dismissedAt === "string" &&
        typeof record.deviationAtDismiss === "number"
    );
}

/** Read the legacy store; malformed or unavailable storage becomes empty. */
export function loadDismissState(): InsightsDismissState {
    try {
        const raw = getStorage()?.getItem(DISMISSED_INSIGHTS_STORAGE_KEY);
        if (!raw) return emptyState();
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null) return emptyState();
        const record = parsed as Record<string, unknown>;
        return {
            subscriptions: Array.isArray(record.subscriptions)
                ? record.subscriptions.filter(isSubscriptionDismissal)
                : [],
            outliers: Array.isArray(record.outliers)
                ? record.outliers.filter(isOutlierDismissal)
                : [],
        };
    } catch {
        return emptyState();
    }
}

/** Replace the legacy store with only records that still need migration. */
export function replaceDismissState(state: InsightsDismissState): void {
    try {
        const storage = getStorage();
        if (!storage) return;
        if (state.subscriptions.length === 0 && state.outliers.length === 0) {
            storage.removeItem(DISMISSED_INSIGHTS_STORAGE_KEY);
            return;
        }
        storage.setItem(DISMISSED_INSIGHTS_STORAGE_KEY, JSON.stringify(state));
    } catch {
        // Retry when the migration gate next mounts and storage is available.
    }
}
