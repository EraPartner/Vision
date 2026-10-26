// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { createQueryWrapper, createTestQueryClient } from "@/test/queryWrapper";
import { toast } from "sonner";
import { apiClient } from "@/lib/api";
import {
    useInvestmentsQuery,
    usePortfolioTransactionsQuery,
    useAllPortfolioTransactionsQuery,
    useInvestmentMutations,
} from "@/hooks/portfolio/useInvestments";
import { INVESTMENT_STUB } from "@/test/msw/handlers";
import {
    asAccountId,
    asCurrencyCode,
    asInvestmentId,
    asPortfolioTransactionId,
} from "@vision/types/brands";
import { must } from "@/test/must";

vi.mock("@/stores/hydration/LanguageHydration", async (importOriginal) => {
    const actual =
        await importOriginal<
            typeof import("@/stores/hydration/LanguageHydration")
        >();
    const { default: enDict } = await import("@/locales/en");
    return {
        ...actual,
        useLanguage: () => ({
            language: "en" as const,
            setLanguage: vi.fn(),
            t: (key: string, vars?: Record<string, string | number>) => {
                let str = enDict[key] ?? key;
                if (vars) {
                    for (const [k, v] of Object.entries(vars)) {
                        str = str.replaceAll(`{${k}}`, String(v));
                    }
                }
                return str;
            },
        }),
    };
});

const PORTFOLIO_TXN_STUB = {
    id: asPortfolioTransactionId(1),
    investment_id: asInvestmentId(1),
    type: "buy" as const,
    date: "2025-01-15",
    amount: 1000,
    units: 10,
    price_per_unit: 100,
    fees: 5,
    taxes: 0,
    currency: asCurrencyCode("EUR"),
    is_recurring: false,
    created_at: "2025-01-15T10:00:00.000Z",
    updated_at: "2025-01-15T10:00:00.000Z",
};

const makeWrapper = createQueryWrapper;

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// useInvestmentsQuery
// ---------------------------------------------------------------------------

describe("useInvestmentsQuery", () => {
    it("fetches investments on success", async () => {
        vi.spyOn(apiClient, "getInvestments").mockResolvedValue({
            items: [INVESTMENT_STUB as never],
            total: 1,
            limit: 500,
            offset: 0,
            links: [],
        });
        const { result } = renderHook(() => useInvestmentsQuery(), {
            wrapper: makeWrapper(),
        });
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(result.current.data?.items).toHaveLength(1);
        expect(result.current.data?.items[0]?.id).toBe(1);
    });

    it("passes limit:500 and active:false to the API", async () => {
        const spy = vi.spyOn(apiClient, "getInvestments").mockResolvedValue({
            items: [],
            total: 0,
            limit: 500,
            offset: 0,
            links: [],
        });
        const { result } = renderHook(() => useInvestmentsQuery(), {
            wrapper: makeWrapper(),
        });
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(spy).toHaveBeenCalledWith(
            {
                limit: 500,
                offset: 0,
                active: false,
            },
            expect.any(AbortSignal),
        );
    });

    it("loads more than 500 mixed active and archived holdings", async () => {
        const rows = Array.from({ length: 603 }, (_, index) => ({
            ...INVESTMENT_STUB,
            id: index + 1,
            is_active: index % 2 === 0,
        }));
        vi.spyOn(apiClient, "getInvestments").mockImplementation(
            (params) =>
                Promise.resolve({
                    items: rows.slice(
                        params?.offset ?? 0,
                        (params?.offset ?? 0) + 500,
                    ) as never,
                    total: rows.length,
                    limit: 500,
                    offset: params?.offset ?? 0,
                    links: [],
                }),
        );
        const { result } = renderHook(() => useInvestmentsQuery(), {
            wrapper: makeWrapper(),
        });
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(result.current.data?.items).toHaveLength(603);
        expect(
            result.current.data?.items.filter((i) => i.is_active),
        ).toHaveLength(302);
    });

    it("exposes error on failure", async () => {
        vi.spyOn(apiClient, "getInvestments").mockRejectedValue(
            new Error("network error"),
        );
        const { result } = renderHook(() => useInvestmentsQuery(), {
            wrapper: makeWrapper(),
        });
        await waitFor(() => expect(result.current.isError).toBe(true));
    });
});

