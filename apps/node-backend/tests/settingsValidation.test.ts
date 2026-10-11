import { describe, expect, it } from "vitest";
import { __validateSettingValue } from "../src/routes/settings.ts";

describe("Belgian tax frozen-calculation settings validation", () => {
  it("accepts the canonical field and preserves unrelated metadata", () => {
    const value = {
      2025: {
        status: "frozen",
        frozenCalculation: {
          federalPITBeforeExemption: 12345,
          totalPIT: 9876,
        },
      },
    };

    expect(
      __validateSettingValue("belgian_tax_profile_snapshot_meta_v1", value),
    ).toEqual(value);
  });

  it("rejects the retired federalPITTotal alias", () => {
    expect(() =>
      __validateSettingValue("belgian_tax_profile_snapshot_meta_v1", {
        2025: {
          frozenCalculation: {
            federalPITBeforeExemption: 12345,
            federalPITTotal: 12345,
          },
        },
      }),
    ).toThrow(/federalPITTotal.*no longer accepted/);
  });
});

describe("Belgian tax profile settings validation", () => {
  it("accepts a nullish serviceVoucherSpend and rejects a negative one", () => {
    for (const spend of [1_200, 0, null, undefined]) {
      const value = { taxYear: 2025, serviceVoucherSpend: spend };
      expect(__validateSettingValue("belgian_tax_profile", value)).toEqual(value);
    }
    expect(() =>
      __validateSettingValue("belgian_tax_profile", { serviceVoucherSpend: -1 }),
    ).toThrow();
  });
});

