// Scenario verification matrix, part 4: regions. State/regional factor, Flemish woonbonus,
// Walloon chèque habitat, service vouchers per region and income year. Single employee earning
// 50,000 gross unless stated (IY 2025: net 37,535, tax 13,002.75; IY 2026: net 37,395, tax
// 12,844.25; see part 1).

import { expect } from "vitest";
import { activity, household, partner } from "./testHousehold";
import { eur, runScenarios, type Scenario } from "./scenarioMatrix";
import type { BelgianRegion } from "../types";
import type { BelgianTaxHouseholdV2, HouseholdHomeInputs, PartnerReductionInputs } from "../householdTypes";

const employee = (
    gross: number,
    extra: Partial<BelgianTaxHouseholdV2> = {},
    reductions?: PartnerReductionInputs,
): BelgianTaxHouseholdV2 =>
    household(
        [partner("A", [activity("employee", gross)], reductions ? { reductions } : {})],
        extra,
    );

const home = (h: Partial<HouseholdHomeInputs>): HouseholdHomeInputs => ({
    cadastralIncome: 0,
    mortgageInterestPaid: 0,
    mortgageIsPrimaryResidence: true,
    ...h,
});

const vouchers = (spend: number): PartnerReductionInputs => ({
    personalPensionContributions: 0,
    lifeInsurancePremiums: 0,
    charitableDonations: 0,
    childcareCosts: 0,
    medicalExpenses: 0,
    serviceVoucherEligible: true,
    serviceVoucherSpend: spend,
});

const chequeHabitat = (taxYear: number, firstQualifyingYear?: number): BelgianTaxHouseholdV2 =>
    employee(50_000, {
        taxYear,
        region: "wallonia",
        communalSurchargePercent: 7.5,
        dependents: { children: 1, otherPersons: 0 },
        home: home({
            mortgageInterestPaid: 4_000,
            mortgageCapitalRepaid: 2_000,
            mortgageStartYear: 2016,
            ...(firstQualifyingYear !== undefined ? { firstQualifyingYear } : {}),
        }),
    });

/** Service-voucher reduction expected per region and income year for a 2,000 spend. */
const VOUCHER_TABLE: ReadonlyArray<[number, BelgianRegion, number, string]> = [
    // IY 2024: all three regions 1,790 cap (W2). Flanders 20%, Wallonia 30%, Brussels 15%.
    [2024, "flanders", 0.2 * 1_790, "20% × 1,790 = 358"],
    [2024, "wallonia", 0.3 * 1_790, "30% × 1,790 = 537"],
    [2024, "brussels", 0.15 * 1_790, "15% × 1,790 = 268.50"],
    // IY 2025: Flanders abolished (C20); Wallonia and Brussels cap 1,850 (W2).
    [2025, "flanders", 0, "abolished"],
    [2025, "wallonia", 0.3 * 1_850, "30% × 1,850 = 555"],
    [2025, "brussels", 0.15 * 1_850, "15% × 1,850 = 277.50"],
    // IY 2026: Wallonia cap 1,890 (W2); Brussels abolished from AY 2027 (C34).
    [2026, "flanders", 0, "abolished"],
    [2026, "wallonia", 0.3 * 1_890, "30% × 1,890 = 567"],
    [2026, "brussels", 0, "abolished"],
];

