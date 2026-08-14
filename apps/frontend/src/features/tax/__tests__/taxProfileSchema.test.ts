import { describe, expect, test } from "vitest";
import { taxProfileIncomeStepSchema } from "../taxProfileSchema";

function firstIssue(profile: Record<string, unknown>): string | undefined {
  const result = taxProfileIncomeStepSchema.safeParse(profile);
  return result.success ? undefined : result.error.issues[0].message;
}

describe("taxProfileIncomeStepSchema", () => {
  test("passes with a positive gross income on the lump-sum method", () => {
    expect(
      taxProfileIncomeStepSchema.safeParse({
        grossAnnualIncome: 50000,
        professionalExpenseMethod: "lump_sum",
      }).success,
    ).toBe(true);
  });

  test("missing, zero, or malformed gross income reports the gross-income key", () => {
    expect(firstIssue({})).toBe("tax.profile.validation.grossIncomeRequired");
    expect(firstIssue({ grossAnnualIncome: 0 })).toBe("tax.profile.validation.grossIncomeRequired");
    expect(firstIssue({ grossAnnualIncome: NaN })).toBe("tax.profile.validation.grossIncomeRequired");
    expect(firstIssue({ grossAnnualIncome: "50000" })).toBe(
      "tax.profile.validation.grossIncomeRequired",
    );
  });

  test("the actual-expenses method additionally requires a positive expenses amount", () => {
    const base = { grossAnnualIncome: 50000, professionalExpenseMethod: "actual" };
    expect(firstIssue(base)).toBe("tax.profile.validation.actualExpensesRequired");
    expect(firstIssue({ ...base, actualProfessionalExpenses: 0 })).toBe(
      "tax.profile.validation.actualExpensesRequired",
    );
    expect(
      taxProfileIncomeStepSchema.safeParse({ ...base, actualProfessionalExpenses: 1200 }).success,
    ).toBe(true);
  });

  test("gross income is reported first when both rules fail (one toast per attempt)", () => {
    const result = taxProfileIncomeStepSchema.safeParse({
      grossAnnualIncome: 0,
      professionalExpenseMethod: "actual",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0].message).toBe("tax.profile.validation.grossIncomeRequired");
    }
  });
});
