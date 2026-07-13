// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { createQueryWrapper } from "@/test/queryWrapper";
import { apiClient } from "@/lib/api";
import {
    useUpcomingPlannedPayments,
    dismissKeyFor,
    __resetDismissedCacheForTests,
} from "@/hooks/useUpcomingPlannedPayments";
import { LOCAL_STORAGE_KEYS } from "@/lib/localStorage-keys";
import { todayYmd } from "@/lib/timezone";
import type { PlannedTransaction } from "@/types/api";

const makeQueryWrapper = createQueryWrapper;

function makePlanned(overrides: Partial<PlannedTransaction>): PlannedTransaction {
    return {
        id: 1,
        planned_date: todayYmd(),
        bank_account: "BE12345678901234",
        recipient_id: 1,
        recipient_name: "Landlord",
        memo: "Monthly rent",
        amount: -1200.0,
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
        ...overrides,
    };
}

function listOf(items: PlannedTransaction[]) {
    return { items, total: items.length, limit: 100, offset: 0, links: [] };
}

// window.localStorage is unavailable under the sandboxed jsdom runner (see the
// long-standing adminToken.test.ts note) — back it with an in-memory stub.
function installMemoryLocalStorage() {
    const backing = new Map<string, string>();
    const stub: Pick<Storage, "getItem" | "setItem" | "removeItem" | "clear"> = {
        getItem: (k) => (backing.has(k) ? backing.get(k)! : null),
        setItem: (k, v) => void backing.set(k, String(v)),
        removeItem: (k) => void backing.delete(k),
        clear: () => backing.clear(),
    };
    Object.defineProperty(window, "localStorage", { value: stub, configurable: true });
}

beforeEach(() => {
    installMemoryLocalStorage();
    __resetDismissedCacheForTests();
});

afterEach(() => vi.restoreAllMocks());

describe("useUpcomingPlannedPayments", () => {
    it("hides a dismissed occurrence from visibleUpcoming", async () => {
        const pt = makePlanned({ id: 7 });
        vi.spyOn(apiClient, "getPlannedTransactions").mockResolvedValue(listOf([pt]));

        const { result } = renderHook(() => useUpcomingPlannedPayments(), {
            wrapper: makeQueryWrapper(),
        });
        await waitFor(() => expect(result.current.visibleUpcoming).toHaveLength(1));

        act(() => result.current.dismiss(pt));
        expect(result.current.visibleUpcoming).toHaveLength(0);
        // Still present in the raw list — dismissal is presentation-only.
        expect(result.current.upcoming).toHaveLength(1);
    });

    it("re-surfaces a recurring payment once planned_date advances to the next cycle", async () => {
        const thisCycle = makePlanned({ id: 7, planned_date: todayYmd() });
        // Same row id, advanced date — what the row looks like after /execute.
        const nextDate = new Date(`${todayYmd()}T00:00:00`);
        nextDate.setDate(nextDate.getDate() + 5);
        const y = nextDate.getFullYear();
        const m = String(nextDate.getMonth() + 1).padStart(2, "0");
        const d = String(nextDate.getDate()).padStart(2, "0");
        const nextCycle = makePlanned({ id: 7, planned_date: `${y}-${m}-${d}` });

        const spy = vi
            .spyOn(apiClient, "getPlannedTransactions")
            .mockResolvedValue(listOf([thisCycle]));

        const wrapper = makeQueryWrapper();
        const first = renderHook(() => useUpcomingPlannedPayments(), { wrapper });
        await waitFor(() => expect(first.result.current.visibleUpcoming).toHaveLength(1));
        act(() => first.result.current.dismiss(thisCycle));
        expect(first.result.current.visibleUpcoming).toHaveLength(0);
        first.unmount();

        spy.mockResolvedValue(listOf([nextCycle]));
        const second = renderHook(() => useUpcomingPlannedPayments(), {
            wrapper: makeQueryWrapper(),
        });
        await waitFor(() => expect(second.result.current.upcoming).toHaveLength(1));
        // Different occurrence key → the reminder is visible again.
        expect(second.result.current.visibleUpcoming).toHaveLength(1);
    });

    it("normalizes ISO-timestamp planned_date when keying dismissals", () => {
        expect(dismissKeyFor({ id: 3, planned_date: "2026-06-15T00:00:00.000Z" })).toBe(
            "3:2026-06-15",
        );
        expect(dismissKeyFor({ id: 3, planned_date: "2026-06-15" })).toBe("3:2026-06-15");
    });

    it("prunes past-dated and legacy id-only entries on load", async () => {
        window.localStorage.setItem(
            LOCAL_STORAGE_KEYS.DISMISSED_UPCOMING_PAYMENTS,
            // legacy numeric entry + stale dated entry + valid future entry
            JSON.stringify([42, "9:2020-01-01", `7:${todayYmd()}`]),
        );
        __resetDismissedCacheForTests();

        const pt = makePlanned({ id: 7, planned_date: todayYmd() });
        vi.spyOn(apiClient, "getPlannedTransactions").mockResolvedValue(listOf([pt]));

        const { result } = renderHook(() => useUpcomingPlannedPayments(), {
            wrapper: makeQueryWrapper(),
        });
        await waitFor(() => expect(result.current.upcoming).toHaveLength(1));
        // The surviving valid entry still applies…
        expect(result.current.visibleUpcoming).toHaveLength(0);

        // …and a write persists only well-formed, non-stale keys.
        act(() => result.current.dismiss({ id: 8, planned_date: todayYmd() }));
        const stored = JSON.parse(
            window.localStorage.getItem(LOCAL_STORAGE_KEYS.DISMISSED_UPCOMING_PAYMENTS) ?? "[]",
        );
        expect(stored).toEqual(
            expect.arrayContaining([`7:${todayYmd()}`, `8:${todayYmd()}`]),
        );
        expect(stored).toHaveLength(2);
    });
});
