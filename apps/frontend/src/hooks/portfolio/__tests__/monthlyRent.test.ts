import { describe, expect, it } from "vitest";
import { monthlyRentInTarget } from "../monthlyRent";
import type { InvestmentSummary } from "@/types/portfolio";

const property = (transactions: unknown[]) =>
    ({
        currency: "EUR",
        originalCurrency: "USD",
        transactions,
    }) as InvestmentSummary;
const convert = (amount: number, currency: string) =>
    currency === "EUR" ? amount : currency === "USD" ? amount * 0.8 : undefined;

describe("monthly rent booking currency", () => {
    it("converts the most recent foreign rent even when summary amounts are already EUR", () => {
        expect(
            monthlyRentInTarget(
                property([
                    {
                        id: 1,
                        date: "2026-01-01",
                        type: "rent_income",
                        amount: 500,
                        currency: "EUR",
                    },
                    {
                        id: 2,
                        date: "2026-02-01",
                        type: "rent_income",
                        amount: 1000,
                        currency: "USD",
                    },
                ]),
                convert,
            ),
        ).toBe(800);
    });
    it("preserves same-currency rent and falls back to the original investment currency", () => {
        expect(
            monthlyRentInTarget(
                property([
                    {
                        id: 1,
                        date: "2026-01-01",
                        type: "rent_income",
                        amount: 1000,
                        currency: "EUR",
                    },
                ]),
                convert,
            ),
        ).toBe(1000);
        expect(
            monthlyRentInTarget(
                property([
                    {
                        id: 1,
                        date: "2026-01-01",
                        type: "rent_income",
                        amount: 1000,
                    },
                ]),
                convert,
            ),
        ).toBe(800);
    });
    it("distinguishes missing rates from zero rental income", () => {
        expect(
            monthlyRentInTarget(
                property([
                    {
                        id: 1,
                        date: "2026-01-01",
                        type: "rent_income",
                        amount: 1000,
                        currency: "XYZ",
                    },
                ]),
                convert,
            ),
        ).toBeUndefined();
        expect(monthlyRentInTarget(property([]), convert)).toBe(0);
    });
});
