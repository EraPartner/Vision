import { describe, expect, test } from "vitest";
import { getTaxTable, isApproximatedTaxYear } from "..";
import { computeWithParity } from "./householdParity";
import { computeSpecialSocialSecurityContribution } from "../socialSecurity";
import { computePropertyTaxEstimate } from "../propertyTax";
import { computeOwnHomeCredit, type OwnHomeCreditInputs } from "../personPit";
import type { BelgianTaxProfile } from "../types";

const baseProfile: BelgianTaxProfile = {
    profileConfigured: true,
    employmentType: "employee",
    grossAnnualIncome: 50_000,
    professionalExpenseMethod: "lump_sum",
    actualProfessionalExpenses: 0,
    communalSurchargePercent: 7,
    region: "flanders",
    dependentChildren: 0,
    dependentChildrenUnder3: 0,
    dependentOtherPersons: 0,
    isDisabled: false,
    isSpouseDisabled: false,
    isIsolatedParent: false,
    cadastralIncome: 0,
    additionalResidences: [],
    otherTaxableIncome: 0,
    alimonyPaid: 0,
    personalPensionContributions: 0,
    pensionScheme: "1050",
    pensionEligible: false,
    lifeInsurancePremiums: 0,
    lifeInsuranceEligible: false,
    mortgageInterestPaid: 0,
    charitableDonations: 0,
    charitableDonationsEligible: false,
    childcareCosts: 0,
    childcareEligibleDays: 0,
    childcareEligible: false,
    employeeGroupInsuranceContributions: 0,
    employeeGroupInsuranceEligible: false,
    unionDues: 0,
    medicalExpenses: 0,
    domesticHelpCosts: 0,
    domesticHelpEligible: false,
    annualDividendIncome: 0,
    annualSavingsInterest: 0,
    taxYear: 2025,
};

function profile(overrides: Partial<BelgianTaxProfile>): BelgianTaxProfile {
    return { ...baseProfile, ...overrides };
}

