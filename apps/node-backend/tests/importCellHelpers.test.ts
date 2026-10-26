import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { cellText, stringifyCell } from "../src/services/cellText.ts";
import { requiredValue } from "../src/services/requiredValue.ts";
import { storedConfigObject } from "../src/services/portfolio/storedConfig.ts";

describe("stringifyCell / cellText", () => {
  it("matches String() for every cell shape an import produces", () => {
    const cells: unknown[] = [
      "text",
      "",
      0,
      -1.5,
      true,
      10n,
      undefined,
      null,
      new Date("2025-06-01T00:00:00Z"),
      new Decimal("12.3400"),
      Buffer.from("abc"),
      ["a", 1, null, undefined],
      { richText: [] },
    ];
    for (const cell of cells) {
      expect(stringifyCell(cell)).toBe(String(cell));
    }
  });

  it("reads nullish cells as the empty string", () => {
    expect(cellText(null)).toBe("");
    expect(cellText(undefined)).toBe("");
    expect(cellText(0)).toBe("0");
    expect(cellText("x")).toBe("x");
  });
});

describe("requiredValue", () => {
  it("returns present values, including falsy ones", () => {
    expect(requiredValue(0, "zero")).toBe(0);
    expect(requiredValue("", "empty")).toBe("");
    expect(requiredValue(false, "false")).toBe(false);
  });

  it("names the broken invariant when the value is missing", () => {
    expect(() => requiredValue(undefined, "the map has the key")).toThrow(
      "Invariant violated: the map has the key",
    );
    expect(() => requiredValue(null, "the row exists")).toThrow(
      "Invariant violated: the row exists",
    );
  });
});

describe("storedConfigObject", () => {
  it("reads an object column as-is", () => {
    expect(storedConfigObject({ format: "x", n: 1 })).toEqual({
      format: "x",
      n: 1,
    });
  });

  it("parses a JSON string", () => {
    expect(storedConfigObject('{"format":"saxo_xlsx_v1"}')).toEqual({
      format: "saxo_xlsx_v1",
    });
  });

  it("reads malformed, non-object or absent configs as having no keys", () => {
    expect(storedConfigObject("{not json")).toEqual({});
    expect(storedConfigObject("null")).toEqual({});
    expect(storedConfigObject("42")).toEqual({});
    expect(storedConfigObject('["a"]')).toEqual({});
    expect(storedConfigObject(null)).toEqual({});
    expect(storedConfigObject(undefined)).toEqual({});
    expect(storedConfigObject(7)).toEqual({});
  });
});
