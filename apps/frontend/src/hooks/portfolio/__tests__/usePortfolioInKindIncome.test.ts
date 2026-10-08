// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { usePortfolioSummaries } from "../usePortfolioSummaries";
import type { Investment, PortfolioTransaction } from "@/types/api";
import type { PortfolioSummaryItem } from "@/lib/api/info";

const settings = vi.hoisted(() => ({
    method: "weighted_avg",
    multiplier: 1,
    currency: "EUR",
}));
vi.mock("@/stores/hydration/AppSettingsHydration", () => ({
    useAppSettings: () => ({
        appSettings: {
            costBasisMethod: settings.method,
            defaultCurrency: settings.currency,
        },
    }),
}));
vi.mock("@/hooks/useExchangeRates", () => ({
    useExchangeRates: () => ({ multiplierFor: () => settings.multiplier }),
}));
const investment = {
    id: 1,
    name: "Synthetic metal",
    asset_class: "metals",
    currency: "EUR",
    current_price: 20,
    is_active: true,
} as Investment;
function transactions(sold = false): PortfolioTransaction[] {
    return [
        { id: 1, type: "buy", date: "2025-01-01", units: 1, amount: 10 },
        {
            id: 2,
            type: "gift",
            date: "2025-02-01",
            units: 1,
            amount: 0,
            price_per_unit: 0,
        },
        {
            id: 3,
            type: "sell",
            date: "2025-03-01",
            units: sold ? 2 : 1,
            amount: sold ? 30 : 15,
        },
        { id: 4, type: "dividend", date: "2025-04-01", amount: 2 },
    ].map((row) => ({
        investment_id: 1,
        fees: 0,
        taxes: 0,
        currency: "EUR",
        is_recurring: false,
        created_at: "",
        updated_at: "",
        ...row,
    })) as PortfolioTransaction[];
}
const included = {
    id: 5,
    investment_id: 1,
    type: "dividend",
    date: "2025-02-01",
    amount: 7,
    units: undefined,
    price_per_unit: undefined,
    fees: 0,
    taxes: 0,
    currency: "EUR",
    income_recognition_role: "included_in_units",
    is_recurring: false,
    created_at: "",
    updated_at: "",
} as PortfolioTransaction;
beforeEach(() => {
    settings.method = "weighted_avg";
    settings.multiplier = 1;
    settings.currency = "EUR";
});

