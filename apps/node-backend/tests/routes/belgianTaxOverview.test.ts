import { beforeEach, describe, expect, it, vi } from "vitest";
import { routeAgent } from "../helpers/routeApp.ts";
import { bodyAt } from "../helpers/responseBody.ts";
import type { BelgianTaxHouseholdV2 } from "@vision/shared-utils/belgian-tax/householdTypes";

vi.mock("../../src/services/settingsService.ts", () => ({
  default: {
    getAllWithBaselines: vi.fn(),
    replace: vi.fn(),
    replaceMany: vi.fn(),
  },
}));
vi.mock(
  "@vision/shared-utils/belgian-tax/household",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@vision/shared-utils/belgian-tax/household")
      >();
    return {
      ...actual,
      computeHouseholdTax: vi.fn(actual.computeHouseholdTax),
    };
  },
);
import settingsService from "../../src/services/settingsService.ts";
import * as engine from "@vision/shared-utils/belgian-tax/household";
import { DEFAULT_BELGIAN_TAX_PROFILE } from "@vision/shared-utils/belgian-tax/profileDefaults";
import { defaultHousehold } from "@vision/shared-utils/belgian-tax/settings";
import router from "../../src/routes/belgianTax.ts";

const api = routeAgent(router, { mountPath: "/api/belgian-tax" });
const path = "/api/belgian-tax/overview";
const settings = vi.mocked(settingsService);

function household(year: number, grossIncome: number): BelgianTaxHouseholdV2 {
  const value = defaultHousehold({
    ...DEFAULT_BELGIAN_TAX_PROFILE,
    taxYear: year,
    grossAnnualIncome: grossIncome,
    profileConfigured: true,
  });
  return value;
}

beforeEach(() => {
  vi.clearAllMocks();
  settings.getAllWithBaselines.mockResolvedValue({
    settings: {},
    expected: {},
  });
});

