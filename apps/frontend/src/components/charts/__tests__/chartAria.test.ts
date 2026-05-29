import { describe, it, expect } from 'vitest';
import { summarizeSeriesChart, summarizeProportionChart, summarizeSparkline } from '../chartAria';

describe('summarizeSeriesChart', () => {
  it('lists category count and named series', () => {
    expect(summarizeSeriesChart('Bar chart', 3, ['Taxes', 'Fees'])).toBe(
      'Bar chart with 3 categories, series: Taxes, Fees',
    );
  });

  it('singularises and drops unnamed series', () => {
    expect(summarizeSeriesChart('Line chart', 1, [undefined, ''])).toBe('Line chart with 1 category');
  });
});

describe('summarizeProportionChart', () => {
  it('lists segment names', () => {
    expect(summarizeProportionChart('Pie chart', ['Food', 'Rent'])).toBe(
      'Pie chart with 2 segments: Food, Rent',
    );
  });

  it('truncates after six and reports the remainder', () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    expect(summarizeProportionChart('Donut chart', names)).toBe(
      'Donut chart with 8 segments: a, b, c, d, e, f, and 2 more',
    );
  });
});

describe('summarizeSparkline', () => {
  it('reports point count and value range', () => {
    expect(summarizeSparkline([3, 1, 4, 1, 5])).toBe('Sparkline of 5 points, ranging 1 to 5');
  });

  it('handles empty / non-finite input', () => {
    expect(summarizeSparkline([])).toBe('Sparkline, no data');
    expect(summarizeSparkline([NaN, Infinity])).toBe('Sparkline, no data');
  });
});
