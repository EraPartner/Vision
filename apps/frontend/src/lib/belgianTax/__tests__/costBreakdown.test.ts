import { describe, expect, it } from "vitest";
import { buildPortfolioCostBreakdowns } from "../costBreakdown";

const labels = {
    capitalGainsTax: "capital gains",
    dividendWithholding: "dividend withholding",
    transactionTax: "transaction tax",
    otherTaxes: "other taxes",
    manualTaxAdjustments: "manual taxes",
    brokerFees: "broker fees",
    managementFees: "management fees",
    otherFees: "other fees",
    manualFeeAdjustments: "manual fees",
};

describe("buildPortfolioCostBreakdowns", () => {
    it("classifies current-year taxes and fees while retaining manual adjustments", () => {
        const result = buildPortfolioCostBreakdowns({
            summaries: [
                {
                    transactions: [
                        {
                            type: "sell",
                            date: "2026-01-02",
                            taxes: 2,
                            fees: 3,
                            currency: "USD",
                        },
                        {
                            type: "dividend",
                            date: "2026-02-03",
                            taxes: 4,
                            fees: 5,
                            currency: "USD",
                        },
                        {
                            type: "tax",
                            date: "2026-03-04",
                            amount: 6,
                            currency: "USD",
                        },
                        {
                            type: "fee",
                            date: "2026-04-05",
                            amount: 7,
                            currency: "USD",
                        },
                        {
                            type: "buy",
                            date: "2025-12-31",
                            taxes: 100,
                            fees: 100,
                            currency: "USD",
                        },
                    ],
                },
            ],
            year: 2026,
            convert: (amount) => amount * 2,
            labels,
            manualTaxes: 8,
            manualFees: 9,
        });

        expect(result.taxBreakdown).toEqual([
            { name: "capital gains", value: 4 },
            { name: "dividend withholding", value: 8 },
            { name: "other taxes", value: 12 },
            { name: "manual taxes", value: 8 },
        ]);
        expect(result.feeBreakdown).toEqual([
            { name: "broker fees", value: 6 },
            { name: "management fees", value: 14 },
            { name: "other fees", value: 10 },
            { name: "manual fees", value: 9 },
        ]);
    });
});
