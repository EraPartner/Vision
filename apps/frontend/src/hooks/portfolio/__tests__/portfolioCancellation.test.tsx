// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { createQueryWrapper, createTestQueryClient } from "@/test/queryWrapper";
import {
    useAllPortfolioTransactionsQuery,
    useInvestmentsQuery,
    usePortfolioTransactionsQuery,
} from "../useInvestments";

// Real query and domain/client layers; only the HTTP transport is gated.
afterEach(() => vi.restoreAllMocks());

describe("portfolio transport cancellation", () => {
    it.each([
        ["inventory", () => useInvestmentsQuery(), 1],
        ["recent history", () => usePortfolioTransactionsQuery([1, 2, 3]), 1],
        ["detail history", () => useAllPortfolioTransactionsQuery(1), 1],
        [
            "complete history",
            () => usePortfolioTransactionsQuery([1, 2, 3, 4, 5, 6, 7], true),
            4,
        ],
    ] as const)(
        "aborts %s on unmount before a new mount starts",
        async (_name, query, initialRequests) => {
            let active = 0;
            let peak = 0;
            let cancelled = 0;
            let hold = true;
            const transport = vi
                .spyOn(globalThis, "fetch")
                .mockImplementation(async (_url, options) => {
                    active++;
                    peak = Math.max(peak, active);
                    let finished = false;
                    const finish = () => {
                        if (!finished) {
                            finished = true;
                            active--;
                        }
                    };
                    try {
                        if (hold) {
                            await new Promise<void>((_resolve, reject) => {
                                options!.signal!.addEventListener(
                                    "abort",
                                    () => {
                                        cancelled++;
                                        finish();
                                        reject(
                                            new DOMException(
                                                "Cancelled",
                                                "AbortError",
                                            ),
                                        );
                                    },
                                    { once: true },
                                );
                            });
                        }
                        return new Response(
                            JSON.stringify({
                                ok: true,
                                data: {
                                    items: [],
                                    total: 0,
                                    limit: 1000,
                                    offset: 0,
                                    links: [],
                                },
                            }),
                            { status: 200 },
                        );
                    } finally {
                        finish();
                    }
                });
            const client = createTestQueryClient();
            const wrapper = createQueryWrapper(client);
            const first = renderHook(query as () => unknown, { wrapper });
            await waitFor(() =>
                expect(transport).toHaveBeenCalledTimes(initialRequests),
            );
            first.unmount();
            expect(cancelled).toBe(initialRequests);
            expect(transport).toHaveBeenCalledTimes(initialRequests);
            hold = false;
            const second = renderHook(query as () => { isSuccess: boolean }, {
                wrapper,
            });
            await waitFor(() =>
                expect(second.result.current.isSuccess).toBe(true),
            );
            expect(peak).toBeLessThanOrEqual(4);
            expect(active).toBe(0);
            second.unmount();
            client.clear();
        },
    );
});
