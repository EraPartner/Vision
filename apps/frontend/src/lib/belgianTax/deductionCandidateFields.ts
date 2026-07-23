/**
 * Deduction-type → BelgianTaxProfile field map for the transaction-derived
 * deduction candidates card (tax-critical).
 *
 * Confirming a candidate group SETS the amount field to the group's transaction
 * total (replace, never accumulate) and flips the eligibility flag to true
 * where one exists — without the flag the amount would not enter the PIT
 * calculation. Types with no flag (alimony, union dues, mortgage interest) are
 * picked up by the engine unconditionally.
 */

import type { BelgianTaxProfile } from './types';

/** Profile fields whose value is a number — the only valid Confirm targets. */
type NumericProfileField = {
    [K in keyof BelgianTaxProfile]-?: NonNullable<BelgianTaxProfile[K]> extends number ? K : never;
}[keyof BelgianTaxProfile];

/** Profile fields whose value is a boolean — the only valid eligibility flags. */
type BooleanProfileField = {
    [K in keyof BelgianTaxProfile]-?: NonNullable<BelgianTaxProfile[K]> extends boolean ? K : never;
}[keyof BelgianTaxProfile];

export interface DeductionFieldMapping {
    /** Field Confirm SETS (replaces) to the group's transaction total. */
    amountField: NumericProfileField;
    /** Eligibility flag flipped to true alongside the amount, when one exists. */
    eligibilityField?: BooleanProfileField;
}

/**
 * Keys are the `deductionType` strings emitted by
 * /api/info/deduction-candidates; groups with any other deductionType are not
 * confirmable and are skipped by the card.
 */
export const DEDUCTION_TYPE_PROFILE_FIELDS: Readonly<Record<string, DeductionFieldMapping | undefined>> = {
    pensionSavings: { amountField: 'personalPensionContributions', eligibilityField: 'pensionEligible' },
    lifeInsurance: { amountField: 'lifeInsurancePremiums', eligibilityField: 'lifeInsuranceEligible' },
    groupInsurance: { amountField: 'employeeGroupInsuranceContributions', eligibilityField: 'employeeGroupInsuranceEligible' },
    charitableDonations: { amountField: 'charitableDonations', eligibilityField: 'charitableDonationsEligible' },
    childcare: { amountField: 'childcareCosts', eligibilityField: 'childcareEligible' },
    alimony: { amountField: 'alimonyPaid' },
    unionDues: { amountField: 'unionDues' },
    mortgageInterest: { amountField: 'mortgageInterestPaid' },
};