describe("computeBelgianPIT — IY 2025 brackets", () => {
    test("returns zero tax for zero income", () => {
        const result = computeWithParity(profile({ grossAnnualIncome: 0 }));
        expect(result.totalPIT).toBe(0);
        expect(result.totalTaxBurden).toBe(0);
    });

    test("employee SS = 13.07% of gross salary", () => {
        const result = computeWithParity(
            profile({ grossAnnualIncome: 40_000 }),
        );
        expect(result.employeeSocialSecurity).toBeCloseTo(40_000 * 0.1307, 2);
    });

    test("totalTaxBurden does NOT double-count communal surcharge", () => {
        // Regression test for the IY-2025 bug where surcharge was added once inside totalPIT
        // and again in totalTaxBurden.
        const result = computeWithParity(
            profile({ grossAnnualIncome: 50_000 }),
        );
        const expected =
            result.totalPIT +
            result.employeeSocialSecurity +
            result.specialSocialSecurityContribution +
            result.propertyTaxEstimate;
        expect(result.totalTaxBurden).toBeCloseTo(expected, 5);
    });

    test("professional expense forfait caps at €5,930 for employees IY 2025", () => {
        const result = computeWithParity(
            profile({ grossAnnualIncome: 100_000 }),
        );
        // 30% of 100k = 30k > cap, so capped at 5_930
        expect(result.professionalExpenses).toBe(5_930);
    });

    test("employee forfait is computed on gross pay after the 13.07% contribution (art. 51 al. 1)", () => {
        // WIB 92 art. 51 al. 1: percentages of the gross income "vooraf verminderd met" the
        // art. 52, 7° contributions; FPS Finance › Beroepsinkomen: "brutoberoepsinkomen
        // (verminderd met bijdragen)". Gross 15_000 → SS 1_960.50 → base 13_039.50 × 30%.
        const result = computeWithParity(profile({ grossAnnualIncome: 15_000 }));
        expect(result.employeeSocialSecurity).toBeCloseTo(1_960.5, 5);
        expect(result.professionalExpenses).toBeCloseTo(3_911.85, 5);
        // Civil servants: 11.05% comes off first as well.
        const civil = computeWithParity(
            profile({ employmentType: "civil_servant", grossAnnualIncome: 15_000 }),
        );
        expect(civil.professionalExpenses).toBeCloseTo(15_000 * (1 - 0.1105) * 0.3, 5);
    });

    test("director gets 3% / €3,130 cap forfait", () => {
        const result = computeWithParity(
            profile({ employmentType: "director", grossAnnualIncome: 200_000 }),
        );
        expect(result.professionalExpenses).toBe(3_130);
    });

    test("self-employed trading profits (winsten) get the employee forfait: 30% capped at €5,930", () => {
        // WIB 92 art. 51 al. 2, 1° and al. 3 — FPS indexation notice AY 2026, table I:
        // "Rémunérations des travailleurs et bénéfices: 5.930". `selfEmployedIncomeKind`
        // defaults to "profits".
        const result = computeWithParity(
            profile({
                employmentType: "self_employed",
                grossAnnualIncome: 80_000,
            }),
        );
        expect(result.professionalExpenses).toBe(5_930);
        const small = computeWithParity(
            profile({
                employmentType: "self_employed",
                selfEmployedIncomeKind: "profits",
                grossAnnualIncome: 10_000,
            }),
        );
        expect(small.professionalExpenses).toBe(3_000);
    });

    test("self-employed fees (baten) use the degressive art. 51 al. 2, 4° scale, capped at €5,210", () => {
        // FPS indexation notice AY 2026: 28.7% to 7,540 / 10% to 14,970 / 5% to 24,920 / 3% above;
        // cap "conjoints aidants et profits" 5,210.
        const fees = computeWithParity(
            profile({
                employmentType: "self_employed",
                selfEmployedIncomeKind: "fees",
                grossAnnualIncome: 30_000,
            }),
        );
        const expected =
            7_540 * 0.287 +
            (14_970 - 7_540) * 0.1 +
            (24_920 - 14_970) * 0.05 +
            (30_000 - 24_920) * 0.03;
        expect(fees.professionalExpenses).toBeCloseTo(expected, 2); // 3,556.88
        const capped = computeWithParity(
            profile({
                employmentType: "self_employed",
                selfEmployedIncomeKind: "fees",
                grossAnnualIncome: 100_000,
            }),
        );
        expect(capped.professionalExpenses).toBe(5_210);
        // IY 2024 scale (notice AY 2025): 7,310 / 14,520 / 24,160, cap 5,050.
        const y24 = computeWithParity(
            profile({
                taxYear: 2024,
                employmentType: "self_employed",
                selfEmployedIncomeKind: "fees",
                grossAnnualIncome: 100_000,
            }),
        );
        expect(y24.professionalExpenses).toBe(5_050);
    });

    test("pensions and other income carry no forfait", () => {
        const result = computeWithParity(
            profile({ employmentType: "retired", grossAnnualIncome: 30_000 }),
        );
        expect(result.professionalExpenses).toBe(0);
    });

    test("self-employed actual expenses are deductible", () => {
        const result = computeWithParity(
            profile({
                employmentType: "self_employed",
                grossAnnualIncome: 80_000,
                professionalExpenseMethod: "actual",
                actualProfessionalExpenses: 12_000,
            }),
        );
        expect(result.professionalExpenses).toBe(12_000);
    });

    test("progressive brackets accumulate at the right thresholds (€60k gross IY 2025)", () => {
        // Single, no dependents, employee, lump-sum forfait, 7% surcharge.
        // Gross 60_000 → SS 60_000×0.1307 = 7_842 → net 52_158
        // forfait min(60_000×0.30, 5_930) = 5_930 → taxable 46_228
        const result = computeWithParity(
            profile({ grossAnnualIncome: 60_000 }),
        );
        expect(result.taxableIncome).toBeCloseTo(46_228, 0);
        // Bracket 1: 16_320 × 0.25 = 4_080
        expect(result.federalPITBracket1).toBeCloseTo(4_080, 1);
        // Bracket 2: 12_480 × 0.40 = 4_992
        expect(result.federalPITBracket2).toBeCloseTo(4_992, 1);
        // Bracket 3: (46_228 − 28_800) × 0.45 = 17_428 × 0.45 = 7_842.6
        expect(result.federalPITBracket3).toBeCloseTo(7_842.6, 1);
        // Bracket 4: 0 (below €49,840)
        expect(result.federalPITBracket4).toBe(0);
        expect(result.marginalRate).toBe(45);
    });

    test("personal exemption applied at lowest brackets first (PwC method)", () => {
        // CIR-92 art. 134 §3 + PwC sample: the exemption is taxed from the lowest
        // exemption-bracket up. Basic IY2025 exemption €10,910 < first-bracket
        // ceiling €11,460, so it all sits in bracket 1: benefit = 10_910 × 0.25 = 2_727.50.
        const result = computeWithParity(
            profile({ grossAnnualIncome: 40_000 }),
        );
        expect(result.personalExemptionBenefit).toBeCloseTo(2_727.5, 1);
    });

    test("PwC screenshot case: taxable €19,105.84 → exemption benefit €2,727.50", () => {
        // Real-world reproduction of the user's PIT breakdown screenshot. Before the F1 fix
        // the value was €3,145.38 (exemption applied at the top). PwC-correct value is €2,727.50.
        // Use "other" so all of the gross flows straight to taxable income (no SS, no forfait).
        const result = computeWithParity(
            profile({
                employmentType: "other",
                grossAnnualIncome: 19_105.84,
            }),
        );
        // Sanity: taxable income lands where the screenshot shows.
        expect(result.taxableIncome).toBeCloseTo(19_105.84, 0);
        // Federal PIT before reductions matches the screenshot's 5_194.34.
        expect(result.federalPITBeforeExemption).toBeCloseTo(5_194.34, 0);
        // Belastingvrije som benefit — the value this audit fix corrects.
        expect(result.personalExemptionBenefit).toBeCloseTo(2_727.5, 1);
    });

    test("exemption straddling two brackets uses 25% then 30% overflow (PwC sample)", () => {
        // Two children at IY2025 → exemption = 10_910 + 5_110 = 16_020.
        // PwC AY2026 sample: 25% × 11_460 + 30% × (16_020 - 11_460)
        //                  = 2_865 + 1_368 = 4_233.
        const result = computeWithParity(
            profile({ grossAnnualIncome: 80_000, dependentChildren: 2 }),
        );
        expect(result.personalExemptionAmount).toBe(16_020);
        expect(result.personalExemptionBenefit).toBeCloseTo(4_233, 1);
    });

    test("exemption above the 16_320 cut spills into the 40% slice", () => {
        // Three children + isolated parent push exemption above €16,320.
        // exemption = 10_910 + 11_440 + 1_980 = 24_330
        //   25% × 11_460                  = 2_865
        //   30% × (16_320 - 11_460=4_860) = 1_458
        //   40% × (24_330 - 16_320=8_010) = 3_204
        // total benefit = 7_527
        const result = computeWithParity(
            profile({
                grossAnnualIncome: 80_000,
                dependentChildren: 3,
                isIsolatedParent: true,
            }),
        );
        expect(result.personalExemptionAmount).toBe(24_330);
        expect(result.personalExemptionBenefit).toBeCloseTo(7_527, 1);
    });

    test("dependent children increase the personal exemption", () => {
        const noKids = computeWithParity(
            profile({ grossAnnualIncome: 60_000 }),
        );
        const twoKids = computeWithParity(
            profile({ grossAnnualIncome: 60_000, dependentChildren: 2 }),
        );
        expect(twoKids.personalExemptionAmount).toBe(
            noKids.personalExemptionAmount + 5_110,
        );
        expect(twoKids.totalPIT).toBeLessThan(noKids.totalPIT);
    });

    test("isolated parent adds the single-parent supplement when at least one child", () => {
        const single = computeWithParity(
            profile({
                grossAnnualIncome: 60_000,
                dependentChildren: 1,
                isIsolatedParent: true,
            }),
        );
        const couple = computeWithParity(
            profile({ grossAnnualIncome: 60_000, dependentChildren: 1 }),
        );
        expect(single.personalExemptionAmount).toBe(
            couple.personalExemptionAmount + 1_980,
        );
    });

    test("disability supplement adds €1,980 for self", () => {
        const disabled = computeWithParity(
            profile({ grossAnnualIncome: 60_000, isDisabled: true }),
        );
        const normal = computeWithParity(
            profile({ grossAnnualIncome: 60_000 }),
        );
        expect(disabled.personalExemptionAmount).toBe(
            normal.personalExemptionAmount + 1_980,
        );
    });

    test("disabled child counts as TWO children on the supplement scale", () => {
        // 1 dependent child of which 1 is disabled → effective count 2 → IY2025 €5,110
        // supplement (vs €1,980 for an able-bodied single child).
        const disabled = computeWithParity(
            profile({
                grossAnnualIncome: 60_000,
                dependentChildren: 1,
                dependentChildrenDisabled: 1,
            }),
        );
        const able = computeWithParity(
            profile({ grossAnnualIncome: 60_000, dependentChildren: 1 }),
        );
        expect(disabled.personalExemptionAmount).toBe(
            able.personalExemptionAmount + (5_110 - 1_980),
        );
    });

    test("disabled-child count is capped at the dependent-children head count", () => {
        // disabledChildren > dependentChildren is clamped — taxpayer can't claim more
        // disabled children than they have dependents.
        const r = computeWithParity(
            profile({
                grossAnnualIncome: 60_000,
                dependentChildren: 1,
                dependentChildrenDisabled: 5,
            }),
        );
        const sane = computeWithParity(
            profile({
                grossAnnualIncome: 60_000,
                dependentChildren: 1,
                dependentChildrenDisabled: 1,
            }),
        );
        expect(r.personalExemptionAmount).toBe(sane.personalExemptionAmount);
    });

    test("child-under-3 supplement is skipped when childcare credit is claimed", () => {
        // CIR-92 art. 132bis: the two are mutually exclusive.
        const withChildcare = computeWithParity(
            profile({
                grossAnnualIncome: 60_000,
                dependentChildren: 1,
                dependentChildrenUnder3: 1,
                childcareEligible: true,
                childcareCosts: 2_000,
                childcareEligibleDays: 100,
            }),
        );
        const noChildcare = computeWithParity(
            profile({
                grossAnnualIncome: 60_000,
                dependentChildren: 1,
                dependentChildrenUnder3: 1,
            }),
        );
        // With childcare deduction the under-3 supplement (€740 IY2025) is forfeit.
        expect(
            noChildcare.personalExemptionAmount -
                withChildcare.personalExemptionAmount,
        ).toBe(740);
    });

    test("state + regional factor: 1.0000 Flanders and Wallonia, 0.9950 Brussels (75.043% × opcentiemen)", () => {
        // Reduced state tax 75.043% (RD 19 Dec 2017) × (1 + 33.257%) or × (1 + 32.591%).
        for (const year of [2024, 2025, 2026]) {
            const tbl = getTaxTable(year);
            expect(tbl.regionalAutonomyFactor.flanders).toBeCloseTo(0.75043 * 1.33257, 4);
            expect(tbl.regionalAutonomyFactor.wallonia).toBeCloseTo(0.75043 * 1.33257, 4);
            expect(tbl.regionalAutonomyFactor.brussels).toBeCloseTo(0.75043 * 1.32591, 4);
        }
        // The factor multiplies the PIT after reductions and propagates to the surcharge.
        const flanders = computeWithParity(profile({ grossAnnualIncome: 60_000 }));
        const brussels = computeWithParity(
            profile({ grossAnnualIncome: 60_000, region: "brussels" }),
        );
        expect(brussels.federalPITAfterReductions).toBeCloseTo(
            flanders.federalPITAfterReductions * 0.995,
            6,
        );
    });

    test("pension savings credit only applies when eligible flag set", () => {
        const noFlag = computeWithParity(
            profile({
                grossAnnualIncome: 60_000,
                personalPensionContributions: 1_050,
            }),
        );
        const withFlag = computeWithParity(
            profile({
                grossAnnualIncome: 60_000,
                personalPensionContributions: 1_050,
                pensionEligible: true,
            }),
        );
        expect(noFlag.federalTaxCredits).toBe(0);
        expect(withFlag.federalTaxCredits).toBeCloseTo(1_050 * 0.3, 2);
    });

    test("alternative pension scheme uses €1,350 cap × 25%", () => {
        const result = computeWithParity(
            profile({
                grossAnnualIncome: 60_000,
                personalPensionContributions: 1_500,
                pensionEligible: true,
                pensionScheme: "1350",
            }),
        );
        expect(result.federalTaxCredits).toBeCloseTo(1_350 * 0.25, 2);
    });

    test("charitable donations require eligibility flag and minimum €40 (IY 2025 = 30%)", () => {
        const tiny = computeWithParity(
            profile({
                grossAnnualIncome: 60_000,
                charitableDonations: 30,
                charitableDonationsEligible: true,
            }),
        );
        const valid = computeWithParity(
            profile({
                grossAnnualIncome: 60_000,
                charitableDonations: 200,
                charitableDonationsEligible: true,
            }),
        );
        expect(tiny.federalTaxCredits).toBe(0); // below €40 minimum
        // Law of 11 Dec 2025 lowered the donation reduction from 45% to 30% as from AY 2026 (IY 2025).
        expect(valid.federalTaxCredits).toBeCloseTo(200 * 0.3, 2);
    });

    test("donation rate is 45% for IY 2024 but 30% for IY 2025", () => {
        const y24 = computeWithParity(
            profile({
                taxYear: 2024,
                grossAnnualIncome: 60_000,
                charitableDonations: 200,
                charitableDonationsEligible: true,
            }),
        );
        const y25 = computeWithParity(
            profile({
                taxYear: 2025,
                grossAnnualIncome: 60_000,
                charitableDonations: 200,
                charitableDonationsEligible: true,
            }),
        );
        expect(y24.federalTaxCredits).toBeCloseTo(200 * 0.45, 2);
        expect(y25.federalTaxCredits).toBeCloseTo(200 * 0.3, 2);
    });

    test("donation eligible amount capped at 10% of net taxable income", () => {
        // Gross 60_000 → SS 7_842, forfait 5_930 → taxable 46_228.
        // 10% × 46_228 = 4_622.80 → caps the €8_000 gift.
        // Credit (IY 2025) = 4_622.80 × 0.30 = 1_386.84.
        const result = computeWithParity(
            profile({
                grossAnnualIncome: 60_000,
                charitableDonations: 8_000,
                charitableDonationsEligible: true,
            }),
        );
        expect(result.federalTaxCredits).toBeCloseTo(4_622.8 * 0.3, 1);
    });

    test("donation absolute cap is €408,130 for both IY 2024 and IY 2025", () => {
        // Income high enough that 10% × taxable > €408,130 → absolute cap binds.
        // Gross 5_000_000 employee → forfait capped €5_930 → taxable ≈ 4_341_565 →
        // 10% = 434_156.50, exceeds absolute cap.
        const y24 = computeWithParity(
            profile({
                taxYear: 2024,
                grossAnnualIncome: 5_000_000,
                charitableDonations: 1_000_000,
                charitableDonationsEligible: true,
            }),
        );
        // PIT before exemption is far above any credit, so federalTaxCredits ≈ raw credit.
        expect(y24.federalTaxCredits).toBeCloseTo(408_130 * 0.45, 0);

        const y25 = computeWithParity(
            profile({
                taxYear: 2025,
                grossAnnualIncome: 5_000_000,
                charitableDonations: 1_000_000,
                charitableDonationsEligible: true,
            }),
        );
        expect(y25.federalTaxCredits).toBeCloseTo(408_130 * 0.3, 0);
    });

    test("domestic help credit: €8,160 wage cap for IY 2024, abolished from IY 2025", () => {
        // Art. 145/34 al. 5 — FPS indexation notice AY 2025: 8,160. Abolished by the law of
        // 18 Dec 2025 art. 68, applicable from AY 2026 (art. 90).
        const y24 = computeWithParity(
            profile({
                taxYear: 2024,
                grossAnnualIncome: 100_000,
                domesticHelpCosts: 50_000,
                domesticHelpEligible: true,
            }),
        );
        expect(y24.federalTaxCredits).toBeCloseTo(8_160 * 0.3, 2);
        const y25 = computeWithParity(
            profile({
                grossAnnualIncome: 100_000,
                domesticHelpCosts: 50_000,
                domesticHelpEligible: true,
            }),
        );
        expect(y25.federalTaxCredits).toBe(0);
    });

    test("alimony deductible at 80% (2024), 70% (2025) and 60% (2026) — art. 104", () => {
        // Law of 18 Dec 2025 art. 35; fin.belgium.be "Betaald onderhoudsgeld".
        const deducted = (taxYear: number) => {
            const result = computeWithParity(
                profile({ taxYear, grossAnnualIncome: 60_000, alimonyPaid: 10_000 }),
            );
            const noAlimony = computeWithParity(
                profile({ taxYear, grossAnnualIncome: 60_000 }),
            );
            return noAlimony.taxableIncome - result.taxableIncome;
        };
        expect(deducted(2024)).toBe(8_000);
        expect(deducted(2026)).toBe(6_000);
        const result = computeWithParity(
            profile({ grossAnnualIncome: 60_000, alimonyPaid: 10_000 }),
        );
        const noAlimony = computeWithParity(
            profile({ grossAnnualIncome: 60_000 }),
        );
        // 70% × 10_000 = 7_000 less taxable income
        expect(noAlimony.taxableIncome - result.taxableIncome).toBe(7_000);
    });

    test("communal surcharge applied to federal PIT after credits", () => {
        const result = computeWithParity(
            profile({ grossAnnualIncome: 60_000, communalSurchargePercent: 8 }),
        );
        expect(result.communalSurcharge).toBeCloseTo(
            result.federalPITAfterReductions * 0.08,
            2,
        );
    });

    test("dividend WHT reclaim modeled as tax-return credit", () => {
        const result = computeWithParity(
            profile({ annualDividendIncome: 2_000 }),
        );
        // Art. 21, 14°: €833 for IY 2024, 2025 and 2026 (frozen by the law of 18 Dec 2025;
        // FPS indexation notices AY 2025-2027, fin.belgium.be "Vrijstellingen dividenden").
        // 833 × 30% = 249.90
        expect(result.dividendWhtReclaim).toBeCloseTo(833 * 0.3, 2);
        for (const taxYear of [2024, 2026]) {
            expect(
                computeWithParity(profile({ taxYear, annualDividendIncome: 2_000 }))
                    .dividendWhtReclaim,
            ).toBeCloseTo(833 * 0.3, 2);
        }
    });

    test("savings interest tax = 15% above the €1,020 exemption (IY 2024-2026)", () => {
        // Art. 21, 5°: 1,020 after the freeze (FPS indexation notice AY 2026 prints
        // "1.050 — après gel: 1.020"; fin.belgium.be "Spaargeld en beleggingen").
        const result = computeWithParity(
            profile({ annualSavingsInterest: 2_000 }),
        );
        // (2_000 - 1_020) × 0.15 = 147
        expect(result.savingsInterestTax).toBeCloseTo(147, 2);
        expect(
            computeWithParity(profile({ taxYear: 2026, annualSavingsInterest: 2_000 }))
                .savingsInterestTax,
        ).toBeCloseTo(147, 2);
    });

    test("life insurance reduction cap is €2,450 for IY 2024-2026 (art. 145/6, frozen)", () => {
        for (const taxYear of [2024, 2025, 2026]) {
            const result = computeWithParity(
                profile({
                    taxYear,
                    grossAnnualIncome: 60_000,
                    lifeInsurancePremiums: 5_000,
                    lifeInsuranceEligible: true,
                }),
            );
            expect(result.federalTaxCredits).toBeCloseTo(2_450 * 0.3, 2);
        }
    });

    test("IY 2024 tables apply when taxYear = 2024", () => {
        const result = computeWithParity(
            profile({ taxYear: 2024, grossAnnualIncome: 60_000 }),
        );
        // IY 2024 employee forfait cap = 5_750
        expect(result.professionalExpenses).toBe(5_750);
    });

    test("tax credits cannot make PIT go negative; appliedTaxCredits clamps to PIT", () => {
        // Modest income + many children pushes exemption benefit ≈ federal PIT, so even
        // a small donation credit forces the cap to bite. Without the clamp, the model
        // would emit a negative federal PIT.
        const result = computeWithParity(
            profile({
                grossAnnualIncome: 30_000,
                dependentChildren: 4,
                charitableDonations: 100_000,
                charitableDonationsEligible: true,
            }),
        );
        expect(result.federalPITAfterReductions).toBe(0);
        // Displayed federalTaxCredits is clamped — never exceeds gross PIT.
        expect(result.federalTaxCredits).toBeLessThanOrEqual(
            result.federalPITBeforeExemption,
        );
    });

    test("Flemish woonbonus, loan signed in 2015: €1,520 base at 40% (art. 145/37 §3)", () => {
        const result = computeWithParity(
            profile({
                grossAnnualIncome: 50_000,
                region: "flanders",
                mortgageIsPrimaryResidence: true,
                mortgageStartYear: 2015,
                mortgageRegion: "flanders",
                mortgageInterestPaid: 2_000,
                mortgageCapitalRepaid: 3_000,
            }),
        );
        expect(result.ownHomeCreditRegime).toBe("flemish_woonbonus");
        // 2015 mortgage → eleventh period in IY 2025 → no €760 increase. 1_520 × 0.40 = 608.
        expect(result.ownHomeCredit).toBeCloseTo(608, 1);
    });

    test("Flemish woonbonus, loan signed before 2015: €2,280 at the marginal rate, minimum 30% (art. 145/37 §2)", () => {
        const base = {
            region: "flanders" as const,
            mortgageIsPrimaryResidence: true,
            mortgageStartYear: 2012,
            mortgageRegion: "flanders" as const,
            mortgageInterestPaid: 2_000,
            mortgageCapitalRepaid: 3_000,
        };
        // Gross 50,000 → taxable income in the 45% bracket (IY 2025: 28,800-49,840).
        const high = computeWithParity(profile({ grossAnnualIncome: 50_000, ...base }));
        expect(high.marginalRate).toBe(45);
        expect(high.ownHomeCredit).toBeCloseTo(2_280 * 0.45, 2);
        // Gross 15,000 → 25% bracket → the 30% minimum applies.
        const low = computeWithParity(profile({ grossAnnualIncome: 15_000, ...base }));
        expect(low.marginalRate).toBe(25);
        expect(low.ownHomeCredit).toBeCloseTo(2_280 * 0.3, 2);
    });

    test("Flemish woonbonus: the €80 for 3+ children applies only with the first-ten-years €760", () => {
        const loan = (startYear: number) =>
            computeWithParity(
                profile({
                    grossAnnualIncome: 50_000,
                    dependentChildren: 3,
                    region: "flanders",
                    mortgageIsPrimaryResidence: true,
                    mortgageStartYear: startYear,
                    mortgageRegion: "flanders",
                    mortgageInterestPaid: 5_000,
                    mortgageCapitalRepaid: 3_000,
                }),
            );
        // 2019 loan, IY 2025 (seventh period): (1_520 + 760 + 80) × 40%.
        expect(loan(2019).ownHomeCredit).toBeCloseTo((1_520 + 760 + 80) * 0.4, 2);
        // 2015 loan, IY 2025 (eleventh period): 1_520 × 40%, no €760 and no €80.
        expect(loan(2015).ownHomeCredit).toBeCloseTo(1_520 * 0.4, 2);
    });

    test('Flemish "geïntegreerde" woonbonus (2016-2019 loan) uses €1,520 base + first-10y supplement', () => {
        const result = computeWithParity(
            profile({
                grossAnnualIncome: 50_000,
                region: "flanders",
                mortgageIsPrimaryResidence: true,
                mortgageStartYear: 2019,
                mortgageRegion: "flanders",
                mortgageInterestPaid: 5_000,
                mortgageCapitalRepaid: 3_000,
            }),
        );
        // 2019 mortgage → "geïntegreerde" regime (post-2016 reform).
        // cap = 1_520 + 760 = 2_280. credit = 2_280 × 0.40 = 912.
        expect(result.ownHomeCredit).toBeCloseTo(912, 1);
    });

    test("Flemish woonbonus IY 2024: a 2015 loan in its first ten periods matches the integrated regime", () => {
        // IY 2024 puts a 2015 loan in its tenth period: art. 145/37 §3 gives 1_520 + 760 at 40%,
        // the same as a 2016-2019 integrated woonbonus (art. 145/38/2).
        //   2015 loan:  cap = 1_520 + 760 = 2_280 → credit 912.
        //   2019 loan:  cap = 1_520 + 760 = 2_280 → credit 912.
        const ordinary = computeWithParity(
            profile({
                taxYear: 2024,
                grossAnnualIncome: 50_000,
                region: "flanders",
                mortgageIsPrimaryResidence: true,
                mortgageStartYear: 2015,
                mortgageRegion: "flanders",
                mortgageInterestPaid: 5_000,
                mortgageCapitalRepaid: 3_000,
            }),
        );
        const integrated = computeWithParity(
            profile({
                taxYear: 2024,
                grossAnnualIncome: 50_000,
                region: "flanders",
                mortgageIsPrimaryResidence: true,
                mortgageStartYear: 2019,
                mortgageRegion: "flanders",
                mortgageInterestPaid: 5_000,
                mortgageCapitalRepaid: 3_000,
            }),
        );
        expect(ordinary.ownHomeCredit).toBeCloseTo(912, 1);
        expect(integrated.ownHomeCredit).toBeCloseTo(912, 1);
    });

    const walloon = (overrides: Partial<BelgianTaxProfile>) =>
        computeWithParity(
            profile({
                region: "wallonia",
                mortgageIsPrimaryResidence: true,
                mortgageStartYear: 2018,
                mortgageRegion: "wallonia",
                mortgageInterestPaid: 4_000,
                ...overrides,
            }),
        );

    test("Walloon chèque habitat between the income limits: 1,520 − 1.275% × (income − lower limit) + 125 per child", () => {
        const result = walloon({ grossAnnualIncome: 50_000, dependentChildren: 2 });
        expect(result.ownHomeCreditRegime).toBe("walloon_cheque_habitat");
        // Art. 145/46ter §2, 2° (circular 2026/C/18); IY 2025 lower limit 27,353 (N26).
        const expected = 1_520 - (result.taxableIncome - 27_353) * 0.01275 + 2 * 125;
        expect(result.taxableIncome).toBeGreaterThan(27_353);
        expect(result.ownHomeCredit).toBeCloseTo(expected, 2);
    });

    test("Walloon chèque habitat at or below the lower limit: full 1,520; disabled children count twice", () => {
        const result = walloon({
            grossAnnualIncome: 20_000,
            dependentChildren: 2,
            dependentChildrenDisabled: 1,
        });
        expect(result.taxableIncome).toBeLessThanOrEqual(27_353);
        // 1_520 + (2 + 1) × 125.
        expect(result.ownHomeCredit).toBeCloseTo(1_895, 2);
    });

    test("Walloon chèque habitat above the upper limit: nothing, not even the child increase", () => {
        const result = walloon({ grossAnnualIncome: 200_000, dependentChildren: 2 });
        expect(result.taxableIncome).toBeGreaterThan(105_503);
        expect(result.ownHomeCredit).toBe(0);
    });

    test("Walloon chèque habitat: halved from the eleventh period, capped at the amounts paid", () => {
        // 2016 loan in IY 2026 is the eleventh period (§3).
        const eleventh = walloon({
            taxYear: 2026,
            grossAnnualIncome: 20_000,
            mortgageStartYear: 2016,
        });
        expect(eleventh.ownHomeCredit).toBeCloseTo(1_520 / 2, 2);
        // §4: never more than the interest and capital actually paid.
        const capped = walloon({
            grossAnnualIncome: 20_000,
            mortgageInterestPaid: 500,
            mortgageCapitalRepaid: 300,
        });
        expect(capped.ownHomeCredit).toBeCloseTo(800, 2);
    });

    test("Walloon chèque habitat: twenty assessment years at most (art. 145/46quinquies); loan age follows the income year", () => {
        // 2017 loan in IY 2027 (approximated year on the 2026 table) is the eleventh period: halved,
        // not full as `table.year` − 2017 = 9 would give.
        const eleventh = walloon({ taxYear: 2027, grossAnnualIncome: 20_000, mortgageStartYear: 2017 });
        expect(eleventh.ownHomeCredit).toBeCloseTo(1_520 / 2, 2);
        // 2016 loan in IY 2035 is the twentieth period (still halved); IY 2036 is the twenty-first.
        const twentieth = walloon({ taxYear: 2035, grossAnnualIncome: 20_000, mortgageStartYear: 2016 });
        expect(twentieth.ownHomeCredit).toBeCloseTo(1_520 / 2, 2);
        const twentyFirst = walloon({ taxYear: 2036, grossAnnualIncome: 20_000, mortgageStartYear: 2016 });
        expect(twentyFirst.ownHomeCreditRegime).toBe("walloon_cheque_habitat");
        expect(twentyFirst.ownHomeCredit).toBe(0);
    });

    test("Walloon chèque habitat: periods count from the first qualifying year when set (art. 145/46quinquies)", () => {
        const table = getTaxTable(2026);
        const inputs: OwnHomeCreditInputs = {
            region: "wallonia",
            mortgageIsPrimaryResidence: true,
            mortgageStartYear: 2016,
            mortgageRegion: "wallonia",
            mortgageInterestPaid: 4_000,
            dependentChildren: 0,
        };
        const taxpayer = (incomeYear: number) => ({
            taxableIncome: 20_000,
            marginalRatePercent: 25,
            incomeYear,
        });
        const credit = (incomeYear: number, firstQualifyingYear?: number) =>
            computeOwnHomeCredit(
                firstQualifyingYear === undefined
                    ? inputs
                    : { ...inputs, firstQualifyingYear },
                table,
                "walloon_cheque_habitat",
                taxpayer(incomeYear),
            );
        // Without the input the 2016 loan year is the proxy: IY 2026 is the eleventh period.
        expect(credit(2026)).toBeCloseTo(1_520 / 2, 2);
        // A home that first qualified in 2019 (after construction) is in its eighth period: full.
        expect(credit(2026, 2019)).toBeCloseTo(1_520, 2);
        // Halved from the eleventh period counted from 2019 (IY 2029), nothing from the 21st (IY 2039).
        expect(credit(2028, 2019)).toBeCloseTo(1_520, 2);
        expect(credit(2029, 2019)).toBeCloseTo(1_520 / 2, 2);
        expect(credit(2038, 2019)).toBeCloseTo(1_520 / 2, 2);
        expect(credit(2039, 2019)).toBe(0);
        // Before the first qualifying year the conditions are not met yet.
        expect(credit(2018, 2019)).toBe(0);
    });

    test("Walloon chèque habitat: computeBelgianPIT keeps the loan-year proxy (no v1 input)", () => {
        const result = walloon({ taxYear: 2026, grossAnnualIncome: 20_000, mortgageStartYear: 2016 });
        expect(result.ownHomeCredit).toBeCloseTo(1_520 / 2, 2);
    });

    test("Walloon chèque habitat: loans signed from 1 Jan 2025 do not qualify", () => {
        const result = walloon({ grossAnnualIncome: 20_000, mortgageStartYear: 2025 });
        expect(result.ownHomeCreditRegime).toBe("none");
        expect(result.ownHomeCredit).toBe(0);
    });

    test("Brussels primary residence: no own-home credit modeled", () => {
        const result = computeWithParity(
            profile({
                grossAnnualIncome: 50_000,
                region: "brussels",
                mortgageIsPrimaryResidence: true,
                mortgageStartYear: 2019,
                mortgageRegion: "brussels",
                mortgageInterestPaid: 5_000,
            }),
        );
        expect(result.ownHomeCreditRegime).toBe("none");
        expect(result.ownHomeCredit).toBe(0);
    });

    test("Post-2020 Flemish mortgage: no woonbonus successor modeled", () => {
        const result = computeWithParity(
            profile({
                grossAnnualIncome: 50_000,
                region: "flanders",
                mortgageIsPrimaryResidence: true,
                mortgageStartYear: 2021,
                mortgageRegion: "flanders",
                mortgageInterestPaid: 5_000,
            }),
        );
        expect(result.ownHomeCreditRegime).toBe("none");
        expect(result.ownHomeCredit).toBe(0);
    });

    test("marital quotient: single-earner couple shifts income to spouse and lowers PIT", () => {
        const single = computeWithParity(
            profile({ grossAnnualIncome: 80_000, filingStatus: "single" }),
        );
        const married = computeWithParity(
            profile({
                grossAnnualIncome: 80_000,
                filingStatus: "married_joint",
                spouseProfessionalIncome: 0,
            }),
        );
        expect(married.maritalQuotientTransfer).toBeGreaterThan(0);
        // €80k single earner → after SS+forfait ~€63,665 taxable. 30% of household = €19,099.5,
        // but the IY 2025 cap is €13,460, so transfer caps at €13,460.
        expect(married.maritalQuotientTransfer).toBeCloseTo(13_460, 0);
        expect(married.maritalQuotientBenefit).toBeGreaterThan(0);
        expect(married.federalPITAfterReductions).toBeLessThan(
            single.federalPITAfterReductions,
        );
    });

    test("marital quotient: does not apply when spouse already earns ≥30% of household", () => {
        const result = computeWithParity(
            profile({
                grossAnnualIncome: 50_000,
                filingStatus: "married_joint",
                spouseProfessionalIncome: 35_000, // > 30% of 85_000
            }),
        );
        expect(result.maritalQuotientTransfer).toBe(0);
        expect(result.maritalQuotientBenefit).toBe(0);
    });

    test("joint assessment taxes the spouse's own income even when no quotient applies (décumul)", () => {
        // Art. 126 §1 and art. 130: each spouse's income is taxed in their own name. With the
        // spouse at 35k (≥ 30% of the household) no transfer happens, but the household tax must
        // still include the spouse's own progressive tax net of the basic exemption. Until
        // 2026-10-11 the engine dropped the spouse's tax entirely in this case.
        // IY 2025: brackets 16,320 / 28,800 / 49,840; basic exemption 10,910 × 25% = 2,727.50.
        //  earner taxable 50_000 − 6_535 − 5_930 = 37_535 → 4_080 + 4_992 + 3_930.75 − 2_727.50 = 10_275.25
        //  spouse 35_000                            → 4_080 + 4_992 + 2_790    − 2_727.50 =  9_134.50
        const earnerOnly = computeWithParity(
            profile({ grossAnnualIncome: 50_000, filingStatus: "married_joint", spouseProfessionalIncome: 0 }),
        );
        const joint = computeWithParity(
            profile({ grossAnnualIncome: 50_000, filingStatus: "married_joint", spouseProfessionalIncome: 35_000 }),
        );
        expect(joint.maritalQuotientTransfer).toBe(0);
        expect(joint.federalPITBeforeExemption - joint.personalExemptionBenefit).toBeCloseTo(10_275.25 + 9_134.5, 2);
        expect(joint.federalPITBeforeExemption - joint.personalExemptionBenefit).toBeGreaterThan(
            earnerOnly.federalPITBeforeExemption - earnerOnly.personalExemptionBenefit,
        );
        // Household aggregates include the spouse's income, since totalPIT and the CSSS do.
        expect(joint.grossIncome).toBe(50_000);
        expect(joint.spouseProfessionalIncome).toBe(35_000);
        expect(joint.householdGrossIncome).toBe(85_000);
        expect(joint.netTakeHome).toBeCloseTo(85_000 - joint.totalTaxBurden, 6);
        expect(joint.effectiveRate).toBeCloseTo((joint.totalTaxBurden / 85_000) * 100, 6);
        expect(joint.breakdown.find((r) => r.label === "Spouse professional income")?.amount).toBe(35_000);
        expect(earnerOnly.householdGrossIncome).toBe(50_000);
    });

    test("marital quotient ignored for single filer even if spouse income set", () => {
        const result = computeWithParity(
            profile({
                grossAnnualIncome: 80_000,
                filingStatus: "single",
                spouseProfessionalIncome: 0,
            }),
        );
        expect(result.maritalQuotientTransfer).toBe(0);
        expect(result.maritalQuotientBenefit).toBe(0);
    });

    test("IY 2024 marital quotient uses the lower cap (€13,050)", () => {
        // Arts 87-88 — FPS indexation notice AY 2025 and fin.belgium.be previous-years page.
        const result = computeWithParity(
            profile({
                taxYear: 2024,
                grossAnnualIncome: 80_000,
                filingStatus: "married_joint",
                spouseProfessionalIncome: 0,
            }),
        );
        expect(result.maritalQuotientTransfer).toBeCloseTo(13_050, 0);
    });

    test("IY 2026 marital quotient cap is €11,780 after the law of 15 July 2026", () => {
        // Art. 88 base 5,860 indexed — FPS indexation notice AY 2027.
        const result = computeWithParity(
            profile({
                taxYear: 2026,
                grossAnnualIncome: 80_000,
                filingStatus: "married_joint",
                spouseProfessionalIncome: 0,
            }),
        );
        expect(result.maritalQuotientTransfer).toBeCloseTo(11_780, 0);
    });

    test("marital quotient: art. 88 caps own income PLUS transfer at the cap", () => {
        // Art. 88 al. 1: the spouse is topped up so that own income + transferred part reaches
        // 30% of the household total "doch niet hoger dan" the cap. With €5,000 own income and
        // 30% of the household above the cap, the transfer is 13,460 − 5,000, not 13,460.
        const result = computeWithParity(
            profile({
                grossAnnualIncome: 80_000,
                filingStatus: "married_joint",
                spouseProfessionalIncome: 5_000,
            }),
        );
        expect(result.maritalQuotientTransfer).toBeCloseTo(13_460 - 5_000, 0);
    });

    test("service vouchers: Brussels 15% of the spend (legacy count × €10 when no spend is set)", () => {
        const result = computeWithParity(
            profile({
                region: "brussels",
                serviceVoucherCount: 100,
                serviceVoucherEligible: true,
            }),
        );
        // 100 × €10 = €1,000 spend, under the €1,850 cap → 15% = €150.
        expect(result.serviceVoucherCredit).toBeCloseTo(150, 2);
    });

    test("service vouchers: spend overrides the count and is capped per year and region", () => {
        const credit = (region: BelgianTaxProfile["region"], taxYear: number) =>
            computeWithParity(
                profile({
                    region,
                    taxYear,
                    serviceVoucherCount: 10,
                    serviceVoucherSpend: 5_000,
                    serviceVoucherEligible: true,
                }),
            ).serviceVoucherCredit;
        // WIB 92 art. 145/21, regional versions (Fisconetplus).
        expect(credit("flanders", 2024)).toBeCloseTo(1_790 * 0.2, 2);
        expect(credit("flanders", 2025)).toBe(0);
        expect(credit("wallonia", 2024)).toBeCloseTo(1_790 * 0.3, 2);
        expect(credit("wallonia", 2025)).toBeCloseTo(1_850 * 0.3, 2);
        expect(credit("wallonia", 2026)).toBeCloseTo(1_890 * 0.3, 2);
        expect(credit("brussels", 2024)).toBeCloseTo(1_790 * 0.15, 2);
        expect(credit("brussels", 2025)).toBeCloseTo(1_850 * 0.15, 2);
        // Brussels ordinance of 18 Dec 2025: abolished from AY 2027 (circular 2026/C/34).
        expect(credit("brussels", 2026)).toBe(0);
    });

    test("service vouchers: Wallonia 30% of the spend below the cap", () => {
        const result = computeWithParity(
            profile({
                region: "wallonia",
                serviceVoucherSpend: 900,
                serviceVoucherEligible: true,
            }),
        );
        expect(result.serviceVoucherCredit).toBeCloseTo(270, 2);
    });

    test("service vouchers: Flanders rate is 0 for IY 2025+", () => {
        const result = computeWithParity(
            profile({
                region: "flanders",
                taxYear: 2025,
                serviceVoucherCount: 100,
                serviceVoucherEligible: true,
            }),
        );
        expect(result.serviceVoucherCredit).toBe(0);
    });

    test("service vouchers: nothing when eligibility flag is off", () => {
        const result = computeWithParity(
            profile({
                region: "brussels",
                serviceVoucherCount: 100,
                serviceVoucherEligible: false,
            }),
        );
        expect(result.serviceVoucherCredit).toBe(0);
    });

    test("IY 2026 table carries the AY 2027 indexation notice (post-reform) and 10% capital gains tax", () => {
        const t26 = getTaxTable(2026);
        const t25 = getTaxTable(2025);
        // Art. 130 and art. 134 §2 — FPS indexation notice AY 2027.
        expect(t26.brackets.map((b) => b.to)).toEqual([16_720, 29_510, 51_070, Infinity]);
        expect(t26.exemptionBrackets.map((b) => b.to)).toEqual([
            11_750, 16_720, 27_860, 51_070, Infinity,
        ]);
        // Arts 131-133 after the law of 15 July 2026.
        expect(t26.basicPersonalExemption).toBe(11_550);
        expect(t26.dependentChildExemptionIncreases).toEqual([0, 2_130, 5_130, 11_440, 18_510]);
        expect(t26.disabledSupplement).toBe(2_030);
        expect(t26.employeeProfessionalExpenseCap).toBe(6_070);
        expect(t26.directorProfessionalExpenseCap).toBe(3_200);
        expect(t26.childcareDailyCap).toBe(17.3);
        // Frozen items stay at the IY 2025 level.
        expect(t26.dividendExemption).toBe(t25.dividendExemption);
        expect(t26.savingsInterestExemption).toBe(t25.savingsInterestExemption);
        expect(t26.pensionSavingsCapStandard).toBe(1_050);
        expect(t26.capitalGainsTaxRate).toBe(0.1);
        expect(t26.capitalGainsTaxExemptionSingle).toBe(10_000);
        expect(t26.capitalGainsTaxExemptionMarried).toBe(20_000);
        // IY 2025 and earlier have no CGT yet.
        expect(t25.capitalGainsTaxRate).toBe(0);
    });

    test("Mortgage not flagged as primary residence → no credit", () => {
        const result = computeWithParity(
            profile({
                grossAnnualIncome: 50_000,
                region: "flanders",
                mortgageIsPrimaryResidence: false,
                mortgageStartYear: 2018,
                mortgageInterestPaid: 5_000,
            }),
        );
        expect(result.ownHomeCredit).toBe(0);
    });
});

