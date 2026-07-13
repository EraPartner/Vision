// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { createQueryWrapper } from "@/test/queryWrapper";
import { toast } from "sonner";
import { apiClient } from "@/lib/api";
import {
    useInvestmentsQuery,
    usePortfolioTransactionsQuery,
    useInvestmentMutations,
} from "@/hooks/portfolio/useInvestments";
import { INVESTMENT_STUB } from "@/test/msw/handlers";

vi.mock("@/contexts/LanguageContext", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/contexts/LanguageContext")>();
    const { default: enDict } = await import("@/locales/en");
    return {
        ...actual,
        useLanguage: () => ({
            language: "en" as const,
            setLanguage: vi.fn(),
            t: (key: string, vars?: Record<string, string | number>) => {
                let str = (enDict as Record<string, string>)[key] ?? key;
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
    id: 1,
    investment_id: 1,
    type: "buy" as const,
    date: "2025-01-15",
    amount: 1000,
    units: 10,
    price_per_unit: 100,
    fees: 5,
    taxes: 0,
    currency: "EUR",
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
        const { result } = renderHook(() => useInvestmentsQuery(), { wrapper: makeWrapper() });
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(result.current.data?.items).toHaveLength(1);
        expect(result.current.data?.items[0].id).toBe(1);
    });

    it("passes limit:500 and active:false to the API", async () => {
        const spy = vi.spyOn(apiClient, "getInvestments").mockResolvedValue({
            items: [],
            total: 0,
            limit: 500,
            offset: 0,
            links: [],
        });
        const { result } = renderHook(() => useInvestmentsQuery(), { wrapper: makeWrapper() });
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(spy).toHaveBeenCalledWith({ limit: 500, active: false });
    });

    it("exposes error on failure", async () => {
        vi.spyOn(apiClient, "getInvestments").mockRejectedValue(new Error("network error"));
        const { result } = renderHook(() => useInvestmentsQuery(), { wrapper: makeWrapper() });
        await waitFor(() => expect(result.current.isError).toBe(true));
    });
});

// ---------------------------------------------------------------------------
// usePortfolioTransactionsQuery
// ---------------------------------------------------------------------------

describe("usePortfolioTransactionsQuery", () => {
    it("is idle when investmentIds is empty", () => {
        const spy = vi.spyOn(apiClient, "getPortfolioTransactionsBulk").mockResolvedValue({
            items: [],
            total: 0,
            limit: 1000,
            offset: 0,
            links: [],
        });
        const { result } = renderHook(
            () => usePortfolioTransactionsQuery([]),
            { wrapper: makeWrapper() },
        );
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
            () => usePortfolioTransactionsQuery([1, 2]),
            { wrapper: makeWrapper() },
        );
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(result.current.data).toEqual([PORTFOLIO_TXN_STUB]);
    });

    it("passes investment_ids as comma-joined string to bulk endpoint", async () => {
        const spy = vi.spyOn(apiClient, "getPortfolioTransactionsBulk").mockResolvedValue({
            items: [],
            total: 0,
            limit: 1000,
            offset: 0,
            links: [],
        });
        const { result } = renderHook(
            () => usePortfolioTransactionsQuery([1, 2, 3]),
            { wrapper: makeWrapper() },
        );
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(spy).toHaveBeenCalledWith(
            expect.objectContaining({ investment_ids: "1,2,3" }),
        );
    });

    it("falls back to per-investment requests when bulk endpoint fails", async () => {
        vi.spyOn(apiClient, "getPortfolioTransactionsBulk").mockRejectedValue(
            new Error("bulk unavailable"),
        );
        vi.spyOn(apiClient, "getPortfolioTransactions").mockResolvedValue({
            items: [PORTFOLIO_TXN_STUB],
            total: 1,
            limit: 1000,
            offset: 0,
            links: [],
        });
        const { result } = renderHook(
            () => usePortfolioTransactionsQuery([1]),
            { wrapper: makeWrapper() },
        );
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(result.current.data).toEqual([PORTFOLIO_TXN_STUB]);
        expect(apiClient.getPortfolioTransactions).toHaveBeenCalledWith(1, { limit: 1000 });
    });

    it("flattens transactions from multiple investments in fallback mode", async () => {
        vi.spyOn(apiClient, "getPortfolioTransactionsBulk").mockRejectedValue(
            new Error("bulk failed"),
        );
        const txn1 = { ...PORTFOLIO_TXN_STUB, id: 1, investment_id: 1 };
        const txn2 = { ...PORTFOLIO_TXN_STUB, id: 2, investment_id: 2 };
        vi.spyOn(apiClient, "getPortfolioTransactions")
            .mockResolvedValueOnce({
                items: [txn1],
                total: 1,
                limit: 1000,
                offset: 0,
                links: [],
            })
            .mockResolvedValueOnce({
                items: [txn2],
                total: 1,
                limit: 1000,
                offset: 0,
                links: [],
            });
        const { result } = renderHook(
            () => usePortfolioTransactionsQuery([1, 2]),
            { wrapper: makeWrapper() },
        );
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(result.current.data).toHaveLength(2);
    });
});

