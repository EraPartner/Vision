import { describe, expect, test } from 'vitest';
import { computeBelgianPIT, getTaxTable } from '..';
import { computeSpecialSocialSecurityContribution } from '../socialSecurity';
import { computePropertyTaxEstimate } from '../propertyTax';
import type { BelgianTaxProfile } from '../types';

const baseProfile: BelgianTaxProfile = {
    profileConfigured: true,
    employmentType: 'employee',
    grossAnnualIncome: 50_000,
    professionalExpenseMethod: 'lump_sum',
    actualProfessionalExpenses: 0,
    communalSurchargePercent: 7,
    region: 'flanders',
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
    pensionScheme: '1050',
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

describe('computeBelgianPIT — IY 2025 brackets', () => {
    test('returns zero tax for zero income', () => {
        const result = computeBelgianPIT(profile({ grossAnnualIncome: 0 }));
        expect(result.totalPIT).toBe(0);
        expect(result.totalTaxBurden).toBe(0);
    });

    test('employee SS = 13.07% of gross salary', () => {
        const result = computeBelgianPIT(profile({ grossAnnualIncome: 40_000 }));
        expect(result.employeeSocialSecurity).toBeCloseTo(40_000 * 0.1307, 2);
    });

    test('totalTaxBurden does NOT double-count communal surcharge', () => {
        // Regression test for the IY-2025 bug where surcharge was added once inside totalPIT
        // and again in totalTaxBurden.
        const result = computeBelgianPIT(profile({ grossAnnualIncome: 50_000 }));
        const expected =
            result.totalPIT +
            result.employeeSocialSecurity +
            result.specialSocialSecurityContribution +
            result.propertyTaxEstimate;
        expect(result.totalTaxBurden).toBeCloseTo(expected, 5);
    });

    test('professional expense forfait caps at €5,930 for employees IY 2025', () => {
        const result = computeBelgianPIT(profile({ grossAnnualIncome: 100_000 }));
        // 30% of 100k = 30k > cap, so capped at 5_930
        expect(result.professionalExpenses).toBe(5_930);
    });

    test('director gets 3% / €3,130 cap forfait', () => {
        const result = computeBelgianPIT(
            profile({ employmentType: 'director', grossAnnualIncome: 200_000 }),
        );
        expect(result.professionalExpenses).toBe(3_130);
    });

    test('self-employed gets NO forfait when method = lump_sum', () => {
        const result = computeBelgianPIT(
            profile({ employmentType: 'self_employed', grossAnnualIncome: 80_000 }),
        );
        expect(result.professionalExpenses).toBe(0);
    });

    test('self-employed actual expenses are deductible', () => {
        const result = computeBelgianPIT(
            profile({
                employmentType: 'self_employed',
                grossAnnualIncome: 80_000,
                professionalExpenseMethod: 'actual',
                actualProfessionalExpenses: 12_000,
            }),
        );
        expect(result.professionalExpenses).toBe(12_000);
    });

    test('progressive brackets accumulate at the right thresholds (€60k gross IY 2025)', () => {
        // Single, no dependents, employee, lump-sum forfait, 7% surcharge.
        // Gross 60_000 → SS 60_000×0.1307 = 7_842 → net 52_158
        // forfait min(60_000×0.30, 5_930) = 5_930 → taxable 46_228
        const result = computeBelgianPIT(profile({ grossAnnualIncome: 60_000 }));
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

    test('personal exemption applied at lowest brackets first', () => {
        // Gross 40k → SS 5_228 → net 34_772 → forfait 5_930 → taxable 28_842.
        // Without exemption: 16_320×0.25 + 12_480×0.40 + 42×0.45 = 9_090.9
        // With €10_910 exemption: taxable 17_932 → 16_320×0.25 + 1_612×0.40 = 4_724.8
        // Benefit = 9_090.9 − 4_724.8 = 4_366.1 (the exemption shifts income from 40% to 25%).
        const result = computeBelgianPIT(profile({ grossAnnualIncome: 40_000 }));
        expect(result.personalExemptionBenefit).toBeCloseTo(4_366.1, 1);
    });

    test('dependent children increase the personal exemption', () => {
        const noKids = computeBelgianPIT(profile({ grossAnnualIncome: 60_000 }));
        const twoKids = computeBelgianPIT(profile({ grossAnnualIncome: 60_000, dependentChildren: 2 }));
        expect(twoKids.personalExemptionAmount).toBe(noKids.personalExemptionAmount + 5_110);
        expect(twoKids.totalPIT).toBeLessThan(noKids.totalPIT);
    });

    test('isolated parent adds the single-parent supplement when at least one child', () => {
        const single = computeBelgianPIT(
            profile({ grossAnnualIncome: 60_000, dependentChildren: 1, isIsolatedParent: true }),
        );
        const couple = computeBelgianPIT(profile({ grossAnnualIncome: 60_000, dependentChildren: 1 }));
        expect(single.personalExemptionAmount).toBe(couple.personalExemptionAmount + 1_980);
    });

    test('disability supplement adds €1,980 for self', () => {
        const disabled = computeBelgianPIT(profile({ grossAnnualIncome: 60_000, isDisabled: true }));
        const normal = computeBelgianPIT(profile({ grossAnnualIncome: 60_000 }));
        expect(disabled.personalExemptionAmount).toBe(normal.personalExemptionAmount + 1_980);
    });

    test('pension savings credit only applies when eligible flag set', () => {
        const noFlag = computeBelgianPIT(
            profile({ grossAnnualIncome: 60_000, personalPensionContributions: 1_050 }),
        );
        const withFlag = computeBelgianPIT(
            profile({ grossAnnualIncome: 60_000, personalPensionContributions: 1_050, pensionEligible: true }),
        );
        expect(noFlag.federalTaxCredits).toBe(0);
        expect(withFlag.federalTaxCredits).toBeCloseTo(1_050 * 0.30, 2);
    });

    test('alternative pension scheme uses €1,350 cap × 25%', () => {
        const result = computeBelgianPIT(
            profile({
                grossAnnualIncome: 60_000,
                personalPensionContributions: 1_500,
                pensionEligible: true,
                pensionScheme: '1350',
            }),
        );
        expect(result.federalTaxCredits).toBeCloseTo(1_350 * 0.25, 2);
    });

    test('charitable donations require eligibility flag and minimum €40', () => {
        const tiny = computeBelgianPIT(
            profile({ grossAnnualIncome: 60_000, charitableDonations: 30, charitableDonationsEligible: true }),
        );
        const valid = computeBelgianPIT(
            profile({ grossAnnualIncome: 60_000, charitableDonations: 200, charitableDonationsEligible: true }),
        );
        expect(tiny.federalTaxCredits).toBe(0); // below €40 minimum
        expect(valid.federalTaxCredits).toBeCloseTo(200 * 0.45, 2);
    });

    test('domestic help credit caps at €8,290 wages IY 2025', () => {
        const result = computeBelgianPIT(
            profile({ grossAnnualIncome: 100_000, domesticHelpCosts: 50_000, domesticHelpEligible: true }),
        );
        expect(result.federalTaxCredits).toBeCloseTo(8_290 * 0.30, 2);
    });

    test('alimony deductible at 80%', () => {
        const result = computeBelgianPIT(
            profile({ grossAnnualIncome: 60_000, alimonyPaid: 10_000 }),
        );
        const noAlimony = computeBelgianPIT(profile({ grossAnnualIncome: 60_000 }));
        // 80% × 10_000 = 8_000 less taxable income
        expect(noAlimony.taxableIncome - result.taxableIncome).toBe(8_000);
    });

    test('communal surcharge applied to federal PIT after credits', () => {
        const result = computeBelgianPIT(profile({ grossAnnualIncome: 60_000, communalSurchargePercent: 8 }));
        expect(result.communalSurcharge).toBeCloseTo(result.federalPITAfterReductions * 0.08, 2);
    });

    test('dividend WHT reclaim modeled as tax-return credit', () => {
        const result = computeBelgianPIT(profile({ annualDividendIncome: 2_000 }));
        // 859 × 30% = 257.70
        expect(result.dividendWhtReclaim).toBeCloseTo(859 * 0.30, 2);
    });

    test('savings interest tax = 15% above the €1,050 IY 2025 exemption', () => {
        const result = computeBelgianPIT(profile({ annualSavingsInterest: 2_000 }));
        // (2_000 - 1_050) × 0.15 = 142.5
        expect(result.savingsInterestTax).toBeCloseTo(142.5, 2);
    });

    test('IY 2024 tables apply when taxYear = 2024', () => {
        const result = computeBelgianPIT(profile({ taxYear: 2024, grossAnnualIncome: 60_000 }));
        // IY 2024 employee forfait cap = 5_750
        expect(result.professionalExpenses).toBe(5_750);
    });
});

describe('computeSpecialSocialSecurityContribution — IY 2025 step function', () => {
    const table = getTaxTable(2025);

    test('returns 0 below the €18,592 floor', () => {
        const p = profile({ employmentType: 'employee', grossAnnualIncome: 16_000 });
        expect(computeSpecialSocialSecurityContribution(p, 16_000, table)).toBe(0);
    });

    test('flat €111.55 in tier 2', () => {
        const p = profile({ employmentType: 'employee', grossAnnualIncome: 20_000 });
        expect(computeSpecialSocialSecurityContribution(p, 20_000, table)).toBeCloseTo(111.55, 2);
    });

    test('caps at €731.28 for high incomes', () => {
        const p = profile({ employmentType: 'employee', grossAnnualIncome: 100_000 });
        expect(computeSpecialSocialSecurityContribution(p, 100_000, table)).toBeCloseTo(731.28, 2);
    });

    test('returns 0 for self-employed', () => {
        const p = profile({ employmentType: 'self_employed', grossAnnualIncome: 60_000 });
        expect(computeSpecialSocialSecurityContribution(p, 50_000, table)).toBe(0);
    });
});

describe('computePropertyTaxEstimate', () => {
    const table = getTaxTable(2025);

    test('returns 0 when no cadastral income', () => {
        const p = profile({ cadastralIncome: 0 });
        expect(computePropertyTaxEstimate(p, table)).toBe(0);
    });

    test('Wallonia lower than Flanders for the same cadastral income (regional base rate)', () => {
        const flanders = profile({ cadastralIncome: 1_500, region: 'flanders' });
        const wallonia = profile({ cadastralIncome: 1_500, region: 'wallonia' });
        // Flanders 3.97% vs Wallonia 1.25% on indexed CI; wallonia centimes higher but base lower → still lower total.
        expect(computePropertyTaxEstimate(flanders, table)).toBeGreaterThan(
            computePropertyTaxEstimate(wallonia, table),
        );
    });

    test('aggregates additional residences', () => {
        const single = profile({ cadastralIncome: 1_500, region: 'flanders' });
        const multi = profile({
            cadastralIncome: 1_500,
            region: 'flanders',
            additionalResidences: [{ cadastralIncome: 500, region: 'flanders' }],
        });
        expect(computePropertyTaxEstimate(multi, table)).toBeGreaterThan(
            computePropertyTaxEstimate(single, table),
        );
    });
});