describe("PwC AY 2026 worked sample — end-to-end pipeline", () => {
    // Reference: PwC Worldwide Tax Summaries — Belgium — Individual — Sample personal income
    // tax calculation. Married, single-earner couple, 2 dependent children, AY 2026 (IY 2025).
    // PwC is a SECONDARY source (rule matrix P1). Its worked example implies a combined
    // state + regional factor of 0.99501, which equals the Brussels product 0.75043 × 1.32591,
    // not the Flemish 0.75043 × 1.33257 = 1.0000 the engine now uses (RD 19 Dec 2017, special
    // finance law art. 81quater). The sample is therefore re-derived here with the primary
    // factor for Flanders, and reproduced as published when run with the Brussels factor.
    //
    // PwC starts the worked example from "salary after social security = €50,000". To feed our
    // pre-SS pipeline, gross = 50,000 / (1 − 0.1307) ≈ 57,517.59 so net-after-SS rounds to €50k.
    //
    // PwC line items the pipeline must reproduce:
    //   • Forfait:                        €5,930  → taxable €44,070
    //   • Marital-quotient transfer:      €13,221 (= 30% × 44,070, under the €13,460 cap)
    //   • Earner exemption benefit (2 kids): 25%×11,460 + 30%×4,560 = €4,233
    //   • Spouse exemption benefit:        25%×10,910 = €2,727.50
    //   • Combined federal after the factor: PwC ~€6,307 (× 0.99501)
    //   • Communal surcharge 7%:           ~€441.5
    //   • CSSS (joint, base €44,070):      €422.94
    //   • Final tax due:                   €7,171.55 (PwC; we accept ±€2 for in-period rounding)
    // Re-derived for Flanders (factor 1.0000): (7,171.55 − 422.94) / 0.99501 + 422.94 ≈ €7,205.39.

    const pwcSample = (overrides: Partial<BelgianTaxProfile> = {}) =>
        profile({
            taxYear: 2025,
            grossAnnualIncome: 57_517.59,
            employmentType: "employee",
            region: "flanders",
            communalSurchargePercent: 7,
            dependentChildren: 2,
            filingStatus: "married_joint",
            spouseProfessionalIncome: 0,
            ...overrides,
        });

    const finalTaxDue = (r: ReturnType<typeof computeWithParity>) =>
        r.federalPITAfterReductions + r.communalSurcharge + r.specialSocialSecurityContribution;

    test("feeder values match the PwC AY 2026 sample", () => {
        const r = computeWithParity(pwcSample());
        expect(r.professionalExpenses).toBe(5_930);
        expect(r.taxableIncome).toBeCloseTo(44_070, 0);
        expect(r.maritalQuotientTransfer).toBeCloseTo(13_221, 0);
        expect(r.personalExemptionAmount).toBe(16_020); // 10,910 + 5,110 for 2 kids
        // CSSS — joint filer at €44,070 net taxable professional income → €422.94.
        expect(r.specialSocialSecurityContribution).toBeCloseTo(422.94, 1);
    });

    test("Flanders (factor 1.0000): final tax due within €2 of the re-derived €7,205.39", () => {
        // PwC rounds the bracket-3 slice (2,050 instead of 2,049), producing a ~€0.70
        // gap from our exact arithmetic. Allow ±€2 to absorb their published rounding.
        const r = computeWithParity(pwcSample());
        expect(Math.abs(finalTaxDue(r) - 7_205.39)).toBeLessThan(2);
    });

    test("Brussels (factor 0.9950) reproduces PwC's published €7,171.55 within €2", () => {
        const r = computeWithParity(pwcSample({ region: "brussels" }));
        expect(Math.abs(finalTaxDue(r) - 7_171.55)).toBeLessThan(2);
    });

    test("the state + regional factor is visible in the pipeline output", () => {
        // Federal PIT before the factor = brackets − exemption benefit (both spouses combined).
        const flanders = computeWithParity(pwcSample());
        const beforeFactor =
            flanders.federalPITBeforeExemption - flanders.personalExemptionBenefit;
        expect(flanders.federalPITAfterReductions).toBeCloseTo(beforeFactor * 1.0, 1);
        const brussels = computeWithParity(pwcSample({ region: "brussels" }));
        expect(brussels.federalPITAfterReductions).toBeCloseTo(beforeFactor * 0.995, 1);
    });
});

