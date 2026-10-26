import { describe, expect, test } from "vitest";
import { computeHouseholdTax, toBelgianTaxCalculation } from "../../src/belgianTax/household.ts";
import { computeBelgianPIT } from "../../src/belgianTax/pit.ts";
import { upgradeProfileV1ToHousehold } from "../../src/belgianTax/householdMigration.ts";
import { activity, household, married, partner } from "./testHousehold.ts";
import { makeTaxProfile } from "./testProfile.ts";
import { must } from "../helpers/must.ts";

const single = (...activities: ReturnType<typeof activity>[]) =>
    computeHouseholdTax(household([partner("A", activities)]));

describe("activities and forfait categories (IY 2025)", () => {
    test("two part-time jobs share one remuneration forfait at the cap (art. 51 al. 3)", () => {
        // 20,000 + 15,000 gross; contributions 13.07% = 4,574.50; base 30,425.50; 30% = 9,127.65
        // → capped once at 5,930 (two separate forfaits would have given 5,215.80 + 3,911.85).
        const r = single(activity("employee", 20_000), activity("employee", 15_000));
        const a = must(r.partners[0], "partners[0]");
        expect(a.categories).toHaveLength(1);
        expect(a.professionalExpenses).toBe(5_930);
        expect(a.employeeSocialSecurity).toBeCloseTo(4_574.5, 9);
        expect(a.netProfessionalIncome).toBeCloseTo(30_425.5 - 5_930, 9);
        // Allocated pro rata to the activities.
        expect(must(a.activities[0], "activities[0]").professionalExpenses + must(a.activities[1], "activities[1]").professionalExpenses).toBeCloseTo(5_930, 9);
    });

    test("employee 40k + trading profits 15k: separate categories, each with its own forfait", () => {
        // Employee: 40,000 − 5,228 = 34,772 → forfait 5,930 → 28,842.
        // Profits: 15,000 → 30% = 4,500 → 10,500. Total 39,342.
        const r = single(activity("employee", 40_000), activity("self_employed_profits", 15_000));
        const a = must(r.partners[0], "partners[0]");
        expect(a.categories.map((c) => [c.category, c.professionalExpenses])).toEqual([
            ["remuneration", 5_930],
            ["profits", 4_500],
        ]);
        expect(a.netProfessionalIncome).toBeCloseTo(39_342, 9);
        expect(r.issues).toContainEqual({ code: "forfait_category_aggregation_unverified", severity: "needs_source", partnerId: "A" });
        expect(r.issues).toContainEqual({ code: "csss_mixed_activity_base_unverified", severity: "needs_source", partnerId: "A" });
        // CSSS single scale on 39,342: 335.50 + 4.009% × (39,342 − 37,344).
        expect(r.csss.total).toBeCloseTo(335.5 + 0.04009 * (39_342 - 37_344), 9);
    });

    test("helping spouse: 5% forfait (art. 51 al. 2, 3°) after the art. 52, 7° contributions, fees cap", () => {
        const r = single(activity("helping_spouse", 30_000, { socialContributionsPaid: 3_000 }));
        expect(must(r.partners[0], "partners[0]").professionalExpenses).toBeCloseTo(1_350, 9);
        expect(must(r.partners[0], "partners[0]").netProfessionalIncome).toBeCloseTo(25_650, 9);
        const capped = single(activity("helping_spouse", 200_000));
        expect(must(capped.partners[0], "partners[0]").professionalExpenses).toBe(5_210);
    });

    test("self-employed contributions come off the gross before the forfait (art. 52, 7°)", () => {
        // 40,000 − 8,000 = 32,000; 30% = 9,600 → cap 5,930; net 26,070.
        const r = single(activity("self_employed_profits", 40_000, { socialContributionsPaid: 8_000 }));
        expect(must(must(r.partners[0], "partners[0]").activities[0], "activities[0]").socialContributionsPaid).toBe(8_000);
        expect(must(r.partners[0], "partners[0]").netProfessionalIncome).toBeCloseTo(26_070, 9);
    });

    test("pension: no social security, no forfait, no CSSS", () => {
        const r = single(activity("pension", 25_000));
        const a = must(r.partners[0], "partners[0]");
        expect(a.employeeSocialSecurity).toBe(0);
        expect(a.professionalExpenses).toBe(0);
        expect(a.netProfessionalIncome).toBe(25_000);
        expect(a.csssSubject).toBe(false);
        expect(r.csss.total).toBe(0);
    });

    test("actual expenses above the income: category clamped at 0 with a warning", () => {
        const h = household([
            partner("A", [activity("employee", 10_000)], {
                professionalExpenses: { remuneration: { method: "actual", actualAmount: 20_000 } },
                otherTaxableIncome: 5_000,
            }),
        ]);
        const r = computeHouseholdTax(h);
        expect(must(r.partners[0], "partners[0]").netProfessionalIncome).toBe(0);
        expect(must(r.partners[0], "partners[0]").taxableIncome).toBe(5_000);
        expect(r.issues).toContainEqual({ code: "loss_offset_not_modelled", severity: "warning", partnerId: "A" });
    });

    test("union dues deduct only inside an actual remuneration claim", () => {
        const lump = household([partner("A", [activity("employee", 40_000)], { unionDues: 200 })]);
        expect(must(computeHouseholdTax(lump).partners[0], "partners[0]").unionDuesApplied).toBe(0);
        const actual = household([
            partner("A", [activity("employee", 40_000)], {
                unionDues: 200,
                professionalExpenses: { remuneration: { method: "actual", actualAmount: 1_000 } },
            }),
        ]);
        expect(must(computeHouseholdTax(actual).partners[0], "partners[0]").professionalExpenses).toBe(1_200);
    });
});

