// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { createQueryWrapper } from "@/test/queryWrapper";
import { usePortfolioSummaries } from "@/hooks/portfolio/usePortfolioSummaries";
import type { Investment, PortfolioTransaction } from "@/types/api";
import type { PortfolioSummaryItem } from "@/lib/api/info";

// usePortfolioSummaries pulls FX rates via useExchangeRates (useQuery), so the
// hook needs a QueryClientProvider. The query is left unresolved on purpose: the
// rate map degrades to EUR-only (multiplier 1), which is correct for the all-EUR
// fixtures below.
const makeWrapper = createQueryWrapper;

const inv = (overrides: Partial<Investment>): Investment =>
    ({
        id: 1,
        name: "X",
        asset_class: "stock",
        currency: "EUR",
        current_price: 0,
        interest_rate: 0,
        is_active: true,
        ...overrides,
    }) as unknown as Investment;

const txn = (overrides: Partial<PortfolioTransaction>): PortfolioTransaction =>
    ({
        id: 1,
        investment_id: 1,
        type: "buy",
        amount: 0,
        units: 0,
        fees: 0,
        taxes: 0,
        date: "2026-01-01",
        currency: "EUR",
        ...overrides,
    }) as unknown as PortfolioTransaction;

function gainLossOf(
    investments: Investment[],
    transactions: PortfolioTransaction[],
) {
    const { result } = renderHook(
        () => usePortfolioSummaries({ investments, transactions }),
        {
            wrapper: makeWrapper(),
        },
    );
    return result.current.summaries[0].gainLoss;
}

describe("usePortfolioSummaries — canonical identity columns", () => {
    it("keeps the investment row's typed NUMERIC columns and calendar-day maturity", () => {
        // portfolioSummaryService passes `SELECT i.*` through: NUMERIC columns
        // arrive as strings and maturity_date as a serialized local-midnight
        // Date, which is the previous UTC day for a server east of UTC.
        const canonical = {
            id: 1,
            is_active: true,
            cadastral_income: "1250.00",
            municipality_tax_rate: "7.50",
            maturity_date: "2030-06-14T22:00:00.000Z",
            maturityDate: "2030-06-14T22:00:00.000Z",
        } as unknown as PortfolioSummaryItem;
        const { result } = renderHook(
            () =>
                usePortfolioSummaries({
                    investments: [
                        inv({
                            id: 1,
                            asset_class: "savings",
                            cadastral_income: 1250,
                            municipality_tax_rate: 7.5,
                            maturity_date: "2030-06-15",
                        }),
                    ],
                    transactions: [],
                    canonicalSummaries: [canonical],
                }),
            { wrapper: makeWrapper() },
        );
        const [summary] = result.current.summaries;
        expect(summary.cadastral_income).toBe(1250);
        expect(summary.municipality_tax_rate).toBe(7.5);
        expect(summary.maturity_date).toBe("2030-06-15");
        expect(summary.maturityDate).toBe("2030-06-15");
    });
});

