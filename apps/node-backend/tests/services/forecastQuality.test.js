import { afterEach, describe, expect, it, vi } from "vitest";
import { forecast } from "../../src/services/calculations/forecast/methods/prophetLite.ts";
import {
  walkForwardBacktest,
  walkForwardBacktestRolling,
} from "../../src/services/calculations/forecast/backtest.ts";
const dateAt = (i) =>
  new Date(Date.UTC(2023, 0, 1 + i)).toISOString().slice(0, 10);
const patterns = [
  ["zero", () => 0, () => 1e-6],
  ["constant", () => 100, () => 1e-6],
  ["linear", (i) => 100 + 0.1 * i, () => 0.05],
  [
    "weekly",
    (i) => 100 + 20 * Math.sin((2 * Math.PI * i) / 7),
    (n) => (n <= 90 ? 1.5 : 0.25),
  ],
  [
    "weekly trend",
    (i) => 100 + 0.1 * i + 20 * Math.sin((2 * Math.PI * i) / 7),
    (n) => (n <= 90 ? 1.5 : 0.25),
  ],
  [
    "plateau",
    (i, n) => 100 + 0.1 * Math.min(i, Math.floor(0.7 * n)),
    () => 0.3,
  ],
];
afterEach(() => vi.useRealTimers());
describe("declared Prophet-lite synthetic regression benchmarks", () => {
  for (const n of [60, 90, 180, 365, 730]) {
    it.each(patterns)(
      "%s: 30-day holdout after " + n + " training days",
      (_name, value, ceiling) => {
        const history = Array.from({ length: n }, (_, i) => ({
          date: dateAt(i),
          net: value(i, n),
        }));
        const series = forecast({
          history,
          forecastDates: Array.from({ length: 30 }, (_, i) => dateAt(n + i)),
        });
        expect(series).toHaveLength(30);
        const mae =
          series.reduce(
            (sum, p, i) => sum + Math.abs(p.value - value(n + i, n)),
            0,
          ) / 30;
        expect(mae).toBeLessThanOrEqual(ceiling(n));
      },
    );
  }
  it.each([365, 730, 1095])(
    "calendar annual baseline after %i days (limited fit)",
    (n) => {
      const value = (i) => {
        const d = new Date(Date.UTC(2023, 0, 1 + i));
        const doy =
          (d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000;
        return 100 + 20 * Math.sin((2 * Math.PI * doy) / 365.25);
      };
      const series = forecast({
        history: Array.from({ length: n }, (_, i) => ({
          date: dateAt(i),
          net: value(i),
        })),
        forecastDates: Array.from({ length: 30 }, (_, i) => dateAt(n + i)),
      });
      expect(
        series.reduce(
          (sum, p, i) => sum + Math.abs(p.value - value(n + i)),
          0,
        ) / 30,
      ).toBeLessThanOrEqual(6);
    },
  );
});
const methods = [
  {
    id: "wrong",
    label: "Wrong",
    forecast: ({ forecastDates }) =>
      forecastDates.map((date) => ({ date, value: 10 })),
  },
];
function februaryHistory(total) {
  return [
    { date: "2024-01-01", net: 100 },
    ...Array.from({ length: 29 }, (_, i) => ({
      date: `2024-02-${String(i + 1).padStart(2, "0")}`,
      net: total / 29,
    })),
  ];
}
describe("honest percentage error around zero net cashflow", () => {
  it.each([0, 0.01, -0.01, 1e-10])(
    "withholds MAPE for total %s while retaining absolute error",
    (total) => {
      const [r] = walkForwardBacktest({
        history: februaryHistory(total),
        methods,
        asOfMonth: "2024-03",
        windowMonths: 1,
      });
      expect(r.perMonth[0].mape).toBeNull();
      expect(r.aggregate.mape).toBeNull();
      expect(r.aggregate.mae).toBeCloseTo(10 - total / 29);
    },
  );
  it("reports a finite percentage just above the eligibility boundary", () => {
    const [r] = walkForwardBacktest({
      history: februaryHistory(0.011),
      methods,
      asOfMonth: "2024-03",
      windowMonths: 1,
    });
    expect(Number.isFinite(r.aggregate.mape)).toBe(true);
    expect(r.aggregate.mape).toBeGreaterThan(0);
  });
  it("averages percentage error over eligible months only", () => {
    const history = [
      ...februaryHistory(0),
      ...Array.from({ length: 31 }, (_, i) => ({
        date: `2024-03-${String(i + 1).padStart(2, "0")}`,
        net: 100,
      })),
    ];
    const [r] = walkForwardBacktest({
      history,
      methods,
      asOfMonth: "2024-04",
      windowMonths: 2,
    });
    expect(r.aggregate).toMatchObject({ mape: 0.9, months: 2 });
  });
  it("withholds percentage error for an empty backtest", () => {
    expect(
      walkForwardBacktest({
        history: [],
        methods,
        asOfMonth: "2024-03",
        windowMonths: 1,
      })[0].aggregate,
    ).toMatchObject({ mape: null, months: 0 });
  });
  it("uses the same policy for rolling windows", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-03-01T12:00:00Z"));
    const [r] = walkForwardBacktestRolling({
      history: [{ date: "2024-02-01", net: 100 }],
      methods,
      daysBack: 30,
      daysForward: 7,
      windowCount: 1,
    });
    expect(r.aggregate).toMatchObject({ mape: null, mae: 10, windows: 1 });
  });
});
