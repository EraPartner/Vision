import { describe, expect, test } from "vitest";
import {
  ASSET_CLASSES,
  UNIT_BASED_ASSET_CLASSES,
  FIXED_INCOME_ASSET_CLASSES,
  isUnitBased,
  isFixedIncome,
  isRealEstate,
} from "@/utils/assetClass";

describe("asset class constants", () => {
  test("contains the full ordered set", () => {
    expect(ASSET_CLASSES).toEqual([
      "stock",
      "etf",
      "crypto",
      "metals",
      "real_estate",
      "savings",
      "bond",
    ]);
  });

  test("unit-based and fixed-income subsets are correct", () => {
    expect(UNIT_BASED_ASSET_CLASSES).toEqual(["stock", "etf", "crypto", "metals"]);
    expect(FIXED_INCOME_ASSET_CLASSES).toEqual(["savings", "bond"]);
  });
});

describe("isUnitBased", () => {
  test("true for unit-based classes", () => {
    for (const c of UNIT_BASED_ASSET_CLASSES) expect(isUnitBased(c)).toBe(true);
  });

  test("false for non-unit-based classes", () => {
    expect(isUnitBased("savings")).toBe(false);
    expect(isUnitBased("real_estate")).toBe(false);
  });
});

describe("isFixedIncome", () => {
  test("true for savings and bond", () => {
    expect(isFixedIncome("savings")).toBe(true);
    expect(isFixedIncome("bond")).toBe(true);
  });

  test("false for stocks", () => {
    expect(isFixedIncome("stock")).toBe(false);
  });
});

describe("isRealEstate", () => {
  test("true only for real_estate", () => {
    expect(isRealEstate("real_estate")).toBe(true);
    expect(isRealEstate("stock")).toBe(false);
  });
});
