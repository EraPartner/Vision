import { describe, expect, it } from "vitest";
import { __validateSettingValue } from "../src/routes/settings.js";

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
