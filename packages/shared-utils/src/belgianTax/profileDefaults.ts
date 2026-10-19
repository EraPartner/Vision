import { LATEST_TAX_YEAR } from "./taxYears.ts";
import type { BelgianTaxProfile } from "./types.ts";

export const DEFAULT_BELGIAN_TAX_PROFILE: BelgianTaxProfile = {
  profileConfigured: false,
  employmentType: "employee",
  grossAnnualIncome: 0,
  professionalExpenseMethod: "lump_sum",
  actualProfessionalExpenses: 0,
  communalSurchargePercent: 7,
  region: "flanders",
  dependentChildren: 0,
  dependentChildrenUnder3: 0,
  dependentChildrenDisabled: 0,
  dependentOtherPersons: 0,
  dependentOtherPersonsDisabled: 0,
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
  mortgageCapitalRepaid: 0,
  mortgageStartYear: undefined,
  mortgageRegion: undefined,
  mortgageIsPrimaryResidence: false,
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
  serviceVoucherCount: 0,
  serviceVoucherEligible: false,
  filingStatus: "single",
  spouseProfessionalIncome: 0,
  annualDividendIncome: 0,
  annualSavingsInterest: 0,
  taxIncomeCategoryIds: [],
  taxYear: LATEST_TAX_YEAR,
};

export function hasMeaningfulBelgianTaxData(
  profile: BelgianTaxProfile,
): boolean {
  return (
    profile.profileConfigured === true ||
    (profile.grossAnnualIncome ?? 0) > 0 ||
    (profile.otherTaxableIncome ?? 0) > 0 ||
    (profile.cadastralIncome ?? 0) > 0 ||
    (profile.dependentChildren ?? 0) > 0 ||
    (profile.dependentOtherPersons ?? 0) > 0 ||
    (profile.actualProfessionalExpenses ?? 0) > 0
  );
}
