// Scenario verification matrix, part 5: properties that follow from the law for every input.
//  - IN-01 (arts 87-88, 126 §1, 134): without dependants, a joint assessment never yields more
//    PIT than the same couple assessed separately. The quotient applies only when it lowers the
//    tax and the art. 134 balance transfer only adds exemption; everything else is per spouse.
//  - IN-02 (art. 126 §1 al. 2, art. 130): per-partner figures add up to the household totals.
//  - IN-03 (art. 134): an exemption balance leaves one partner and reaches the other unchanged;
//    the quotient moves income without creating or losing any.
//  - IN-04: one partner with one activity equals computeBelgianPIT (golden parity harness).

import { describe, expect, test } from "vitest";
import fc from "fast-check";
import { computeHouseholdTax } from "../household";
import type { BelgianRegion } from "../types";
import type { BelgianTaxHouseholdV2, HouseholdTaxResult } from "../householdTypes";
import { activity, event, household, partner } from "./testHousehold";
import { compareParity } from "./householdParity";
import { makeTaxProfile } from "./testProfile";

const money = (max: number) =>
    fc.oneof(fc.constant(0), fc.integer({ min: 0, max: max * 100 }).map((c) => c / 100));

interface CoupleInput {
    taxYear: number;
    region: BelgianRegion;
    surcharge: number;
    aEmployee: number;
    aNet: number;
    bEmployee: number;
    bNet: number;
    bOther: number;
    aAlimony: number;
    pension: number;
}

const coupleArb: fc.Arbitrary<CoupleInput> = fc.record({
    taxYear: fc.constantFrom(2024, 2025, 2026),
    region: fc.constantFrom<BelgianRegion>("flanders", "wallonia", "brussels"),
    surcharge: fc.integer({ min: 0, max: 9 }),
    aEmployee: money(150_000),
    aNet: money(60_000),
    bEmployee: money(60_000),
    bNet: money(30_000),
    bOther: fc.oneof(fc.constant(0), money(40_000)),
    aAlimony: fc.oneof(fc.constant(0), money(15_000)),
    pension: fc.oneof(fc.constant(0), money(1_350)),
});

function couple(input: CoupleInput, unionDate: string): BelgianTaxHouseholdV2 {
    const reductions = {
        personalPensionContributions: input.pension,
        pensionEligible: input.pension > 0,
        lifeInsurancePremiums: 0,
        charitableDonations: 0,
        childcareCosts: 0,
        medicalExpenses: 0,
    };
    return household(
        [
            partner(
                "A",
                [activity("employee", input.aEmployee), activity("net_professional_amount", input.aNet)],
                { alimonyPaid: input.aAlimony, reductions },
            ),
            partner(
                "B",
                [activity("employee", input.bEmployee), activity("net_professional_amount", input.bNet)],
                { otherTaxableIncome: input.bOther },
            ),
        ],
        {
            taxYear: input.taxYear,
            region: input.region,
            communalSurchargePercent: input.surcharge,
            relationship: { events: [event("marriage", unionDate)] },
        },
    );
}

const sum = (r: HouseholdTaxResult, pick: (p: HouseholdTaxResult["partners"][number]) => number) =>
    r.partners.reduce((acc, p) => acc + pick(p), 0);

const close = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

describe("scenario matrix: invariants", () => {
    test("IN-01 joint PIT never exceeds separate PIT without dependants (arts 87-88, 134)", () => {
        fc.assert(
            fc.property(coupleArb, (input) => {
                const joint = computeHouseholdTax(couple(input, "2015-05-02"));
                const separate = computeHouseholdTax(couple(input, `${input.taxYear}-06-01`));
                expect(joint.assessment.mode).toBe("joint");
                expect(separate.assessment.mode).toBe("separate");
                expect(joint.totals.totalPIT).toBeLessThanOrEqual(separate.totals.totalPIT + 1e-6);
                if (joint.quotient.applied) expect(joint.quotient.benefit).toBeGreaterThan(0);
            }),
            { numRuns: 300 },
        );
    });

    test("IN-02 per-partner figures sum to the household totals (art. 126 §1 al. 2, art. 130)", () => {
        fc.assert(
            fc.property(coupleArb, fc.boolean(), (input, joint) => {
                const r = computeHouseholdTax(couple(input, joint ? "2015-05-02" : `${input.taxYear}-06-01`));
                expect(close(sum(r, (p) => p.totalPIT), r.totals.totalPIT)).toBe(true);
                expect(close(sum(r, (p) => p.taxableIncome), r.totals.taxableIncome)).toBe(true);
                expect(close(sum(r, (p) => p.federalPITAfterReductions), r.totals.federalPITAfterReductions)).toBe(true);
                expect(close(sum(r, (p) => p.specialSocialSecurityContribution), r.csss.total)).toBe(true);
                expect(close(sum(r, (p) => p.employeeSocialSecurity), r.totals.employeeSocialSecurity)).toBe(true);
            }),
            { numRuns: 300 },
        );
    });

    test("IN-03 exemption balances and quotient transfers are conserved (art. 134, arts 87-88)", () => {
        fc.assert(
            fc.property(coupleArb, (input) => {
                const r = computeHouseholdTax(couple(input, "2015-05-02"));
                expect(close(sum(r, (p) => p.exemption.transferredIn), sum(r, (p) => p.exemption.transferredOut))).toBe(true);
                expect(close(sum(r, (p) => p.quotientAdjustment), 0)).toBe(true);
            }),
            { numRuns: 300 },
        );
    });

    test.each([
        ["employee", makeTaxProfile({ employmentType: "employee", grossAnnualIncome: 50_000 })],
        ["civil servant", makeTaxProfile({ employmentType: "civil_servant", grossAnnualIncome: 50_000 })],
        ["director", makeTaxProfile({ employmentType: "director", grossAnnualIncome: 60_000 })],
        ["trading profits", makeTaxProfile({ employmentType: "self_employed", selfEmployedIncomeKind: "profits", grossAnnualIncome: 40_000 })],
        ["fees", makeTaxProfile({ employmentType: "self_employed", selfEmployedIncomeKind: "fees", grossAnnualIncome: 30_000 })],
        ["pension", makeTaxProfile({ employmentType: "retired", grossAnnualIncome: 25_000 })],
        ["IY 2024 dependants", makeTaxProfile({ taxYear: 2024, dependentChildren: 1, dependentChildrenDisabled: 1, dependentOtherPersons: 1 })],
        ["IY 2026 Walloon chèque habitat", makeTaxProfile({ taxYear: 2026, region: "wallonia", dependentChildren: 1, mortgageIsPrimaryResidence: true, mortgageInterestPaid: 4_000, mortgageStartYear: 2016 })],
        ["Brussels service vouchers", makeTaxProfile({ region: "brussels", serviceVoucherEligible: true, serviceVoucherSpend: 2_000 })],
    ] as const)("IN-04 one partner equals computeBelgianPIT: %s", (_name, profile) => {
        const outcome = compareParity(profile);
        expect(outcome.exclusion).toBeUndefined();
        expect(outcome.difference).toBeUndefined();
    });
});
