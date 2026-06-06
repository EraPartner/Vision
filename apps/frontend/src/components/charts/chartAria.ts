/**
 * Accessible, localized summaries for chart `role="img"` labels.
 *
 * Every chart renders an `<svg role="img">`. Without a meaningful label a screen
 * reader announces only the chart type ("Bar chart"), conveying nothing about
 * the data. These builders generate a one-line, translated data summary as the
 * default; callers may still pass an explicit `ariaLabel` to override.
 *
 * The translator `t` and a `kindKey` (e.g. `chart.aria.kind.bar`) are injected by
 * each chart component so the summaries are localized (previously they were
 * hardcoded English, so Dutch screen-reader users heard English for every chart).
 */

type TFn = (key: string, vars?: Record<string, string | number>) => string;

/** Summary for category/series charts (bar, line, area, stacked bar). */
export function summarizeSeriesChart(
  t: TFn,
  kindKey: string,
  categoryCount: number,
  seriesLabels: ReadonlyArray<string | undefined>,
): string {
  const kind = t(kindKey);
  const named = seriesLabels.filter((l): l is string => Boolean(l));
  const base = t(categoryCount === 1 ? 'chart.aria.seriesOne' : 'chart.aria.seriesOther', { kind, count: categoryCount });
  return named.length ? base + t('chart.aria.series', { names: named.join(', ') }) : base;
}

/** Summary for proportion charts (pie, donut), listing the first few segment names. */
export function summarizeProportionChart(t: TFn, kindKey: string, names: ReadonlyArray<string>): string {
  const kind = t(kindKey);
  const named = names.filter(Boolean);
  const shown = named.slice(0, 6);
  let out = t(names.length === 1 ? 'chart.aria.segmentOne' : 'chart.aria.segmentOther', { kind, count: names.length });
  if (shown.length) {
    out += t('chart.aria.segmentNames', { names: shown.join(', ') });
    if (named.length > shown.length) out += t('chart.aria.andMore', { count: named.length - shown.length });
  }
  return out;
}

/** Summary for a sparkline (array of numbers): point count + value range. */
export function summarizeSparkline(t: TFn, values: ReadonlyArray<number>): string {
  const finite = values.filter((v) => Number.isFinite(v));
  if (!finite.length) return t('chart.aria.sparklineEmpty');
  let min = finite[0];
  let max = finite[0];
  for (const v of finite) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  // Round to 2 decimals so the label never leaks float noise (e.g. 81.26999999999998).
  const round2 = (v: number) => Math.round(v * 100) / 100;
  return t(finite.length === 1 ? 'chart.aria.sparklineOne' : 'chart.aria.sparklineOther', { count: finite.length, min: round2(min), max: round2(max) });
}
