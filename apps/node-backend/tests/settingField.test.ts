import { describe, expect, it } from "vitest";
import { settingField } from "../src/repositories/settingsRepository.ts";

describe("settingField", () => {
  it("reads a field the way optional chaining on the raw value did", () => {
    expect(settingField({ defaultCurrency: "usd" }, "defaultCurrency")).toBe(
      "usd",
    );
    expect(settingField({}, "defaultCurrency")).toBeUndefined();
    expect(settingField(null, "defaultCurrency")).toBeUndefined();
    expect(settingField(undefined, "defaultCurrency")).toBeUndefined();
    expect(settingField([1, 2], "defaultCurrency")).toBeUndefined();
    expect(settingField(false, "autoClearPlannedOnMatch")).toBeUndefined();
    // Primitives are boxed, exactly like `value?.length` on a string.
    expect(settingField("abc", "length")).toBe(3);
  });
});
