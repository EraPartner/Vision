import { describe, it, expect } from "vitest";
import type { BelgianTaxYearTable } from "../constants";
import {
    yearOf,
    recordedTaxesForYear,
    recordedFeesForYear,
    enrichInvestmentCosts,
    computeTobRecorded,
    computeTobAutoEstimate,
    computeTacrEstimate,
    computeRealizedGainSplit,
    computeReyndersEstimate,
    computeCgtEstimate,
    computeDividendWht,
    type PortfolioTaxInvestment,
    type ConvertFn,
} from "../portfolioTax";

// USD converts to target at 0.9; everything else is identity. Lets us assert the
// currency-conversion path without depending on the live ECB rate table.
const convert: ConvertFn = (amount, currency) =>
    currency === "USD" ? amount * 0.9 : amount;

// Only the fields the portfolio-tax estimators read. Cast to the full table type.
const baseTable = {
    dividendExemption: 1000,
    dividendWHTRate: 0.3,
    securitiesAccountTaxRate: 0.0015,
    securitiesAccountTaxThreshold: 1_000_000,
    capitalGainsTaxRate: 0,
    capitalGainsTaxExemptionSingle: 0,
    capitalGainsTaxExemptionMarried: 0,
    reyndersTaxRate: 0.3,
    tob: {
        bonds: { rate: 0.0012, cap: 1_300 },
        sharesAndOther: { rate: 0.0035, cap: 1_600 },
        accumulatingFunds: { rate: 0.0132, cap: 4_000 },
        distributingFunds: { rate: 0.0012, cap: 1_300 },
    },
} as unknown as BelgianTaxYearTable;

const table2025: BelgianTaxYearTable = baseTable;
const table2026: BelgianTaxYearTable = {
    ...baseTable,
    capitalGainsTaxRate: 0.1,
    capitalGainsTaxExemptionSingle: 10_000,
    capitalGainsTaxExemptionMarried: 20_000,
} as unknown as BelgianTaxYearTable;

const investments: PortfolioTaxInvestment[] = [
    {
        id: 1,
        assetClass: "stock",
        currency: "EUR",
        realizedGain: 500,
        currentValue: 12_000,
        transactions: [
            {
                type: "buy",
                date: "2025-03-01",
                amount: 10_000,
                taxes: 35,
                fees: 5,
            },
            {
                type: "dividend",
                date: "2025-06-01",
                amount: 200,
                taxes: 60,
                dividend_amount_convention: "net",
            },
            { type: "sell", date: "2025-09-01", taxes: 0 },
        ],
    },
    {
        id: 2,
        assetClass: "etf",
        currency: "EUR",
        realizedGain: 0,
        currentValue: 5_000,
        transactions: [
            {
                type: "buy",
                date: "2025-02-01",
                amount: 5_000,
                taxes: 0,
                fees: 2,
            },
        ],
    },
    {
        id: 3,
        assetClass: "bond",
        currency: "EUR",
        realizedGain: 300,
        currentValue: 8_000,
        transactions: [
            { type: "buy", date: "2025-01-15", amount: 8_000, taxes: 9.6 },
        ],
    },
    {
        id: 4,
        assetClass: "stock",
        currency: "USD",
        realizedGain: 200, // → 180 EUR
        currentValue: 1_000, // → 900 EUR
        transactions: [
            {
                type: "buy",
                date: "2024-12-01",
                amount: 4_000,
                taxes: 14,
                currency: "USD",
            }, // prior year — excluded
            {
                type: "dividend",
                date: "2025-05-01",
                amount: 100,
                taxes: 15,
                currency: "USD",
                dividend_amount_convention: "net",
            }, // → 90 / 13.5 EUR
        ],
    },
];

describe("yearOf", () => {
    it("parses the ISO year prefix and rejects junk", () => {
        expect(yearOf("2025-03-01")).toBe(2025);
        expect(yearOf(undefined)).toBeNull();
        expect(yearOf("not-a-date")).toBeNull();
    });
});

