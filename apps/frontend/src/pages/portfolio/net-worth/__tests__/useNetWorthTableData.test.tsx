// @vitest-environment jsdom
/**
 * The snapshot table reads its pagination facts from the RESPONSE BODY
 * (snapshotsTotal), which is the single API-wide convention — the endpoint used
 * to also emit an envelope-level `meta.pagination`, now retired. These pin that
 * the hook never depended on `meta`, and that hasMore/total come from the body.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { createLanguageQueryWrapper } from "@/test/queryWrapper";
import { apiClient } from "@/lib/api";
import { useNetWorthTableData } from "../useNetWorthTableData";

afterEach(() => vi.clearAllMocks());

const snapshot = (date: string) => ({ date, liquid: 1, investments: 1, netWorth: 2 });

describe("useNetWorthTableData", () => {
    it("takes total from the body's snapshotsTotal, not from envelope meta", async () => {
        vi.spyOn(apiClient, "getNetWorth").mockResolvedValue({
            current: { liquid: 0, liabilities: 0, investments: 0, netWorth: 0 },
            monthlyChange: 0,
            monthlyChangePercent: 0,
            snapshots: [snapshot("2026-03-05"), snapshot("2026-03-04")],
            snapshotsTotal: 5,
            snapshotsLimit: 2,
            snapshotsOffset: 0,
        } as never);

        const { result } = renderHook(
            () => useNetWorthTableData({ currency: "EUR", pageSize: 2 }),
            { wrapper: createLanguageQueryWrapper() },
        );

        await waitFor(() => expect(result.current.totalItems).toBe(5));
        expect(result.current.allItems).toHaveLength(2);
        expect(result.current.hasMore).toBe(true);
    });

    it("falls back to the page length when the body carries no total", async () => {
        vi.spyOn(apiClient, "getNetWorth").mockResolvedValue({
            current: { liquid: 0, liabilities: 0, investments: 0, netWorth: 0 },
            monthlyChange: 0,
            monthlyChangePercent: 0,
            snapshots: [snapshot("2026-03-05")],
        } as never);

        const { result } = renderHook(
            () => useNetWorthTableData({ currency: "EUR", pageSize: 2 }),
            { wrapper: createLanguageQueryWrapper() },
        );

        await waitFor(() => expect(result.current.totalItems).toBe(1));
        expect(result.current.hasMore).toBe(false);
    });

    it("appends the next page and re-reads the total from that body", async () => {
        const spy = vi.spyOn(apiClient, "getNetWorth")
            .mockResolvedValueOnce({
                current: { liquid: 0, liabilities: 0, investments: 0, netWorth: 0 },
                monthlyChange: 0,
                monthlyChangePercent: 0,
                snapshots: [snapshot("2026-03-05")],
                snapshotsTotal: 2,
            } as never)
            .mockResolvedValueOnce({
                current: { liquid: 0, liabilities: 0, investments: 0, netWorth: 0 },
                monthlyChange: 0,
                monthlyChangePercent: 0,
                snapshots: [snapshot("2026-03-04")],
                snapshotsTotal: 2,
            } as never);

        const { result } = renderHook(
            () => useNetWorthTableData({ currency: "EUR", pageSize: 1 }),
            { wrapper: createLanguageQueryWrapper() },
        );

        await waitFor(() => expect(result.current.allItems).toHaveLength(1));
        await act(async () => {
            await result.current.loadMore();
        });

        expect(result.current.allItems).toHaveLength(2);
        expect(result.current.hasMore).toBe(false);
        expect(spy).toHaveBeenLastCalledWith({ currency: "EUR", limit: 1, offset: 1 });
    });
});
