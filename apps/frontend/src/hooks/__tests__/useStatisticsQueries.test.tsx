// @vitest-environment jsdom
/**
 * useStatistics request contract, observed at the HTTP boundary (MSW): which
 * aggregation endpoints are requested, for which window, and with which
 * exclusions. Settings and exclusion inputs are stubbed; react-query is real.
 */
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "@/test/msw/server";
import { createQueryWrapper } from "@/test/queryWrapper";

vi.mock("@/stores/hydration/AppSettingsHydration", () => ({
    useAppSettings: () => ({ appSettings: { defaultCurrency: "USD" } }),
}));
vi.mock("@/hooks/useExcludedIds", () => ({
    useExcludedIds: () => ({
        excludedCategoryIds: [7],
        excludedRecipientIds: [8],
        exclusionsApply: true,
        isReady: true,
    }),
}));

import { useRecipientInsights, useStatistics } from "../useStatistics";

interface SeenRequest {
    endpoint: string;
    params: URLSearchParams;
}

let seen: SeenRequest[] = [];
function record({ request }: { request: Request }) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/aggregations/")) {
        seen.push({
            endpoint: url.pathname.replace("/api/aggregations/", ""),
            params: url.searchParams,
        });
    }
}

function summarize({ endpoint, params }: SeenRequest) {
    return {
        endpoint,
        currency: params.get("currency"),
        start_date: params.get("start_date"),
        end_date: params.get("end_date"),
        excluded_category_ids: params.getAll("excluded_category_ids"),
        excluded_recipient_ids: params.getAll("excluded_recipient_ids"),
    };
}

const ENDPOINTS = [
    "monthly-summary",
    "category-pivot",
    "recipient-by-year",
    "recipient-insights",
];

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-07T12:00:00"));
    seen = [];
    server.events.on("request:start", record);
});

afterEach(() => {
    server.events.removeListener("request:start", record);
    vi.useRealTimers();
});

describe("useStatistics requests", () => {
    it("requests each chart unfiltered and with the active exclusions over the 24-month window", async () => {
        renderHook(() => useStatistics(), { wrapper: createQueryWrapper() });

        await waitFor(() => expect(seen).toHaveLength(8));

        const requests = seen.map(summarize);
        const window = { start_date: "2024-10-01", end_date: "2026-09-07" };
        for (const endpoint of ENDPOINTS) {
            const forEndpoint = requests.filter((r) => r.endpoint === endpoint);
            expect(forEndpoint, endpoint).toHaveLength(2);
            expect(forEndpoint).toEqual(
                expect.arrayContaining([
                    {
                        endpoint,
                        currency: "USD",
                        ...window,
                        excluded_category_ids: [],
                        excluded_recipient_ids: [],
                    },
                    {
                        endpoint,
                        currency: "USD",
                        ...window,
                        excluded_category_ids: ["7"],
                        excluded_recipient_ids: ["8"],
                    },
                ]),
            );
        }
    });

    it("sends no date bounds for the all-time window", async () => {
        renderHook(() => useStatistics("all"), {
            wrapper: createQueryWrapper(),
        });

        await waitFor(() => expect(seen).toHaveLength(8));

        expect(new Set(seen.map(({ endpoint }) => endpoint))).toEqual(
            new Set(ENDPOINTS),
        );
        for (const { endpoint, params } of seen) {
            expect(params.get("currency"), endpoint).toBe("USD");
            expect(params.has("start_date"), endpoint).toBe(false);
            expect(params.has("end_date"), endpoint).toBe(false);
        }
        const monthly = seen.filter((r) => r.endpoint === "monthly-summary");
        expect(monthly.every(({ params }) => params.get("all_time") === "true")).toBe(true);
    });
});

describe("useRecipientInsights window", () => {
    it("requests the selected 24-month window with both exclusion lists", async () => {
        renderHook(() => useRecipientInsights("USD", [7], [8], "24m"), {
            wrapper: createQueryWrapper(),
        });

        await waitFor(() => expect(seen).toHaveLength(1));
        expect(summarize(seen[0]!)).toEqual({
            endpoint: "recipient-insights",
            currency: "USD",
            start_date: "2024-10-01",
            end_date: "2026-09-07",
            excluded_category_ids: ["7"],
            excluded_recipient_ids: ["8"],
        });
    });
});