describe("special social security contribution", () => {
    test("joint: A employee + B self-employed → joint scale on the household income", () => {
        // A: 50,000 − 6,535 − 5,930 = 37,535. B profits: 20,000 − 5,930 = 14,070. Base 51,605.
        // Joint tier 3: 123.95 + 1.3% × (51,605 − 21,070.96).
        const r = computeHouseholdTax(
            married([activity("employee", 50_000)], [activity("self_employed_profits", 20_000)]),
        );
        expect(r.csss.scale).toBe("joint");
        expect(r.csss.base).toBeCloseTo(51_605, 9);
        const expected = 123.95 + 0.013 * (51_605 - 21_070.96);
        expect(r.csss.total).toBeCloseTo(expected, 9);
        expect(must(r.partners[0], "partners[0]").specialSocialSecurityContribution).toBeCloseTo((expected * 37_535) / 51_605, 9);
        expect(must(r.partners[1], "partners[1]").specialSocialSecurityContribution).toBeCloseTo((expected * 14_070) / 51_605, 9);
    });

    test("PwC AY 2026 sample: joint household base 44,070 → €422.94", () => {
        const profile = makeTaxProfile({
            grossAnnualIncome: 57_517.59,
            dependentChildren: 2,
            filingStatus: "married_joint",
            spouseProfessionalIncome: 0,
        });
        const r = computeHouseholdTax(upgradeProfileV1ToHousehold(profile));
        expect(r.csss.base).toBeCloseTo(44_070, 0);
        expect(r.csss.total).toBeCloseTo(422.94, 1);
    });

    test("separate: each subject partner on the single scale", () => {
        const h = household(
            [partner("A", [activity("employee", 50_000)]), partner("B", [activity("self_employed_fees", 50_000)])],
        );
        const r = computeHouseholdTax(h);
        expect(r.assessment.mode).toBe("separate");
        expect(r.csss.scale).toBe("single");
        expect(must(r.partners[1], "partners[1]").specialSocialSecurityContribution).toBe(0);
    });
});