describe("special SS basis", () => {
    test("joint assessment: CSSS is computed on the household income, not the earner alone", () => {
        // Law of 30 March 1994 art. 107, 2° ("gezinsinkomen" = sum of each spouse's net income).
        // Earner alone: €50,000 gross → net professional ≈ 37,535 → joint scale €123.95 + 1.3% × …
        const alone = computeWithParity(
            profile({
                grossAnnualIncome: 50_000,
                filingStatus: "married_joint",
                spouseProfessionalIncome: 0,
            }),
        );
        const withSpouse = computeWithParity(
            profile({
                grossAnnualIncome: 50_000,
                filingStatus: "married_joint",
                spouseProfessionalIncome: 20_000,
            }),
        );
        expect(withSpouse.specialSocialSecurityContribution).toBeCloseTo(
            alone.specialSocialSecurityContribution + 0.013 * 20_000,
            2,
        );
    });

    test("IY 2024 exemption valuation brackets follow the AY 2025 notice (11,120 / 15,820 / 26,360 / 48,320)", () => {
        expect(getTaxTable(2024).exemptionBrackets.map((b) => b.to)).toEqual([
            11_120, 15_820, 26_360, 48_320, Infinity,
        ]);
    });

    test("uses professional income only, not other taxable income", () => {
        // Tiny salary + large rental income. Professional net (after SS + forfait) is well below
        // the €18,592 CSSS floor, so the contribution must be 0 even though `taxableIncome` is huge.
        const result = computeWithParity(
            profile({ grossAnnualIncome: 10_000, otherTaxableIncome: 80_000 }),
        );
        expect(result.taxableIncome).toBeGreaterThan(18_592);
        expect(result.specialSocialSecurityContribution).toBe(0);
    });

    test("uses professional income only — CSSS reached on salary alone is unchanged by rental", () => {
        const noRental = computeWithParity(
            profile({ grossAnnualIncome: 100_000 }),
        );
        const withRental = computeWithParity(
            profile({ grossAnnualIncome: 100_000, otherTaxableIncome: 50_000 }),
        );
        expect(noRental.specialSocialSecurityContribution).toBeCloseTo(
            731.28,
            2,
        );
        expect(withRental.specialSocialSecurityContribution).toBeCloseTo(
            731.28,
            2,
        );
    });
});