// ---------------------------------------------------------------------------
// useInvestmentMutations — investments
// ---------------------------------------------------------------------------

describe("useInvestmentMutations — addInvestment", () => {
    it("calls apiClient.createInvestment with payload", async () => {
        const spy = vi.spyOn(apiClient, "createInvestment").mockResolvedValue(INVESTMENT_STUB as never);
        const { result } = renderHook(() => useInvestmentMutations(), { wrapper: makeWrapper() });
        await act(async () => {
            await result.current.addInvestment({ name: "Test ETF", asset_class: "etf" });
        });
        expect(spy).toHaveBeenCalledWith({ name: "Test ETF", asset_class: "etf" });
    });

    it("calls toast.error when addInvestment fails", async () => {
        const toastSpy = vi.spyOn(toast, "error");
        vi.spyOn(apiClient, "createInvestment").mockRejectedValue(new Error("create failed"));
        const { result } = renderHook(() => useInvestmentMutations(), { wrapper: makeWrapper() });
        await act(async () => {
            await result.current.addInvestment({ name: "Test ETF", asset_class: "etf" }).catch(() => {});
        });
        await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    });
});

describe("useInvestmentMutations — updateInvestment", () => {
    it("calls apiClient.updateInvestment with id and payload", async () => {
        const spy = vi.spyOn(apiClient, "updateInvestment").mockResolvedValue(INVESTMENT_STUB as never);
        const { result } = renderHook(() => useInvestmentMutations(), { wrapper: makeWrapper() });
        await act(async () => {
            await result.current.updateInvestment(1, { name: "Updated ETF" });
        });
        expect(spy).toHaveBeenCalledWith(1, { name: "Updated ETF" });
    });

    it("calls toast.error when updateInvestment fails", async () => {
        const toastSpy = vi.spyOn(toast, "error");
        vi.spyOn(apiClient, "updateInvestment").mockRejectedValue(new Error("update failed"));
        const { result } = renderHook(() => useInvestmentMutations(), { wrapper: makeWrapper() });
        await act(async () => {
            await result.current.updateInvestment(1, { name: "Updated" }).catch(() => {});
        });
        await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    });
});

describe("useInvestmentMutations — deleteInvestment", () => {
    it("calls apiClient.deleteInvestment with id", async () => {
        const spy = vi.spyOn(apiClient, "deleteInvestment").mockResolvedValue(undefined);
        const { result } = renderHook(() => useInvestmentMutations(), { wrapper: makeWrapper() });
        act(() => { result.current.deleteInvestment(1); });
        await waitFor(() => expect(spy).toHaveBeenCalledWith(1));
    });

    it("calls toast.error when deleteInvestment fails", async () => {
        const toastSpy = vi.spyOn(toast, "error");
        vi.spyOn(apiClient, "deleteInvestment").mockRejectedValue(new Error("delete failed"));
        const { result } = renderHook(() => useInvestmentMutations(), { wrapper: makeWrapper() });
        act(() => { result.current.deleteInvestment(1); });
        await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    });
});

// ---------------------------------------------------------------------------
// useInvestmentMutations — transactions
// ---------------------------------------------------------------------------

