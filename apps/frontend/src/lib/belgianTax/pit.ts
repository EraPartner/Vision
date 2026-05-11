/**
 * Belgian Personal Income Tax (PIT) calculator.
 *
 * Implements:
 *  - Federal progressive brackets (year-aware)
 *  - Personal exemption ("quotité du revenu exempté") applied at the lowest brackets first
 *    via a dedicated exemption-bracket table (CIR-92 art. 134 §3).
 *  - Professional expense deduction (lump-sum or actual)
 *  - Deductions: alimony (80%), union dues, medical
 *  - Tax credits ("réductions d'impôt"): pension savings, life insurance, group insurance,
 *    charitable donations, childcare, domestic personnel, all with statutory caps
 *  - Regional own-home credit (Flemish woonbonus pre-2020 / Walloon chèque habitat post-2016).
 *    Brussels and post-2020 Flemish regimes are not modeled.
 *  - Communal surcharge applied to federal PIT after credits
 *  - Employee social security + special social security contribution
 *  - Property tax estimate (separate, informational)
 *  - Investment income side calc: dividend WHT reclaim + savings interest tax
 *
 * Limitations / not modeled:
 *  - Marital quotient / married joint filing income split
 *  - Brussels post-2017 stamp-duty rebate (one-time, not annual)
 *  - Flemish post-2020 mortgages (no successor regime — capital owners only)
 *  - Securities account tax (TACR) — values exposed via constants for UI use
 *  - Reynders tax on accumulating bond fund redemptions
 *  - Foreign tax credit (DBI-RDT) on foreign dividends
 *  - Speculative capital gains regime
 */

import type {
    BelgianTaxProfile,
    BelgianTaxCalculation,
    BracketTax,
    MortgageCreditRegime,
} from './types';
import { getTaxTable, type BelgianTaxYearTable, type ExemptionBracket } from './constants';
import { computeEmployeeSocialSecurity, computeSpecialSocialSecurityContribution } from './socialSecurity';
import { computePropertyTaxEstimate } from './propertyTax';

function computeProgressiveTax(value: number, brackets: BelgianTaxYearTable['brackets']): BracketTax {
    const result: BracketTax = { b1: 0, b2: 0, b3: 0, b4: 0, total: 0 };
    if (value <= 0) return result;

    if (value > brackets[0].from) {
        result.b1 = (Math.min(value, brackets[0].to) - brackets[0].from) * brackets[0].rate;
    }
    if (value > brackets[1].from) {
        result.b2 = (Math.min(value, brackets[1].to) - brackets[1].from) * brackets[1].rate;
    }
    if (value > brackets[2].from) {
        result.b3 = (Math.min(value, brackets[2].to) - brackets[2].from) * brackets[2].rate;
    }
    if (value > brackets[3].from) {
        result.b4 = (value - brackets[3].from) * brackets[3].rate;
    }
    result.total = result.b1 + result.b2 + result.b3 + result.b4;
    return result;
}

/**
 * Tax on the personal exemption itself, computed from the lowest bracket upward
 * using the exemption-bracket rate table. This figure is subtracted from gross PIT.
 *
 * Per PwC's IY2025 sample calculation: 25% on the bracket-1 portion, 30% on the
 * bracket-2 overflow, then main rates above. See CIR-92 art. 134 §3.
 */
function computeExemptionBenefit(exemptionAmount: number, brackets: ReadonlyArray<ExemptionBracket>): number {
    if (exemptionAmount <= 0) return 0;
    let total = 0;
    for (const b of brackets) {
        if (exemptionAmount <= b.from) break;
        const upper = Math.min(exemptionAmount, b.to);
        total += (upper - b.from) * b.rate;
    }
    return total;
}

function computeProfessionalExpenses(profile: BelgianTaxProfile, table: BelgianTaxYearTable): number {
    if (profile.professionalExpenseMethod === 'actual') {
        return Math.max(profile.actualProfessionalExpenses || 0, 0);
    }
    // PwC: only employees and civil servants get the 30% / EUR-cap forfait.
    // Directors get 3% / lower cap. Self-employed (zelfstandigen / indépendants) only deduct
    // actual professional expenses — no statutory forfait.
    if (profile.employmentType === 'director') {
        return Math.min(
            profile.grossAnnualIncome * table.directorProfessionalExpenseRate,
            table.directorProfessionalExpenseCap,
        );
    }
    if (profile.employmentType === 'employee' || profile.employmentType === 'civil_servant') {
        return Math.min(
            profile.grossAnnualIncome * table.employeeProfessionalExpenseRate,
            table.employeeProfessionalExpenseCap,
        );
    }
    return 0;
}