describe("useAllPortfolioTransactionsQuery", () => {
    it("pages until the server total proves the instrument history complete", async () => {
        const spy = vi
            .spyOn(apiClient, "getPortfolioTransactions")
            .mockResolvedValueOnce({
                items: Array.from({ length: 1000 }, (_, index) => ({
                    ...PORTFOLIO_TXN_STUB,
                    id: asPortfolioTransactionId(index + 1),
                })),
                total: 1001,
                limit: 1000,
                offset: 0,
                links: [],
            })
            .mockResolvedValueOnce({
                items: [{ ...PORTFOLIO_TXN_STUB, id: asPortfolioTransactionId(1001) }],
                total: 1001,
                limit: 1000,
                offset: 1000,
                links: [],
            });
        const { result } = renderHook(
            () => useAllPortfolioTransactionsQuery(asInvestmentId(4)),
            { wrapper: makeWrapper() },
        );
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(result.current.data).toHaveLength(1001);
        expect(spy).toHaveBeenNthCalledWith(
            1,
            4,
            {
                limit: 1000,
                offset: 0,
            },
            expect.any(AbortSignal),
        );
        expect(spy).toHaveBeenNthCalledWith(
            2,
            4,
            {
                limit: 1000,
                offset: 1000,
            },
            expect.any(AbortSignal),
        );
    });
});

// ---------------------------------------------------------------------------
// usePortfolioTransactionsQuery
// ---------------------------------------------------------------------------

