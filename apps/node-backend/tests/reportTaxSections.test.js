import { describe, it, expect } from 'vitest';

import { renderTaxExecutiveSummary } from '../src/services/reports/sections/taxExecutiveSummary.js';
import { renderTaxTypeBreakdown } from '../src/services/reports/sections/taxTypeBreakdown.js';
import { renderFeeBreakdown } from '../src/services/reports/sections/feeBreakdown.js';
import { renderTaxByAssetClass } from '../src/services/reports/sections/taxByAssetClass.js';
import { renderTaxMonthlyTrend } from '../src/services/reports/sections/taxMonthlyTrend.js';
import { renderTopInvestmentsByCost } from '../src/services/reports/sections/topInvestmentsByCost.js';

// fmtCurrency renders "EUR<nbsp>1,234.56".
const eur = (s) => `EUR ${s}`;

const ctx = { currency: 'EUR' };

// Fixture mirrors fetchTaxData's ACTUAL output shape: top-level totals (no
// nested `totals` object), monthly buckets carrying the four split tax
// components (no combined `taxes` field), byAssetClass as an ARRAY of
// { assetClass, taxes, fees }, and per-investment buckets named
// tob/wht/sell/other/fees/total. Every figure is non-zero and distinct so a
// renderer reading a wrong field (which yields 0) or a fees-only total is a
// visible failure, not a coincidental pass.
const data = {
  taxYear: 2024,
  startDate: '2024-01-01',
  endDate: '2024-12-31',
  currency: 'EUR',
  period: { kind: 'year', year: 2024 },
  periodNote: null,
  taxTables: {},
  taxProfile: undefined,
  precomputedPIT: undefined,
  tobTotal: 120.5,
  dividendWHTTotal: 87.3,
  sellTaxTotal: 45.6,
  otherTaxTotal: 12.4,
  feesTotal: 33.2,
  dividendsReceived: 291,
  byMonth: [
    { year: 2024, month: 1, tob: 70.5, wht: 40.3, sell: 25.6, other: 2.4, fees: 13.2 },
    { year: 2024, month: 2, tob: 50, wht: 47, sell: 20, other: 10, fees: 20 },
  ],
  byAssetClass: [
    { assetClass: 'stock', taxes: 200, fees: 21.2 },
    { assetClass: 'crypto', taxes: 65.8, fees: 12 },
  ],
  // Deliberately listed fees-heavy-first: Beta leads on fees (80 vs 10) but
  // Alpha leads on total cost (190 vs 85), so a fees-only sort or a fees-only
  // "Total Cost" puts Beta first / prints 10.00 — both visibly wrong.
  byInvestment: [
    { investmentId: 2, name: 'Beta Fund', symbol: 'BETA', assetClass: 'crypto', tob: 5, wht: 0, sell: 0, other: 0, fees: 80, total: 85 },
    { investmentId: 1, name: 'Alpha Corp', symbol: 'ALPH', assetClass: 'stock', tob: 100, wht: 50, sell: 25, other: 5, fees: 10, total: 190 },
  ],
  unconvertedCurrencies: [],
};

describe('renderTaxExecutiveSummary', () => {
  it('renders the top-level totals, not an empty state', () => {
    const html = renderTaxExecutiveSummary(data, ctx);

    expect(html).not.toContain('No tax data');
    // Total taxes = 120.5 + 87.3 + 45.6 + 12.4 = 265.8; total cost adds fees 33.2.
    expect(html).toContain(eur('265.80'));
    expect(html).toContain(eur('299.00'));
    expect(html).toContain(eur('120.50')); // TOB
    expect(html).toContain(eur('87.30'));  // dividend WHT
    expect(html).toContain(eur('45.60'));  // sell tax
    expect(html).toContain(eur('12.40'));  // other taxes
    expect(html).toContain(eur('33.20'));  // fees
    expect(html).toContain(eur('291.00')); // dividends received
    // Effective WHT rate = 87.3 / 291 = 30.0%.
    expect(html).toContain('30.0%');
    // Net dividend result = 291 - 87.3.
    expect(html).toContain(eur('203.70'));
  });
});

describe('renderTaxTypeBreakdown', () => {
  it('lists every non-zero component with its amount', () => {
    const html = renderTaxTypeBreakdown(data, ctx);

    expect(html).not.toContain('No tax data');
    expect(html).toContain(`Total cost: ${eur('299.00')} across 5 categories`);
    expect(html).toContain(eur('120.50'));
    expect(html).toContain(eur('87.30'));
    expect(html).toContain(eur('45.60'));
    expect(html).toContain(eur('33.20'));
    expect(html).toContain(eur('12.40'));
  });

  it('still renders the empty state when there is no data', () => {
    expect(renderTaxTypeBreakdown(null, ctx)).toContain('No tax data');
  });
});

