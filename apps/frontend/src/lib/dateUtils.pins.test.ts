// Pin tests for PKG-07 / PKG-09 / PKG-12 (date-fns adoption, see
// docs/audits/2026-07-package-adoption-audit.md). Written against the
// hand-rolled implementations FIRST; the date-fns swap must keep them green.
import { describe, expect, test } from "vitest";
import { CHART_DATE_PATTERNS, formatDate, parseISO } from "./dateUtils";
import { filterByPeriod, CHART_PERIOD_OFFSET_DAYS } from "@/components/charts/chartPeriods";

describe("formatDate numeric patterns (PKG-12 pins)", () => {
  // Single-digit day+month, and double-digit day+month with an afternoon time.
  const d1 = new Date(2026, 2, 5, 0, 0); // 2026-03-05 00:00
  const d2 = new Date(2025, 11, 31, 14, 7); // 2025-12-31 14:07

  test.each([
    ["yyyy-MM-dd", "2026-03-05", "2025-12-31"],
    ["yyyy-MM-dd HH:mm", "2026-03-05 00:00", "2025-12-31 14:07"],
    ["dd/MM/yyyy", "05/03/2026", "31/12/2025"],
    ["MM/dd/yyyy", "03/05/2026", "12/31/2025"],
    ["dd.MM.yyyy", "05.03.2026", "31.12.2025"],
    ["dd-MM-yyyy", "05-03-2026", "31-12-2025"],
    ["MM/yyyy", "03/2026", "12/2025"],
    ["yyyy-MM", "2026-03", "2025-12"],
    ["MM.yyyy", "03.2026", "12.2025"],
    ["MM-yyyy", "03-2026", "12-2025"],
  ])("%s", (pattern, expected1, expected2) => {
    expect(formatDate(d1, pattern)).toBe(expected1);
    expect(formatDate(d2, pattern)).toBe(expected2);
  });

  test("month-name and default branches render via Intl honoring the locale", () => {
    // These branches stay on Intl.DateTimeFormat (do-not-migrate): date-fns
    // format would use its own locale objects and break non-English rendering.
    expect(formatDate(d1, "MMM yyyy", "en-US")).toBe("Mar 2026");
    expect(formatDate(d1, "MMM yyyy", "nl-BE")).toBe("mrt 2026");
    expect(formatDate(d1, "MMM yy", "en-US")).toBe("Mar 26");
    expect(formatDate(d1, "d MMM", "en-US")).toBe("5 Mar");
    expect(formatDate(d1, "d MMM", "nl-BE")).toBe("5 mrt");
    expect(formatDate(d1, "d MMM yy", "en-US")).toBe("5 Mar 26");
    expect(formatDate(d1, "d MMM yyyy", "en-US")).toBe("5 Mar 2026");
    expect(formatDate(d1, "dd MMM yyyy", "en-US")).toBe("05 Mar 2026");
    expect(formatDate(d1, "MMM d", "en-US")).toBe("Mar 5");
    expect(formatDate(d1, "unknown-pattern", "en-US")).toBe("March 5, 2026");
  });

  test("canonical chart date roles stay pinned", () => {
    expect(formatDate(d1, CHART_DATE_PATTERNS.dayTick, "en-US")).toBe("5 Mar");
    expect(formatDate(d1, CHART_DATE_PATTERNS.monthTick, "en-US")).toBe("Mar 26");
    expect(formatDate(d1, CHART_DATE_PATTERNS.detail, "en-US")).toBe("5 Mar 2026");
    expect(formatDate(d1, CHART_DATE_PATTERNS.monthLabel, "en-US")).toBe("Mar 2026");
    expect(formatDate(d1, CHART_DATE_PATTERNS.yearTick, "en-US")).toBe("2026");
  });
});

describe("parseISO (PKG-07 pins)", () => {
  test("date-only strings parse as LOCAL midnight", () => {
    const d = parseISO("2026-07-01");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(6);
    expect(d.getDate()).toBe(1);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
  });

  test("full timestamps keep Date's native parsing (fallback branch)", () => {
    const d = parseISO("2026-07-01T10:30:00Z");
    expect(d.getTime()).toBe(new Date("2026-07-01T10:30:00Z").getTime());
  });

  test("garbage input yields Invalid Date", () => {
    expect(Number.isNaN(parseISO("not-a-date").getTime())).toBe(true);
  });
});

describe("filterByPeriod day-subtraction cutoff (PKG-09 pins)", () => {
  // Rows spanning ~13 months of consecutive month-ends plus daily tail.
  const rows: { d: string }[] = [];
  for (let i = 0; i < 400; i++) {
    const dt = new Date(2026, 0, 30);
    dt.setDate(dt.getDate() - i);
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, "0");
    const dd = String(dt.getDate()).padStart(2, "0");
    rows.unshift({ d: `${y}-${m}-${dd}` });
  }
  const getYmd = (r: { d: string }) => r.d;

  test.each(["1m", "3m", "6m", "1y"] as const)("period %s keeps exactly the offset window", (period) => {
    const days = CHART_PERIOD_OFFSET_DAYS[period];
    const out = filterByPeriod(rows, getYmd, period);
    // The cutoff is anchor(last row) minus `days`, compared as YMD strings
    // (inclusive). Pin both the count and the boundary element.
    expect(out.length).toBe(days + 1);
    expect(out[0].d).toBe(rows[rows.length - 1 - days].d);
    expect(out[out.length - 1].d).toBe("2026-01-30");
  });

  test("period 'all' and invalid anchors return a copy of the input", () => {
    expect(filterByPeriod(rows, getYmd, "all")).toEqual(rows);
    const bad = [{ d: "garbage" }];
    expect(filterByPeriod(bad, (r) => r.d, "1m")).toEqual(bad);
  });

  test("month-boundary anchor: cutoff crosses into the previous month correctly", () => {
    // Anchor 2026-03-01 minus 30 days -> 2026-01-30 (setDate rollover semantics).
    const data = [
      { d: "2026-01-29" },
      { d: "2026-01-30" },
      { d: "2026-02-15" },
      { d: "2026-03-01" },
    ];
    const out = filterByPeriod(data, (r) => r.d, "1m");
    expect(out.map((r) => r.d)).toEqual(["2026-01-30", "2026-02-15", "2026-03-01"]);
  });
});
