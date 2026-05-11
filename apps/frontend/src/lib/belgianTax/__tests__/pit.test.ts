import { describe, expect, test } from 'vitest';
import { computeBelgianPIT, getTaxTable, isApproximatedTaxYear } from '..';
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

    test('personal exemption applied at lowest brackets first (PwC method)', () => {
        // CIR-92 art. 134 §3 + PwC sample: the exemption is taxed from bracket 1 up.
        // Basic IY2025 exemption €10,910 < first-bracket ceiling €16,320, so it all sits
        // in bracket 1: benefit = 10_910 × 0.25 = 2_727.50.
        const result = computeBelgianPIT(profile({ grossAnnualIncome: 40_000 }));
        expect(result.personalExemptionBenefit).toBeCloseTo(2_727.5, 1);
    });

    test('PwC screenshot case: taxable €19,105.84 → exemption benefit €2,727.50', () => {
        // Real-world reproduction of the user's PIT breakdown screenshot. Before the F1 fix
        // the value was €3,145.38 (exemption applied at the top). PwC-correct value is €2,727.50.
        // Use self_employed so all of the gross flows straight to taxable income (no SS, no forfait).
        const result = computeBelgianPIT(
            profile({
                employmentType: 'self_employed',
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

    test('exemption straddling two brackets uses 25% then 30% overflow', () => {
        // Two children at IY2025 → exemption = 10_910 + 5_110 = 16_020. Sits entirely in
        // bracket 1 (ceiling 16_320), so benefit = 16_020 × 0.25 = 4_005.
        const result = computeBelgianPIT(
            profile({ grossAnnualIncome: 80_000, dependentChildren: 2 }),
        );
        expect(result.personalExemptionAmount).toBe(16_020);
        expect(result.personalExemptionBenefit).toBeCloseTo(4_005, 1);
    });

    test('exemption above first-bracket ceiling uses 30% on the overflow', () => {
        // Three children + isolated parent push exemption above €16,320.
        // exemption = 10_910 + 11_440 + 1_980 = 24_330
        // bracket 1 fills: 16_320 × 0.25 = 4_080
        // overflow into bracket 2: (24_330 - 16_320) × 0.30 = 2_403
        // total benefit = 6_483
        const result = computeBelgianPIT(
            profile({
                grossAnnualIncome: 80_000,
                dependentChildren: 3,
                isIsolatedParent: true,
            }),
        );
        expect(result.personalExemptionAmount).toBe(24_330);
        expect(result.personalExemptionBenefit).toBeCloseTo(6_483, 1);
    });

    test('federalPITTotal back-compat alias equals federalPITBeforeExemption', () => {
        const r = computeBelgianPIT(profile({ grossAnnualIncome: 50_000 }));
        expect(r.federalPITTotal).toBe(r.federalPITBeforeExemption);
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

    test('tax credits cannot make PIT go negative; appliedTaxCredits clamps to PIT', () => {
        // Massive donation that vastly exceeds gross PIT. The clamp should match PIT after
        // exemption (i.e. donate enough → owe zero PIT, but not a negative refund).
        const result = computeBelgianPIT(
            profile({
                grossAnnualIncome: 22_000, // small income → small PIT
                charitableDonations: 100_000,
                charitableDonationsEligible: true,
            }),
        );
        expect(result.federalPITAfterReductions).toBe(0);
        // Displayed federalTaxCredits is clamped — not the raw 100_000 × 0.45.
        expect(result.federalTaxCredits).toBeLessThanOrEqual(result.federalPITBeforeExemption);
    });

    test('Flemish woonbonus credit applied for pre-2020 primary-residence mortgage', () => {
        const result = computeBelgianPIT(
            profile({
                grossAnnualIncome: 50_000,
                region: 'flanders',
                mortgageIsPrimaryResidence: true,
                mortgageStartYear: 2015,
                mortgageRegion: 'flanders',
                mortgageInterestPaid: 2_000,
                mortgageCapitalRepaid: 3_000,
            }),
        );
        expect(result.ownHomeCreditRegime).toBe('flemish_woonbonus');
        // 2015 mortgage → loanAge 10 in IY 2025 → no first-10y supplement.
        // cap = 2_280 (base only). credit = 2_280 × 0.40 = 912.
        expect(result.ownHomeCredit).toBeCloseTo(912, 1);
    });

    test('Flemish woonbonus: first-10y supplement when loan age < 10', () => {
        const result = computeBelgianPIT(
            profile({
                grossAnnualIncome: 50_000,
                region: 'flanders',
                mortgageIsPrimaryResidence: true,
                mortgageStartYear: 2019,
                mortgageRegion: 'flanders',
                mortgageInterestPaid: 5_000,
                mortgageCapitalRepaid: 3_000,
            }),
        );
        // cap = 2_280 + 760 = 3_040. credit = 3_040 × 0.40 = 1_216.
        expect(result.ownHomeCredit).toBeCloseTo(1_216, 1);
    });

    test('Walloon chèque habitat applied for post-2016 primary residence in Wallonia', () => {
        const result = computeBelgianPIT(
            profile({
                grossAnnualIncome: 50_000,
                region: 'wallonia',
                mortgageIsPrimaryResidence: true,
                mortgageStartYear: 2018,
                mortgageRegion: 'wallonia',
                mortgageInterestPaid: 4_000,
                dependentChildren: 2,
            }),
        );
        expect(result.ownHomeCreditRegime).toBe('walloon_cheque_habitat');
        // 1_520 + 2 × 125 = 1_770.
        expect(result.ownHomeCredit).toBeCloseTo(1_770, 1);
    });

    test('Brussels primary residence: no own-home credit modeled', () => {
        const result = computeBelgianPIT(
            profile({
                grossAnnualIncome: 50_000,
                region: 'brussels',
                mortgageIsPrimaryResidence: true,
                mortgageStartYear: 2019,
                mortgageRegion: 'brussels',
                mortgageInterestPaid: 5_000,
            }),
        );
        expect(result.ownHomeCreditRegime).toBe('none');
        expect(result.ownHomeCredit).toBe(0);
    });

    test('Post-2020 Flemish mortgage: no woonbonus successor modeled', () => {
        const result = computeBelgianPIT(
            profile({
                grossAnnualIncome: 50_000,
                region: 'flanders',
                mortgageIsPrimaryResidence: true,
                mortgageStartYear: 2021,
                mortgageRegion: 'flanders',
                mortgageInterestPaid: 5_000,
            }),
        );
        expect(result.ownHomeCreditRegime).toBe('none');
        expect(result.ownHomeCredit).toBe(0);
    });

    test('Mortgage not flagged as primary residence → no credit', () => {
        const result = computeBelgianPIT(
            profile({
                grossAnnualIncome: 50_000,
                region: 'flanders',
                mortgageIsPrimaryResidence: false,
                mortgageStartYear: 2018,
                mortgageInterestPaid: 5_000,
            }),
        );
        expect(result.ownHomeCredit).toBe(0);
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

    test('boundary income lands in the lower (closing) tier', () => {
        // The CSSS table's tier `to` values are inclusive. An income exactly on the boundary
        // belongs to the closing tier, not the opening one. Income at 18_592.02 (tier-1 top
        // bound) lands in tier 1 → flat 0. The F4 fix made this explicit in the loop
        // condition; behavior unchanged on continuous-bound tables but defensive against
        // future tables with gaps.
        const p = profile({ employmentType: 'employee', grossAnnualIncome: 18_592.02 });
        expect(computeSpecialSocialSecurityContribution(p, 18_592.02, table)).toBe(0);
        // Just above the boundary → tier 2 flat €111.55.
        expect(computeSpecialSocialSecurityContribution(p, 18_592.03, table)).toBeCloseTo(111.55, 2);
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

describe('getTaxTable — nearest-year fallback (F2)', () => {
    test('exact match returns the requested year', () => {
        expect(getTaxTable(2025).year).toBe(2025);
        expect(getTaxTable(2024).year).toBe(2024);
        expect(isApproximatedTaxYear(2024)).toBe(false);
        expect(isApproximatedTaxYear(2025)).toBe(false);
    });

    test('year before earliest falls back to earliest, flagged as approximated', () => {
        expect(getTaxTable(2016).year).toBe(2024);
        expect(isApproximatedTaxYear(2016)).toBe(true);
    });

    test('year after latest falls back to latest, flagged as approximated', () => {
        expect(getTaxTable(2030).year).toBe(2025);
        expect(isApproximatedTaxYear(2030)).toBe(true);
    });
});
