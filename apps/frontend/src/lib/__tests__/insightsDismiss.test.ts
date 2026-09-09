import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
    DISMISSED_INSIGHTS_STORAGE_KEY,
    loadDismissState,
    replaceDismissState,
} from "@/lib/insightsDismiss";

class MemoryStorage {
    private store = new Map<string, string>();
    getItem(key: string) {
        return this.store.get(key) ?? null;
    }
    setItem(key: string, value: string) {
        this.store.set(key, value);
    }
    removeItem(key: string) {
        this.store.delete(key);
    }
}

describe("legacy insight dismissal storage", () => {
    beforeEach(() => vi.stubGlobal("localStorage", new MemoryStorage()));
    afterEach(() => vi.unstubAllGlobals());

    test("loads only valid migration records", () => {
        localStorage.setItem(
            DISMISSED_INSIGHTS_STORAGE_KEY,
            JSON.stringify({
                subscriptions: [
                    { recipientId: "invalid", findingType: "new" },
                    { recipientId: 1, findingType: "priceChange" },
                ],
                outliers: [
                    { categoryId: 2, monthKey: "2026-08" },
                    {
                        categoryId: 3,
                        monthKey: "2026-09",
                        dismissedAt: "2026-09-01T00:00:00.000Z",
                        deviationAtDismiss: 2.5,
                    },
                ],
            }),
        );

        expect(loadDismissState()).toEqual({
            subscriptions: [{ recipientId: 1, findingType: "priceChange" }],
            outliers: [
                {
                    categoryId: 3,
                    monthKey: "2026-09",
                    dismissedAt: "2026-09-01T00:00:00.000Z",
                    deviationAtDismiss: 2.5,
                },
            ],
        });
    });

    test("malformed and unavailable storage degrade to an empty state", () => {
        localStorage.setItem(DISMISSED_INSIGHTS_STORAGE_KEY, "not json");
        expect(loadDismissState()).toEqual({ subscriptions: [], outliers: [] });

        vi.stubGlobal("localStorage", undefined);
        expect(loadDismissState()).toEqual({ subscriptions: [], outliers: [] });
        expect(() =>
            replaceDismissState({ subscriptions: [], outliers: [] }),
        ).not.toThrow();
    });

    test("replaces remaining records and clears an empty migration state", () => {
        const state = {
            subscriptions: [{ recipientId: 4, findingType: "new" as const }],
            outliers: [],
        };
        replaceDismissState(state);
        expect(loadDismissState()).toEqual(state);

        replaceDismissState({ subscriptions: [], outliers: [] });
        expect(localStorage.getItem(DISMISSED_INSIGHTS_STORAGE_KEY)).toBeNull();
    });
});