describe("recorded taxes/fees for a year", () => {
    it("sums per-txn taxes + explicit tax txns, scoped to the year", () => {
        expect(recordedTaxesForYear(investments[0], 2025, convert)).toBeCloseTo(
            95,
            8,
        ); // 35 + 60 + 0
        expect(recordedFeesForYear(investments[0], 2025, convert)).toBeCloseTo(
            5,
            8,
        );
        // inv 4: 2024 buy excluded; only the 2025 dividend's 15 USD → 13.5 EUR counts.
        expect(recordedTaxesForYear(investments[3], 2025, convert)).toBeCloseTo(
            13.5,
            8,
        );
    });

    it("enriches with manual adjustments", () => {
        const costs = enrichInvestmentCosts(investments[0], 2025, convert, {
            taxes: 10,
            fees: 5,
        });
        expect(costs.recordedTaxes).toBeCloseTo(95, 8);
        expect(costs.taxes).toBeCloseTo(105, 8);
        expect(costs.fees).toBeCloseTo(10, 8);
        expect(costs.total).toBeCloseTo(115, 8);
    });
});

describe("TOB", () => {
    it("sums recorded buy-leg taxes for the year", () => {
        // inv1 buy 35 + inv3 buy 9.6 (+ inv4 buy is prior year)
        expect(computeTobRecorded(investments, 2025, convert)).toBeCloseTo(
            44.6,
            8,
        );
    });

    it("estimates per-leg TOB by asset class with the per-leg cap", () => {
        // stock 10000*0.0035=35 ; etf(accum) 5000*0.0132=66 ; bond 8000*0.0012=9.6 ; inv4 buy prior year
        expect(
            computeTobAutoEstimate(investments, 2025, table2025, convert),
        ).toBeCloseTo(110.6, 8);
    });
});

describe("TACR", () => {
    it("is zero below the threshold", () => {
        expect(computeTacrEstimate(investments, table2025, convert)).toBe(0);
    });

    it("applies the rate once aggregate value crosses the threshold", () => {
        const big: PortfolioTaxInvestment[] = [
            {
                id: 9,
                assetClass: "stock",
                currency: "EUR",
                currentValue: 2_000_000,
                transactions: [],
            },
        ];
        expect(computeTacrEstimate(big, table2025, convert)).toBeCloseTo(
            3_000,
            8,
        ); // 2_000_000 * 0.0015
    });
});

describe("realized-gain split + Reynders + CGT", () => {
    it("routes gains to Reynders-interest and CGT pools (pre-2026: CGT inactive)", () => {
        const split = computeRealizedGainSplit(investments, convert, false);
        expect(split.reyndersInterest).toBeCloseTo(300, 8); // bond inv3, full portion
        expect(split.cgtGains).toBeCloseTo(680, 8); // stock 500 + stock-USD 180
        expect(computeReyndersEstimate(split, table2025)).toBeCloseTo(90, 8); // 300 * 0.30
        expect(computeCgtEstimate(split, table2025, "single", false)).toBe(0); // inactive
    });

    it("taxes CGT-pool gains above the exemption when active (2026+)", () => {
        const fixture: PortfolioTaxInvestment[] = [
            {
                id: 10,
                assetClass: "stock",
                currency: "EUR",
                realizedGain: 50_000,
                currentValue: 60_000,
                transactions: [],
            },
        ];
        const split = computeRealizedGainSplit(fixture, convert, true);
        expect(split.cgtGains).toBeCloseTo(50_000, 8);
        // single: (50000 - 10000) * 0.10
        expect(
            computeCgtEstimate(split, table2026, "single", true),
        ).toBeCloseTo(4_000, 8);
        // married: (50000 - 20000) * 0.10
        expect(
            computeCgtEstimate(split, table2026, "married_joint", true),
        ).toBeCloseTo(3_000, 8);
    });

    it("honours an explicit subjectToReynders=false override on a bond (stays out of Reynders)", () => {
        const fixture: PortfolioTaxInvestment[] = [
            {
                id: 11,
                assetClass: "bond",
                currency: "EUR",
                realizedGain: 1_000,
                subjectToReynders: false,
                currentValue: 0,
                transactions: [],
            },
        ];
        // pre-2026: direct bond under normal management → neither pool
        expect(computeRealizedGainSplit(fixture, convert, false)).toEqual({
            reyndersInterest: 0,
            cgtGains: 0,
        });
        // 2026+: direct bond enters CGT scope
        expect(computeRealizedGainSplit(fixture, convert, true)).toEqual({
            reyndersInterest: 0,
            cgtGains: 1_000,
        });
    });
});