describe("computeSpecialSocialSecurityContribution — post 1 April 2022 reform", () => {
    const table = getTaxTable(2025);

    test("returns 0 below the €18,592 floor", () => {
        const p = profile({
            employmentType: "employee",
            grossAnnualIncome: 16_000,
        });
        expect(computeSpecialSocialSecurityContribution(p, 16_000, table)).toBe(
            0,
        );
    });

    test("tier 2 single: 5% × (income − €18,592.02)", () => {
        // €20,000 → 5% × €1,407.98 = €70.40
        const p = profile({
            employmentType: "employee",
            grossAnnualIncome: 20_000,
        });
        expect(
            computeSpecialSocialSecurityContribution(p, 20_000, table),
        ).toBeCloseTo(70.4, 2);
    });

    test("tier 3 single: €123.95 + 1.3% × (income − €21,070.96) at €25,000", () => {
        // Single tier 3 holds until €37,344. €25,000 → €123.95 + 1.3% × €3,929.04 = €175.03.
        const p = profile({ employmentType: "employee" });
        expect(
            computeSpecialSocialSecurityContribution(p, 25_000, table),
        ).toBeCloseTo(175.03, 2);
    });

    test("PwC IY 2025 sample reproduced — joint filer at €44,070 → €422.94", () => {
        // Direct check of the PwC sample (married, single earner, net taxable €44,070):
        // joint table tier 3 still applies → €123.95 + 1.3% × (44,070 − 21,070.96) = €422.94.
        const joint = profile({
            employmentType: "employee",
            filingStatus: "married_joint",
        });
        expect(
            computeSpecialSocialSecurityContribution(joint, 44_070, table),
        ).toBeCloseTo(422.94, 2);
    });

    test("tier 4 single: €335.50 + 4.009% × (income − €37,344) up to €40,997.26", () => {
        // Law of 30 March 1994 art. 108 §1 (law of 20 Nov 2022 version).
        const p = profile({ employmentType: "employee" });
        expect(
            computeSpecialSocialSecurityContribution(p, 40_000, table),
        ).toBeCloseTo(335.5 + 0.04009 * (40_000 - 37_344), 2);
        // Continuity at the tier 4 / tier 5 boundary: 335.50 + 4.009% × 3,653.26 = 481.96.
        expect(
            computeSpecialSocialSecurityContribution(p, 40_997.26, table),
        ).toBeCloseTo(481.96, 1);
    });

    test("tier 5 single: €481.96 + 1.2996% × (income − €40,997.26) up to €60,181.95", () => {
        const p = profile({ employmentType: "employee" });
        // 481.96 + 1.2996% × 3,072.74 = 521.89 (the pre-fix code returned 605.15 here).
        expect(
            computeSpecialSocialSecurityContribution(p, 44_070, table),
        ).toBeCloseTo(521.89, 1);
        expect(
            computeSpecialSocialSecurityContribution(p, 50_000, table),
        ).toBeCloseTo(481.96 + 0.012996 * (50_000 - 40_997.26), 2);
        // Reaches the €731.28 cap at the top of the tier.
        expect(
            computeSpecialSocialSecurityContribution(p, 60_181.95, table),
        ).toBeCloseTo(731.28, 1);
        expect(
            computeSpecialSocialSecurityContribution(p, 60_182, table),
        ).toBeCloseTo(731.28, 2);
    });

    test("caps at €731.28 for high incomes", () => {
        const p = profile({
            employmentType: "employee",
            grossAnnualIncome: 100_000,
        });
        expect(
            computeSpecialSocialSecurityContribution(p, 100_000, table),
        ).toBeCloseTo(731.28, 2);
    });

    test("returns 0 for self-employed", () => {
        const p = profile({
            employmentType: "self_employed",
            grossAnnualIncome: 60_000,
        });
        expect(computeSpecialSocialSecurityContribution(p, 50_000, table)).toBe(
            0,
        );
    });

    test("boundary income at the tier 1/2 cut sits in tier 1 (0)", () => {
        const p = profile({
            employmentType: "employee",
            grossAnnualIncome: 18_592.02,
        });
        expect(
            computeSpecialSocialSecurityContribution(p, 18_592.02, table),
        ).toBe(0);
        // Just above → tier 2: 5% × €0.01 ≈ €0.0005.
        expect(
            computeSpecialSocialSecurityContribution(p, 18_592.03, table),
        ).toBeCloseTo(0.0005, 4);
    });
});

