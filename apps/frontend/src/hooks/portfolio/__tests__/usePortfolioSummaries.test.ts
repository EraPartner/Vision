// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { createQueryWrapper } from "@/test/queryWrapper";
import { usePortfolioSummaries } from "@/hooks/portfolio/usePortfolioSummaries";
import type { Investment, PortfolioTransaction } from "@/types/api";
import type { PortfolioSummaryItem } from "@/lib/api/info";
import { asInvestmentId, asPortfolioTransactionId } from "@vision/types/brands";
import { must } from "@/test/must";

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
                            id: asInvestmentId(1),
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
        const summary = must(result.current.summaries[0]);
        expect(summary.cadastral_income).toBe(1250);
        expect(summary.municipality_tax_rate).toBe(7.5);
        expect(summary.maturity_date).toBe("2030-06-15");
        expect(summary.maturityDate).toBe("2030-06-15");
    });
});

describe("usePortfolioSummaries — server summaries only", () => {
    const summary = (overrides: Partial<PortfolioSummaryItem>) =>
        ({
            is_active: true,
            currentValue: 0,
            gainLoss: 0,
            realizedGain: 0,
            unrealizedGain: 0,
            ...overrides,
        }) as unknown as PortfolioSummaryItem;

    it("takes archived holdings from the all-holdings summary and keeps them out of current totals", () => {
        const { result } = renderHook(
            () =>
                usePortfolioSummaries({
                    investments: [
                        inv({ id: asInvestmentId(1), current_price: 20 }),
                        inv({ id: asInvestmentId(2), current_price: 50, is_active: false }),
                    ],
                    transactions: [
                        txn({ id: asPortfolioTransactionId(1), investment_id: asInvestmentId(1), amount: 10, units: 1 }),
                        txn({ id: asPortfolioTransactionId(2), investment_id: asInvestmentId(2), amount: 25, units: 1 }),
                    ],
                    canonicalSummaries: [
                        summary({ id: asInvestmentId(1), currentValue: 20, gainLoss: 10 }),
                    ],
                    canonicalArchivedSummaries: [
                        summary({ id: asInvestmentId(1), currentValue: 999 }),
                        summary({
                            id: asInvestmentId(2),
                            is_active: false,
                            realizedGain: 7,
                            gainLoss: 7,
                        }),
                    ],
                }),
            { wrapper: makeWrapper() },
        );

        expect(result.current.summaries.map((s) => s.id)).toEqual([1]);
        expect(result.current.inactiveSummaries[0]).toMatchObject({
            id: 2,
            realizedGain: 7,
            summarySource: "canonical",
        });
        expect(result.current.inactiveSummaries[0]?.transactions).toHaveLength(
            1,
        );
        expect(result.current.totals.totalPortfolioValue).toBe(20);
        expect(result.current.totals.totalGainLoss).toBe(10);
    });

    it("computes nothing locally while a holding's server summary is missing", () => {
        const { result } = renderHook(
            () =>
                usePortfolioSummaries({
                    investments: [
                        inv({ id: asInvestmentId(1), current_price: 20 }),
                        inv({ id: asInvestmentId(2), is_active: false }),
                    ],
                    transactions: [txn({ amount: 10, units: 1 })],
                }),
            { wrapper: makeWrapper() },
        );

        expect(result.current.allSummaries).toEqual([]);
    });
});