describe("dividend withholding", () => {
    it("computes income, recorded WHT, and the exempt-bracket reclaim", () => {
        const wht = computeDividendWht(investments, 2025, table2025, convert);
        expect(wht.totalDividendIncome).toBeCloseTo(290, 8); // 200 + 90
        expect(wht.dividendWhtRecorded).toBeCloseTo(73.5, 8); // 60 + 13.5
        expect(wht.grossDividendBase).toBeCloseTo(363.5, 8);
        // reclaim = min(73.5, min(363.5, 1000)*0.30 = 109.05) = 73.5 → net cost 0
        expect(wht.dividendWhtReclaim).toBeCloseTo(73.5, 8);
        expect(wht.dividendWhtNetCost).toBe(0);
    });

    it("caps the reclaim by the exempt bracket when WHT is large", () => {
        const fixture: PortfolioTaxInvestment[] = [
            {
                id: 12,
                assetClass: "stock",
                currency: "EUR",
                currentValue: 0,
                transactions: [
                    {
                        type: "dividend",
                        date: "2025-04-01",
                        amount: 5_000,
                        taxes: 1_500,
                        dividend_amount_convention: "net",
                    },
                ],
            },
        ];
        const wht = computeDividendWht(fixture, 2025, table2025, convert);
        // grossBase = 6500; min(6500, 1000)=1000; reclaim = min(1500, 1000*0.30=300) = 300
        expect(wht.dividendWhtReclaim).toBeCloseTo(300, 8);
        expect(wht.dividendWhtNetCost).toBeCloseTo(1_200, 8); // 1500 - 300
    });

    it("doubles the exempt bracket for married_joint filers (per-taxpayer exemption)", () => {
        const fixture: PortfolioTaxInvestment[] = [
            {
                id: 12,
                assetClass: "stock",
                currency: "EUR",
                currentValue: 0,
                transactions: [
                    {
                        type: "dividend",
                        date: "2025-04-01",
                        amount: 5_000,
                        taxes: 1_500,
                        dividend_amount_convention: "net",
                    },
                ],
            },
        ];
        const wht = computeDividendWht(
            fixture,
            2025,
            table2025,
            convert,
            "married_joint",
        );
        // exemption ×2 → min(6500, 2000)=2000; reclaim = min(1500, 2000*0.30=600) = 600
        expect(wht.dividendWhtReclaim).toBeCloseTo(600, 8);
        expect(wht.dividendWhtNetCost).toBeCloseTo(900, 8); // 1500 - 600
    });

    it("uses the explicit gross or net convention and blocks estimates for unknown rows", () => {
        const gross = computeDividendWht(
            [
                {
                    id: 20,
                    assetClass: "stock",
                    currentValue: 0,
                    transactions: [
                        {
                            type: "dividend",
                            date: "2025-04-01",
                            amount: 100,
                            taxes: 30,
                            dividend_amount_convention: "gross",
                        },
                    ],
                },
            ],
            2025,
            table2025,
            convert,
        );
        expect(gross.grossDividendBase).toBe(100);
        expect(gross.unknownDividendConventionCount).toBe(0);

        const unknown = computeDividendWht(
            [
                {
                    id: 21,
                    assetClass: "stock",
                    currentValue: 0,
                    transactions: [
                        {
                            type: "dividend",
                            date: "2025-04-01",
                            amount: 70,
                            taxes: 30,
                        },
                    ],
                },
            ],
            2025,
            table2025,
            convert,
        );
        expect(unknown.totalDividendIncome).toBe(70);
        expect(unknown.grossDividendWht).toBe(30);
        expect(unknown.grossDividendBase).toBeNull();
        expect(unknown.dividendWhtReclaim).toBeNull();
        expect(unknown.dividendWhtNetCost).toBeNull();
        expect(unknown.unknownDividendConventionCount).toBe(1);
    });
});
