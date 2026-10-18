import { describe, expect, test } from "vitest";
import { householdIncomeStepSchema } from "../taxProfileSchema";

type Activity = Record<string, unknown>;

function household(
  activitiesA: Activity[],
  expensesA: Record<string, unknown> = {},
  partnerB?: { activities: Activity[]; professionalExpenses?: Record<string, unknown> },
) {
  return {
    partners: [
      { id: "A", activities: activitiesA, professionalExpenses: expensesA },
      ...(partnerB
        ? [{ id: "B", activities: partnerB.activities, professionalExpenses: partnerB.professionalExpenses ?? {} }]
        : []),
    ],
  };
}

function firstIssue(value: unknown): string | undefined {
  const result = householdIncomeStepSchema.safeParse(value);
  return result.success ? undefined : result.error.issues[0]?.message;
}

const employee = (grossIncome: unknown): Activity => ({ id: "act_A_1", kind: "employee", grossIncome });

describe("householdIncomeStepSchema", () => {
  test("passes with a positive gross income on the lump-sum method", () => {
    expect(
      householdIncomeStepSchema.safeParse(household([employee(50000)], { remuneration: { method: "lump_sum", actualAmount: 0 } }))
        .success,
    ).toBe(true);
  });

  test("missing, zero, or malformed income of partner A reports the gross-income key", () => {
    expect(firstIssue({})).toBe("tax.profile.validation.grossIncomeRequired");
    expect(firstIssue(household([]))).toBe("tax.profile.validation.grossIncomeRequired");
    expect(firstIssue(household([employee(0)]))).toBe("tax.profile.validation.grossIncomeRequired");
    expect(firstIssue(household([employee(NaN)]))).toBe("tax.profile.validation.grossIncomeRequired");
    expect(firstIssue(household([employee("50000")]))).toBe("tax.profile.validation.grossIncomeRequired");
    // Partner B's income does not satisfy partner A's requirement.
    expect(firstIssue(household([employee(0)], {}, { activities: [employee(30000)] }))).toBe(
      "tax.profile.validation.grossIncomeRequired",
    );
  });

  test("an already-net amount counts as income", () => {
    expect(
      firstIssue(household([{ id: "act_A_1", kind: "net_professional_amount", grossIncome: 0, netProfessionalIncome: 12000 }])),
    ).toBeUndefined();
  });

  test("the actual-expenses method requires a positive amount per used category, for either partner", () => {
    const actual = { remuneration: { method: "actual", actualAmount: 0 } };
    expect(firstIssue(household([employee(50000)], actual))).toBe("tax.profile.validation.actualExpensesRequired");
    expect(
      firstIssue(household([employee(50000)], { remuneration: { method: "actual", actualAmount: 1200 } })),
    ).toBeUndefined();
    expect(
      firstIssue(household([employee(50000)], {}, { activities: [{ id: "act_B_1", kind: "employee", grossIncome: 1 }], professionalExpenses: actual })),
    ).toBe("tax.profile.validation.actualExpensesRequired");
    // A stale choice for a category no activity uses is ignored.
    expect(firstIssue(household([employee(50000)], { profits: { method: "actual", actualAmount: 0 } }))).toBeUndefined();
  });

  test("an activity may not end before it starts", () => {
    expect(
      firstIssue(household([{ ...employee(50000), startDate: "2025-06-01", endDate: "2025-01-31" }])),
    ).toBe("tax.profile.validation.activityDatesOrder");
    expect(
      firstIssue(household([{ ...employee(50000), startDate: "2025-01-01", endDate: "2025-01-31" }])),
    ).toBeUndefined();
  });

  test("gross income is reported first when several rules fail (one toast per attempt)", () => {
    const result = householdIncomeStepSchema.safeParse(
      household([employee(0)], { remuneration: { method: "actual", actualAmount: 0 } }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0]?.message).toBe("tax.profile.validation.grossIncomeRequired");
    }
  });
});