function computePersonalExemption(profile: BelgianTaxProfile, table: BelgianTaxYearTable): number {
    const childCount = Math.max(profile.dependentChildren || 0, 0);
    const baseChild =
        childCount <= 4
            ? table.dependentChildExemptionIncreases[childCount] ?? 0
            : (table.dependentChildExemptionIncreases[4] ?? 0)
                + (childCount - 4) * table.extraChildExemptionFromFifth;

    const childUnder3 = Math.max(profile.dependentChildrenUnder3 || 0, 0) * table.childUnder3Supplement;
    const otherDep = Math.max(profile.dependentOtherPersons || 0, 0) * table.otherDependentExemption;

    const disabilitySupplement =
        (profile.isDisabled ? table.disabledSupplement : 0)
        + (profile.isSpouseDisabled ? table.disabledSupplement : 0);

    const isolatedParentSupplement =
        profile.isIsolatedParent && childCount > 0 ? table.isolatedParentSupplement : 0;

    return (
        table.basicPersonalExemption
        + baseChild
        + childUnder3
        + otherDep
        + disabilitySupplement
        + isolatedParentSupplement
    );
}

/**
 * Resolve the regional own-home credit regime applicable to the user's mortgage.
 * Returns 'none' when the mortgage doesn't fit a modeled regime.
 */
function resolveMortgageRegime(profile: BelgianTaxProfile): MortgageCreditRegime {
    if (!profile.mortgageIsPrimaryResidence) return 'none';
    if (!profile.mortgageInterestPaid && !profile.mortgageCapitalRepaid) return 'none';
    const region = profile.mortgageRegion ?? profile.region;
    const startYear = profile.mortgageStartYear ?? 0;
    if (region === 'flanders' && startYear > 0 && startYear < 2020) return 'flemish_woonbonus';
    if (region === 'wallonia' && startYear >= 2016) return 'walloon_cheque_habitat';
    return 'none';
}

/**
 * Compute the regional own-home tax credit.
 *
 * Flemish woonbonus (pre-2020, primary residence):
 *   credit = min(interest + capital, base_cap [+ first-10y supplement] [+ 3+ children supplement]) × 40%
 *
 * Walloon chèque habitat (post-2016, primary residence, first 10 loan years):
 *   credit = base [+ €125 × dependent children]
 *   (Simplified — actual scheme has income-based phaseout and decreasing tail in years 11–20.)
 *
 * All other cases (Brussels, post-2020 Flemish, secondary residences): 0.
 */
function computeOwnHomeCredit(
    profile: BelgianTaxProfile,
    table: BelgianTaxYearTable,
    regime: MortgageCreditRegime,
): number {
    if (regime === 'none') return 0;
    const interest = Math.max(profile.mortgageInterestPaid || 0, 0);
    const capital = Math.max(profile.mortgageCapitalRepaid || 0, 0);

    if (regime === 'flemish_woonbonus') {
        const startYear = profile.mortgageStartYear ?? 0;
        const loanAge = Math.max(0, table.year - startYear);
        let cap = table.flemishWoonbonusBaseCap;
        if (loanAge < 10) cap += table.flemishWoonbonusExtraFirst10y;
        if ((profile.dependentChildren || 0) >= 3) cap += table.flemishWoonbonusExtraChildren;
        const eligibleExpenses = Math.min(interest + capital, cap);
        return eligibleExpenses * table.flemishWoonbonusRate;
    }

    if (regime === 'walloon_cheque_habitat') {
        const startYear = profile.mortgageStartYear ?? 0;
        const loanAge = Math.max(0, table.year - startYear);
        // First 10 years only in our simplified model.
        if (loanAge >= 10) return 0;
        const childSupplement =
            Math.max(profile.dependentChildren || 0, 0) * table.walloonChequeHabitatChildSupplement;
        return table.walloonChequeHabitatBase + childSupplement;
    }

    return 0;
}

function clampAtZero(n: number): number {
    return n > 0 ? n : 0;
}