describe("household assembly", () => {
    test("one partner with one activity equals computeBelgianPIT", () => {
        const profile = makeTaxProfile({ grossAnnualIncome: 62_000, dependentChildren: 1, otherTaxableIncome: 3_000 });
        const v2 = upgradeProfileV1ToHousehold(profile);
        expect(toBelgianTaxCalculation(computeHouseholdTax(v2), v2)).toEqual(computeBelgianPIT(profile));
    });

    test("reductions stay with the partner who paid them under a joint assessment", () => {
        const h = married([activity("employee", 50_000)], [activity("employee", 30_000)]);
        must(h.partners[1], "partners[1]").reductions = { ...must(h.partners[1], "partners[1]").reductions, pensionEligible: true, personalPensionContributions: 1_050 };
        const r = computeHouseholdTax(h);
        expect(must(r.partners[1], "partners[1]").reductions.pension).toBeCloseTo(315, 9);
        expect(must(r.partners[0], "partners[0]").reductions.pension).toBe(0);
        expect(r.issues).toContainEqual({ code: "joint_reduction_allocation_unverified", severity: "needs_source" });
    });

    test("service-voucher spend is capped per partner (art. 145/21, Wallonia IY 2025: 30% up to €1,850)", () => {
        const h = married([activity("employee", 50_000)], [activity("employee", 30_000)]);
        h.region = "wallonia";
        must(h.partners[0], "partners[0]").reductions = { ...must(h.partners[0], "partners[0]").reductions, serviceVoucherEligible: true, serviceVoucherSpend: 3_000 };
        must(h.partners[1], "partners[1]").reductions = { ...must(h.partners[1], "partners[1]").reductions, serviceVoucherEligible: true, serviceVoucherCount: 50 };
        const r = computeHouseholdTax(h);
        expect(must(r.partners[0], "partners[0]").reductions.serviceVouchers).toBeCloseTo(1_850 * 0.3, 9);
        // Legacy count × €10 = €500 spend.
        expect(must(r.partners[1], "partners[1]").reductions.serviceVouchers).toBeCloseTo(500 * 0.3, 9);
    });

    test("own-home credit uses the claiming partner's income (Walloon chèque habitat phase-out)", () => {
        const h = married([activity("employee", 15_000)], [activity("employee", 60_000)]);
        h.region = "wallonia";
        h.home = {
            ...h.home,
            mortgageIsPrimaryResidence: true,
            mortgageStartYear: 2018,
            mortgageInterestPaid: 4_000,
            mortgageCreditPartnerId: "B",
        };
        const r = computeHouseholdTax(h);
        const b = must(r.partners[1], "partners[1]");
        expect(b.ownHomeCredit).toBeCloseTo(
            1_520 - (b.taxableIncomeBeforeQuotient - 27_353) * 0.01275,
            9,
        );
        expect(must(r.partners[0], "partners[0]").ownHomeCredit).toBe(0);
    });

    test("chèque habitat counts its periods from home.firstQualifyingYear, else from the loan year", () => {
        const h = household([partner("A", [activity("employee", 20_000)])]);
        h.taxYear = 2026;
        h.region = "wallonia";
        h.home = {
            ...h.home,
            mortgageIsPrimaryResidence: true,
            mortgageStartYear: 2016,
            mortgageInterestPaid: 4_000,
        };
        // Loan-year proxy: IY 2026 is the eleventh period of a 2016 loan, halved.
        const proxy = must(computeHouseholdTax(h).partners[0], "partners[0]");
        expect(proxy.ownHomeCreditRegime).toBe("walloon_cheque_habitat");
        expect(proxy.ownHomeCredit).toBeCloseTo(1_520 / 2, 9);
        // First claimed for IY 2019: eighth period, full credit.
        h.home.firstQualifyingYear = 2019;
        expect(must(computeHouseholdTax(h).partners[0], "partners[0]").ownHomeCredit).toBeCloseTo(1_520, 9);
        // Twenty-first period counted from 2019: nothing.
        h.taxYear = 2039;
        expect(must(computeHouseholdTax(h).partners[0], "partners[0]").ownHomeCredit).toBe(0);
    });

    test("alimony beyond the payer's income is charged on the other spouse (art. 105, 3°)", () => {
        const h = married([activity("employee", 0)], [activity("net_professional_amount", 40_000)]);
        must(h.partners[0], "partners[0]").alimonyPaid = 10_000;
        const r = computeHouseholdTax(h);
        const total = must(r.partners[0], "partners[0]").taxableIncome + must(r.partners[1], "partners[1]").taxableIncome;
        expect(total).toBeCloseTo(40_000 - 7_000, 9);
    });

    test("low income with children raises the refundable-credit open item", () => {
        const h = household([partner("A", [activity("employee", 12_000)])], {
            dependents: { children: 2, otherPersons: 0 },
        });
        expect(computeHouseholdTax(h).issues).toContainEqual({
            code: "refundable_child_credit_not_modelled",
            severity: "needs_source",
        });
        expect(computeHouseholdTax(h).totals.refundableChildCredit).toBe(0);
    });

    test("quotient is withheld when a partner's reductions already clear the household tax (art. 88 al. 2)", () => {
        // A's childcare reduction wipes A's tax; a 30% transfer to B would create tax for B that
        // A's reduction cannot offset, so the assessment would be higher with the quotient.
        const h = married([activity("employee", 40_000)], [activity("employee", 0)]);
        must(h.partners[0], "partners[0]").reductions = {
            ...must(h.partners[0], "partners[0]").reductions,
            childcareEligible: true,
            childcareEligibleDays: 2_000,
            childcareCosts: 30_000,
        };
        const r = computeHouseholdTax(h);
        expect(r.quotient.applied).toBe(false);
        expect(r.totals.totalPIT).toBe(0);
    });

    test("quotient benefit is the saving on the final tax, after the factor and the surcharge", () => {
        const a = [activity("employee", 40_000)];
        const b = [activity("employee", 0)];
        const flanders = computeHouseholdTax(married(a, b));
        const brussels = computeHouseholdTax(
            married(a, b, { region: "brussels", communalSurchargePercent: 6 }),
        );
        expect(flanders.quotient.applied).toBe(true);
        expect(brussels.quotient.applied).toBe(true);
        // Same transfer and bracket saving; Brussels factor 0.9950 and 6% instead of 1.0000 and 7%.
        expect(brussels.quotient.transfer).toBeCloseTo(flanders.quotient.transfer, 9);
        expect(brussels.quotient.benefit).toBeCloseTo(
            (flanders.quotient.benefit / 1.07) * 0.995 * 1.06,
            6,
        );
    });

    test("the quotient is pension income pro rata for the receiving spouse (Com.IB 87/23, AAFisc 40/2011)", () => {
        // A: pension 20,000 + net 20,000 → 40,000; B none. Transfer 30% = 12,000, of which
        // 12,000 × 20,000 / 40,000 = 6,000 is pension. A: 14,000 of 28,000; B: 6,000 of 12,000.
        // A tax 6,024.50; share ½: base 2,219.27 × ½ = 1,109.635 (28,000 ≤ 28,780);
        //   additional 457.23 × 780 / 9,150 × ½ = 19.488491803…; below the 3,012.25 limit
        // B tax 272.50; 2,676.50 × ½ = 1,338.25, limited to 272.50 × ½ = 136.25 (art. 153)
        const r = computeHouseholdTax(
            married(
                [activity("pension", 20_000), activity("net_professional_amount", 20_000)],
                [],
            ),
        );
        expect(r.quotient).toMatchObject({ applied: true, fromPartnerId: "A", transfer: 12_000 });
        expect(must(r.partners[0], "partners[0]").pensionReduction).toBeCloseTo(1_109.635 + 19.488491803279, 9);
        expect(must(r.partners[1], "partners[1]").pensionReduction).toBeCloseTo(136.25, 9);
        expect(r.issues).toContainEqual({
            code: "pension_reduction_activity_income_not_excluded",
            severity: "warning",
            partnerId: "B",
        });
    });

    test("joint woonbonus credit beyond both spouses' room raises the allocation issue", () => {
        // RG-20 with 6,000 of payments: A fills the 2,280 cap (912), B's tax 452.731 absorbs
        // 1,131.8275; the rest of B's 3,000 fills B's cap (2,280 → 912), so 459.269 is lost.
        const r = computeHouseholdTax(
            married([activity("employee", 50_000)], [activity("employee", 8_000)], {
                home: {
                    cadastralIncome: 0,
                    mortgageInterestPaid: 3_000,
                    mortgageCapitalRepaid: 3_000,
                    mortgageStartYear: 2018,
                    mortgageIsPrimaryResidence: true,
                    woonbonusChildrenAtLoanStart: 0,
                    mortgageSharePartnerB: 50,
                },
            }),
        );
        expect(must(r.partners[0], "partners[0]").ownHomeCredit).toBeCloseTo(912, 9);
        expect(must(r.partners[1], "partners[1]").ownHomeCredit).toBeCloseTo(912, 9);
        expect(must(r.partners[1], "partners[1]").reductionsApplied).toBeCloseTo(452.731, 6);
        expect(r.issues).toContainEqual({ code: "joint_reduction_allocation_unverified", severity: "needs_source" });
    });

    test("marginal rate follows the post-quotient taxable income", () => {
        const r = computeHouseholdTax(married([activity("employee", 40_000)], [activity("employee", 0)]));
        expect(r.quotient.applied).toBe(true);
        // A: about 29.7k taxable before the transfer (45% bracket), about 20.8k after it (40%).
        expect(must(r.partners[0], "partners[0]").marginalRate).toBe(40);
        expect(must(r.partners[1], "partners[1]").marginalRate).toBe(25);
    });

    test("household cash totals include already-net activity amounts", () => {
        const r = computeHouseholdTax(married([activity("employee", 50_000)], [activity("net_professional_amount", 20_000)]));
        expect(r.totals.grossIncome).toBe(70_000);
        expect(r.totals.netTakeHome).toBeCloseTo(70_000 - r.totals.totalTaxBurden, 9);
    });

    test("does not mutate its input", () => {
        const h = married([activity("employee", 50_000)], [activity("net_professional_amount", 0)]);
        const before = structuredClone(h);
        computeHouseholdTax(h);
        expect(h).toEqual(before);
    });
});

