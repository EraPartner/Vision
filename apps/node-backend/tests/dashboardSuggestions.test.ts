import { describe, expect, it } from "vitest";
import { DEFAULT_BELGIAN_TAX_PROFILE } from "@vision/shared-utils/belgian-tax/profileDefaults";
import { getTaxTable } from "@vision/shared-utils/belgian-tax/constants";
import { buildDashboardSuggestions } from "../src/services/tax/dashboardSuggestions.ts";

const profile = { ...DEFAULT_BELGIAN_TAX_PROFILE, taxYear: 2025 };
describe("native deduction suggestion amounts remain in the TypeScript engine", () => {
  it("uses the selected year's pension scheme limits", () => {
    const table = getTaxTable(2025);
    const result = buildDashboardSuggestions(
      {
        ...profile,
        pensionEligible: true,
        personalPensionContributions: 0,
        pensionScheme: "1350",
      },
      45,
    );
    expect(result.find((row) => row.id === "pension.no_amount")).toEqual({
      id: "pension.no_amount",
      titleKey: "tax.suggestions.item.pension",
      descriptionKey: "tax.suggestions.pension.noAmount",
      estimate:
        table.pensionSavingsCapAlternative *
        table.pensionSavingsRateAlternative,
    });
  });
  it("preserves capped life insurance and childcare advice including the example days", () => {
    const table = getTaxTable(2025);
    const result = buildDashboardSuggestions(
      {
        ...profile,
        lifeInsuranceEligible: false,
        lifeInsurancePremiums: 100000,
        childcareEligible: false,
        dependentChildren: 1,
        childcareEligibleDays: 0,
        childcareCosts: 0,
      },
      45,
    );
    expect(result.find((row) => row.id === "life.not_marked")?.estimate).toBe(
      table.lifeInsuranceCap * table.lifeInsuranceRate,
    );
    expect(result.find((row) => row.id === "childcare.suggest")).toMatchObject({
      descriptionParams: { days: 120 },
      estimate: table.childcareRate * 120 * table.childcareDailyCap,
    });
  });
  it("uses the table's alimony fraction and clamps the server marginal rate", () => {
    const table = getTaxTable(2025);
    expect(
      buildDashboardSuggestions({ ...profile, alimonyPaid: 1000 }, 200).find(
        (row) => row.id === "alimony.applied",
      )?.estimate,
    ).toBe(table.alimonyDeductibleFraction * 1000);
    expect(
      buildDashboardSuggestions({ ...profile, alimonyPaid: 1000 }, -5).find(
        (row) => row.id === "alimony.applied",
      )?.estimate,
    ).toBe(0);
  });
  it("retains amount-free guidance and note keys without inventing a financial estimate", () => {
    const result = buildDashboardSuggestions(
      { ...profile, charitableDonationsEligible: true, charitableDonations: 0 },
      45,
    );
    expect(result.find((row) => row.id === "donations.no_amount")).toEqual({
      id: "donations.no_amount",
      titleKey: "tax.suggestions.item.donations",
      descriptionKey: "tax.suggestions.donations.noAmount",
      noteKey: "tax.suggestions.donations.note",
    });
  });
});