const validHousehold = () => ({
  version: 2,
  taxYear: 2025,
  profileConfigured: true,
  region: "flanders",
  communalSurchargePercent: 7,
  partners: [
    {
      id: "A",
      isDisabled: false,
      activities: [{ id: "act_A_1", kind: "employee", grossIncome: 50000 }],
      professionalExpenses: {
        remuneration: { method: "lump_sum", actualAmount: 0 },
      },
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
    {
      id: "B",
      isDisabled: false,
      activities: [
        {
          id: "act_B_1",
          kind: "net_professional_amount",
          grossIncome: 0,
          netProfessionalIncome: 12000,
        },
      ],
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
  relationship: {
    events: [{ id: "evt_1", kind: "marriage", date: "2015-05-02" }],
  },
  dependents: { children: 2, otherPersons: 0, claimantPartnerId: "A" },
  home: { cadastralIncome: 1200, mortgageInterestPaid: 0 },
  futureField: { kept: true },
});

type Household = ReturnType<typeof validHousehold>;

describe("Belgian tax household v2 settings validation", () => {
  const validate = (value: unknown) =>
    __validateSettingValue("belgian_tax_household_v2", value);

  it("accepts a valid household and keeps unknown keys", () => {
    const value = validHousehold();
    expect(validate(value)).toEqual(value);
  });

  it("accepts a chèque habitat first qualifying year", () => {
    const value = { ...validHousehold(), home: { cadastralIncome: 0, mortgageInterestPaid: 0, firstQualifyingYear: 2019 } };
    expect(validate(value)).toEqual(value);
  });

  it("accepts the woonbonus children at the loan start", () => {
    const value = {
      ...validHousehold(),
      home: { cadastralIncome: 0, mortgageInterestPaid: 0, woonbonusChildrenAtLoanStart: 3 },
    };
    expect(validate(value)).toEqual(value);
  });

  it("accepts partner B's share of the own-home payments", () => {
    const value = {
      ...validHousehold(),
      home: { cadastralIncome: 0, mortgageInterestPaid: 0, mortgageSharePartnerB: 40 },
    };
    expect(validate(value)).toEqual(value);
  });

  it.each<[string, (h: Household) => unknown]>([
    ["version 1", (h) => ({ ...h, version: 1 })],
    ["a missing taxYear", ({ taxYear: _taxYear, ...rest }) => rest],
    [
      "three partners",
      (h) => ({ ...h, partners: [...h.partners, { ...h.partners[1], id: "B" }] }),
    ],
    [
      "duplicate partner ids",
      (h) => ({ ...h, partners: [h.partners[0], { ...h.partners[1], id: "A" }] }),
    ],
    [
      "no partner A",
      (h) => ({ ...h, partners: [{ ...h.partners[1] }] }),
    ],
    [
      "duplicate activity ids",
      (h) => ({
        ...h,
        partners: [
          h.partners[0],
          {
            ...h.partners[1],
            activities: [{ id: "act_A_1", kind: "pension", grossIncome: 1 }],
          },
        ],
      }),
    ],
    [
      "a malformed activity id",
      (h) => ({
        ...h,
        partners: [
          {
            ...h.partners[0],
            activities: [{ id: "job-1", kind: "employee", grossIncome: 1 }],
          },
          h.partners[1],
        ],
      }),
    ],
    [
      "netProfessionalIncome on an employee activity",
      (h) => ({
        ...h,
        partners: [
          {
            ...h.partners[0],
            activities: [
              {
                id: "act_A_1",
                kind: "employee",
                grossIncome: 1,
                netProfessionalIncome: 1,
              },
            ],
          },
          h.partners[1],
        ],
      }),
    ],
    [
      "a dangling event partner",
      (h) => ({
        ...h,
        partners: [h.partners[0]],
        relationship: {
          events: [
            { id: "evt_1", kind: "death", date: "2025-01-01", partnerId: "B" },
          ],
        },
      }),
    ],
    [
      "a death without the deceased partner",
      (h) => ({
        ...h,
        relationship: {
          events: [{ id: "evt_1", kind: "death", date: "2025-01-01" }],
        },
      }),
    ],
    [
      "a dangling claimant",
      (h) => ({
        ...h,
        partners: [h.partners[0]],
        dependents: { children: 0, otherPersons: 0, claimantPartnerId: "B" },
      }),
    ],
    [
      "a dangling mortgage partner",
      (h) => ({
        ...h,
        partners: [h.partners[0]],
        home: { ...h.home, mortgageCreditPartnerId: "B" },
      }),
    ],
    [
      "a fractional first qualifying year",
      (h) => ({ ...h, home: { ...h.home, firstQualifyingYear: 2019.5 } }),
    ],
    [
      "fractional woonbonus children at the loan start",
      (h) => ({ ...h, home: { ...h.home, woonbonusChildrenAtLoanStart: 2.5 } }),
    ],
    [
      "an own-home share above 100%",
      (h) => ({ ...h, home: { ...h.home, mortgageSharePartnerB: 120 } }),
    ],
    [
      "negative woonbonus children at the loan start",
      (h) => ({ ...h, home: { ...h.home, woonbonusChildrenAtLoanStart: -1 } }),
    ],
    [
      "a bad event date",
      (h) => ({
        ...h,
        relationship: {
          events: [{ id: "evt_1", kind: "marriage", date: "2015-13-40" }],
        },
      }),
    ],
    [
      "an unknown event kind",
      (h) => ({
        ...h,
        relationship: {
          events: [{ id: "evt_1", kind: "engagement", date: "2015-01-01" }],
        },
      }),
    ],
    [
      "negative money",
      (h) => ({ ...h, partners: [{ ...h.partners[0], alimonyPaid: -1 }, h.partners[1]] }),
    ],
    [
      "more than 20 activities",
      (h) => ({
        ...h,
        partners: [
          {
            ...h.partners[0],
            activities: Array.from({ length: 21 }, (_, i) => ({
              id: `act_A_${i}`,
              kind: "employee",
              grossIncome: 1,
            })),
          },
          h.partners[1],
        ],
      }),
    ],
    ["a surcharge above 9%", (h) => ({ ...h, communalSurchargePercent: 70 })],
  ])("rejects %s", (_label, mutate) => {
    expect(() => validate(mutate(validHousehold()))).toThrow(
      /Invalid belgian_tax_household_v2/,
    );
  });

  it("validates year-keyed household snapshots", () => {
    const snapshots = { 2025: validHousehold() };
    expect(
      __validateSettingValue("belgian_tax_household_snapshots_v2", snapshots),
    ).toEqual(snapshots);
    expect(() =>
      __validateSettingValue("belgian_tax_household_snapshots_v2", {
        latest: validHousehold(),
      }),
    ).toThrow(/Invalid belgian_tax_household_snapshots_v2/);
    expect(() =>
      __validateSettingValue("belgian_tax_household_snapshots_v2", {
        2025: { ...validHousehold(), version: 1 },
      }),
    ).toThrow(/Invalid belgian_tax_household_snapshots_v2/);
    expect(() =>
      __validateSettingValue("belgian_tax_household_snapshots_v2", {
        2025: { ...validHousehold(), taxYear: 2026 },
      }),
    ).toThrow(/Invalid belgian_tax_household_snapshots_v2/);
  });

  it("accepts a frozen household result in the snapshot meta and still refuses federalPITTotal", () => {
    const meta = {
      2025: {
        frozenCalculation: { federalPITBeforeExemption: 1 },
        frozenHouseholdResult: { engineVersion: 2, incomeYear: 2025 },
      },
    };
    expect(
      __validateSettingValue("belgian_tax_profile_snapshot_meta_v1", meta),
    ).toEqual(meta);
    expect(() =>
      __validateSettingValue("belgian_tax_profile_snapshot_meta_v1", {
        2025: {
          frozenCalculation: { federalPITTotal: 1 },
          frozenHouseholdResult: { engineVersion: 2 },
        },
      }),
    ).toThrow(/federalPITTotal.*no longer accepted/);
    expect(() =>
      __validateSettingValue("belgian_tax_profile_snapshot_meta_v1", {
        2025: { frozenHouseholdResult: "nope" },
      }),
    ).toThrow();
  });
});
