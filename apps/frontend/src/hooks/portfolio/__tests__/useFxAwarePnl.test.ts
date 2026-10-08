// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useFxAwarePnl } from "../useFxAwarePnl";
import type { InvestmentSummary } from "@/types/portfolio";

vi.mock("@/hooks/useCurrencyConverter", () => ({
    useCurrencyConverter: () => ({ ratesToEur: { EUR: 1, USD: 0.8 } }),
}));

const holding = (overrides: Partial<InvestmentSummary>) =>
    ({
        currency: "EUR",
        originalCurrency: "USD",
        totalUnits: 10,
        currentPrice: 16,
        avgCostBasis: 8,
        realizedGain: 0,
        unrealizedGain: 80,
        summarySource: "local",
        transactions: [
            {
                type: "buy",
                amount: 80,
                units: 10,
                currency: "EUR",
                date: "2026-01-01",
            },
        ],
        ...overrides,
    }) as InvestmentSummary;

describe("useFxAwarePnl currency ownership", () => {
    it("does not invent a local quote-currency basis for mixed monetary rows", () => {
        const { result } = renderHook(() => useFxAwarePnl("EUR"));
        expect(result.current(holding({}))).toBeUndefined();
    });

    it("uses canonical monetary fields despite mixed booking currencies", () => {
        const { result } = renderHook(() => useFxAwarePnl("EUR"));
        expect(result.current(holding({ summarySource: "canonical" }))).toEqual(
            {
                realizedTarget: 0,
                unrealizedTarget: 80,
                unrealizedPercent: 100,
            },
        );
    });

    it("uses the original quote currency when a same-currency local row omits its currency", () => {
        const { result } = renderHook(() => useFxAwarePnl("EUR"));
        expect(
            result.current(
                holding({
                    transactions: [
                        {
                            type: "buy",
                            amount: 100,
                            units: 10,
                            date: "2026-01-01",
                        },
                    ] as InvestmentSummary["transactions"],
                }),
            ),
        ).toEqual({
            realizedTarget: 0,
            unrealizedTarget: 80,
            unrealizedPercent: 100,
        });
    });
});