describe('CSSS joint table — used when filingStatus === "married_joint"', () => {
    const table = getTaxTable(2025);

    test("joint table matches single below the divergence at €37,344", () => {
        const incomeBelowSplit = 30_000;
        const single = profile({ employmentType: "employee" });
        const joint = profile({
            employmentType: "employee",
            filingStatus: "married_joint",
        });
        expect(
            computeSpecialSocialSecurityContribution(
                single,
                incomeBelowSplit,
                table,
            ),
        ).toBeCloseTo(
            computeSpecialSocialSecurityContribution(
                joint,
                incomeBelowSplit,
                table,
            ),
            2,
        );
    });

    test("joint pays less than single at €50,000 — single on the 1.2996% ramp, joint on the 1.3% ramp", () => {
        const single = profile({ employmentType: "employee" });
        const joint = profile({
            employmentType: "employee",
            filingStatus: "married_joint",
        });
        const singleAmt = computeSpecialSocialSecurityContribution(
            single,
            50_000,
            table,
        );
        const jointAmt = computeSpecialSocialSecurityContribution(
            joint,
            50_000,
            table,
        );
        // Single: €481.96 + 1.2996% × (50,000 − 40,997.26) = €598.96
        expect(singleAmt).toBeCloseTo(598.96, 1);
        // Joint: €123.95 + 1.3% × (50,000 − 21,070.96) = €123.95 + €376.08 = €500.03
        expect(jointAmt).toBeCloseTo(500.03, 1);
        expect(jointAmt).toBeLessThan(singleAmt);
    });

    test("joint flat €632.39 across €60,182–€74,688 band", () => {
        const joint = profile({
            employmentType: "employee",
            filingStatus: "married_joint",
        });
        expect(
            computeSpecialSocialSecurityContribution(joint, 65_000, table),
        ).toBeCloseTo(632.39, 2);
        expect(
            computeSpecialSocialSecurityContribution(joint, 74_000, table),
        ).toBeCloseTo(632.39, 2);
    });

    test("joint caps at €731.28 at very high incomes", () => {
        const joint = profile({
            employmentType: "employee",
            filingStatus: "married_joint",
        });
        expect(
            computeSpecialSocialSecurityContribution(joint, 200_000, table),
        ).toBeCloseTo(731.28, 2);
    });
});

