export const CHART_RANGE_KEYS = Object.freeze([
  "1d",
  "5d",
  "1mo",
  "3mo",
  "6mo",
  "1y",
  "2y",
  "5y",
  "max",
] as const);

export type ChartRange = (typeof CHART_RANGE_KEYS)[number];

export function makeChartRangeMap<T>(
  values: readonly T[],
): Readonly<Record<ChartRange, T>> {
  if (values.length !== CHART_RANGE_KEYS.length) {
    throw new Error(
      `Expected ${CHART_RANGE_KEYS.length} chart-range values, received ${values.length}`,
    );
  }
  return Object.freeze(
    Object.fromEntries(
      CHART_RANGE_KEYS.map((key, index) => [key, values[index]]),
    ),
  ) as Readonly<Record<ChartRange, T>>;
}
