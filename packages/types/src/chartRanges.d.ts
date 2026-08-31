export declare const CHART_RANGE_KEYS: readonly [
  "1d",
  "5d",
  "1mo",
  "3mo",
  "6mo",
  "1y",
  "2y",
  "5y",
  "max",
];

export type ChartRange = (typeof CHART_RANGE_KEYS)[number];

export declare function makeChartRangeMap<T>(
  values: readonly T[],
): Readonly<Record<ChartRange, T>>;
