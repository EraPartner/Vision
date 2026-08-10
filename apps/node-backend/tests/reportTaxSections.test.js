import { describe, it, expect } from 'vitest';

import { renderTaxExecutiveSummary } from '../src/services/reports/sections/taxExecutiveSummary.js';
import { renderTaxTypeBreakdown } from '../src/services/reports/sections/taxTypeBreakdown.js';
import { renderFeeBreakdown } from '../src/services/reports/sections/feeBreakdown.js';
import { renderTaxByAssetClass } from '../src/services/reports/sections/taxByAssetClass.js';
import { renderTaxMonthlyTrend } from '../src/services/reports/sections/taxMonthlyTrend.js';
import { renderTopInvestmentsByCost } from '../src/services/reports/sections/topInvestmentsByCost.js';
import { renderBelgianRulesSummary } from '../src/services/reports/sections/belgianRulesSummary.js';
import { getTaxTable } from '../src/services/reports/belgianTaxTables.js';

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

describe('renderBelgianRulesSummary', () => {
  // Two DIFFERENT unit conventions meet in this section, which is what made the
  // rates render 100x/10,000x too large: getTaxTable ships fractions (WHT 0.30,
  // TOB 0.0035) while the client's precomputedPIT brackets are already in percent
  // units (pit.ts: `rate: br.rate * 100` → 25). Real values from both sources.
  const rulesData = {
    ...data,
    taxYear: 2025,
    taxTables: getTaxTable(2025),
    taxProfile: { filingStatus: 'single' },
    precomputedPIT: {
      taxableIncome: 50_000,
      totalTax: 12_345.67,
      brackets: [
        { label: 'Bracket 1 (25%)', rate: 25, taxableIncome: 16_320, taxAmount: 4080 },
        { label: 'Bracket 2 (40%)', rate: 40, taxableIncome: 12_000, taxAmount: 4800 },
        { label: 'Bracket 4 (50%)', rate: 50, taxableIncome: 6931.34, taxAmount: 3465.67 },
      ],
    },
  };

  it('renders backend fraction rates scaled exactly once', () => {
    const html = renderBelgianRulesSummary(rulesData, ctx);

    // dividendWHTRate 0.30 → 30.0%, not 3000.0% (double-scaled) or 0.3%.
    expect(html).toContain('+30.0%');
    expect(html).not.toContain('3000.0%');
    // TOB fractions 0.0012 / 0.0035 / 0.0132 → 0.12% / 0.35% / 1.32%. The
    // statutory rates are sub-percent, so they need two fraction digits: at the
    // default one digit they collapse to 0.1% / 0.4% / 1.3%.
    expect(html).toContain('+0.12%');
    expect(html).toContain('+0.35%');
    expect(html).toContain('+1.32%');
    expect(html).not.toContain('+12.00%');
    expect(html).not.toContain('+35.00%');
    expect(html).not.toContain('+132.00%');
  });

  it('renders client PIT bracket rates without re-scaling percent units', () => {
    const html = renderBelgianRulesSummary(rulesData, ctx);

    // rate: 25 is ALREADY a percent → 25.0%, not 250000.0%.
    expect(html).toContain('+25.0%');
    expect(html).toContain('+40.0%');
    expect(html).toContain('+50.0%');
    expect(html).not.toContain('250000.0%');
    expect(html).not.toContain('400000.0%');
    expect(html).not.toContain('500000.0%');
    // No rate cell anywhere in the section exceeds 100%.
    const pctCells = [...html.matchAll(/class="num">([+-][\d.]+)%/g)].map(m => Number(m[1]));
    expect(pctCells.length).toBeGreaterThan(0);
    for (const p of pctCells) expect(Math.abs(p)).toBeLessThanOrEqual(100);

    // Surrounding currency figures still render, so the section isn't an empty state.
    expect(html).toContain(eur('859.00'));    // 2025 dividend exemption
    expect(html).toContain(eur('1,600.00'));  // shares & other TOB cap
    expect(html).toContain(eur('12,345.67')); // estimated total PIT
  });

  it('falls back to the placeholder when neither table nor PIT data is present', () => {
    expect(renderBelgianRulesSummary(null, ctx)).toContain('No tax table data');
  });

  it('escapes a client-supplied PIT bracket label instead of injecting raw HTML', () => {
    const maliciousData = {
      ...rulesData,
      precomputedPIT: {
        ...rulesData.precomputedPIT,
        brackets: [
          { label: '<script>alert(1)</script>', rate: 25, taxableIncome: 16_320, taxAmount: 4080 },
        ],
      },
    };

    const html = renderBelgianRulesSummary(maliciousData, ctx);

    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
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
