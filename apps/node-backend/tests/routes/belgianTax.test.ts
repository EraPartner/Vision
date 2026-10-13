import { describe, expect, it } from "vitest";
import type { BelgianTaxHouseholdV2 } from "@vision/shared-utils/belgian-tax/householdTypes";
import {
  computeHouseholdTax,
  toBelgianTaxCalculation,
} from "@vision/shared-utils/belgian-tax/household";
import { routeAgent } from "../helpers/routeApp.ts";
import { bodyAt } from "../helpers/responseBody.ts";
import router from "../../src/routes/belgianTax.ts";

const api = routeAgent(router, { mountPath: "/api/belgian-tax" });
const path = "/api/belgian-tax/compute";

function household(): BelgianTaxHouseholdV2 {
  return {
    version: 2,
    taxYear: 2025,
    profileConfigured: true,
    region: "flanders",
    communalSurchargePercent: 7,
    partners: [
      {
        id: "A",
        isDisabled: false,
        activities: [{ id: "act_A_1", kind: "employee", grossIncome: 50_000 }],
        professionalExpenses: {},
        unionDues: 0,
        otherTaxableIncome: 0,
        alimonyPaid: 0,
        reductions: {
          personalPensionContributions: 0,
          lifeInsurancePremiums: 0,
          charitableDonations: 0,
          childcareCosts: 0,
          medicalExpenses: 0,
        },
      },
    ],
    relationship: { events: [] },
    dependents: { children: 0, otherPersons: 0 },
    home: { cadastralIncome: 0, mortgageInterestPaid: 0 },
  };
}

describe("Belgian tax computation API", () => {
  it("returns the hand-verified IY 2025 employee figures (scenario SC-01)", async () => {
    const response = await api
      .post(path)
      .send({ household: household() })
      .expect(200);
    expect(bodyAt(response, "ok")).toBe(true);
    expect(
      bodyAt(
        response,
        "data",
        "result",
        "partners",
        0,
        "employeeSocialSecurity",
      ),
    ).toBeCloseTo(6535, 8);
    expect(
      bodyAt(response, "data", "result", "partners", 0, "professionalExpenses"),
    ).toBeCloseTo(5930, 8);
    expect(
      bodyAt(response, "data", "result", "partners", 0, "taxableIncome"),
    ).toBeCloseTo(37535, 8);
    expect(
      bodyAt(response, "data", "result", "totals", "totalPIT"),
    ).toBeCloseTo(10994.5175, 8);
    expect(bodyAt(response, "data", "result", "csss", "total")).toBeCloseTo(
      343.15719,
      8,
    );
    expect(bodyAt(response, "data", "calculation", "totalPIT")).toBeCloseTo(
      10994.5175,
      8,
    );
  });

  it.each([2024, 2025, 2026, 2030])(
    "preserves all web engine output for IY %i",
    async (year) => {
      const input = household();
      input.taxYear = year;
      input.region = "wallonia";
      const result = computeHouseholdTax(input);
      const calculation = toBelgianTaxCalculation(result, input);
      const response = await api
        .post(path)
        .send({ household: input })
        .expect(200);
      // Compare wire JSON, including optional omitted fields and approximation issues.
      expect(bodyAt(response, "data")).toEqual(
        JSON.parse(JSON.stringify({ result, calculation })),
      );
    },
  );

  it("computes a joint household and quotient with distinct partner output", async () => {
    const input = household();
    const partner = structuredClone(input.partners[0]!);
    partner.id = "B";
    partner.activities = [
      { id: "act_B_1", kind: "employee", grossIncome: 10_000 },
    ];
    input.partners.push(partner);
    input.relationship.events.push({
      id: "marriage",
      kind: "marriage",
      date: "2015-05-02",
    });
    const response = await api
      .post(path)
      .send({ household: input })
      .expect(200);
    expect(bodyAt(response, "data", "result", "assessment", "mode")).toBe(
      "joint",
    );
    expect(bodyAt(response, "data", "result", "partners", 0, "partnerId")).toBe(
      "A",
    );
    expect(bodyAt(response, "data", "result", "partners", 1, "partnerId")).toBe(
      "B",
    );
    expect(bodyAt(response, "data", "result", "quotient")).toEqual(
      JSON.parse(JSON.stringify(computeHouseholdTax(input).quotient)),
    );
  });

  it.each([
    {},
    { household: null },
    { household: { version: 1 } },
    { household: household(), save: true },
    { household: { ...household(), taxYear: "2025" } },
    { household: { ...household(), communalSurchargePercent: 10 } },
    { household: { ...household(), partners: [] } },
    {
      household: {
        ...household(),
        partners: [household().partners[0], household().partners[0]],
      },
    },
    {
      household: {
        ...household(),
        dependents: { children: 0, otherPersons: 0, claimantPartnerId: "B" },
      },
    },
    {
      household: {
        ...household(),
        relationship: {
          events: [{ id: "death", kind: "death", date: "2025-01-01" }],
        },
      },
    },
  ])(
    "rejects invalid or ambiguous input with the standard envelope: %#",
    async (input) => {
      const response = await api.post(path).send(input).expect(400);
      expect(bodyAt(response, "ok")).toBe(false);
      expect(bodyAt(response, "error", "code")).toBe("VALIDATION_ERROR");
      expect(bodyAt(response, "data")).toBeUndefined();
    },
  );

  it("uses the same CSRF guard as the rest of the API", async () => {
    await api
      .post(path)
      .set("Origin", "https://untrusted.example")
      .send({ household: household() })
      .expect(403);
  });
});