describe("usePortfolioSummaries — gainLoss does not double-count (FE mirror of backend)", () => {
    it("waits for canonical dated FX when monetary rows use another booking currency", () => {
        const { result } = renderHook(
            () =>
                usePortfolioSummaries({
                    investments: [
                        inv({ id: 1, currency: "USD", current_price: 20 }),
                        inv({ id: 2, currency: "USD", is_active: false }),
                        inv({ id: 3, current_price: 20 }),
                    ],
                    transactions: [
                        txn({
                            id: 1,
                            investment_id: 1,
                            amount: 80,
                            units: 10,
                            fx_rate_to_eur: 1,
                        }),
                        txn({ id: 2, investment_id: 2, amount: 80, units: 10 }),
                        txn({ id: 3, investment_id: 3, amount: 10, units: 1 }),
                    ],
                }),
            { wrapper: makeWrapper() },
        );
        // Archived holdings never get a canonical summary, so they stay local.
        expect(
            result.current.allSummaries.map((summary) => summary.id),
        ).toEqual([2, 3]);
        expect(result.current.totals.totalGainLoss).toBe(10);
    });

    it("ignores zero-money currency labels on unit-only events in the local fallback", () => {
        const { result } = renderHook(
            () =>
                usePortfolioSummaries({
                    investments: [inv({ current_price: 20 })],
                    transactions: [
                        txn({ amount: 10, units: 1 }),
                        txn({
                            id: 2,
                            type: "split",
                            units: 2,
                            currency: "USD",
                        }),
                    ],
                }),
            { wrapper: makeWrapper() },
        );
        expect(result.current.summaries[0].totalUnits).toBe(2);
        expect(result.current.summaries[0].gainLoss).toBe(30);
    });

    it("keeps archived history discoverable but excludes it from current totals", () => {
        const { result } = renderHook(
            () =>
                usePortfolioSummaries({
                    investments: [
                        inv({ id: 1, current_price: 20 }),
                        inv({ id: 2, current_price: 50, is_active: false }),
                    ],
                    transactions: [
                        txn({ id: 1, investment_id: 1, amount: 10, units: 1 }),
                        txn({ id: 2, investment_id: 2, amount: 25, units: 1 }),
                    ],
                }),
            { wrapper: makeWrapper() },
        );

        expect(result.current.summaries.map((summary) => summary.id)).toEqual([
            1,
        ]);
        expect(
            result.current.inactiveSummaries.map((summary) => summary.id),
        ).toEqual([2]);
        expect(
            result.current.allSummaries.map((summary) => summary.id),
        ).toEqual([1, 2]);
        expect(result.current.inactiveSummaries[0].transactions).toHaveLength(
            1,
        );
        expect(result.current.totals.totalPortfolioValue).toBe(20);
    });

    it("uses broker partitions and exposes legacy oversells instead of flat replay", () => {
        const { result } = renderHook(
            () =>
                usePortfolioSummaries({
                    investments: [
                        inv({ asset_class: "stock", current_price: 10 }),
                    ],
                    transactions: [
                        txn({
                            id: 1,
                            type: "buy",
                            amount: 50,
                            units: 5,
                            account_id: 1,
                        }),
                        txn({
                            id: 2,
                            type: "buy",
                            amount: 50,
                            units: 5,
                            account_id: 2,
                        }),
                        txn({
                            id: 3,
                            type: "sell",
                            amount: 70,
                            units: 7,
                            account_id: 1,
                            date: "2026-02-01",
                        }),
                    ],
                }),
            { wrapper: makeWrapper() },
        );
        expect(result.current.summaries[0]).toMatchObject({
            fullyAssigned: true,
            oversold: true,
            totalUnits: 5,
            currentValue: 50,
        });
    });

    it("unit-based: a buy fee is folded into cost basis only once", () => {
        // Paid 110 (100 + 10 fee), worth 150 → economic gain 40 (was 30 before fix).
        const gainLoss = gainLossOf(
            [inv({ asset_class: "stock", current_price: 150 })],
            [txn({ type: "buy", amount: 100, units: 1, fees: 10 })],
        );
        expect(gainLoss).toBe(40);
    });

    it("real estate: rent + fees + taxes counted once", () => {
        // appreciation 10000 + rent 12000 − fees 2000 − taxes 1000 = 19000 (was 28000).
        const gainLoss = gainLossOf(
            [inv({ asset_class: "real_estate", current_price: 0 })],
            [
                txn({ id: 1, type: "buy", amount: 250000 }),
                txn({ id: 2, type: "appreciation", amount: 10000 }),
                txn({ id: 3, type: "rent_income", amount: 12000 }),
                txn({ id: 4, type: "fee", amount: 2000 }),
                txn({ id: 5, type: "tax", amount: 1000 }),
            ],
        );
        expect(gainLoss).toBe(19000);
    });

    it("fixed income: interest received counted once", () => {
        // One 400 interest payment, no accrual → 400 (was 800: realized + income).
        const gainLoss = gainLossOf(
            [
                inv({
                    asset_class: "savings",
                    interest_rate: 0,
                    current_price: 0,
                }),
            ],
            [
                txn({ id: 1, type: "buy", amount: 10000, date: "2025-01-01" }),
                txn({
                    id: 2,
                    type: "interest",
                    amount: 400,
                    date: "2026-01-01",
                }),
            ],
        );
        expect(gainLoss).toBe(400);
    });
});
