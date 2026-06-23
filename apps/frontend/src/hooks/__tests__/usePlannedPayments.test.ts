// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { apiClient } from "@/lib/api";
import { usePlannedPayments } from "@/hooks/usePlannedPayments";
import type { PlannedTransaction } from "@/types/api";

const STUB: PlannedTransaction = {
    id: 1,
    planned_date: "2025-02-01",
    bank_account: "BE12345678901234",
    recipient_id: 1,
    recipient_name: "Landlord",
    memo: "Monthly rent",
    amount: 1200.0,
    currency: "EUR",
    category_id: undefined,
    category_name: undefined,
    comment: undefined,
    url: undefined,
    is_recurring: true,
    recurrence_pattern: "monthly",
    is_executed: false,
    last_executed_date: undefined,
    is_loan: false,
    loan_type: null,
    loan_principal: null,
    loan_annual_interest_rate: null,
    loan_term_months: null,
    loan_start_date: null,
    loan_payment_day: null,
    loan_regular_payment_amount: null,
    loan_first_payment_date: null,
    loan_schedule: [],
    executed_transaction_id: undefined,
    execution_count: 0,
    executions: [],
    is_active: true,
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: undefined,
    links: [],
};

const emptyList = { items: [], total: 0, limit: 1000, offset: 0, links: [] };
const oneItem = { items: [STUB], total: 1, limit: 1000, offset: 0, links: [] };

afterEach(() => vi.restoreAllMocks());

describe("usePlannedPayments", () => {
    it("starts in loading state", () => {
        vi.spyOn(apiClient, "getPlannedTransactions").mockResolvedValue(emptyList);
        const { result } = renderHook(() => usePlannedPayments());
        expect(result.current.loading).toBe(true);
    });

    it("resolves with empty payments list", async () => {
        vi.spyOn(apiClient, "getPlannedTransactions").mockResolvedValue(emptyList);
        const { result } = renderHook(() => usePlannedPayments());
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.payments).toEqual([]);
        expect(result.current.error).toBeNull();
    });

    it("maps API response to PlannedPayment shape", async () => {
        vi.spyOn(apiClient, "getPlannedTransactions").mockResolvedValue(oneItem);
        const { result } = renderHook(() => usePlannedPayments());
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.payments).toHaveLength(1);
        const p = result.current.payments[0];
        expect(p.name).toBe("Monthly rent");
        expect(p.amount).toBe(1200);
        expect(p.currency).toBe("EUR");
        expect(p.is_recurring).toBe(true);
        expect(p.frequency).toBe("monthly");
    });

    it("sets error when fetch fails", async () => {
        vi.spyOn(apiClient, "getPlannedTransactions").mockRejectedValue(new Error("Network error"));
        const { result } = renderHook(() => usePlannedPayments());
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.error).toBe("Network error");
    });

    it("addPayment appends to the list", async () => {
        vi.spyOn(apiClient, "getPlannedTransactions").mockResolvedValue(emptyList);
        vi.spyOn(apiClient, "createPlannedTransaction").mockResolvedValue(STUB);
        const { result } = renderHook(() => usePlannedPayments());
        await waitFor(() => expect(result.current.loading).toBe(false));
        await act(async () => {
            await result.current.addPayment({
                name: "Monthly rent",
                amount: 1200,
                currency: "EUR",
                due_date: "2025-02-01",
                is_recurring: true,
                is_active: true,
            });
        });
        expect(result.current.payments).toHaveLength(1);
    });

    it("deletePayment removes the payment from the list", async () => {
        vi.spyOn(apiClient, "getPlannedTransactions").mockResolvedValue(oneItem);
        vi.spyOn(apiClient, "deletePlannedTransaction").mockResolvedValue(undefined);
        const { result } = renderHook(() => usePlannedPayments());
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.payments).toHaveLength(1);
        await act(async () => {
            await result.current.deletePayment(1);
        });
        expect(result.current.payments).toHaveLength(0);
    });

    it("updatePayment replaces the matching payment", async () => {
        vi.spyOn(apiClient, "getPlannedTransactions").mockResolvedValue(oneItem);
        const updated = { ...STUB, amount: 1500, memo: "Updated rent" };
        vi.spyOn(apiClient, "updatePlannedTransaction").mockResolvedValue(updated);
        const { result } = renderHook(() => usePlannedPayments());
        await waitFor(() => expect(result.current.loading).toBe(false));
        await act(async () => {
            await result.current.updatePayment(1, { amount: 1500 });
        });
        expect(result.current.payments[0].amount).toBe(1500);
        expect(result.current.payments[0].name).toBe("Updated rent");
    });

    it("refetch re-calls the API", async () => {
        const spy = vi.spyOn(apiClient, "getPlannedTransactions").mockResolvedValue(emptyList);
        const { result } = renderHook(() => usePlannedPayments());
        await waitFor(() => expect(result.current.loading).toBe(false));
        await act(async () => { await result.current.refetch(); });
        expect(spy).toHaveBeenCalledTimes(2);
    });
});
