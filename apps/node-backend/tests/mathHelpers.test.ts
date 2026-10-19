import { describe, expect, it } from "vitest";
import { firstNonZero, nanToZero, nonZeroOr } from "../src/lib/math.ts";

describe("nanToZero", () => {
  it("keeps real numbers, including 0 and negatives", () => {
    expect(nanToZero(0)).toBe(0);
    expect(nanToZero(-12.5)).toBe(-12.5);
    expect(nanToZero(Number("42.10"))).toBe(42.1);
  });

  it("reads unparseable input as 0", () => {
    expect(nanToZero(Number("abc"))).toBe(0);
    expect(nanToZero(parseInt("", 10))).toBe(0);
  });
});

describe("nonZeroOr", () => {
  it("falls back for 0 and NaN only", () => {
    expect(nonZeroOr(0, 500)).toBe(500);
    expect(nonZeroOr(Number.NaN, 500)).toBe(500);
    expect(nonZeroOr(25, 500)).toBe(25);
    expect(nonZeroOr(-1, 500)).toBe(-1);
  });
});

describe("firstNonZero", () => {
  it("returns the first deciding comparison", () => {
    expect(firstNonZero(0, -3, 7)).toBe(-3);
    expect(firstNonZero(2, -3)).toBe(2);
  });

  it("skips ties and NaN, and is 0 when every comparison ties", () => {
    expect(firstNonZero(Number.NaN, 4)).toBe(4);
    expect(firstNonZero(0, 0)).toBe(0);
    expect(firstNonZero()).toBe(0);
  });

  it("orders by a primary key, then a tie-breaker", () => {
    const rows = [
      { date: "2026-02-01", id: 2 },
      { date: "2026-01-01", id: 9 },
      { date: "2026-02-01", id: 1 },
    ];
    rows.sort((a, b) =>
      firstNonZero(a.date.localeCompare(b.date), a.id - b.id),
    );
    expect(rows.map((row) => row.id)).toEqual([9, 1, 2]);
  });
});
