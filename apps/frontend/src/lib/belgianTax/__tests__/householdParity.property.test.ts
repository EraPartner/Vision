// Property-based parity between the v1 engine (computeBelgianPIT) and the household engine
// (upgrade → computeHouseholdTax → toBelgianTaxCalculation). Every generated profile must match
// unless one of the documented exclusions in householdParity.ts applies.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { compareParity } from "./householdParity";
import { makeTaxProfile } from "./testProfile";
import type { BelgianTaxProfile } from "../types";

const money = (max: number) =>
    fc.oneof(fc.constant(0), fc.integer({ min: 0, max: max * 100 }).map((c) => c / 100));

const profileArb: fc.Arbitrary<BelgianTaxProfile> = fc
    .record({
        taxYear: fc.constantFrom(2024, 2025, 2026),
        employmentType: fc.constantFrom(
            "employee",
            "civil_servant",
            "director",
            "self_employed",
            "retired",
            "other",
        ),
        selfEmployedIncomeKind: fc.constantFrom("profits", "fees"),
        grossAnnualIncome: money(250_000),
        professionalExpenseMethod: fc.constantFrom("lump_sum", "actual"),
        actualProfessionalExpenses: money(20_000),
        unionDues: money(600),
        otherTaxableIncome: fc.oneof(fc.constant(0), fc.constant(0), money(30_000)),
        alimonyPaid: fc.oneof(fc.constant(0), fc.constant(0), money(10_000)),
        region: fc.constantFrom("flanders", "wallonia", "brussels"),
        communalSurchargePercent: fc.integer({ min: 0, max: 9 }),
        dependentChildren: fc.integer({ min: 0, max: 6 }),
        dependentChildrenUnder3: fc.integer({ min: 0, max: 2 }),
        dependentChildrenDisabled: fc.integer({ min: 0, max: 1 }),
        dependentOtherPersons: fc.integer({ min: 0, max: 2 }),
        isDisabled: fc.boolean(),
        isSpouseDisabled: fc.constantFrom(false, false, false, false, true),
        isIsolatedParent: fc.constantFrom(false, false, false, true),
        filingStatus: fc.constantFrom("single", "married_joint"),
        spouseProfessionalIncome: money(120_000),
        pensionEligible: fc.boolean(),
        personalPensionContributions: money(1_500),
        charitableDonationsEligible: fc.boolean(),
        charitableDonations: money(3_000),
        childcareEligible: fc.boolean(),
        childcareCosts: money(4_000),
        childcareEligibleDays: fc.integer({ min: 0, max: 250 }),
        serviceVoucherEligible: fc.boolean(),
        serviceVoucherCount: fc.integer({ min: 0, max: 200 }),
        cadastralIncome: money(3_000),
        mortgageIsPrimaryResidence: fc.boolean(),
        mortgageInterestPaid: money(8_000),
        mortgageStartYear: fc.integer({ min: 2005, max: 2026 }),
        mortgageRegion: fc.constantFrom("flanders", "wallonia", "brussels"),
        annualDividendIncome: money(5_000),
        annualSavingsInterest: money(3_000),
    })
    .map((r) => makeTaxProfile(r as Partial<BelgianTaxProfile>));

describe("household engine parity with computeBelgianPIT", () => {
    it("matches every generated profile outside the documented exclusions", () => {
        let compared = 0;
        let comparedJoint = 0;
        fc.assert(
            fc.property(profileArb, (profile) => {
                const outcome = compareParity(profile);
                if (outcome.exclusion) return true;
                compared++;
                if (profile.filingStatus === "married_joint") comparedJoint++;
                expect(outcome.difference).toBeUndefined();
                return true;
            }),
            { numRuns: 600, seed: 20261011 },
        );
        // The exclusions must stay narrow: a large share of profiles, joint ones included, is
        // compared (about 210 of 600 with this seed; the generator biases towards exclusions).
        expect(compared).toBeGreaterThan(150);
        expect(comparedJoint).toBeGreaterThan(20);
    });

    it("one partner with one activity reproduces computeBelgianPIT on single profiles", () => {
        fc.assert(
            fc.property(
                profileArb.map((p) => ({ ...p, filingStatus: "single" as const, isSpouseDisabled: false })),
                (profile) => {
                    const outcome = compareParity(profile);
                    // Only the two single-partner exclusions can apply to a single filer.
                    expect([undefined, "category_loss", "union_dues_outside_remuneration"]).toContain(
                        outcome.exclusion,
                    );
                    if (!outcome.exclusion) expect(outcome.difference).toBeUndefined();
                },
            ),
            { numRuns: 400, seed: 7 },
        );
    });
});
