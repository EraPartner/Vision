import { getTaxTable } from "@vision/shared-utils/belgian-tax/constants";
import type { BelgianTaxProfile } from "@vision/shared-utils/belgian-tax/types";

export interface DashboardDeductionSuggestion {
  id: string;
  titleKey: string;
  descriptionKey: string;
  descriptionParams?: Record<string, number>;
  estimate?: number;
  noteKey?: string;
}

/** Web deduction advice extracted unchanged. */
export function buildDashboardSuggestions(
  profile: BelgianTaxProfile,
  marginalRate: number,
): DashboardDeductionSuggestion[] {
  const items: Array<{
    id: string;
    titleKey: string;
    descriptionKey: string;
    estimate?: number;
    noteKey?: string;
    descriptionParams?: Record<string, number>;
  }> = [];
  // All rates / caps resolved from the year-aware tax table so suggestions stay
  // accurate when historical (or future) tax years are selected.
  const table = getTaxTable(profile.taxYear);
  const donationRate = table.charitableDonationRate;
  const childcareRate = table.childcareRate;
  const childcareDailyCap = table.childcareDailyCap;
  const lifeInsuranceRate = table.lifeInsuranceRate;
  const lifeInsuranceCap = table.lifeInsuranceCap;
  const groupInsuranceRate = table.groupInsuranceRate;
  const domesticHelpRate = table.domesticHelpRate;
  const alimonyFraction = table.alimonyDeductibleFraction;

  // Pension savings
  const pensionCeiling =
    profile.pensionScheme === "1350"
      ? table.pensionSavingsCapAlternative
      : table.pensionSavingsCapStandard;
  const pensionRate =
    profile.pensionScheme === "1350"
      ? table.pensionSavingsRateAlternative
      : table.pensionSavingsRateStandard;
  const pensionMaxCredit = pensionCeiling * pensionRate;
  if (profile.pensionEligible && !(profile.personalPensionContributions > 0)) {
    items.push({
      id: "pension.no_amount",
      titleKey: "tax.suggestions.item.pension",
      descriptionKey: "tax.suggestions.pension.noAmount",
      estimate: pensionMaxCredit,
    });
  } else if (
    !profile.pensionEligible &&
    profile.personalPensionContributions > 0
  ) {
    const est =
      Math.min(profile.personalPensionContributions, pensionCeiling) *
      pensionRate;
    items.push({
      id: "pension.not_marked",
      titleKey: "tax.suggestions.item.pension",
      descriptionKey: "tax.suggestions.pension.notMarked",
      estimate: est,
    });
  } else if (
    !profile.pensionEligible &&
    profile.grossAnnualIncome > 0 &&
    profile.personalPensionContributions === 0
  ) {
    items.push({
      id: "pension.suggest",
      titleKey: "tax.suggestions.item.pension",
      descriptionKey: "tax.suggestions.pension.suggest",
      estimate: pensionMaxCredit,
    });
  }

  // Life insurance
  if (profile.lifeInsuranceEligible && !(profile.lifeInsurancePremiums > 0)) {
    items.push({
      id: "life.no_amount",
      titleKey: "tax.suggestions.item.life",
      descriptionKey: "tax.suggestions.life.noAmount",
      estimate: lifeInsuranceCap * lifeInsuranceRate,
    });
  } else if (
    !profile.lifeInsuranceEligible &&
    profile.lifeInsurancePremiums > 0
  ) {
    const est =
      Math.min(profile.lifeInsurancePremiums, lifeInsuranceCap) *
      lifeInsuranceRate;
    items.push({
      id: "life.not_marked",
      titleKey: "tax.suggestions.item.life",
      descriptionKey: "tax.suggestions.life.notMarked",
      estimate: est,
    });
  }

  // Group insurance
  if (
    profile.employeeGroupInsuranceEligible &&
    !((profile.employeeGroupInsuranceContributions ?? 0) > 0)
  ) {
    items.push({
      id: "group.no_amount",
      titleKey: "tax.suggestions.item.group",
      descriptionKey: "tax.suggestions.group.noAmount",
      estimate: 0,
    });
  } else if (
    !profile.employeeGroupInsuranceEligible &&
    (profile.employeeGroupInsuranceContributions ?? 0) > 0
  ) {
    items.push({
      id: "group.not_marked",
      titleKey: "tax.suggestions.item.group",
      descriptionKey: "tax.suggestions.group.notMarked",
      estimate:
        (profile.employeeGroupInsuranceContributions ?? 0) * groupInsuranceRate,
    });
  } else if (
    !profile.employeeGroupInsuranceEligible &&
    profile.employmentType === "employee" &&
    !((profile.employeeGroupInsuranceContributions ?? 0) > 0)
  ) {
    items.push({
      id: "group.suggest",
      titleKey: "tax.suggestions.item.group",
      descriptionKey: "tax.suggestions.group.suggest",
      estimate: 0,
    });
  }

  // Charitable donations
  if (
    profile.charitableDonationsEligible &&
    !(profile.charitableDonations > 0)
  ) {
    items.push({
      id: "donations.no_amount",
      titleKey: "tax.suggestions.item.donations",
      descriptionKey: "tax.suggestions.donations.noAmount",
      noteKey: "tax.suggestions.donations.note",
    });
  } else if (
    !profile.charitableDonationsEligible &&
    profile.charitableDonations > 0
  ) {
    const est = donationRate * profile.charitableDonations;
    items.push({
      id: "donations.not_marked",
      titleKey: "tax.suggestions.item.donations",
      descriptionKey: "tax.suggestions.donations.notMarked",
      estimate: est,
    });
  }

  // Childcare
  const childcareCap = (profile.childcareEligibleDays ?? 0) * childcareDailyCap;
  if (profile.childcareEligible && !(profile.childcareCosts > 0)) {
    items.push({
      id: "childcare.no_amount",
      titleKey: "tax.suggestions.item.childcare",
      descriptionKey: "tax.suggestions.childcare.noAmount",
      estimate: 0,
    });
  } else if (!profile.childcareEligible && profile.childcareCosts > 0) {
    const est = childcareRate * Math.min(profile.childcareCosts, childcareCap);
    items.push({
      id: "childcare.not_marked",
      titleKey: "tax.suggestions.item.childcare",
      descriptionKey: "tax.suggestions.childcare.notMarked",
      estimate: est,
    });
  } else if (
    !profile.childcareEligible &&
    profile.dependentChildren > 0 &&
    profile.childcareEligibleDays === 0
  ) {
    // soft suggestion — show example using 120 days
    const exampleDays = 120;
    const exampleEst = childcareRate * (exampleDays * childcareDailyCap);
    items.push({
      id: "childcare.suggest",
      titleKey: "tax.suggestions.item.childcare",
      descriptionKey: "tax.suggestions.childcare.suggest",
      descriptionParams: { days: exampleDays },
      estimate: exampleEst,
    });
  }

  // Domestic help
  if (profile.domesticHelpEligible && !((profile.domesticHelpCosts ?? 0) > 0)) {
    items.push({
      id: "domestic.no_amount",
      titleKey: "tax.suggestions.item.domestic",
      descriptionKey: "tax.suggestions.domestic.noAmount",
      estimate: 0,
    });
  } else if (
    !profile.domesticHelpEligible &&
    (profile.domesticHelpCosts ?? 0) > 0
  ) {
    const est = domesticHelpRate * (profile.domesticHelpCosts ?? 0);
    items.push({
      id: "domestic.not_marked",
      titleKey: "tax.suggestions.item.domestic",
      descriptionKey: "tax.suggestions.domestic.notMarked",
      estimate: est,
    });
  }

  // Alimony (deduction) — estimate tax saving using marginal rate
  if (profile.alimonyPaid > 0) {
    const deduction = alimonyFraction * profile.alimonyPaid;
    const marginal = Math.max(0, Math.min(marginalRate, 100)) / 100;
    const estSaving = deduction * marginal;
    items.push({
      id: "alimony.applied",
      titleKey: "tax.suggestions.item.alimony",
      descriptionKey: "tax.suggestions.alimony.applied",
      estimate: estSaving,
    });
  }

  return items;
}
