import { describe, expect, it } from "vitest";
import {
    applyDeductionCandidate,
    attributeToPartners,
    deductionFieldValue,
    householdHasPartnerB,
    householdWithRecordedIncome,
    partnerBShare,
} from "../partnerAttribution";
import { DEDUCTION_TYPE_PROFILE_FIELDS } from "../deductionCandidateFields";
import { activity, household, partner } from "./testHousehold";

const pension = DEDUCTION_TYPE_PROFILE_FIELDS.pensionSavings!;
const alimony = DEDUCTION_TYPE_PROFILE_FIELDS.alimony!;
const mortgage = DEDUCTION_TYPE_PROFILE_FIELDS.mortgageInterest!;

describe("attributeToPartners", () => {
    it("gives everything to partner A without partner B", () => {
        expect(
            attributeToPartners(1000.123, { me: 100, partner: 400, joint: 500.123 }, false),
        ).toEqual({ A: 1000.123, B: 0 });
    });

    it("maps me to A, partner to B and splits joint 50/50", () => {
        expect(attributeToPartners(1000, { me: 100, partner: 400, joint: 500 }, true)).toEqual({
            A: 350,
            B: 650,
        });
    });

    it("keeps unowned amounts on A and the shares adding up to the total", () => {
        // 0.05 of joint money halves to 0.025 → B 0.03 (rounded), A takes the rest.
        const shares = attributeToPartners(10.05, { partner: 0, joint: 0.05 }, true);
        expect(shares).toEqual({ A: 10.02, B: 0.03 });
        expect(shares.A + shares.B).toBeCloseTo(10.05, 10);
        expect(attributeToPartners(10, undefined, true)).toEqual({ A: 10, B: 0 });
    });

    it("reads partner B from the household", () => {
        expect(householdHasPartnerB(household([partner("A", [])]))).toBe(false);
        expect(
            householdHasPartnerB(household([partner("A", []), partner("B", [])])),
        ).toBe(true);
        expect(householdHasPartnerB(null)).toBe(false);
        expect(partnerBShare({ partner: 10 }, false)).toBe(0);
    });
});

describe("householdWithRecordedIncome", () => {
    it("puts each partner's share on their primary gross activity", () => {
        const h = household([
            partner("A", [activity("employee", 50_000)]),
            partner("B", [activity("self_employed_fees", 20_000)]),
        ]);
        const next = householdWithRecordedIncome(h, 70_000, 30_000)!;
        expect(next.partners[0]!.activities[0]!.grossIncome).toBe(40_000);
        expect(next.partners[1]!.activities[0]!.grossIncome).toBe(30_000);
        // The input household is not mutated.
        expect(h.partners[1]!.activities[0]!.grossIncome).toBe(20_000);
    });

    it("declines when partner B has no activity with a gross figure", () => {
        const h = household([
            partner("A", [activity("employee", 50_000)]),
            partner("B", [activity("net_professional_amount", 12_000)]),
        ]);
        expect(householdWithRecordedIncome(h, 70_000, 30_000)).toBeUndefined();
        expect(
            householdWithRecordedIncome(household([partner("A", [])]), 1, 0),
        ).toBeUndefined();
    });
});

describe("applyDeductionCandidate", () => {
    const two = () =>
        household([
            partner("A", [activity("employee", 50_000)]),
            partner("B", [activity("employee", 30_000)], {
                reductions: {
                    personalPensionContributions: 500,
                    lifeInsurancePremiums: 0,
                    charitableDonations: 0,
                    childcareCosts: 0,
                    medicalExpenses: 0,
                },
            }),
        ]);

    it("sets each partner's reduction and eligibility from their share", () => {
        const next = applyDeductionCandidate(two(), pension, { A: 600, B: 420 }, 1020);
        expect(next.partners[0]!.reductions.personalPensionContributions).toBe(600);
        expect(next.partners[0]!.reductions.pensionEligible).toBe(true);
        expect(next.partners[1]!.reductions.personalPensionContributions).toBe(420);
        expect(deductionFieldValue(next, "B", pension)).toBe(420);
    });

    it("leaves a partner with a zero share untouched", () => {
        const next = applyDeductionCandidate(two(), pension, { A: 900, B: 0 }, 900);
        expect(next.partners[1]!.reductions.personalPensionContributions).toBe(500);
        expect(next.partners[1]!.reductions.pensionEligible).toBeUndefined();
    });

    it("writes partner-level fields on the partner and home fields once", () => {
        const withAlimony = applyDeductionCandidate(two(), alimony, { A: 0, B: 300 }, 300);
        expect(withAlimony.partners[1]!.alimonyPaid).toBe(300);
        expect(withAlimony.partners[0]!.alimonyPaid).toBe(0);
        const withMortgage = applyDeductionCandidate(two(), mortgage, { A: 700, B: 300 }, 1000);
        expect(withMortgage.home.mortgageInterestPaid).toBe(1000);
        expect(deductionFieldValue(withMortgage, "B", mortgage)).toBe(1000);
    });
});
