import { describe, expect, it, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import {
    accountKeys,
    cashflowKeys,
    insightsKeys,
    invalidateTransactionData,
    netWorthKeys,
    plannedKeys,
} from "@/lib/queryKeys";

describe("invalidateTransactionData", () => {
    it("invalidates the insights digest after transaction mutations", () => {
        const invalidateQueries = vi.fn();
        const queryClient = { invalidateQueries } as unknown as QueryClient;

        invalidateTransactionData(queryClient);

        expect(invalidateQueries).toHaveBeenCalledWith({
            queryKey: insightsKeys.digest,
        });
    });

    it("invalidates account-scoped planned transactions after transaction mutations", () => {
        const invalidateQueries = vi.fn();
        const queryClient = { invalidateQueries } as unknown as QueryClient;

        invalidateTransactionData(queryClient);

        expect(invalidateQueries).toHaveBeenCalledWith({
            queryKey: plannedKeys.accountTransactionsAll,
        });
    });

    it("invalidates account balances and their dashboard and net-worth consumers", () => {
        const invalidateQueries = vi.fn();
        const queryClient = { invalidateQueries } as unknown as QueryClient;

        invalidateTransactionData(queryClient);

        expect(invalidateQueries).toHaveBeenCalledWith({
            queryKey: accountKeys.all,
        });
        expect(invalidateQueries).toHaveBeenCalledWith({
            queryKey: cashflowKeys.bankBalancesAll,
        });
        expect(invalidateQueries).toHaveBeenCalledWith({
            queryKey: netWorthKeys.all,
        });
    });
});