describe('renderFeeBreakdown', () => {
  it('labels rows with asset-class names and totals fees from the top level', () => {
    const html = renderFeeBreakdown(data, ctx);

    expect(html).not.toContain('No fee data');
    expect(html).toContain(`Total fees: ${eur('33.20')}`);
    expect(html).toContain('<td>stock</td>');
    expect(html).toContain('<td>crypto</td>');
    // Array-index labels from the old Object.entries() iteration.
    expect(html).not.toContain('<td>0</td>');
    expect(html).not.toContain('<td>1</td>');
    expect(html).toContain(eur('21.20')); // stock fees
    expect(html).toContain(eur('12.00')); // crypto fees
    // Shares of total fees: 21.2/33.2 and 12/33.2.
    expect(html).toContain('63.9%');
    expect(html).toContain('36.1%');
  });
});

describe('renderTaxByAssetClass', () => {
  it('labels rows with asset-class names and renders taxes + fees per class', () => {
    const html = renderTaxByAssetClass(data, ctx);

    expect(html).not.toContain('No data');
    expect(html).toContain('<td>stock</td>');
    expect(html).toContain('<td>crypto</td>');
    expect(html).not.toContain('<td>0</td>');
    expect(html).not.toContain('<td>1</td>');
    expect(html).toContain(eur('200.00')); // stock taxes
    expect(html).toContain(eur('21.20'));  // stock fees
    expect(html).toContain(eur('221.20')); // stock total
    expect(html).toContain(eur('65.80'));  // crypto taxes
    expect(html).toContain(eur('12.00'));  // crypto fees
    expect(html).toContain(eur('77.80'));  // crypto total
  });
});

describe('renderTaxMonthlyTrend', () => {
  it('derives the Taxes column from the split components, not a missing m.taxes', () => {
    const html = renderTaxMonthlyTrend(data, ctx);

    expect(html).not.toContain('No monthly data');
    // Jan taxes = 70.5 + 40.3 + 25.6 + 2.4 = 138.8; total adds fees 13.2.
    expect(html).toContain(eur('138.80'));
    expect(html).toContain(eur('152.00'));
    // Feb taxes = 50 + 47 + 20 + 10 = 127; total adds fees 20.
    expect(html).toContain(eur('127.00'));
    expect(html).toContain(eur('147.00'));
    // The old m.taxes read rendered 0.00 in every Taxes cell.
    expect(html).not.toContain(eur('0.00'));
  });
});

describe('renderTopInvestmentsByCost', () => {
  it('renders the per-investment tax columns and a total cost that includes taxes', () => {
    const html = renderTopInvestmentsByCost(data, ctx);

    expect(html).not.toContain('No data');
    expect(html).toContain('Alpha Corp');
    expect(html).toContain('Beta Fund');
    // Alpha's split columns — the old tobTotal/dividendWHTTotal/sellTaxTotal
    // reads rendered 0.00 in all three.
    expect(html).toContain(eur('100.00')); // TOB
    expect(html).toContain(eur('50.00'));  // dividend WHT
    expect(html).toContain(eur('25.00'));  // sell tax
    // Total cost includes taxes: 190.00 and 85.00 in the bold total cell —
    // not the fees-only 10.00/80.00 the old `taxes + fees` (undefined + fees)
    // arithmetic produced.
    expect(html).toContain(`style="font-weight:600;">${eur('190.00')}`);
    expect(html).toContain(`style="font-weight:600;">${eur('85.00')}`);
    expect(html).not.toContain(`style="font-weight:600;">${eur('10.00')}`);
    expect(html).not.toContain(`style="font-weight:600;">${eur('80.00')}`);
  });

  it('sorts by total cost, not by fees', () => {
    const html = renderTopInvestmentsByCost(data, ctx);

    // Alpha (total 190, fees 10) must rank above Beta (total 85, fees 80)
    // even though the fixture lists Beta first and Beta leads on fees.
    expect(html.indexOf('Alpha Corp')).toBeGreaterThan(-1);
    expect(html.indexOf('Alpha Corp')).toBeLessThan(html.indexOf('Beta Fund'));
  });
});