describe("usePortfolioTransactionsQuery", () => {
    it("is idle when investmentIds is empty", () => {
        const spy = vi
            .spyOn(apiClient, "getPortfolioTransactionsBulk")
            .mockResolvedValue({
                items: [],
                total: 0,
                limit: 1000,
                offset: 0,
                links: [],
            });
        const { result } = renderHook(() => usePortfolioTransactionsQuery([]), {
            wrapper: makeWrapper(),
        });
        expect(spy).not.toHaveBeenCalled();
        expect(result.current.fetchStatus).toBe("idle");
    });

    it("uses bulk endpoint when investmentIds is non-empty", async () => {
        vi.spyOn(apiClient, "getPortfolioTransactionsBulk").mockResolvedValue({
            items: [PORTFOLIO_TXN_STUB],
            total: 1,
            limit: 1000,
            offset: 0,
            links: [],
        });
        const { result } = renderHook(
            () => usePortfolioTransactionsQuery([asInvestmentId(1), asInvestmentId(2)]),
            { wrapper: makeWrapper() },
        );
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(result.current.data).toEqual([PORTFOLIO_TXN_STUB]);
    });

    it("passes investment_ids as comma-joined string to bulk endpoint", async () => {
        const spy = vi
            .spyOn(apiClient, "getPortfolioTransactionsBulk")
            .mockResolvedValue({
                items: [],
                total: 0,
                limit: 1000,
                offset: 0,
                links: [],
            });
        const { result } = renderHook(
            () => usePortfolioTransactionsQuery([asInvestmentId(1), asInvestmentId(2), asInvestmentId(3)]),
            { wrapper: makeWrapper() },
        );
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(spy).toHaveBeenCalledWith(
            expect.objectContaining({ investment_ids: "1,2,3" }),
            expect.any(AbortSignal),
        );
    });

    it.each([401, 429, 500, 504])(
        "does not fan out a failed bulk request (%s)",
        async (status) => {
            const error = Object.assign(new Error("bulk unavailable"), {
                status,
            });
            vi.spyOn(
                apiClient,
                "getPortfolioTransactionsBulk",
            ).mockRejectedValue(error);
            const individual = vi.spyOn(apiClient, "getPortfolioTransactions");
            const { result } = renderHook(
                () => usePortfolioTransactionsQuery([asInvestmentId(1), asInvestmentId(2)]),
                { wrapper: makeWrapper() },
            );
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect(result.current.error).toBe(error);
            expect(individual).not.toHaveBeenCalled();
        },
    );

    it("bounds complete-history work to four concurrent holdings", async () => {
        let active = 0;
        let peak = 0;
        vi.spyOn(apiClient, "getPortfolioTransactions").mockImplementation(
            async (id) => {
                active += 1;
                peak = Math.max(peak, active);
                await new Promise((resolve) => setTimeout(resolve, 5));
                active -= 1;
                return {
                    items: [{ ...PORTFOLIO_TXN_STUB, investment_id: id }],
                    total: 1,
                    limit: 1000,
                    offset: 0,
                    links: [],
                };
            },
        );
        const { result } = renderHook(
            () => usePortfolioTransactionsQuery([asInvestmentId(1), asInvestmentId(2), asInvestmentId(3), asInvestmentId(4), asInvestmentId(5), asInvestmentId(6), asInvestmentId(7)], true),
            { wrapper: makeWrapper() },
        );
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(result.current.data).toHaveLength(7);
        expect(peak).toBeLessThanOrEqual(4);
    });

    it("drains failed workers before retrying and stops queued holdings and pages", async () => {
        let active = 0;
        let peak = 0;
        let firstAttempt = true;
        let rejectFirst!: (error: Error) => void;
        const releases: (() => void)[] = [];
        const failure = new Error("first holding failed");
        const requests = vi
            .spyOn(apiClient, "getPortfolioTransactions")
            .mockImplementation(async (id) => {
                active++;
                peak = Math.max(peak, active);
                try {
                    if (firstAttempt) {
                        if (id === 1)
                            await new Promise<void>((_resolve, reject) => {
                                rejectFirst = reject;
                            });
                        else
                            await new Promise<void>((resolve) =>
                                releases.push(resolve),
                            );
                    }
                    return {
                        items: [{ ...PORTFOLIO_TXN_STUB, investment_id: id }],
                        // The first attempt would need another page, which must not start.
                        total: firstAttempt ? 2 : 1,
                        limit: 1000,
                        offset: 0,
                        links: [],
                    };
                } finally {
                    active--;
                }
            });
        const { result } = renderHook(
            () => usePortfolioTransactionsQuery([asInvestmentId(1), asInvestmentId(2), asInvestmentId(3), asInvestmentId(4), asInvestmentId(5), asInvestmentId(6), asInvestmentId(7)], true),
            { wrapper: makeWrapper() },
        );
        await waitFor(() => expect(requests).toHaveBeenCalledTimes(4));
        await act(() => Promise.resolve(rejectFirst(failure)));
        expect(active).toBe(3);
        expect(result.current.isFetching).toBe(true);
        expect(result.current.isError).toBe(false);
        await act(() => Promise.resolve(must(releases[0])()));
        expect(active).toBe(2);
        expect(requests).toHaveBeenCalledTimes(4);
        expect(result.current.isFetching).toBe(true);
        await act(() => {
            must(releases[1])();
            must(releases[2])();
            return Promise.resolve();
        });
        await waitFor(() => expect(result.current.isError).toBe(true));
        expect(result.current.error).toBe(failure);
        expect(active).toBe(0);
        expect(requests).toHaveBeenCalledTimes(4);
        firstAttempt = false;
        await act(async () => {
            await result.current.refetch();
        });
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(result.current.data).toHaveLength(7);
        expect(peak).toBeLessThanOrEqual(4);
    });

    it("retains cached history on failure and recovers on retry", async () => {
        const bulk = vi
            .spyOn(apiClient, "getPortfolioTransactionsBulk")
            .mockResolvedValue({
                items: [PORTFOLIO_TXN_STUB],
                total: 1,
                limit: 50,
                offset: 0,
                links: [],
            });
        const { result } = renderHook(
            () => usePortfolioTransactionsQuery([asInvestmentId(1)]),
            { wrapper: makeWrapper() },
        );
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        bulk.mockRejectedValueOnce(new Error("offline"));
        await act(async () => {
            await result.current.refetch();
        });
        await waitFor(() => expect(result.current.isError).toBe(true));
        expect(result.current.data).toHaveLength(1);
        await act(async () => {
            await result.current.refetch();
        });
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
    });
});

// ---------------------------------------------------------------------------
// useInvestmentMutations — investments
// ---------------------------------------------------------------------------

