/**
 * Portfolio Allocation section renderer.
 *
 * Shows asset-class breakdown via horizontal bars + a legend table.
 */

import { buildAssetClassBuckets, emptySection, escapeHtml, fmtCurrency, fmtPct, sectionPage, svgHorizontalBars } from '../sectionHelpers.js';

/**
 * @param {import('../dataFetcherPortfolio.js').PortfolioReportData | null} data
 * @param {{ currency: string }} ctx
 * @returns {string}
 */
export function renderPortfolioAllocation(data, { currency }) {
  const snapshots = data?.snapshots ?? [];
  const latest    = snapshots.length ? snapshots[snapshots.length - 1] : null;

  if (!latest && !data?.breakdown?.length) {
    return emptySection({
      title: 'Asset Allocation',
      subtitle: 'Distribution across asset classes',
      heading: 'No allocation data',
      message: 'Add investments to see the allocation breakdown.',
    });
  }

  const classes = buildAssetClassBuckets(latest, data?.breakdown ?? []);
  classes.sort((a, b) => b.value - a.value);
  const total = classes.reduce((s, c) => s + c.value, 0);

  const barItems = classes.map(c => ({
    label:    c.label,
    value:    c.value,
    fmtValue: fmtCurrency(c.value, currency),
  }));

  const tableRows = classes.map(c => {
    // eslint-disable-next-line vision-local-money/no-raw-money-arithmetic
    const pct = total > 0 ? (c.value / total) : 0;
    const gl  = c.value - c.invested;
    return `<tr>
      <td>${escapeHtml(c.label)}</td>
      <td class="num">${fmtCurrency(c.value,    currency)}</td>
      <td class="num">${fmtCurrency(c.invested, currency)}</td>
      <td class="num">${fmtPct(pct)}</td>
      <td class="num ${gl >= 0 ? 'pos' : 'neg'}">${fmtCurrency(gl, currency)}</td>
    </tr>`;
  }).join('');

  return sectionPage({
    title: 'Asset Allocation',
    subtitle: 'Distribution of portfolio value across asset classes',
    content: `
      <div class="chart-wrap">${svgHorizontalBars(barItems, { maxItems: 8 })}</div>
      <table class="data-table">
        <thead><tr>
          <th>Asset Class</th>
          <th class="num">Value</th>
          <th class="num">Invested</th>
          <th class="num">Allocation</th>
          <th class="num">Unrealised P/L</th>
        </tr></thead>
        <tbody>${tableRows}</tbody>
      </table>`,
  });
}
