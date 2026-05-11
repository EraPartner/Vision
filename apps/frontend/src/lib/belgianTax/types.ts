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

/**
 * Filing status for income-splitting purposes.
 *  - `single`: single, divorced, widowed without surviving-spouse joint return, or legal cohabitant
 *    (cohabitants are taxed as singles by default unless they opt in).
 *  - `married_joint`: married or legal cohabitants opting for joint return. Triggers marital
 *    quotient modeling when one spouse has materially lower professional income than the other.
 */
export type FilingStatus = 'single' | 'married_joint';

/**
 * Regional own-home credit regime. Determined by the mortgage's region and origination year.
 *  - `flemish_woonbonus`: Flemish "geïntegreerde woonbonus", available for primary-residence
 *    mortgages signed before 2020-01-01 in the Flemish Region.
 *  - `walloon_cheque_habitat`: Walloon "chèque habitat", available for primary-residence
 *    mortgages signed on/after 2016-01-01 in the Walloon Region. Simplified flat estimate.
 *  - `none`: No annual credit modeled (Brussels post-2017 has only one-time stamp-duty rebate;
 *    pre-existing Brussels and post-2020 Flemish regimes are not modeled).
 */
export type MortgageCreditRegime =
    | 'flemish_woonbonus'
    | 'walloon_cheque_habitat'
    | 'none';

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
    /**
     * Number of dependent children with a recognised disability (CIR-92 art. 132 4°).
     * Per PwC: each handicapped child counts as TWO children on the dependent-children
     * scale. This count is the *subset* of `dependentChildren` who are disabled — it
     * adjusts the effective count used for the supplement lookup, not the head count.
     */
    dependentChildrenDisabled?: number;
    dependentOtherPersons: number;
    /**
     * Number of OTHER dependents (parents, grandparents, etc.) with a recognised
     * disability. Same "counts as two" rule applies (CIR-92 art. 136).
     */
    dependentOtherPersonsDisabled?: number;
    isDisabled: boolean;
    isSpouseDisabled: boolean;
    /** Single-parent flag — triggers the "isolated parent with dependents" supplement */
    isIsolatedParent?: boolean;
    cadastralIncome: number;
    /**
     * Optional override for the communal + provincial centimes additionnels applied to the
     * main residence. When omitted, the regional median from the year table is used.
     * Example: 1400 → +1400% centimes on top of the regional base rate.
     */
    cadastralCentimesOverride?: number;
    additionalResidences?: {
        label?: string;
        cadastralIncome: number;
        region?: BelgianRegion;
        isOwnHome?: boolean;
        /** Per-residence centimes override; same semantics as `cadastralCentimesOverride`. */
        centimesOverride?: number;
    }[];
    otherTaxableIncome: number;
    alimonyPaid: number;
    personalPensionContributions: number;
    pensionScheme?: PensionScheme;
    pensionEligible?: boolean;
    lifeInsurancePremiums: number;
    lifeInsuranceEligible?: boolean;
    /** Annual mortgage interest paid for primary residence (EUR). */
    mortgageInterestPaid: number;
    /** Annual capital repayment on the same mortgage (EUR). Used by Flemish woonbonus alongside interest. */
    mortgageCapitalRepaid?: number;
    /** Year the mortgage contract was signed. Determines applicable regime. */
    mortgageStartYear?: number;
    /** Region where the mortgage was signed. Defaults to profile region when not set. */
    mortgageRegion?: BelgianRegion;
    /** True if the financed property is the taxpayer's primary residence. */
    mortgageIsPrimaryResidence?: boolean;
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
    /**
     * Service vouchers (dienstencheques / titres-services) purchased in the year. Regional schemes:
     *  - Flanders: tax reduction abolished from 1 Jan 2025 (rate = 0).
     *  - Wallonia: fixed €0.90 per voucher on the first 150 vouchers.
     *  - Brussels: 15% reduction per voucher on the first 172 vouchers — still in force.
     */
    serviceVoucherCount?: number;
    serviceVoucherEligible?: boolean;
    /** Filing status — determines whether marital quotient modeling activates. */
    filingStatus?: FilingStatus;
    /**
     * Spouse's professional income (EUR). Only used when `filingStatus === 'married_joint'`.
     * Marital quotient transfers 30% of the higher-earner's professional income to the spouse
     * (capped per `maritalQuotientCap`) when the spouse's own professional income is below the cap.
     */
    spouseProfessionalIncome?: number;
    /** Total dividend income tracked for the year (used to model dividend WHT reclaim) */
    annualDividendIncome?: number;
    /** Savings deposit interest tracked (livret/spaarboekje) for the year */
    annualSavingsInterest?: number;
    /**
     * Category IDs the user has flagged as "salary-like" taxable income. Used by the
     * Tax Overview graphs to filter `monthlyData.income` (which is otherwise just every
     * positive-amount transaction) down to genuinely taxable inflows.
     */
    taxIncomeCategoryIds?: number[];
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
    /** Federal PIT before any reduction (exemption, credits). Was `federalPITTotal` pre-IY2026 fix. */
    federalPITBeforeExemption: number;
    /**
     * @deprecated Old field name kept for back-compat with persisted views and tests.
     * Equals `federalPITBeforeExemption`. New code should use `federalPITBeforeExemption`.
     */
    federalPITTotal: number;
    personalExemptionBenefit: number;
    federalTaxCredits: number;
    /** Regime applied for own-home credit, if any. */
    ownHomeCreditRegime: MortgageCreditRegime;
    /** Estimated regional own-home tax credit (Flemish woonbonus / Walloon chèque habitat). */
    ownHomeCredit: number;
    /** Sum of reductions actually applied to PIT (clamped — never exceeds gross PIT). */
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
    /**
     * Income transferred to the non-earning / lower-earning spouse under the marital quotient.
     * 0 when filing status is single or when both spouses earn comparably.
     */
    maritalQuotientTransfer: number;
    /** Estimated tax reduction attributable to the marital quotient (informational). */
    maritalQuotientBenefit: number;
    /** Estimated service-voucher regional credit (after marital quotient). */
    serviceVoucherCredit: number;
    breakdown: {
        label: string;
        amount: number;
        rate?: number;
        bracket?: string;
    }[];
}