const REGION_SCENARIOS: Scenario[] = [
    {
        id: "RG-01",
        description: "Brussels factor 0.9950 on the tax after reductions, IY 2025",
        rows: ["factor-brussels", "surcharge"],
        articles: "Special finance law arts 5/2, 81quater; BQ104 (Brussels opcentiemen 32.591%)",
        status: "verified",
        household: employee(50_000, { region: "brussels" }),
        verify: (r) => {
            // 10,275.25 × 0.995 × 1.07 = 10,939.5449125
            eur(r.partners[0]?.federalPITAfterReductions, 10_275.25 * 0.995);
            eur(r.totals.totalPIT, 10_939.5449125);
        },
    },
    {
        id: "RG-02",
        description: "Wallonia factor 1.0000 with a 7.5% communal surcharge, IY 2025",
        rows: ["factor-flanders-wallonia", "surcharge"],
        articles: "Walloon decree 13-12-2017 art. 33; WIB 92 arts 465-469",
        status: "verified",
        household: employee(50_000, { region: "wallonia", communalSurchargePercent: 7.5 }),
        verify: (r) => {
            // 10,275.25 × 1.075 = 11,045.89375
            eur(r.totals.totalPIT, 11_045.89375);
        },
    },
    {
        id: "RG-03",
        description: "Brussels: regional reduction deducted before the 0.9950 factor",
        rows: ["factor-brussels", "service-voucher-brussels"],
        articles: "Special finance law art. 5/2 (where federal and regional reductions are charged)",
        status: "needs_source",
        missing:
            "Whether regional reductions (art. 145/21) come off the regional surcharge and federal ones off the reduced state tax, instead of the whole tax before the combined factor; the matrix does not carry this ordering",
        household: employee(50_000, { region: "brussels" }, vouchers(2_000)),
        verify: (r) => {
            // Sourced part only: Brussels IY 2025 15% × 1,850 = 277.50.
            eur(r.partners[0]?.reductions.serviceVouchers, 277.5);
        },
    },
    {
        id: "RG-04",
        description: "Flemish woonbonus, loan of 2012, IY 2024: base 2,280 at the 45% marginal rate",
        rows: ["woonbonus-pre2015", "woonbonus-extra", "brackets"],
        articles: "WIB 92 Flemish art. 145/37 §2; art. 178 §5, 4° (not indexed)",
        status: "verified",
        household: employee(60_000, {
            taxYear: 2024,
            home: home({ mortgageInterestPaid: 6_000, mortgageCapitalRepaid: 2_000, mortgageStartYear: 2012 }),
        }),
        verify: (r) => {
            // net 46,408 (SC-11 base: SS 7,842, cap 5,750) → highest rate 45% (27,920-48,320)
            // twelfth period → no +760; min(8,000, 2,280) × 45% = 1,026
            // 14,472.10 − 1,026 = 13,446.10 × 1.07 = 14,387.327
            eur(r.partners[0]?.ownHomeCredit, 1_026);
            eur(r.totals.totalPIT, 14_387.327);
        },
    },
    {
        id: "RG-05",
        description: "integrated woonbonus, loan of 2018, three children, IY 2025",
        rows: ["woonbonus-integrated", "woonbonus-extra", "children-supplements"],
        articles: "WIB 92 Flemish art. 145/38/2 §§2-3; art. 132 al. 1, 3°",
        status: "verified",
        household: employee(50_000, {
            dependents: { children: 3, otherPersons: 0 },
            home: home({ mortgageInterestPaid: 3_000, mortgageCapitalRepaid: 3_000, mortgageStartYear: 2018 }),
        }),
        verify: (r) => {
            // eighth period: 1,520 + 760 + 80 (3+ children) = 2,360 × 40% = 944
            // exemption 10,910 + 11,440 = 22,350 → 6,735 (JD-01); 13,002.75 − 6,735 = 6,267.75
            // − 944 = 5,323.75 × 1.07 = 5,696.4125
            eur(r.partners[0]?.ownHomeCredit, 944);
            eur(r.totals.totalPIT, 5_696.4125);
        },
    },
    {
        id: "RG-14",
        description: "Flemish woonbonus, loan signed in 2015, eleventh period (IY 2025): base 1,520 at 40%",
        rows: ["woonbonus-2015", "woonbonus-extra"],
        articles: "WIB 92 Flemish art. 145/37 §3",
        status: "verified",
        household: employee(50_000, {
            home: home({ mortgageInterestPaid: 3_000, mortgageCapitalRepaid: 3_000, mortgageStartYear: 2015 }),
        }),
        verify: (r) => {
            // 2025 − 2015 = 10 → eleventh period, no +760; min(6,000, 1,520) × 40% = 608
            eur(r.partners[0]?.ownHomeCredit, 608);
        },
    },
    {
        id: "RG-06",
        description: "no woonbonus for a Flemish loan signed in 2020",
        rows: ["woonbonus-post2020"],
        articles: "FPS circular 2026/C/63",
        status: "verified",
        household: employee(50_000, {
            home: home({ mortgageInterestPaid: 3_000, mortgageStartYear: 2020 }),
        }),
        verify: (r) => {
            expect(r.partners[0]?.ownHomeCreditRegime).toBe("none");
            eur(r.partners[0]?.ownHomeCredit, 0);
        },
    },
    {
        id: "RG-07",
        description: "chèque habitat, tenth period (IY 2025): full amount between the income limits",
        rows: ["cheque-habitat-formula", "cheque-habitat-periods", "children-supplements"],
        articles: "WIB 92 Walloon art. 145/46ter §§2-4 (N26 limits 27,353 / 105,503)",
        status: "verified",
        household: chequeHabitat(2025, 2016),
        verify: (r) => {
            // 1,520 − (37,535 − 27,353) × 1.275% (129.8205) = 1,390.1795 + 125 (one child)
            //   = 1,515.1795 ≤ paid 6,000
            // exemption 10,910 + 1,980 = 12,890 → 3,294; 13,002.75 − 3,294 = 9,708.75
            // − 1,515.1795 = 8,193.5705 × 1.075 = 8,808.0882875
            eur(r.partners[0]?.ownHomeCredit, 1_515.1795);
            eur(r.totals.totalPIT, 8_808.0882875);
        },
    },
    {
        id: "RG-08",
        description: "chèque habitat, eleventh period (IY 2026): halved",
        rows: ["cheque-habitat-formula", "cheque-habitat-periods", "children-supplements"],
        articles: "WIB 92 Walloon art. 145/46ter §3 (N27 limits 28,024 / 108,093)",
        status: "verified",
        household: chequeHabitat(2026, 2016),
        verify: (r) => {
            // (1,520 − (37,395 − 28,024) × 1.275% (119.48025) + 125) / 2 = 762.759875
            // exemption 11,550 + 2,130 = 13,680 → 2,937.50 + 1,930 × 30% (579) = 3,516.50
            // 12,844.25 − 3,516.50 = 9,327.75 − 762.759875 = 8,564.990125 × 1.075
            //   = 9,207.364384375
            eur(r.partners[0]?.ownHomeCredit, 762.759875);
            eur(r.totals.totalPIT, 9_207.364384375);
        },
    },
    {
        id: "RG-09",
        description: "chèque habitat: nothing from the twenty-first period (first period 2016 → income 2036)",
        rows: ["cheque-habitat-periods"],
        articles: "WIB 92 Walloon art. 145/46quinquies (twenty assessment years)",
        status: "verified",
        // IY 2036 runs on the latest (IY 2026) table; only the zero credit is asserted, which
        // does not depend on any amount.
        household: chequeHabitat(2036, 2016),
        verify: (r) => {
            expect(r.partners[0]?.ownHomeCreditRegime).toBe("walloon_cheque_habitat");
            eur(r.partners[0]?.ownHomeCredit, 0);
        },
    },
    {
        id: "RG-10",
        description: "chèque habitat: nothing before the first qualifying year",
        rows: ["cheque-habitat-periods"],
        articles: "WIB 92 Walloon art. 145/46quinquies",
        status: "verified",
        household: chequeHabitat(2025, 2026),
        verify: (r) => {
            eur(r.partners[0]?.ownHomeCredit, 0);
        },
    },
    {
        id: "RG-11",
        description: "chèque habitat: loans signed from 1 January 2025 do not qualify",
        rows: ["cheque-habitat-loans"],
        articles: "WIB 92 Walloon art. 145/46quater §1, 3° (decree of 5 Dec 2024); FPS circular 2026/C/18",
        status: "verified",
        household: employee(50_000, {
            taxYear: 2025,
            region: "wallonia",
            home: home({ mortgageInterestPaid: 4_000, mortgageStartYear: 2025 }),
        }),
        verify: (r) => {
            expect(r.partners[0]?.ownHomeCreditRegime).toBe("none");
        },
    },
    ...VOUCHER_TABLE.map(([year, region, expected, arithmetic]): Scenario => ({
        id: `SV-${year}-${region}`,
        description: `service vouchers, ${region}, IY ${year}, spend 2,000: ${arithmetic}`,
        rows: ["service-voucher-rule", `service-voucher-${region}`],
        articles: "WIB 92 art. 145/21 (regional versions); FPS circulars 2025/C/20, 2026/C/34",
        status: "verified",
        household: employee(50_000, { taxYear: year, region }, vouchers(2_000)),
        verify: (r) => {
            eur(r.partners[0]?.reductions.serviceVouchers, expected);
        },
    })),
    {
        id: "SV-W-TOTAL",
        description: "Wallonia IY 2025: service-voucher reduction in the final tax",
        rows: ["service-voucher-wallonia", "factor-flanders-wallonia"],
        articles: "WIB 92 Walloon art. 145/21",
        status: "verified",
        household: employee(50_000, { region: "wallonia", communalSurchargePercent: 7.5 }, vouchers(2_000)),
        verify: (r) => {
            // 10,275.25 − 555 = 9,720.25 × 1.0000 × 1.075 = 10,449.26875
            eur(r.totals.totalPIT, 10_449.26875);
        },
    },
];

runScenarios("scenario matrix: regions", REGION_SCENARIOS);
