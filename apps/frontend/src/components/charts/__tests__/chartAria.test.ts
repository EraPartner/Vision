import { describe, it, expect } from 'vitest';
import { summarizeSeriesChart, summarizeProportionChart, summarizeSparkline } from '../chartAria';

// Fake translator mirroring the English chart.aria.* keys, so these tests verify
// key selection (one/other) + interpolation independently of the locale files.
const EN: Record<string, string> = {
  'chart.aria.kind.pie': 'Pie chart',
  'chart.aria.kind.donut': 'Donut chart',
  'chart.aria.kind.bar': 'Bar chart',
  'chart.aria.kind.line': 'Line chart',
  'chart.aria.seriesOne': '{kind} with {count} category',
  'chart.aria.seriesOther': '{kind} with {count} categories',
  'chart.aria.series': ', series: {names}',
  'chart.aria.segmentOne': '{kind} with {count} segment',
  'chart.aria.segmentOther': '{kind} with {count} segments',
  'chart.aria.segmentNames': ': {names}',
  'chart.aria.andMore': ', and {count} more',
  'chart.aria.sparklineEmpty': 'Sparkline, no data',
  'chart.aria.sparklineOne': 'Sparkline of {count} point, ranging {min} to {max}',
  'chart.aria.sparklineOther': 'Sparkline of {count} points, ranging {min} to {max}',
};
const t = (key: string, vars?: Record<string, string | number>): string => {
  let text = EN[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{${k}}`, String(v));
  return text;
};

describe('summarizeSeriesChart', () => {
  it('lists category count and named series', () => {
    expect(summarizeSeriesChart(t, 'chart.aria.kind.bar', 3, ['Taxes', 'Fees'])).toBe(
      'Bar chart with 3 categories, series: Taxes, Fees',
    );
  });

  it('singularises and drops unnamed series', () => {
    expect(summarizeSeriesChart(t, 'chart.aria.kind.line', 1, [undefined, ''])).toBe('Line chart with 1 category');
  });
});

describe('summarizeProportionChart', () => {
  it('lists segment names', () => {
    expect(summarizeProportionChart(t, 'chart.aria.kind.pie', ['Food', 'Rent'])).toBe(
      'Pie chart with 2 segments: Food, Rent',
    );
  });

  it('truncates after six and reports the remainder', () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    expect(summarizeProportionChart(t, 'chart.aria.kind.donut', names)).toBe(
      'Donut chart with 8 segments: a, b, c, d, e, f, and 2 more',
    );
  });
});

describe('summarizeSparkline', () => {
  it('reports point count and value range', () => {
    expect(summarizeSparkline(t, [3, 1, 4, 1, 5])).toBe('Sparkline of 5 points, ranging 1 to 5');
  });

  it('rounds min/max to 2 decimals so the label never leaks float noise', () => {
    expect(summarizeSparkline(t, [-402.5, 81.26999999999998, 0.1 + 0.2])).toBe(
      'Sparkline of 3 points, ranging -402.5 to 81.27',
    );
  });

  it('handles empty / non-finite input', () => {
    expect(summarizeSparkline(t, [])).toBe('Sparkline, no data');
    expect(summarizeSparkline(t, [NaN, Infinity])).toBe('Sparkline, no data');
  });
});