describe("useInvestmentMutations — addInvestment", () => {
    it("calls apiClient.createInvestment with payload", async () => {
        const spy = vi
            .spyOn(apiClient, "createInvestment")
            .mockResolvedValue(INVESTMENT_STUB as never);
        const { result } = renderHook(() => useInvestmentMutations(), {
            wrapper: makeWrapper(),
        });
        await act(async () => {
            await result.current.addInvestment({
                name: "Test ETF",
                asset_class: "etf",
            });
        });
        expect(spy).toHaveBeenCalledWith({
            name: "Test ETF",
            asset_class: "etf",
        });
    });

    it("calls toast.error when addInvestment fails", async () => {
        const toastSpy = vi.spyOn(toast, "error");
        vi.spyOn(apiClient, "createInvestment").mockRejectedValue(
            new Error("create failed"),
        );
        const { result } = renderHook(() => useInvestmentMutations(), {
            wrapper: makeWrapper(),
        });
        await act(async () => {
            await result.current
                .addInvestment({ name: "Test ETF", asset_class: "etf" })
                .catch(() => {});
        });
        await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    });
});

describe("useInvestmentMutations — updateInvestment", () => {
    it("calls apiClient.updateInvestment with id and payload", async () => {
        const spy = vi
            .spyOn(apiClient, "updateInvestment")
            .mockResolvedValue(INVESTMENT_STUB as never);
        const { result } = renderHook(() => useInvestmentMutations(), {
            wrapper: makeWrapper(),
        });
        await act(async () => {
            await result.current.updateInvestment(asInvestmentId(1), { name: "Updated ETF" });
        });
        expect(spy).toHaveBeenCalledWith(1, { name: "Updated ETF" });
    });

    it("calls toast.error when updateInvestment fails", async () => {
        const toastSpy = vi.spyOn(toast, "error");
        vi.spyOn(apiClient, "updateInvestment").mockRejectedValue(
            new Error("update failed"),
        );
        const { result } = renderHook(() => useInvestmentMutations(), {
            wrapper: makeWrapper(),
        });
        await act(async () => {
            await result.current
                .updateInvestment(asInvestmentId(1), { name: "Updated" })
                .catch(() => {});
        });
        await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    });
});

describe("useInvestmentMutations — deleteInvestment", () => {
    it("calls apiClient.deleteInvestment with id", async () => {
        const spy = vi
            .spyOn(apiClient, "deleteInvestment")
            .mockResolvedValue(undefined);
        const { result } = renderHook(() => useInvestmentMutations(), {
            wrapper: makeWrapper(),
        });
        act(() => {
            result.current.deleteInvestment(asInvestmentId(1));
        });
        await waitFor(() => expect(spy).toHaveBeenCalledWith(1));
    });

    it("calls toast.error when deleteInvestment fails", async () => {
        const toastSpy = vi.spyOn(toast, "error");
        vi.spyOn(apiClient, "deleteInvestment").mockRejectedValue(
            new Error("delete failed"),
        );
        const { result } = renderHook(() => useInvestmentMutations(), {
            wrapper: makeWrapper(),
        });
        act(() => {
            result.current.deleteInvestment(asInvestmentId(1));
        });
        await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    });
});

// ---------------------------------------------------------------------------
// useInvestmentMutations — transactions
// ---------------------------------------------------------------------------

describe("useInvestmentMutations — addTransaction", () => {
    it("calls apiClient.createPortfolioTransaction with investmentId and data", async () => {
        const spy = vi
            .spyOn(apiClient, "createPortfolioTransaction")
            .mockResolvedValue(PORTFOLIO_TXN_STUB);
        const { result } = renderHook(() => useInvestmentMutations(), {
            wrapper: makeWrapper(),
        });
        const payload = {
            investmentId: asInvestmentId(1),
            type: "buy" as const,
            date: "2025-01-15",
            amount: 1000,
            units: 10,
            price_per_unit: 100,
            currency: asCurrencyCode("EUR"),
        };
        await act(async () => {
            await result.current.addTransaction(payload);
        });
        const { investmentId, ...txnData } = payload;
        expect(spy).toHaveBeenCalledWith(investmentId, txnData);
    });

    it("calls toast.error when addTransaction fails", async () => {
        const toastSpy = vi.spyOn(toast, "error");
        vi.spyOn(apiClient, "createPortfolioTransaction").mockRejectedValue(
            new Error("txn failed"),
        );
        const { result } = renderHook(() => useInvestmentMutations(), {
            wrapper: makeWrapper(),
        });
        await act(async () => {
            await result.current
                .addTransaction({
                    investmentId: asInvestmentId(1),
                    type: "buy",
                    date: "2025-01-15",
                })
                .catch(() => {});
        });
        await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    });
});