describe("art. 147 al. 1, 2°, b-c in the household engine (pension type of Vak V)", () => {
    // Employee 10,000: SS 1,307, forfait 2,607.90 → activity income 6,085.10 (IY 2025).
    const emp10 = () => activity("employee", 10_000);

    test("per partner: the statutory pension leaves the activity income out; art. 153 stays on the net income", () => {
        // SC-24: share 1, 2,603.787937377 limited to 3,258.54 × 15,000 / 21,085.10.
        const r = computeHouseholdTax(
            household([
                partner("A", [activity("pension", 15_000, { pensionKind: "statutory_from_legal_age" }), emp10()]),
            ]),
        );
        expect(must(r.partners[0], "partners[0]").pensionReduction).toBeCloseTo(2_318.134606903, 9);
        expect(r.issues.map((i) => i.code)).not.toContain("pension_reduction_activity_income_not_excluded");
    });

    test("the gross statutory pension of several activities is summed for the limit (AAFisc 40/2011 no. 22)", () => {
        const split = computeHouseholdTax(
            household([
                partner("A", [
                    activity("pension", 10_000, { pensionKind: "statutory_from_legal_age" }),
                    activity("pension", 10_000, { pensionKind: "statutory_from_legal_age" }),
                    emp10(),
                ]),
            ]),
        );
        const one = computeHouseholdTax(
            household([partner("A", [activity("pension", 20_000, { pensionKind: "statutory_from_legal_age" }), emp10()])]),
        );
        expect(must(split.partners[0], "partners[0]").pensionReduction).toBeCloseTo(must(one.partners[0], "partners[0]").pensionReduction, 9);
        expect(must(one.partners[0], "partners[0]").pensionReduction).toBeCloseTo(2_324.594602628, 9);
    });

    test("an unset pension type keeps the plain proportion and warns; `other` does not warn", () => {
        const unset = computeHouseholdTax(household([partner("A", [activity("pension", 20_000), emp10()])]));
        const other = computeHouseholdTax(
            household([partner("A", [activity("pension", 20_000, { pensionKind: "other" }), emp10()])]),
        );
        expect(must(unset.partners[0], "partners[0]").pensionReduction).toBeCloseTo(1_804.812309219, 9);
        expect(must(other.partners[0], "partners[0]").pensionReduction).toBeCloseTo(1_804.812309219, 9);
        expect(unset.issues).toContainEqual({
            code: "pension_reduction_activity_income_not_excluded",
            severity: "warning",
            partnerId: "A",
        });
        expect(other.issues.map((i) => i.code)).not.toContain("pension_reduction_activity_income_not_excluded");
    });

    test("mixed typed and untyped pensions without a survivor's pension: plain proportion and a warning", () => {
        // An untyped pension may be statutory: the limit cannot be tested, so nothing leaves the
        // proportion (fraction 0), as the warning says.
        const mixed = computeHouseholdTax(
            household([
                partner("A", [
                    activity("pension", 15_000, { pensionKind: "statutory_from_legal_age" }),
                    activity("pension", 5_000),
                    emp10(),
                ]),
            ]),
        );
        expect(must(mixed.partners[0], "partners[0]").pensionReduction).toBeCloseTo(1_804.812309219, 9);
        expect(mixed.issues).toContainEqual({
            code: "pension_reduction_activity_income_not_excluded",
            severity: "warning",
            partnerId: "A",
        });
    });

    test("mixed typed and untyped pensions with a survivor's pension: full exclusion, no warning", () => {
        // A survivor's pension decides the exclusion in full whatever the other pensions
        // (AAFisc 40/2011 no. 18).
        const mixed = computeHouseholdTax(
            household([
                partner("A", [
                    activity("pension", 15_000, { pensionKind: "survivor_or_transition" }),
                    activity("pension", 5_000),
                    emp10(),
                ]),
            ]),
        );
        const typed = computeHouseholdTax(
            household([partner("A", [activity("pension", 20_000, { pensionKind: "survivor_or_transition" }), emp10()])]),
        );
        expect(must(mixed.partners[0], "partners[0]").pensionReduction).toBeCloseTo(must(typed.partners[0], "partners[0]").pensionReduction, 9);
        expect(must(mixed.partners[0], "partners[0]").pensionReduction).toBeGreaterThan(1_804.812309219);
        expect(mixed.issues.map((i) => i.code)).not.toContain("pension_reduction_activity_income_not_excluded");
    });

    test("other professional income next to an excluding pension raises an info issue", () => {
        const withOther = computeHouseholdTax(
            household([
                partner("A", [
                    activity("pension", 15_000, { pensionKind: "statutory_from_legal_age" }),
                    activity("other_professional", 5_000),
                ]),
            ]),
        );
        expect(withOther.issues).toContainEqual({
            code: "pension_exclusion_other_income_counted_as_activity",
            severity: "info",
            partnerId: "A",
        });
        const netAmount = computeHouseholdTax(
            household([
                partner("A", [
                    activity("pension", 15_000, { pensionKind: "survivor_or_transition" }),
                    activity("net_professional_amount", 5_000),
                ]),
            ]),
        );
        expect(netAmount.issues.map((i) => i.code)).toContain("pension_exclusion_other_income_counted_as_activity");
        // Nothing excluded (above the upper limit) or no such income: no issue.
        const above = computeHouseholdTax(
            household([
                partner("A", [
                    activity("pension", 30_000, { pensionKind: "statutory_from_legal_age" }),
                    activity("other_professional", 5_000),
                ]),
            ]),
        );
        const employee = computeHouseholdTax(
            household([partner("A", [activity("pension", 15_000, { pensionKind: "statutory_from_legal_age" }), emp10()])]),
        );
        expect(above.issues.map((i) => i.code)).not.toContain("pension_exclusion_other_income_counted_as_activity");
        expect(employee.issues.map((i) => i.code)).not.toContain("pension_exclusion_other_income_counted_as_activity");
    });

    test("quotient from a partially excluding transferor: needs_source issue for the receiver", () => {
        const partial = computeHouseholdTax(
            married([activity("pension", 24_000, { pensionKind: "statutory_from_legal_age" }), activity("employee", 40_000)], []),
        );
        expect(partial.quotient.applied).toBe(true);
        expect(partial.issues).toContainEqual({
            code: "pension_quotient_partial_exclusion_unverified",
            severity: "needs_source",
            partnerId: "B",
        });
        // Full exclusion (JP-03) follows AAFisc 40/2011 no. 19 a: no issue.
        const full = computeHouseholdTax(
            married([activity("pension", 15_000, { pensionKind: "statutory_from_legal_age" }), activity("employee", 40_000)], []),
        );
        expect(full.quotient.applied).toBe(true);
        expect(full.issues.map((i) => i.code)).not.toContain("pension_quotient_partial_exclusion_unverified");
    });

    test("quotient, AAFisc 40/2011 no. 19 a: the receiver leaves out the transferor's activity income in the quotient", () => {
        // JP-03: B 13,152.60 with pensions 4,500 and activity income 8,652.60 → share 1;
        // art. 153 on the plain net income: 560.65 × 4,500 / 13,152.60.
        const r = computeHouseholdTax(
            married([activity("pension", 15_000, { pensionKind: "statutory_from_legal_age" }), activity("employee", 40_000)], []),
        );
        expect(r.quotient).toMatchObject({ applied: true, fromPartnerId: "A", transfer: 13_152.6 });
        expect(must(r.partners[1], "partners[1]").pensionReduction).toBeCloseTo((560.65 * 4_500) / 13_152.6, 9);
        expect(must(r.partners[0], "partners[0]").pensionReduction).toBeCloseTo(2_121.11215571, 8);
        expect(r.issues.map((i) => i.code)).not.toContain("pension_reduction_activity_income_not_excluded");
    });

    test("quotient, AAFisc 40/2011 no. 19 c: only the receiver meets the conditions", () => {
        // A: other pension 24,000 + activity 28,842 → transfer 9,634.47 to B (survivor's pension
        // 2,000, activity 1,825.53, other income 8,000). Nothing of A's activity income leaves
        // B's proportion; B's own 1,825.53 does.
        const r = computeHouseholdTax(
            household(
                [
                    partner("A", [activity("pension", 24_000, { pensionKind: "other" }), activity("employee", 40_000)]),
                    partner(
                        "B",
                        [activity("pension", 2_000, { pensionKind: "survivor_or_transition" }), activity("employee", 3_000)],
                        { otherTaxableIncome: 8_000 },
                    ),
                ],
                { relationship: married([], []).relationship },
            ),
        );
        expect(r.quotient).toMatchObject({ applied: true, fromPartnerId: "A" });
        expect(r.quotient.transfer).toBeCloseTo(9_634.47, 9);
        const moved = 9_634.47 / 52_842;
        const pensionsB = 2_000 + 24_000 * moved;
        // B taxable 21,460: art. 152 full, art. 151/1 (28,780 − 21,460) / 9,150 = 0.8
        const shareB = pensionsB / (21_460 - 1_825.53);
        expect(must(r.partners[1], "partners[1]").pensionReduction).toBeCloseTo((2_219.27 + 457.23 * 0.8) * shareB, 9);
        // A: plain proportion after the transfer
        const pensionsA = 24_000 * (1 - moved);
        const shareA = pensionsA / 43_207.53;
        const factorA = 1 / 3 + ((2 / 3) * (57_560 - 43_207.53)) / 28_780;
        expect(must(r.partners[0], "partners[0]").pensionReduction).toBeCloseTo(2_219.27 * shareA * factorA, 9);
        expect(r.issues.map((i) => i.code)).not.toContain("pension_reduction_activity_income_not_excluded");
    });

    test("quotient: an unset pension type of the transferor warns for the receiver", () => {
        const r = computeHouseholdTax(married([activity("pension", 15_000), activity("employee", 40_000)], []));
        expect(r.quotient.applied).toBe(true);
        expect(r.issues).toContainEqual({
            code: "pension_reduction_activity_income_not_excluded",
            severity: "warning",
            partnerId: "B",
        });
    });
});