describe("useInvestmentMutations — addTransaction", () => {
    it("calls apiClient.createPortfolioTransaction with investmentId and data", async () => {
        const spy = vi.spyOn(apiClient, "createPortfolioTransaction").mockResolvedValue(
            PORTFOLIO_TXN_STUB,
        );
        const { result } = renderHook(() => useInvestmentMutations(), { wrapper: makeWrapper() });
        const payload = {
            investmentId: 1,
            type: "buy" as const,
            date: "2025-01-15",
            amount: 1000,
            units: 10,
            price_per_unit: 100,
            currency: "EUR",
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
        const { result } = renderHook(() => useInvestmentMutations(), { wrapper: makeWrapper() });
        await act(async () => {
            await result.current.addTransaction({
                investmentId: 1,
                type: "buy",
                date: "2025-01-15",
            }).catch(() => {});
        });
        await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    });
});

describe("useInvestmentMutations — deleteTransaction", () => {
    it("calls apiClient.deletePortfolioTransaction with id", async () => {
        const spy = vi.spyOn(apiClient, "deletePortfolioTransaction").mockResolvedValue(undefined);
        const { result } = renderHook(() => useInvestmentMutations(), { wrapper: makeWrapper() });
        act(() => { result.current.deleteTransaction(5); });
        await waitFor(() => expect(spy).toHaveBeenCalledWith(5));
    });

    it("calls toast.error when deleteTransaction fails", async () => {
        const toastSpy = vi.spyOn(toast, "error");
        vi.spyOn(apiClient, "deletePortfolioTransaction").mockRejectedValue(
            new Error("delete txn failed"),
        );
        const { result } = renderHook(() => useInvestmentMutations(), { wrapper: makeWrapper() });
        act(() => { result.current.deleteTransaction(5); });
        await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    });
});

describe("useInvestmentMutations — updateTransaction", () => {
    it("calls apiClient.updatePortfolioTransaction with id and data", async () => {
        const spy = vi.spyOn(apiClient, "updatePortfolioTransaction").mockResolvedValue(
            PORTFOLIO_TXN_STUB,
        );
        const { result } = renderHook(() => useInvestmentMutations(), { wrapper: makeWrapper() });
        await act(async () => {
            await result.current.updateTransaction(5, { amount: 2000 });
        });
        expect(spy).toHaveBeenCalledWith(5, { amount: 2000 });
    });
});

// ---------------------------------------------------------------------------
// useInvestmentMutations — refreshPrices
// ---------------------------------------------------------------------------

describe("useInvestmentMutations — refreshPrices", () => {
    it("calls apiClient.refreshInvestmentPrices", async () => {
        const spy = vi.spyOn(apiClient, "refreshInvestmentPrices").mockResolvedValue({
            updated: 2,
            total: 2,
            prices: {},
            priceSources: { IWDA: "live", SPY: "close" },
        });
        const { result } = renderHook(() => useInvestmentMutations(), { wrapper: makeWrapper() });
        act(() => { result.current.refreshPrices(); });
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
        const { result } = renderHook(() => useInvestmentMutations(), { wrapper: makeWrapper() });
        act(() => { result.current.refreshPrices(); });
        await waitFor(() => expect(successSpy).toHaveBeenCalled());
    });

    it("shows toast.warning when some prices use historical_fallback", async () => {
        const warnSpy = vi.spyOn(toast, "warning");
        vi.spyOn(apiClient, "refreshInvestmentPrices").mockResolvedValue({
            updated: 1,
            total: 2,
            prices: {},
            priceSources: { IWDA: "historical_fallback", SPY: "live" },
        });
        const { result } = renderHook(() => useInvestmentMutations(), { wrapper: makeWrapper() });
        act(() => { result.current.refreshPrices(); });
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
        const { result } = renderHook(() => useInvestmentMutations(), { wrapper: makeWrapper() });
        act(() => { result.current.refreshPrices(); });
        await waitFor(() => expect(warnSpy).toHaveBeenCalled());
    });

    it("shows toast.error when refreshPrices fails", async () => {
        const toastSpy = vi.spyOn(toast, "error");
        vi.spyOn(apiClient, "refreshInvestmentPrices").mockRejectedValue(
            new Error("price fetch failed"),
        );
        const { result } = renderHook(() => useInvestmentMutations(), { wrapper: makeWrapper() });
        act(() => { result.current.refreshPrices(); });
        await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    });

    it("isRefreshingPrices is true while pending and false after completion", async () => {
        let resolve!: (v: {
            updated: number;
            total: number;
            prices: Record<string, number>;
            priceSources: Record<string, "live" | "close" | "cached" | "historical_fallback">;
        }) => void;
        vi.spyOn(apiClient, "refreshInvestmentPrices").mockImplementation(
            () => new Promise((res) => { resolve = res; }),
        );
        const { result } = renderHook(() => useInvestmentMutations(), { wrapper: makeWrapper() });
        act(() => { result.current.refreshPrices(); });
        await waitFor(() => expect(result.current.isRefreshingPrices).toBe(true));
        act(() => {
            resolve({ updated: 0, total: 0, prices: {}, priceSources: {} });
        });
        await waitFor(() => expect(result.current.isRefreshingPrices).toBe(false));
    });
});