describe("useInvestmentMutations — deleteTransaction", () => {
    it("calls apiClient.deletePortfolioTransaction with id", async () => {
        const spy = vi
            .spyOn(apiClient, "deletePortfolioTransaction")
            .mockResolvedValue(undefined);
        const { result } = renderHook(() => useInvestmentMutations(), {
            wrapper: makeWrapper(),
        });
        act(() => {
            result.current.deleteTransaction(asPortfolioTransactionId(5));
        });
        await waitFor(() => expect(spy).toHaveBeenCalledWith(5));
    });

    it("calls toast.error when deleteTransaction fails", async () => {
        const toastSpy = vi.spyOn(toast, "error");
        vi.spyOn(apiClient, "deletePortfolioTransaction").mockRejectedValue(
            new Error("delete txn failed"),
        );
        const { result } = renderHook(() => useInvestmentMutations(), {
            wrapper: makeWrapper(),
        });
        act(() => {
            result.current.deleteTransaction(asPortfolioTransactionId(5));
        });
        await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    });
});

describe("useInvestmentMutations — updateTransaction", () => {
    it("calls apiClient.updatePortfolioTransaction with id and data", async () => {
        const spy = vi
            .spyOn(apiClient, "updatePortfolioTransaction")
            .mockResolvedValue(PORTFOLIO_TXN_STUB);
        const { result } = renderHook(() => useInvestmentMutations(), {
            wrapper: makeWrapper(),
        });
        await act(async () => {
            await result.current.updateTransaction(asPortfolioTransactionId(5), {
                amount: 2000,
                fx_rate_to_eur: null,
                account_id: null,
                note: null,
                recurrence_interval: null,
                recurrence_end_date: null,
            });
        });
        expect(spy).toHaveBeenCalledWith(5, {
            amount: 2000,
            fx_rate_to_eur: null,
            account_id: null,
            note: null,
            recurrence_interval: null,
            recurrence_end_date: null,
        });
    });
});

describe("useInvestmentMutations — bulk broker re-tag", () => {
    it("invalidates portfolio, account, and net-worth consumers", async () => {
        const client = createTestQueryClient();
        const invalidate = vi.spyOn(client, "invalidateQueries");
        const payload = {
            transaction_ids: [asPortfolioTransactionId(1), asPortfolioTransactionId(2)],
            from_account_id: null,
            to_account_id: asAccountId(7),
            idempotency_key: "75557a9d-4dee-453a-9ef6-3b1b56a54b86",
        };
        const spy = vi
            .spyOn(apiClient, "bulkRetagPortfolioTransactions")
            .mockResolvedValue({ changed_count: 2 } as never);
        const { result } = renderHook(() => useInvestmentMutations(), {
            wrapper: createQueryWrapper(client),
        });

        await act(async () => {
            await result.current.bulkRetagTransactions(payload);
        });

        expect(spy).toHaveBeenCalledWith(payload);
        expect(invalidate).toHaveBeenCalledWith({ queryKey: ["investments"] });
        expect(invalidate).toHaveBeenCalledWith({ queryKey: ["accounts"] });
        expect(invalidate).toHaveBeenCalledWith({ queryKey: ["net-worth"] });
    });
});

// ---------------------------------------------------------------------------
// useInvestmentMutations — refreshPrices
// ---------------------------------------------------------------------------

