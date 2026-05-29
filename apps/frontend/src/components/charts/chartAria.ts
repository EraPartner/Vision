/**
 * Accessible default summaries for chart `role="img"` labels.
 *
 * Every chart renders an `<svg role="img">`. Without a meaningful label a screen
 * reader announces only the chart type ("Bar chart"), conveying nothing about
 * the data. The `ariaLabel` prop existed but no caller populated it, so these
 * builders generate a one-line data summary as the default. Callers may still
 * pass an explicit `ariaLabel` to override.
 */

function pluralize(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/** Summary for category/series charts (bar, line, area, stacked bar). */
export function summarizeSeriesChart(
  kind: string,
  categoryCount: number,
  seriesLabels: ReadonlyArray<string | undefined>,
): string {
  const named = seriesLabels.filter((l): l is string => Boolean(l));
  const seriesPart = named.length ? `, series: ${named.join(', ')}` : '';
  return `${kind} with ${pluralize(categoryCount, 'category', 'categories')}${seriesPart}`;
}

/** Summary for proportion charts (pie, donut), listing the first few segment names. */
export function summarizeProportionChart(kind: string, names: ReadonlyArray<string>): string {
  const named = names.filter(Boolean);
  const shown = named.slice(0, 6);
  const more = named.length > shown.length ? `, and ${named.length - shown.length} more` : '';
  const labelPart = shown.length ? `: ${shown.join(', ')}${more}` : '';
  return `${kind} with ${pluralize(names.length, 'segment', 'segments')}${labelPart}`;
}

/** Summary for a sparkline (array of numbers): point count + value range. */
export function summarizeSparkline(values: ReadonlyArray<number>): string {
  const finite = values.filter((v) => Number.isFinite(v));
  if (!finite.length) return 'Sparkline, no data';
  let min = finite[0];
  let max = finite[0];
  for (const v of finite) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return `Sparkline of ${pluralize(finite.length, 'point', 'points')}, ranging ${min} to ${max}`;
}
