import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
    CashForecast,
    CategoryOutlier,
    InsightsDigestResponse,
    SubscriptionCreepNew,
    SubscriptionCreepPriceChange,
} from "@/lib/api/info";
import {
    DISMISSED_INSIGHTS_STORAGE_KEY,
    OUTLIER_REALERT_MARGIN,
    OUTLIER_SUPPRESSION_DAYS,
    countUndismissed,
    dismissOutlier,
    dismissSubscription,
    filterDigest,
    loadDismissState,
} from "@/lib/insightsDismiss";

// Node-env test (no jsdom): provide a minimal in-memory localStorage.
class MemoryStorage {
    private store = new Map<string, string>();
    getItem(key: string) { return this.store.get(key) ?? null; }
    setItem(key: string, value: string) { this.store.set(key, value); }
    removeItem(key: string) { this.store.delete(key); }
    clear() { this.store.clear(); }
    get length() { return this.store.size; }
    key(i: number) { return [...this.store.keys()][i] ?? null; }
}

const NOW = new Date("2026-07-23T12:00:00Z");

function daysAfter(days: number, base: Date = NOW): Date {
    return new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
}

function makeNew(recipientId: number): SubscriptionCreepNew {
    return {
        recipientId,
        recipientName: `Recipient ${recipientId}`,
        findingType: "new",
        latestAmount: 9.99,
        currency: "EUR",
        detectedPattern: "monthly",
        intervalDays: 30,
        predictedNext: "2026-08-01",
        confidence: 85,
    };
}

function makePriceChange(recipientId: number): SubscriptionCreepPriceChange {
    return {
        recipientId,
        recipientName: `Recipient ${recipientId}`,
        findingType: "priceChange",
        previousAmount: 9.99,
        newAmount: 12.99,
        percentChange: 30,
        direction: "increased",
        currency: "EUR",
        confidence: 85,
    };
}

function makeOutlier(categoryId: number, deviation = 2, monthKey = "2026-07"): CategoryOutlier {
    return {
        categoryId,
        categoryName: `Category ${categoryId}`,
        monthKey,
        currentAmount: 450,
        baselineMedian: 200,
        deviation,
        direction: "increased",
    };
}

function makeForecast(prominence: "alert" | "standing"): CashForecast {
    return {
        month: "2026-07",
        currency: "EUR",
        monthEndProjected: 1200,
        minProjected: 300,
        monthEndLow: 900,
        monthEndHigh: 1500,
        crossesZero: prominence === "alert",
        movedSignificantly: false,
        prominence,
        methodId: "ets",
    };
}

function makeDigest(overrides: Partial<InsightsDigestResponse> = {}): InsightsDigestResponse {
    return {
        subscriptionCreep: { new: [], priceChanges: [] },
        categoryOutliers: [],
        cashForecast: null,
        ...overrides,
    };
}