describe("useInvestmentMutations — refreshPrices", () => {
    it("calls apiClient.refreshInvestmentPrices", async () => {
        const spy = vi
            .spyOn(apiClient, "refreshInvestmentPrices")
            .mockResolvedValue({
                updated: 2,
                total: 2,
                prices: {},
                priceSources: { IWDA: "live", SPY: "close" },
            });
        const { result } = renderHook(() => useInvestmentMutations(), {
            wrapper: makeWrapper(),
        });
        act(() => {
            result.current.refreshPrices();
        });
        await waitFor(() => expect(spy).toHaveBeenCalled());
    });

    it("shows toast.success when all prices are live", async () => {
        const successSpy = vi.spyOn(toast, "success");
        vi.spyOn(apiClient, "refreshInvestmentPrices").mockResolvedValue({
            updated: 2,
            total: 2,
            prices: {},
            priceSources: { IWDA: "live", SPY: "close" },
        });
        const { result } = renderHook(() => useInvestmentMutations(), {
            wrapper: makeWrapper(),
        });
        act(() => {
            result.current.refreshPrices();
        });
        await waitFor(() => expect(successSpy).toHaveBeenCalled());
    });

    it("reports zero refreshed prices when no holding has a live provider", async () => {
        const successSpy = vi.spyOn(toast, "success");
        // The backend omits `total` on this early return.
        vi.spyOn(apiClient, "refreshInvestmentPrices").mockResolvedValue({
            updated: 0,
            message: "No investments with live price providers",
        });
        const { result } = renderHook(() => useInvestmentMutations(), {
            wrapper: makeWrapper(),
        });
        act(() => {
            result.current.refreshPrices();
        });
        await waitFor(() =>
            expect(successSpy).toHaveBeenCalledWith(
                "Prices refreshed for 0 investments",
                expect.anything(),
            ),
        );
    });

    it("shows toast.warning when some prices use historical_fallback", async () => {
        const warnSpy = vi.spyOn(toast, "warning");
        vi.spyOn(apiClient, "refreshInvestmentPrices").mockResolvedValue({
            updated: 1,
            total: 2,
            prices: {},
            priceSources: { IWDA: "historical_fallback", SPY: "live" },
        });
        const { result } = renderHook(() => useInvestmentMutations(), {
            wrapper: makeWrapper(),
        });
        act(() => {
            result.current.refreshPrices();
        });
        await waitFor(() => expect(warnSpy).toHaveBeenCalled());
    });

    it("shows toast.warning when some prices use cached source", async () => {
        const warnSpy = vi.spyOn(toast, "warning");
        vi.spyOn(apiClient, "refreshInvestmentPrices").mockResolvedValue({
            updated: 1,
            total: 1,
            prices: {},
            priceSources: { IWDA: "cached" },
        });
        const { result } = renderHook(() => useInvestmentMutations(), {
            wrapper: makeWrapper(),
        });
        act(() => {
            result.current.refreshPrices();
        });
        await waitFor(() => expect(warnSpy).toHaveBeenCalled());
    });

    it("shows toast.error when refreshPrices fails", async () => {
        const toastSpy = vi.spyOn(toast, "error");
        vi.spyOn(apiClient, "refreshInvestmentPrices").mockRejectedValue(
            new Error("price fetch failed"),
        );
        const { result } = renderHook(() => useInvestmentMutations(), {
            wrapper: makeWrapper(),
        });
        act(() => {
            result.current.refreshPrices();
        });
        await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    });

    it("isRefreshingPrices is true while pending and false after completion", async () => {
        let resolve!: (v: {
            updated: number;
            total: number;
            prices: Record<string, number>;
            priceSources: Record<
                string,
                "live" | "close" | "cached" | "historical_fallback"
            >;
        }) => void;
        vi.spyOn(apiClient, "refreshInvestmentPrices").mockImplementation(
            () =>
                new Promise((res) => {
                    resolve = res;
                }),
        );
        const { result } = renderHook(() => useInvestmentMutations(), {
            wrapper: makeWrapper(),
        });
        act(() => {
            result.current.refreshPrices();
        });
        await waitFor(() =>
            expect(result.current.isRefreshingPrices).toBe(true),
        );
        act(() => {
            resolve({ updated: 0, total: 0, prices: {}, priceSources: {} });
        });
        await waitFor(() =>
            expect(result.current.isRefreshingPrices).toBe(false),
        );
    });
});