describe("Read-only native Tax overview", () => {
  it("returns defaults with absent CAS baselines and no settings writes", async () => {
    const response = await api.get(path).expect(200);
    expect(bodyAt(response, "data", "liveYear")).toBe(
      DEFAULT_BELGIAN_TAX_PROFILE.taxYear,
    );
    expect(bodyAt(response, "data", "hasProfile")).toBe(false);
    expect(bodyAt(response, "data", "calculation", "totalPIT")).toBe(0);
    expect(bodyAt(response, "data", "records", 0, "expected")).toEqual({
      exists: false,
    });
    expect(bodyAt(response, "data", "householdMigrationNeeded")).toBe(false);
    expect(settings.replace).not.toHaveBeenCalled();
    expect(settings.replaceMany).not.toHaveBeenCalled();
  });

  it("uses the existing v1 migration, including null defaults and meaningful-data detection", async () => {
    settings.getAllWithBaselines.mockResolvedValue({
      settings: {
        belgian_tax_profile: {
          taxYear: 2025,
          grossAnnualIncome: 50000,
          region: null,
        },
      },
      expected: {},
    });
    const response = await api.get(path).expect(200);
    expect(bodyAt(response, "data", "year")).toBe(2025);
    expect(bodyAt(response, "data", "household", "region")).toBe("flanders");
    expect(bodyAt(response, "data", "hasProfile")).toBe(true);
    expect(bodyAt(response, "data", "householdMigrationNeeded")).toBe(true);
    expect(bodyAt(response, "data", "calculation", "totalPIT")).toBeCloseTo(
      10994.5175,
      8,
    );
    expect(settings.replaceMany).not.toHaveBeenCalled();
  });

  it("prefers a valid v2 household and its historical snapshot over v1 values", async () => {
    settings.getAllWithBaselines.mockResolvedValue({
      settings: {
        belgian_tax_profile: { taxYear: 2025, grossAnnualIncome: 1 },
        belgian_tax_household_v2: household(2026, 30000),
        belgian_tax_household_snapshots_v2: { "2025": household(2025, 50000) },
      },
      expected: {},
    });
    const response = await api.get(path).query({ year: 2025 }).expect(200);
    expect(bodyAt(response, "data", "liveYear")).toBe(2026);
    expect(bodyAt(response, "data", "hasSnapshot")).toBe(true);
    expect(bodyAt(response, "data", "isHistorical")).toBe(true);
    expect(bodyAt(response, "data", "calculation", "grossIncome")).toBe(50000);
    expect(bodyAt(response, "data", "householdMigrationNeeded")).toBe(false);
  });

  it("pins an unsaved historical estimate to the requested year without creating a snapshot", async () => {
    settings.getAllWithBaselines.mockResolvedValue({
      settings: { belgian_tax_household_v2: household(2026, 50000) },
      expected: {},
    });
    const response = await api.get(path).query({ year: 2025 }).expect(200);
    expect(bodyAt(response, "data", "year")).toBe(2025);
    expect(bodyAt(response, "data", "household", "taxYear")).toBe(2025);
    expect(bodyAt(response, "data", "liveHousehold", "taxYear")).toBe(2026);
    expect(bodyAt(response, "data", "hasSnapshot")).toBe(false);
    expect(bodyAt(response, "data", "calculation", "totalPIT")).toBeCloseTo(
      10994.5175,
      8,
    );
  });

  it.each([1850, 2300])(
    "estimates a year outside the storable range (%i) like any unsaved historical year",
    async (year) => {
      settings.getAllWithBaselines.mockResolvedValue({
        settings: { belgian_tax_household_v2: household(2026, 50000) },
        expected: {},
      });
      const response = await api.get(path).query({ year: String(year) }).expect(200);
      expect(bodyAt(response, "data", "year")).toBe(year);
      expect(bodyAt(response, "data", "household", "taxYear")).toBe(year);
      expect(bodyAt(response, "data", "isHistorical")).toBe(true);
      expect(bodyAt(response, "data", "hasSnapshot")).toBe(false);
      expect(typeof bodyAt(response, "data", "calculation", "totalPIT")).toBe("number");
      expect(settings.replaceMany).not.toHaveBeenCalled();
    },
  );

  it("reports a live-year snapshot while keeping the live household as that year's source", async () => {
    settings.getAllWithBaselines.mockResolvedValue({
      settings: {
        belgian_tax_household_v2: household(2025, 50000),
        belgian_tax_household_snapshots_v2: { "2025": household(2025, 90000) },
      },
      expected: {},
    });
    const response = await api.get(path).expect(200);
    expect(bodyAt(response, "data", "hasSnapshot")).toBe(true);
    expect(bodyAt(response, "data", "isHistorical")).toBe(false);
    expect(bodyAt(response, "data", "calculation", "grossIncome")).toBe(50000);
  });

  it("returns fully frozen figures verbatim without calling the current engine", async () => {
    const input = household(2025, 50000);
    const result = engine.computeHouseholdTax(input);
    const calculation = engine.toBelgianTaxCalculation(result, input);
    const frozenCalculation = { ...calculation, totalPIT: 123.4567 };
    const frozenHouseholdResult = {
      ...result,
      totals: { ...result.totals, totalPIT: 123.4567 },
    };
    const metadata = {
      frozenCalculation,
      frozenHouseholdResult,
      filing: {
        filedAt: "2026-05-01T12:00:00Z",
        reference: "synthetic fixture",
      },
      history: [],
    };
    settings.getAllWithBaselines.mockResolvedValue({
      settings: {
        belgian_tax_household_v2: household(2026, 90000),
        belgian_tax_profile_snapshot_meta_v1: { "2025": metadata },
      },
      expected: {},
    });
    vi.mocked(engine.computeHouseholdTax).mockClear();
    const response = await api.get(path).query({ year: 2025 }).expect(200);
    expect(bodyAt(response, "data", "calculation")).toEqual(
      JSON.parse(JSON.stringify(frozenCalculation)),
    );
    expect(bodyAt(response, "data", "result")).toEqual(
      JSON.parse(JSON.stringify(frozenHouseholdResult)),
    );
    expect(bodyAt(response, "data", "metadata")).toEqual(
      JSON.parse(JSON.stringify(metadata)),
    );
    expect(bodyAt(response, "data", "calculationSource")).toBe("frozen");
    expect(engine.computeHouseholdTax).not.toHaveBeenCalled();
  });

  it("preserves a legacy frozen calculation while computing the missing household breakdown", async () => {
    settings.getAllWithBaselines.mockResolvedValue({
      settings: {
        belgian_tax_household_v2: household(2025, 50000),
        belgian_tax_profile_snapshot_meta_v1: {
          "2025": { frozenCalculation: { totalPIT: 99 } },
        },
      },
      expected: {},
    });
    const response = await api.get(path).expect(200);
    expect(bodyAt(response, "data", "calculation")).toEqual({ totalPIT: 99 });
    expect(bodyAt(response, "data", "calculationSource")).toBe("frozen");
    expect(bodyAt(response, "data", "householdResultSource")).toBe("computed");
    expect(
      bodyAt(response, "data", "result", "totals", "totalPIT"),
    ).toBeCloseTo(10994.5175, 8);
  });

  it("reports invalid stored v2 data and retains original compare-and-swap baselines", async () => {
    const invalid = { version: 2, partners: [] };
    const expected = { exists: true, value: JSON.stringify(invalid) };
    settings.getAllWithBaselines.mockResolvedValue({
      settings: { belgian_tax_household_v2: invalid },
      expected: { belgian_tax_household_v2: expected },
    });
    const response = await api.get(path).expect(200);
    expect(bodyAt(response, "data", "storedValueInvalid")).toBe(true);
    expect(bodyAt(response, "data", "warnings", 0, "kind")).toBe(
      "invalid_stored",
    );
    expect(bodyAt(response, "data", "warnings", 0, "stored")).toBeUndefined();
    expect(bodyAt(response, "data", "records", 0, "value")).toEqual(invalid);
    expect(bodyAt(response, "data", "records", 0, "expected")).toEqual(
      expected,
    );
    expect(bodyAt(response, "data", "householdMigrationNeeded")).toBe(false);
    expect(settings.replaceMany).not.toHaveBeenCalled();
  });

  it.each(["2025abc", "2e3", " 2025", "2025.5", "12025", "-2025"])(
    "rejects malformed year %s",
    async (year) => {
      const response = await api.get(path).query({ year }).expect(400);
      expect(bodyAt(response, "error", "code")).toBe("VALIDATION_ERROR");
      expect(settings.getAllWithBaselines).not.toHaveBeenCalled();
    },
  );
});
