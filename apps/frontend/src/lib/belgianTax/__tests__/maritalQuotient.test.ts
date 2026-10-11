import { describe, expect, test } from "vitest";
import { computeHouseholdTax } from "../household";
import { computeMaritalQuotient, resolveMaritalQuotientCap } from "../maritalQuotient";
import { getTaxTable } from "../constants";
import { activity, married, partner, household, event } from "./testHousehold";

describe("marital quotient (arts 87-88)", () => {
    test("art. 88: A 80k / B 5k net professional income, IY 2025 → transfer 8,460", () => {
        // Household 85,000; 30% = 25,500 > cap 13,460 → own income + transfer = 13,460, so the
        // transfer is 13,460 − 5,000 = 8,460.
        // With the quotient (IY 2025 brackets 16,320 / 28,800 / 49,840, basic exemption 10,910):
        //  A 71,540: 4,080 + 4,992 + 9,468 + 10,850 = 29,390 − 2,727.50 = 26,662.50
        //  B 13,460: 3,365 − 2,727.50 = 637.50                     → combined 27,300
        // Without: A 80,000: 33,620; B 5,000 uses 5,000 of its 10,910 exemption and passes
        //  5,910 to A (art. 134), A exemption 16,820 → 25% × 11,460 + 30% × 4,860 + 40% × 500
        //  = 4,523
        //  → A 29,097, B 0                                         → combined 29,097
        const h = married(
            [activity("net_professional_amount", 80_000)],
            [activity("net_professional_amount", 5_000)],
        );
        const r = computeHouseholdTax(h);
        expect(r.assessment.mode).toBe("joint");
        expect(r.quotient).toMatchObject({ applied: true, fromPartnerId: "A", toPartnerId: "B" });
        expect(r.quotient.transfer).toBeCloseTo(8_460, 9);
        const [a, b] = r.partners;
        expect(a?.taxableIncome).toBeCloseTo(71_540, 9);
        expect(b?.taxableIncome).toBeCloseTo(13_460, 9);
        expect(a?.pitAfterExemption).toBeCloseTo(26_662.5, 6);
        expect(b?.pitAfterExemption).toBeCloseTo(637.5, 6);
        expect(r.quotient.benefit).toBeCloseTo(29_097 - 27_300, 6);
    });

    test("quotient goes to the lower earner, whichever partner that is", () => {
        const h = married(
            [activity("net_professional_amount", 0)],
            [activity("net_professional_amount", 80_000)],
        );
        const r = computeHouseholdTax(h);
        expect(r.quotient).toMatchObject({ applied: true, fromPartnerId: "B", toPartnerId: "A" });
        expect(r.quotient.transfer).toBeCloseTo(13_460, 9);
    });

    test("no quotient when the lower earner already has 30% of the household income", () => {
        const r = computeHouseholdTax(
            married([activity("net_professional_amount", 50_000)], [activity("net_professional_amount", 25_000)]),
        );
        expect(r.quotient.applied).toBe(false);
    });

    test("only professional income counts: other income does not enter the 30%", () => {
        const h = married(
            [activity("net_professional_amount", 40_000)],
            [activity("net_professional_amount", 0)],
        );
        const withOther = { ...h, partners: [h.partners[0]!, { ...h.partners[1]!, otherTaxableIncome: 20_000 }] };
        const r = computeHouseholdTax(withOther);
        expect(r.quotient.transfer).toBeCloseTo(12_000, 9);
    });

    test("IY 2026: both spouses 66+ → cap 12,790; otherwise 11,780", () => {
        const base = married(
            [activity("net_professional_amount", 80_000)],
            [activity("net_professional_amount", 0)],
            { taxYear: 2026 },
        );
        const withBirthYears = (a: number, b: number) => ({
            ...base,
            partners: [
                { ...base.partners[0]!, birthYear: a },
                { ...base.partners[1]!, birthYear: b },
            ],
        });
        expect(computeHouseholdTax(withBirthYears(1950, 1960)).quotient.transfer).toBeCloseTo(12_790, 9);
        expect(computeHouseholdTax(withBirthYears(1950, 1961)).quotient.transfer).toBeCloseTo(11_780, 9);
        const missing = computeHouseholdTax(base);
        expect(missing.quotient.transfer).toBeCloseTo(11_780, 9);
        expect(missing.issues).toContainEqual({ code: "senior_quotient_cap_birth_years_missing", severity: "info" });
    });

    test("the senior cap does not exist before IY 2026", () => {
        const cap = resolveMaritalQuotientCap(
            [
                { id: "A", netProfessionalIncome: 1, birthYear: 1940 },
                { id: "B", netProfessionalIncome: 0, birthYear: 1940 },
            ],
            2025,
            getTaxTable(2025),
        );
        expect(cap).toEqual({ cap: 13_460, bothSenior: false, issues: [] });
    });

    test("not applied when it would raise the tax", () => {
        const result = computeMaritalQuotient({
            partners: [
                { id: "A", netProfessionalIncome: 10_000 },
                { id: "B", netProfessionalIncome: 0 },
            ],
            rate: 0.3,
            cap: 13_460,
            evaluate: (t) => (t ? 100 : 100),
        });
        expect(result.applied).toBe(false);
        expect(result.transfer).toBe(0);
    });

    test("separate assessment never applies the quotient", () => {
        const h = household(
            [partner("A", [activity("net_professional_amount", 80_000)]), partner("B", [])],
            { relationship: { events: [event("marriage", "2025-06-14")] } },
        );
        expect(computeHouseholdTax(h).quotient.applied).toBe(false);
    });
});
