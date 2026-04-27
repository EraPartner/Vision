/**
 * Belgian tax — shared types.
 *
 * Source of truth: PwC Worldwide Tax Summaries (Belgium — Individual)
 * cross-checked with FOD Financiën / SPF Finances published indexed amounts.
 *
 * Income year = the year the income was earned. Assessment year = filing year (income year + 1).
 * All `taxYear` fields in this module refer to the **income year**.
 */

export type EmploymentType =
    | 'employee'
    | 'self_employed'
    | 'director'
    | 'civil_servant'
    | 'retired'
    | 'other';

export type BelgianRegion = 'flanders' | 'wallonia' | 'brussels';
export type ProfessionalExpenseMethod = 'lump_sum' | 'actual';
export type PensionScheme = '1050' | '1350';

export interface BelgianTaxProfile {
    profileConfigured: boolean;
    employmentType: EmploymentType;
    grossAnnualIncome: number;
    professionalExpenseMethod: ProfessionalExpenseMethod;
    actualProfessionalExpenses: number;
    communalSurchargePercent: number;
    region: BelgianRegion;
    dependentChildren: number;
    /** Number of dependent children under 3 (extra exemption increase) */
    dependentChildrenUnder3?: number;
    dependentOtherPersons: number;
    isDisabled: boolean;
    isSpouseDisabled: boolean;
    /** Single-parent flag — triggers the "isolated parent with dependents" supplement */
    isIsolatedParent?: boolean;
    cadastralIncome: number;
    additionalResidences?: { label?: string; cadastralIncome: number; region?: BelgianRegion; isOwnHome?: boolean }[];
    otherTaxableIncome: number;
    alimonyPaid: number;
    personalPensionContributions: number;
    pensionScheme?: PensionScheme;
    pensionEligible?: boolean;
    lifeInsurancePremiums: number;
    lifeInsuranceEligible?: boolean;
    mortgageInterestPaid: number;
    charitableDonations: number;
    charitableDonationsEligible?: boolean;
    childcareCosts: number;
    childcareEligibleDays?: number;
    childcareEligible?: boolean;
    employeeGroupInsuranceContributions?: number;
    employeeGroupInsuranceEligible?: boolean;
    unionDues: number;
    medicalExpenses: number;
    domesticHelpCosts?: number;
    domesticHelpEligible?: boolean;
    /** Total dividend income tracked for the year (used to model dividend WHT reclaim) */
    annualDividendIncome?: number;
    /** Savings deposit interest tracked (livret/spaarboekje) for the year */
    annualSavingsInterest?: number;
    taxYear: number;
}

export interface BracketTax {
    b1: number;
    b2: number;
    b3: number;
    b4: number;
    total: number;
}

export interface BelgianTaxCalculation {
    grossIncome: number;
    employeeSocialSecurity: number;
    specialSocialSecurityContribution: number;
    personalExemptionAmount: number;
    netIncomeAfterSS: number;
    professionalExpenses: number;
    otherDeductionsTotal: number;
    deductions: Record<string, number>;
    taxableIncome: number;
    federalPITBracket1: number;
    federalPITBracket2: number;
    federalPITBracket3: number;
    federalPITBracket4: number;
    federalPITTotal: number;
    personalExemptionBenefit: number;
    federalTaxCredits: number;
    taxReductions: number;
    federalPITAfterReductions: number;
    communalSurcharge: number;
    /** Federal PIT after reductions + communal surcharge (income tax only). */
    totalPIT: number;
    /** Income tax + social security + special SS contribution + property tax estimate. */
    totalTaxBurden: number;
    effectiveRate: number;
    marginalRate: number;
    netTakeHome: number;
    monthlyTaxReserve: number;
    propertyTaxEstimate: number;
    /** Estimated dividend WHT reclaimable through the tax return (first €X of dividends). */
    dividendWhtReclaim: number;
    /** Estimated savings deposit interest non-recoverable tax (15% above exemption). */
    savingsInterestTax: number;
    breakdown: {
        label: string;
        amount: number;
        rate?: number;
        bracket?: string;
    }[];
}
