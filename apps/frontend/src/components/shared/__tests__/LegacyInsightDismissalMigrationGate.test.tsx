// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { ApiClientError } from "@/lib/api/client";
import { ApiErrorCode } from "@vision/types";
import {
    DISMISSED_INSIGHTS_STORAGE_KEY,
    loadDismissState,
} from "@/lib/insightsDismiss";
import { insightsKeys } from "@/lib/queryKeys";
import { renderWithApp } from "@/test/renderWithApp";
import { LegacyInsightDismissalMigrationGate } from "../LegacyInsightDismissalMigrationGate";

const mocks = vi.hoisted(() => ({
    dismissInsight: vi.fn(),
}));

vi.mock("@/lib/api/info", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/api/info")>()),
    dismissInsight: mocks.dismissInsight,
}));

function seedLegacyDismissals() {
    localStorage.setItem(
        DISMISSED_INSIGHTS_STORAGE_KEY,
        JSON.stringify({
            subscriptions: [
                { recipientId: 1, findingType: "new" },
                { recipientId: 2, findingType: "priceChange" },
            ],
            outliers: [
                {
                    categoryId: 3,
                    monthKey: "2026-08",
                    dismissedAt: "2026-09-01T00:00:00.000Z",
                    deviationAtDismiss: 4.1,
                },
            ],
        }),
    );
}

describe("LegacyInsightDismissalMigrationGate", () => {
    beforeEach(() => {
        localStorage.clear();
        mocks.dismissInsight.mockReset();
    });

    afterEach(() => vi.useRealTimers());

    it("holds application queries until legacy dismissals are migrated", async () => {
        seedLegacyDismissals();
        let release: (() => void) | undefined;
        const pending = new Promise<void>((resolve) => {
            release = resolve;
        });
        mocks.dismissInsight.mockReturnValue(pending);

        renderWithApp(
            <LegacyInsightDismissalMigrationGate>
                <span>application ready</span>
            </LegacyInsightDismissalMigrationGate>,
        );

        expect(screen.queryByText("application ready")).not.toBeInTheDocument();
        await waitFor(() =>
            expect(mocks.dismissInsight).toHaveBeenCalledTimes(3),
        );
        release?.();
        expect(await screen.findByText("application ready")).toBeVisible();
        expect(loadDismissState()).toEqual({ subscriptions: [], outliers: [] });
    });

    it("consumes stale records, retains transient failures, and retries before release", async () => {
        vi.useFakeTimers();
        seedLegacyDismissals();
        let transientAttempts = 0;
        mocks.dismissInsight.mockImplementation((request) => {
            if (request.kind === "subscription_price_change") {
                transientAttempts += 1;
                return transientAttempts === 1
                    ? Promise.reject(new Error("network unavailable"))
                    : Promise.resolve({});
            }
            if (request.kind === "category_outlier") {
                return Promise.reject(
                    new ApiClientError({
                        status: 404,
                        code: ApiErrorCode.NOT_FOUND,
                        message: "finding is stale",
                    }),
                );
            }
            return Promise.resolve({});
        });

        const { queryClient } = renderWithApp(
            <LegacyInsightDismissalMigrationGate>
                <span>application ready</span>
            </LegacyInsightDismissalMigrationGate>,
        );
        const invalidate = vi.spyOn(queryClient, "invalidateQueries");

        await vi.waitFor(() =>
            expect(mocks.dismissInsight).toHaveBeenCalledTimes(3),
        );
        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });
        expect(screen.queryByText("application ready")).not.toBeInTheDocument();
        expect(loadDismissState()).toEqual({
            subscriptions: [{ recipientId: 2, findingType: "priceChange" }],
            outliers: [],
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(60_000);
        });
        expect(screen.getByText("application ready")).toBeVisible();
        expect(transientAttempts).toBe(2);
        expect(loadDismissState()).toEqual({ subscriptions: [], outliers: [] });
        expect(invalidate).toHaveBeenCalledWith({
            queryKey: insightsKeys.digest,
        });
        expect(invalidate).toHaveBeenCalledWith({
            queryKey: insightsKeys.count,
        });
    });
});
