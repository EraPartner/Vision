import { describe, it, expect } from "vitest";
import { neutralizeCsvFormula, escapeCsvValue } from "@/lib/csv";

describe("neutralizeCsvFormula", () => {
  it("prefixes leading =, +, -, @", () => {
    expect(neutralizeCsvFormula("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(neutralizeCsvFormula("+1+1")).toBe("'+1+1");
    expect(neutralizeCsvFormula("-2")).toBe("'-2");
    expect(neutralizeCsvFormula("@cmd")).toBe("'@cmd");
  });

  it("prefixes leading tab/CR formula bypasses", () => {
    expect(neutralizeCsvFormula("\t=SUM(A1)")).toBe("'\t=SUM(A1)");
    expect(neutralizeCsvFormula("\r=cmd")).toBe("'\r=cmd");
  });

  it("sees through safe leading whitespace to the dangerous char", () => {
    expect(neutralizeCsvFormula(" =SUM(1)")).toBe("' =SUM(1)");
  });

  it("leaves benign strings untouched", () => {
    expect(neutralizeCsvFormula("hello")).toBe("hello");
    expect(neutralizeCsvFormula("")).toBe("");
  });
});

describe("escapeCsvValue", () => {
  it("quotes values containing comma, quote, or newline", () => {
    expect(escapeCsvValue("a,b")).toBe('"a,b"');
    expect(escapeCsvValue('he said "hi"')).toBe('"he said ""hi"""');
    expect(escapeCsvValue("line1\nline2")).toBe('"line1\nline2"');
  });

  it("returns empty string for null/undefined", () => {
    expect(escapeCsvValue(null)).toBe("");
    expect(escapeCsvValue(undefined)).toBe("");
  });

  it("neutralizes dangerous string cells", () => {
    expect(escapeCsvValue("=SUM(A1,B1)")).toBe('"\'=SUM(A1,B1)"');
  });

  it("passes numbers and booleans through verbatim (no formula prefix on negatives)", () => {
    expect(escapeCsvValue(65000)).toBe("65000");
    expect(escapeCsvValue(-5)).toBe("-5");
    expect(escapeCsvValue(true)).toBe("true");
  });
});
