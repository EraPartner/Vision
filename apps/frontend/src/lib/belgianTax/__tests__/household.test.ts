import { describe, expect, test } from "vitest";
import { computeHouseholdTax, toBelgianTaxCalculation } from "../household";
import { computeBelgianPIT } from "../pit";
import { upgradeProfileV1ToHousehold } from "../householdMigration";
import { activity, household, married, partner } from "./testHousehold";
import { makeTaxProfile } from "./testProfile";

const single = (...activities: ReturnType<typeof activity>[]) =>
    computeHouseholdTax(household([partner("A", activities)]));

describe("activities and forfait categories (IY 2025)", () => {
    test("two part-time jobs share one remuneration forfait at the cap (art. 51 al. 3)", () => {
        // 20,000 + 15,000 gross; contributions 13.07% = 4,574.50; base 30,425.50; 30% = 9,127.65
        // → capped once at 5,930 (two separate forfaits would have given 5,215.80 + 3,911.85).
        const r = single(activity("employee", 20_000), activity("employee", 15_000));
        const a = r.partners[0]!;
        expect(a.categories).toHaveLength(1);
        expect(a.professionalExpenses).toBe(5_930);
        expect(a.employeeSocialSecurity).toBeCloseTo(4_574.5, 9);
        expect(a.netProfessionalIncome).toBeCloseTo(30_425.5 - 5_930, 9);
        // Allocated pro rata to the activities.
        expect(a.activities[0]!.professionalExpenses + a.activities[1]!.professionalExpenses).toBeCloseTo(5_930, 9);
    });

    test("employee 40k + trading profits 15k: separate categories, each with its own forfait", () => {
        // Employee: 40,000 − 5,228 = 34,772 → forfait 5,930 → 28,842.
        // Profits: 15,000 → 30% = 4,500 → 10,500. Total 39,342.
        const r = single(activity("employee", 40_000), activity("self_employed_profits", 15_000));
        const a = r.partners[0]!;
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
        expect(r.partners[0]!.professionalExpenses).toBeCloseTo(1_350, 9);
        expect(r.partners[0]!.netProfessionalIncome).toBeCloseTo(25_650, 9);
        const capped = single(activity("helping_spouse", 200_000));
        expect(capped.partners[0]!.professionalExpenses).toBe(5_210);
    });

    test("self-employed contributions come off the gross before the forfait (art. 52, 7°)", () => {
        // 40,000 − 8,000 = 32,000; 30% = 9,600 → cap 5,930; net 26,070.
        const r = single(activity("self_employed_profits", 40_000, { socialContributionsPaid: 8_000 }));
        expect(r.partners[0]!.activities[0]!.socialContributionsPaid).toBe(8_000);
        expect(r.partners[0]!.netProfessionalIncome).toBeCloseTo(26_070, 9);
    });

    test("pension: no social security, no forfait, no CSSS", () => {
        const r = single(activity("pension", 25_000));
        const a = r.partners[0]!;
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
        expect(r.partners[0]!.netProfessionalIncome).toBe(0);
        expect(r.partners[0]!.taxableIncome).toBe(5_000);
        expect(r.issues).toContainEqual({ code: "loss_offset_not_modelled", severity: "warning", partnerId: "A" });
    });

    test("union dues deduct only inside an actual remuneration claim", () => {
        const lump = household([partner("A", [activity("employee", 40_000)], { unionDues: 200 })]);
        expect(computeHouseholdTax(lump).partners[0]!.unionDuesApplied).toBe(0);
        const actual = household([
            partner("A", [activity("employee", 40_000)], {
                unionDues: 200,
                professionalExpenses: { remuneration: { method: "actual", actualAmount: 1_000 } },
            }),
        ]);
        expect(computeHouseholdTax(actual).partners[0]!.professionalExpenses).toBe(1_200);
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
        expect(r.partners[0]!.specialSocialSecurityContribution).toBeCloseTo((expected * 37_535) / 51_605, 9);
        expect(r.partners[1]!.specialSocialSecurityContribution).toBeCloseTo((expected * 14_070) / 51_605, 9);
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
        expect(r.partners[1]!.specialSocialSecurityContribution).toBe(0);
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
        h.partners[1]!.reductions = { ...h.partners[1]!.reductions, pensionEligible: true, personalPensionContributions: 1_050 };
        const r = computeHouseholdTax(h);
        expect(r.partners[1]!.reductions.pension).toBeCloseTo(315, 9);
        expect(r.partners[0]!.reductions.pension).toBe(0);
        expect(r.issues).toContainEqual({ code: "joint_reduction_allocation_unverified", severity: "needs_source" });
    });

    test("service-voucher spend is capped per partner (art. 145/21, Wallonia IY 2025: 30% up to €1,850)", () => {
        const h = married([activity("employee", 50_000)], [activity("employee", 30_000)]);
        h.region = "wallonia";
        h.partners[0]!.reductions = { ...h.partners[0]!.reductions, serviceVoucherEligible: true, serviceVoucherSpend: 3_000 };
        h.partners[1]!.reductions = { ...h.partners[1]!.reductions, serviceVoucherEligible: true, serviceVoucherCount: 50 };
        const r = computeHouseholdTax(h);
        expect(r.partners[0]!.reductions.serviceVouchers).toBeCloseTo(1_850 * 0.3, 9);
        // Legacy count × €10 = €500 spend.
        expect(r.partners[1]!.reductions.serviceVouchers).toBeCloseTo(500 * 0.3, 9);
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
        const b = r.partners[1]!;
        expect(b.ownHomeCredit).toBeCloseTo(
            1_520 - (b.taxableIncomeBeforeQuotient - 27_353) * 0.01275,
            9,
        );
        expect(r.partners[0]!.ownHomeCredit).toBe(0);
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
        const proxy = computeHouseholdTax(h).partners[0]!;
        expect(proxy.ownHomeCreditRegime).toBe("walloon_cheque_habitat");
        expect(proxy.ownHomeCredit).toBeCloseTo(1_520 / 2, 9);
        // First claimed for IY 2019: eighth period, full credit.
        h.home.firstQualifyingYear = 2019;
        expect(computeHouseholdTax(h).partners[0]!.ownHomeCredit).toBeCloseTo(1_520, 9);
        // Twenty-first period counted from 2019: nothing.
        h.taxYear = 2039;
        expect(computeHouseholdTax(h).partners[0]!.ownHomeCredit).toBe(0);
    });

    test("alimony beyond the payer's income is charged on the other spouse (art. 105, 3°)", () => {
        const h = married([activity("employee", 0)], [activity("net_professional_amount", 40_000)]);
        h.partners[0]!.alimonyPaid = 10_000;
        const r = computeHouseholdTax(h);
        const total = r.partners[0]!.taxableIncome + r.partners[1]!.taxableIncome;
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
        h.partners[0]!.reductions = {
            ...h.partners[0]!.reductions,
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
        expect(r.partners[0]!.pensionReduction).toBeCloseTo(1_109.635 + 19.488491803279, 9);
        expect(r.partners[1]!.pensionReduction).toBeCloseTo(136.25, 9);
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
        expect(r.partners[0]!.ownHomeCredit).toBeCloseTo(912, 9);
        expect(r.partners[1]!.ownHomeCredit).toBeCloseTo(912, 9);
        expect(r.partners[1]!.reductionsApplied).toBeCloseTo(452.731, 6);
        expect(r.issues).toContainEqual({ code: "joint_reduction_allocation_unverified", severity: "needs_source" });
    });

    test("marginal rate follows the post-quotient taxable income", () => {
        const r = computeHouseholdTax(married([activity("employee", 40_000)], [activity("employee", 0)]));
        expect(r.quotient.applied).toBe(true);
        // A: about 29.7k taxable before the transfer (45% bracket), about 20.8k after it (40%).
        expect(r.partners[0]!.marginalRate).toBe(40);
        expect(r.partners[1]!.marginalRate).toBe(25);
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
