import type { BelgianTaxCalculation } from "./types";

/**
 * All-zero PIT figures, shown only until the server's first figures for a household arrive
 * (the household was not hydrated with figures, or no year is loaded yet).
 */
export const EMPTY_BELGIAN_TAX_CALCULATION: BelgianTaxCalculation = Object.freeze({
    grossIncome: 0,
    spouseProfessionalIncome: 0,
    householdGrossIncome: 0,
    employeeSocialSecurity: 0,
    specialSocialSecurityContribution: 0,
    personalExemptionAmount: 0,
    netIncomeAfterSS: 0,
    professionalExpenses: 0,
    otherDeductionsTotal: 0,
    deductions: {},
    taxableIncome: 0,
    federalPITBracket1: 0,
    federalPITBracket2: 0,
    federalPITBracket3: 0,
    federalPITBracket4: 0,
    federalPITBeforeExemption: 0,
    personalExemptionBenefit: 0,
    federalTaxCredits: 0,
    ownHomeCreditRegime: "none",
    ownHomeCredit: 0,
    taxReductions: 0,
    federalPITAfterReductions: 0,
    communalSurcharge: 0,
    totalPIT: 0,
    totalTaxBurden: 0,
    effectiveRate: 0,
    marginalRate: 0,
    netTakeHome: 0,
    monthlyTaxReserve: 0,
    propertyTaxEstimate: 0,
    dividendWhtReclaim: 0,
    savingsInterestTax: 0,
    maritalQuotientTransfer: 0,
    maritalQuotientBenefit: 0,
    serviceVoucherCredit: 0,
    breakdown: [],
}) as BelgianTaxCalculation;