export function computeBelgianPIT(profile: BelgianTaxProfile): BelgianTaxCalculation {
    const table = getTaxTable(profile.taxYear);

    // 1. Gross income (salary + other taxable income)
    const grossSalary = Math.max(profile.grossAnnualIncome || 0, 0);
    const otherIncome = Math.max(profile.otherTaxableIncome || 0, 0);
    const gross = grossSalary + otherIncome;

    // 2. Employee social security
    const employeeSS = computeEmployeeSocialSecurity(profile, table);
    const netAfterSS = gross - employeeSS;

    // 3. Professional expense deduction
    const profExpenses = computeProfessionalExpenses(profile, table);

    // 4. True deductions from taxable basis (alimony 80%, union dues, medical).
    //    Pension, life insurance, donations, childcare, domestic help, group insurance =
    //    tax credits, applied below — NOT subtracted from taxable basis.
    const cappedAlimony = Math.max(profile.alimonyPaid || 0, 0) * table.alimonyDeductibleFraction;
    const cappedUnion = Math.max(profile.unionDues || 0, 0);
    const cappedMedical = Math.max(profile.medicalExpenses || 0, 0);

    const otherDeductions = cappedAlimony + cappedUnion + cappedMedical;

    const taxableIncome = clampAtZero(netAfterSS - profExpenses - otherDeductions);

    // 5. Federal PIT on full taxable income (progressive brackets).
    const pitBeforeExemption = computeProgressiveTax(taxableIncome, table.brackets);

    // 6. Personal exemption (quotité du revenu exempté) applied at the LOWEST brackets first
    //    via the dedicated exemption-bracket table (CIR-92 art. 134 §3).
    const personalExemptionTotal = computePersonalExemption(profile, table);
    const exemptionAmount = Math.min(personalExemptionTotal, taxableIncome);
    const personalExemptionBenefit = computeExemptionBenefit(exemptionAmount, table.exemptionBrackets);

    const pitAfterExemption = clampAtZero(pitBeforeExemption.total - personalExemptionBenefit);

    // 7. Federal tax credits (réductions d'impôt). PwC rates and caps.
    const pensionCap =
        profile.pensionScheme === '1350' ? table.pensionSavingsCapAlternative : table.pensionSavingsCapStandard;
    const pensionRate =
        profile.pensionScheme === '1350' ? table.pensionSavingsRateAlternative : table.pensionSavingsRateStandard;
    const pensionCredit = profile.pensionEligible
        ? Math.min(profile.personalPensionContributions || 0, pensionCap) * pensionRate
        : 0;

    const lifeInsuranceCredit = profile.lifeInsuranceEligible
        ? Math.min(profile.lifeInsurancePremiums || 0, table.lifeInsuranceCap) * table.lifeInsuranceRate
        : 0;

    const groupInsuranceCredit = profile.employeeGroupInsuranceEligible
        ? Math.max(profile.employeeGroupInsuranceContributions || 0, 0) * table.groupInsuranceRate
        : 0;

    const donationAmount = Math.max(profile.charitableDonations || 0, 0);
    const donationCredit =
        profile.charitableDonationsEligible && donationAmount >= table.charitableDonationMin
            ? Math.min(donationAmount, table.charitableDonationAbsoluteCap) * table.charitableDonationRate
            : 0;

    const childcareDayCap = Math.max(profile.childcareEligibleDays || 0, 0) * table.childcareDailyCap;
    const childcareCredit = profile.childcareEligible
        ? Math.min(profile.childcareCosts || 0, childcareDayCap) * table.childcareRate
        : 0;

    const domesticHelpCredit = profile.domesticHelpEligible
        ? Math.min(profile.domesticHelpCosts || 0, table.domesticHelpCap) * table.domesticHelpRate
        : 0;

    // Regional own-home credit (Flemish woonbonus / Walloon chèque habitat).
    const ownHomeCreditRegime = resolveMortgageRegime(profile);
    const ownHomeCredit = computeOwnHomeCredit(profile, table, ownHomeCreditRegime);

    const totalTaxCredits =
        pensionCredit +
        lifeInsuranceCredit +
        groupInsuranceCredit +
        donationCredit +
        childcareCredit +
        domesticHelpCredit +
        ownHomeCredit;

    // 8. Federal PIT after credits (cannot go below zero).
    const appliedTaxCredits = Math.min(totalTaxCredits, pitAfterExemption);
    const federalPITAfterReductions = pitAfterExemption - appliedTaxCredits;

    // 9. Communal surcharge applied to federal PIT after reductions.
    const communalSurcharge = federalPITAfterReductions * (profile.communalSurchargePercent / 100);

    // 10. Special social security contribution (function of net taxable income).
    const specialSS = computeSpecialSocialSecurityContribution(profile, taxableIncome, table);

    // 11. Property tax (informational, not part of PIT).
    const propertyTaxEstimate = computePropertyTaxEstimate(profile, table);

    // 12. Investment income side calc.
    const dividendIncome = Math.max(profile.annualDividendIncome || 0, 0);
    const dividendWhtReclaim =
        Math.min(dividendIncome, table.dividendExemption) * table.dividendWHTRate;

    const savingsInterest = Math.max(profile.annualSavingsInterest || 0, 0);
    const savingsInterestTax =
        Math.max(savingsInterest - table.savingsInterestExemption, 0) * table.savingsInterestExcessRate;

    // 13. Aggregate totals — distinct meanings, no double-counting.
    const totalPIT = federalPITAfterReductions + communalSurcharge;
    const totalTaxBurden = totalPIT + employeeSS + specialSS + propertyTaxEstimate;
    const effectiveRate = gross > 0 ? (totalTaxBurden / gross) * 100 : 0;

    let marginalRate = table.brackets[0].rate * 100;
    for (const b of table.brackets) {
        if (taxableIncome > b.from) marginalRate = b.rate * 100;
    }

    const netTakeHome = gross - totalTaxBurden;
    const monthlyTaxReserve = totalPIT / 12;

    const federalPITBeforeExemption = pitBeforeExemption.total;

    const breakdown = [
        { label: 'Gross Income', amount: gross },
        { label: 'Employee Social Security', amount: -employeeSS, rate: table.employeeSSRate * 100 },
        { label: 'Net after Social Security', amount: netAfterSS },
        { label: 'Professional Expenses Deduction', amount: -profExpenses },
        ...(profile.alimonyPaid ? [{ label: 'Alimony paid (80% deductible)', amount: -cappedAlimony }] : []),
        ...(profile.unionDues ? [{ label: 'Union / professional dues', amount: -cappedUnion }] : []),
        ...(profile.medicalExpenses ? [{ label: 'Medical expenses', amount: -cappedMedical }] : []),
        { label: 'Taxable Income', amount: taxableIncome },
        ...(pitBeforeExemption.b1 > 0
            ? [{ label: `Bracket 1 (${table.brackets[0].rate * 100}%)`, amount: -pitBeforeExemption.b1, rate: table.brackets[0].rate * 100, bracket: `€${table.brackets[0].from} – €${table.brackets[0].to}` }]
            : []),
        ...(pitBeforeExemption.b2 > 0
            ? [{ label: `Bracket 2 (${table.brackets[1].rate * 100}%)`, amount: -pitBeforeExemption.b2, rate: table.brackets[1].rate * 100, bracket: `€${table.brackets[1].from} – €${table.brackets[1].to}` }]
            : []),
        ...(pitBeforeExemption.b3 > 0
            ? [{ label: `Bracket 3 (${table.brackets[2].rate * 100}%)`, amount: -pitBeforeExemption.b3, rate: table.brackets[2].rate * 100, bracket: `€${table.brackets[2].from} – €${table.brackets[2].to}` }]
            : []),
        ...(pitBeforeExemption.b4 > 0
            ? [{ label: `Bracket 4 (${table.brackets[3].rate * 100}%)`, amount: -pitBeforeExemption.b4, rate: table.brackets[3].rate * 100, bracket: `€${table.brackets[3].from}+` }]
            : []),
        ...(personalExemptionBenefit > 0
            ? [{ label: 'Personal exemption benefit', amount: -personalExemptionBenefit }]
            : []),
        ...(ownHomeCredit > 0
            ? [{ label: 'Own-home credit', amount: -ownHomeCredit }]
            : []),
        ...(appliedTaxCredits > 0 ? [{ label: 'Tax Credits (reductions)', amount: -appliedTaxCredits }] : []),
        { label: 'Federal PIT (before credits)', amount: -federalPITBeforeExemption },
        { label: 'Federal PIT (after credits)', amount: -federalPITAfterReductions },
        { label: `Communal Surcharge (${profile.communalSurchargePercent}%)`, amount: -communalSurcharge, rate: profile.communalSurchargePercent },
        ...(specialSS > 0 ? [{ label: 'Special Social Security Contribution', amount: -specialSS }] : []),
        { label: 'Net Take-Home', amount: netTakeHome },
    ];

    return {
        grossIncome: gross,
        employeeSocialSecurity: employeeSS,
        specialSocialSecurityContribution: specialSS,
        personalExemptionAmount: personalExemptionTotal,
        netIncomeAfterSS: netAfterSS,
        professionalExpenses: profExpenses,
        otherDeductionsTotal: otherDeductions,
        deductions: {
            alimonyPaid: cappedAlimony,
            personalPensionContributions: 0,
            lifeInsurancePremiums: 0,
            mortgageInterestPaid: Math.max(profile.mortgageInterestPaid || 0, 0),
            charitableDonations: 0,
            childcareCosts: 0,
            unionDues: cappedUnion,
            medicalExpenses: cappedMedical,
        },
        taxableIncome,
        federalPITBracket1: pitBeforeExemption.b1,
        federalPITBracket2: pitBeforeExemption.b2,
        federalPITBracket3: pitBeforeExemption.b3,
        federalPITBracket4: pitBeforeExemption.b4,
        federalPITBeforeExemption,
        federalPITTotal: federalPITBeforeExemption,
        personalExemptionBenefit,
        federalTaxCredits: appliedTaxCredits,
        ownHomeCreditRegime,
        ownHomeCredit,
        taxReductions: personalExemptionBenefit + appliedTaxCredits,
        federalPITAfterReductions,
        communalSurcharge,
        totalPIT,
        totalTaxBurden,
        effectiveRate,
        marginalRate,
        netTakeHome,
        monthlyTaxReserve,
        propertyTaxEstimate,
        dividendWhtReclaim,
        savingsInterestTax,
        breakdown,
    };
}