describe("computePropertyTaxEstimate", () => {
    const table = getTaxTable(2025);

    test("cadastral indexation coefficient follows the FPS notices — IY 2024 = 2.1763, IY 2025 = 2.2446, IY 2026 = 2.3000", () => {
        // Art. 518 WIB 92; notices AY 2025 (point H), AY 2026 (point H), AY 2027 (point J).
        expect(getTaxTable(2024).cadastralIndexationCoefficient).toBe(2.1763);
        expect(getTaxTable(2025).cadastralIndexationCoefficient).toBe(2.2446);
        expect(getTaxTable(2026).cadastralIndexationCoefficient).toBe(2.3);
    });

    test("Flanders precompte = indexed CI × 3.97% × (1 + opcentiemen/100) — IY 2025", () => {
        // CI 1_000 → indexed 2_244.60 → regional 89.110 → × (1 + 11.0) = 1_069.32
        // Default centimes lowered to 1_100 (Belgium-wide median) so the estimate sits
        // inside PwC's typical "20–50% of indexed CI" range for most communes.
        const p = profile({ cadastralIncome: 1_000, region: "flanders" });
        expect(computePropertyTaxEstimate(p, table)).toBeCloseTo(1_069.32, 1);
    });

    test("returns 0 when no cadastral income", () => {
        const p = profile({ cadastralIncome: 0 });
        expect(computePropertyTaxEstimate(p, table)).toBe(0);
    });

    test("Wallonia lower than Flanders for the same cadastral income (regional base rate)", () => {
        const flanders = profile({
            cadastralIncome: 1_500,
            region: "flanders",
        });
        const wallonia = profile({
            cadastralIncome: 1_500,
            region: "wallonia",
        });
        // Flanders 3.97% vs Wallonia 1.25% on indexed CI; wallonia centimes higher but base lower → still lower total.
        expect(computePropertyTaxEstimate(flanders, table)).toBeGreaterThan(
            computePropertyTaxEstimate(wallonia, table),
        );
    });

    test("aggregates additional residences", () => {
        const single = profile({ cadastralIncome: 1_500, region: "flanders" });
        const multi = profile({
            cadastralIncome: 1_500,
            region: "flanders",
            additionalResidences: [
                { cadastralIncome: 500, region: "flanders" },
            ],
        });
        expect(computePropertyTaxEstimate(multi, table)).toBeGreaterThan(
            computePropertyTaxEstimate(single, table),
        );
    });
});