describe("in-kind income frontend summary parity", () => {
    it.each(["weighted_avg", "fifo", "lifo"])(
        "keeps units, basis and gains unchanged for active and sold archived holdings under %s",
        (method) => {
            settings.method = method;
            for (const sold of [false, true]) {
                const investments = [{ ...investment, is_active: !sold }];
                const before = renderHook(() =>
                    usePortfolioSummaries({
                        investments,
                        transactions: transactions(sold),
                    }),
                );
                const after = renderHook(() =>
                    usePortfolioSummaries({
                        investments,
                        transactions: [...transactions(sold), included],
                    }),
                );
                const baseline = before.result.current.allSummaries[0];
                const summary = after.result.current.allSummaries[0];
                expect(baseline.gainLoss).toBe(sold ? 22 : 27);
                for (const key of [
                    "totalUnits",
                    "totalInvested",
                    "avgCostBasis",
                    "realizedGain",
                    "unrealizedGain",
                    "gainLoss",
                    "totalGain",
                    "currentValue",
                ] as const)
                    expect(summary[key]).toBe(baseline[key]);
                expect(summary).toMatchObject({
                    totalDividends: 2,
                    totalIncome: 2,
                    totalInKindIncome: 7,
                });
                expect(summary.transactions).toContain(included);
                expect(
                    sold
                        ? after.result.current.inactiveSummaries
                        : after.result.current.summaries,
                ).toHaveLength(1);
                before.unmount();
                after.unmount();
            }
        },
    );

    it("uses canonical dated income for active and archived holdings while keeping archived ordinary calculations local", () => {
        settings.multiplier = 2;
        const canonical = {
            id: 1,
            currency: "EUR",
            originalCurrency: "USD",
            totalUnits: 1,
            currentValue: 20,
            totalDividends: 2,
            totalIncome: 2,
            totalInKindIncome: 4.9,
            gainLoss: 27,
            realizedGain: 10,
            unrealizedGain: 15,
        } as unknown as PortfolioSummaryItem;
        const { result } = renderHook(() =>
            usePortfolioSummaries({
                investments: [
                    { ...investment, currency: "USD" },
                    { ...investment, id: 2, currency: "USD", is_active: false },
                ],
                transactions: [
                    ...transactions(),
                    included,
                    ...transactions(true).map((tx) => ({
                        ...tx,
                        investment_id: 2,
                    })),
                    { ...included, id: 6, investment_id: 2 },
                ],
                canonicalSummaries: [canonical],
                canonicalArchivedInKindIncome: [
                    { id: 2, totalInKindIncome: 4.9 },
                ],
                requireCanonical: true,
            }),
        );
        expect(result.current.summaries[0]).toMatchObject({
            summarySource: "canonical",
            totalInKindIncome: 4.9,
            totalIncome: 2,
            gainLoss: 27,
        });
        expect(result.current.inactiveSummaries[0]).toMatchObject({
            summarySource: "local",
            totalInKindIncome: 4.9,
            totalIncome: 4,
            gainLoss: 44,
        });
        expect(result.current.totals.totalPortfolioValue).toBe(20);
    });

    it.each([
        ["EUR", 7],
        ["GBP", 5.6],
    ] as const)(
        "converts archived USD income on its date to %s without changing preserved EUR units or ordinary gains",
        (currency, expected) => {
            settings.currency = currency;
            settings.multiplier = currency === "EUR" ? 1 : 0.8;
            const investments = [{ ...investment, id: 2, is_active: false }];
            const ordinary = transactions(true).map((tx) => ({
                ...tx,
                investment_id: 2,
            }));
            const literal = {
                ...included,
                id: 6,
                investment_id: 2,
                amount: 10,
                currency: "USD",
                fx_rate_to_eur: undefined,
            };
            const baseline = renderHook(() =>
                usePortfolioSummaries({ investments, transactions: ordinary }),
            );
            const { result } = renderHook(() =>
                usePortfolioSummaries({
                    investments,
                    transactions: [...ordinary, literal],
                    canonicalArchivedInKindIncome: [
                        { id: 2, totalInKindIncome: expected },
                    ],
                }),
            );
            const archived = result.current.inactiveSummaries[0];
            expect(archived.totalInKindIncome).toBe(expected);
            expect(archived.currency).toBe(currency);
            for (const key of [
                "totalUnits",
                "totalInvested",
                "avgCostBasis",
                "currentValue",
                "realizedGain",
                "unrealizedGain",
                "gainLoss",
                "totalDividends",
                "totalIncome",
            ] as const)
                expect(archived[key]).toBe(
                    baseline.result.current.inactiveSummaries[0][key],
                );
            expect(archived.transactions).toContain(literal);
            expect(result.current.summaries).toHaveLength(0);
            expect(result.current.totals.totalPortfolioValue).toBe(0);
            expect(result.current.byAssetClass("metals")).toHaveLength(0);
        },
    );

    it("leaves foreign archived income unknown when canonical dated conversion is absent, while ordinary rows keep their prior math", () => {
        const ordinary = transactions(true).map((tx) => ({
            ...tx,
            investment_id: 2,
        }));
        const { result } = renderHook(() =>
            usePortfolioSummaries({
                investments: [{ ...investment, id: 2, is_active: false }],
                transactions: [
                    ...ordinary,
                    {
                        ...included,
                        id: 6,
                        investment_id: 2,
                        amount: 10,
                        currency: "USD",
                    },
                ],
            }),
        );
        expect(result.current.inactiveSummaries[0]).toMatchObject({
            totalDividends: 2,
            totalIncome: 2,
            totalUnits: 0,
            gainLoss: 22,
        });
        expect(
            result.current.inactiveSummaries[0].totalInKindIncome,
        ).toBeUndefined();
    });

    it("uses only the dated income field when an archived canonical summary is supplied", () => {
        const { result } = renderHook(() =>
            usePortfolioSummaries({
                investments: [{ ...investment, id: 2, is_active: false }],
                transactions: [
                    ...transactions(true).map((tx) => ({
                        ...tx,
                        investment_id: 2,
                    })),
                    { ...included, id: 6, investment_id: 2, currency: "USD" },
                ],
                canonicalSummaries: [
                    {
                        id: 2,
                        totalInKindIncome: 4.9,
                        gainLoss: 999,
                        totalUnits: 99,
                    } as PortfolioSummaryItem,
                ],
            }),
        );
        expect(result.current.inactiveSummaries[0]).toMatchObject({
            totalInKindIncome: 4.9,
            gainLoss: 22,
            totalUnits: 0,
            totalDividends: 2,
        });
    });

    it("defaults absent older canonical income subtotals to zero", () => {
        const { result } = renderHook(() =>
            usePortfolioSummaries({
                investments: [investment],
                transactions: [],
                canonicalSummaries: [
                    {
                        id: 1,
                        totalUnits: 1,
                        currentValue: 20,
                        gainLoss: 10,
                    } as PortfolioSummaryItem,
                ],
                requireCanonical: true,
            }),
        );
        expect(result.current.summaries[0].totalInKindIncome).toBe(0);
    });
});