describe("insightsDismiss", () => {
    beforeEach(() => {
        vi.stubGlobal("localStorage", new MemoryStorage());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    describe("subscription dismissals", () => {
        test("dismissal is permanent — still suppressed a year later", () => {
            const digest = makeDigest({
                subscriptionCreep: { new: [makeNew(1)], priceChanges: [] },
            });
            const state = dismissSubscription(1, "new");
            expect(filterDigest(digest, state, NOW).newSubscriptions).toHaveLength(0);
            expect(filterDigest(digest, state, daysAfter(365)).newSubscriptions).toHaveLength(0);
        });

        test("findingTypes are independent — dismissing 'new' keeps the priceChange visible", () => {
            const digest = makeDigest({
                subscriptionCreep: { new: [makeNew(1)], priceChanges: [makePriceChange(1)] },
            });
            const state = dismissSubscription(1, "new");
            const filtered = filterDigest(digest, state, NOW);
            expect(filtered.newSubscriptions).toHaveLength(0);
            expect(filtered.priceChanges).toHaveLength(1);
        });

        test("dismissal only affects the matching recipient and persists to localStorage", () => {
            const digest = makeDigest({
                subscriptionCreep: { new: [makeNew(1), makeNew(2)], priceChanges: [] },
            });
            dismissSubscription(1, "new");
            // Reload from storage to prove persistence, not just the returned state.
            const reloaded = loadDismissState();
            const filtered = filterDigest(digest, reloaded, NOW);
            expect(filtered.newSubscriptions.map((f) => f.recipientId)).toEqual([2]);
        });
    });

    describe("category-outlier dismissals", () => {
        test("suppressed within the 14-day window", () => {
            const outlier = makeOutlier(10, 2);
            const state = dismissOutlier(outlier, NOW);
            const digest = makeDigest({ categoryOutliers: [outlier] });
            expect(
                filterDigest(digest, state, daysAfter(OUTLIER_SUPPRESSION_DAYS - 1)).categoryOutliers,
            ).toHaveLength(0);
        });

        test("re-alerts early when deviation worsens past the margin", () => {
            const dismissed = makeOutlier(10, 2);
            const state = dismissOutlier(dismissed, NOW);
            const worsened = makeOutlier(10, 2 + OUTLIER_REALERT_MARGIN + 0.1);
            const digest = makeDigest({ categoryOutliers: [worsened] });
            expect(filterDigest(digest, state, daysAfter(1)).categoryOutliers).toHaveLength(1);
        });

        test("stays suppressed at exactly deviationAtDismiss + margin (must EXCEED)", () => {
            const dismissed = makeOutlier(10, 2);
            const state = dismissOutlier(dismissed, NOW);
            const borderline = makeOutlier(10, 2 + OUTLIER_REALERT_MARGIN);
            const digest = makeDigest({ categoryOutliers: [borderline] });
            expect(filterDigest(digest, state, daysAfter(1)).categoryOutliers).toHaveLength(0);
        });

        test("un-suppresses after the 14-day window elapses", () => {
            const outlier = makeOutlier(10, 2);
            const state = dismissOutlier(outlier, NOW);
            const digest = makeDigest({ categoryOutliers: [outlier] });
            expect(
                filterDigest(digest, state, daysAfter(OUTLIER_SUPPRESSION_DAYS)).categoryOutliers,
            ).toHaveLength(1);
        });

        test("dismissal is keyed by category + month — other categories stay visible", () => {
            const dismissed = makeOutlier(10, 2);
            const other = makeOutlier(11, 2);
            const state = dismissOutlier(dismissed, NOW);
            const digest = makeDigest({ categoryOutliers: [dismissed, other] });
            const visible = filterDigest(digest, state, daysAfter(1)).categoryOutliers;
            expect(visible.map((o) => o.categoryId)).toEqual([11]);
        });
    });

    describe("malformed / absent localStorage", () => {
        test("non-JSON payload → empty state", () => {
            localStorage.setItem(DISMISSED_INSIGHTS_STORAGE_KEY, "not json {");
            expect(loadDismissState()).toEqual({ subscriptions: [], outliers: [] });
        });

        test("wrong-shape payload → malformed entries are dropped", () => {
            localStorage.setItem(
                DISMISSED_INSIGHTS_STORAGE_KEY,
                JSON.stringify({
                    subscriptions: [{ recipientId: "nope" }, { recipientId: 1, findingType: "new" }],
                    outliers: "definitely not an array",
                }),
            );
            expect(loadDismissState()).toEqual({
                subscriptions: [{ recipientId: 1, findingType: "new" }],
                outliers: [],
            });
        });

        test("absent localStorage → empty state and dismissals do not throw", () => {
            vi.stubGlobal("localStorage", undefined);
            expect(loadDismissState()).toEqual({ subscriptions: [], outliers: [] });
            expect(() => dismissSubscription(1, "new")).not.toThrow();
            // In-memory state still reflects the dismissal for this call chain.
            const state = dismissSubscription(1, "new");
            expect(state.subscriptions).toEqual([{ recipientId: 1, findingType: "new" }]);
        });
    });

    describe("countUndismissed", () => {
        test("sums visible rows and counts an alert cash forecast as 1", () => {
            const digest = makeDigest({
                subscriptionCreep: {
                    new: [makeNew(1), makeNew(2)],
                    priceChanges: [makePriceChange(3)],
                },
                categoryOutliers: [makeOutlier(10)],
                cashForecast: makeForecast("alert"),
            });
            expect(countUndismissed(digest, loadDismissState(), NOW)).toBe(5);
        });

        test("a standing cash forecast adds nothing", () => {
            const digest = makeDigest({
                subscriptionCreep: { new: [makeNew(1)], priceChanges: [] },
                cashForecast: makeForecast("standing"),
            });
            expect(countUndismissed(digest, loadDismissState(), NOW)).toBe(1);
        });

        test("dismissals lower the count; undefined digest counts 0", () => {
            const digest = makeDigest({
                subscriptionCreep: { new: [makeNew(1)], priceChanges: [makePriceChange(2)] },
                categoryOutliers: [makeOutlier(10)],
            });
            dismissSubscription(1, "new");
            const state = dismissOutlier(makeOutlier(10), NOW);
            expect(countUndismissed(digest, state, daysAfter(1))).toBe(1);
            expect(countUndismissed(undefined, state, NOW)).toBe(0);
        });
    });
});