describe("TOB caps — statutory per-rate maxima (ADR-057)", () => {
    // Statutory caps are per-rate, not per-instrument:
    //   0.12% → €1,300; 0.35% → €1,600; 1.32% → €4,000.
    // Confirmed against Curvo, tob.tax, PwC Belgium TOB update note.
    test("0.35% shares rate caps at €1,600 per transaction", () => {
        for (const year of [2024, 2025, 2026]) {
            const table = getTaxTable(year);
            expect(table.tob.sharesAndOther.rate).toBe(0.0035);
            expect(table.tob.sharesAndOther.cap).toBe(1_600);
        }
    });

    test("0.12% bonds / distributing funds cap at €1,300", () => {
        for (const year of [2024, 2025, 2026]) {
            const table = getTaxTable(year);
            expect(table.tob.bonds.rate).toBe(0.0012);
            expect(table.tob.bonds.cap).toBe(1_300);
            expect(table.tob.distributingFunds.rate).toBe(0.0012);
            expect(table.tob.distributingFunds.cap).toBe(1_300);
        }
    });

    test("1.32% accumulating funds cap stays at €4,000", () => {
        for (const year of [2024, 2025, 2026]) {
            const table = getTaxTable(year);
            expect(table.tob.accumulatingFunds.rate).toBe(0.0132);
            expect(table.tob.accumulatingFunds.cap).toBe(4_000);
        }
    });

    test("a €1m share buy at 0.35% caps at €1,600 (not at the previous €4,000 mistake)", () => {
        const table = getTaxTable(2025);
        const { rate, cap } = table.tob.sharesAndOther;
        const transactionAmount = 1_000_000;
        const tobOnTrade = Math.min(transactionAmount * rate, cap);
        // 1_000_000 × 0.0035 = 3_500 → capped at 1_600.
        expect(tobOnTrade).toBe(1_600);
    });
});

describe("property tax centimes override (ADR-057)", () => {
    const table = getTaxTable(2025);

    test("main residence override replaces the regional median", () => {
        const baseline = computePropertyTaxEstimate(
            profile({ cadastralIncome: 1_500, region: "flanders" }),
            table,
        );
        const override = computePropertyTaxEstimate(
            profile({
                cadastralIncome: 1_500,
                region: "flanders",
                cadastralCentimesOverride: 600,
            }),
            table,
        );
        // Default Flanders centimes 1100; halving to 600 should produce a markedly lower tax.
        expect(override).toBeLessThan(baseline);
        expect(override).toBeGreaterThan(0);
    });

    test("additional residence override applies per-residence", () => {
        const base = computePropertyTaxEstimate(
            profile({
                cadastralIncome: 1_000,
                region: "flanders",
                additionalResidences: [
                    { cadastralIncome: 1_000, region: "flanders" },
                ],
            }),
            table,
        );
        const withOverride = computePropertyTaxEstimate(
            profile({
                cadastralIncome: 1_000,
                region: "flanders",
                additionalResidences: [
                    {
                        cadastralIncome: 1_000,
                        region: "flanders",
                        centimesOverride: 2200,
                    },
                ],
            }),
            table,
        );
        // Doubling centimes (1100 → 2200) on the additional residence raises the total.
        expect(withOverride).toBeGreaterThan(base);
    });

    test("invalid override (negative) falls back to regional median", () => {
        const baseline = computePropertyTaxEstimate(
            profile({ cadastralIncome: 1_500, region: "flanders" }),
            table,
        );
        const invalid = computePropertyTaxEstimate(
            profile({
                cadastralIncome: 1_500,
                region: "flanders",
                cadastralCentimesOverride: -50,
            }),
            table,
        );
        expect(invalid).toBeCloseTo(baseline, 6);
    });
});

describe("CGT effective date documentation (ADR-057)", () => {
    test("IY 2025 has no CGT (pre-effective)", () => {
        const table = getTaxTable(2025);
        expect(table.capitalGainsTaxRate).toBe(0);
    });

    test("IY 2026 activates 10% CGT with €10k single / €20k married exemptions", () => {
        const table = getTaxTable(2026);
        expect(table.capitalGainsTaxRate).toBe(0.1);
        expect(table.capitalGainsTaxExemptionSingle).toBe(10_000);
        expect(table.capitalGainsTaxExemptionMarried).toBe(20_000);
    });
});

describe("getTaxTable — nearest-year fallback (F2)", () => {
    test("exact match returns the requested year", () => {
        expect(getTaxTable(2025).year).toBe(2025);
        expect(getTaxTable(2024).year).toBe(2024);
        expect(isApproximatedTaxYear(2024)).toBe(false);
        expect(isApproximatedTaxYear(2025)).toBe(false);
    });

    test("year before earliest falls back to earliest, flagged as approximated", () => {
        expect(getTaxTable(2016).year).toBe(2024);
        expect(isApproximatedTaxYear(2016)).toBe(true);
    });

    test("year after latest falls back to latest, flagged as approximated", () => {
        expect(getTaxTable(2030).year).toBe(2026);
        expect(isApproximatedTaxYear(2030)).toBe(true);
    });
});

describe("union dues / medical expenses — base-deduction fix (R7-10)", () => {
    test("medical expenses never reduce taxable income", () => {
        const without = computeWithParity({ ...baseProfile });
        const withMedical = computeWithParity({
            ...baseProfile,
            medicalExpenses: 2000,
        });
        expect(withMedical.taxableIncome).toBe(without.taxableIncome);
        expect(withMedical.totalPIT).toBe(without.totalPIT);
        expect(withMedical.deductions.medicalExpenses).toBe(0);
    });

    test("union dues do NOT deduct under the lump-sum forfait", () => {
        const without = computeWithParity({
            ...baseProfile,
            professionalExpenseMethod: "lump_sum",
        });
        const withDues = computeWithParity({
            ...baseProfile,
            professionalExpenseMethod: "lump_sum",
            unionDues: 300,
        });
        expect(withDues.taxableIncome).toBe(without.taxableIncome);
        expect(withDues.deductions.unionDues).toBe(0);
    });

    test("union dues deduct as actual professional expenses under the actual method", () => {
        const without = computeWithParity({
            ...baseProfile,
            professionalExpenseMethod: "actual",
            actualProfessionalExpenses: 1000,
        });
        const withDues = computeWithParity({
            ...baseProfile,
            professionalExpenseMethod: "actual",
            actualProfessionalExpenses: 1000,
            unionDues: 300,
        });
        expect(withDues.professionalExpenses).toBe(
            without.professionalExpenses + 300,
        );
        expect(withDues.taxableIncome).toBe(without.taxableIncome - 300);
        expect(withDues.deductions.unionDues).toBe(300);
    });
});

describe("breakdown reconciliation — property tax row (R7-12)", () => {
    test("property tax appears as a breakdown row when estimated", () => {
        const result = computeWithParity({
            ...baseProfile,
            cadastralIncome: 1200,
        });
        if (result.propertyTaxEstimate > 0) {
            const row = result.breakdown.find(
                (r) => r.label === "Property Tax (estimate)",
            );
            expect(row).toBeDefined();
            expect(row?.amount).toBeCloseTo(-result.propertyTaxEstimate, 2);
        }
    });

    test('gross PIT position row is labeled "before exemption", not "before credits"', () => {
        const result = computeWithParity({ ...baseProfile });
        expect(
            result.breakdown.some(
                (r) => r.label === "Federal PIT (before exemption)",
            ),
        ).toBe(true);
        expect(
            result.breakdown.some(
                (r) => r.label === "Federal PIT (before credits)",
            ),
        ).toBe(false);
    });
});
