/**
 * Report-section catalog guards.
 *
 * 1. Pins the section contract in services/reports/sectionCatalog.js: the exact
 *    IDs and default-render order per report type — these tests fail if a
 *    refactor changes what a default report renders or in which order. (The
 *    id->renderer wiring lives in services/reports/index.js and is cross-checked
 *    against this catalog at module load by reconcile(); this test imports only
 *    the dependency-free catalog leaf so it does not pull the heavy Puppeteer/
 *    HTML render graph into the coverage denominator.)
 *
 * 2. Guards the frontend mirror: the export dialog's hand-maintained lists in
 *    apps/frontend/src/components/reports/reportSections.ts must offer exactly
 *    the backend's section IDs in the backend's order. generateReport silently
 *    drops unknown IDs (`requested.filter(id => id in renderers)`), so a
 *    FE↔BE typo silently omits a section from the PDF — this test turns that
 *    silent drift into a build failure.
 */

import { describe, expect, it } from 'vitest';

import {
  FINANCIAL_SECTION_CATALOG,
  PORTFOLIO_SECTION_CATALOG,
  TAX_SECTION_CATALOG,
} from '../src/services/reports/sectionCatalog.js';
import {
  FINANCIAL_SECTIONS,
  PORTFOLIO_SECTIONS,
  TAX_SECTIONS,
} from '../../frontend/src/components/reports/reportSections.ts';

const CASES = [
  { type: 'financial', backend: FINANCIAL_SECTION_CATALOG, frontend: FINANCIAL_SECTIONS },
  { type: 'portfolio', backend: PORTFOLIO_SECTION_CATALOG, frontend: PORTFOLIO_SECTIONS },
  { type: 'tax',       backend: TAX_SECTION_CATALOG,       frontend: TAX_SECTIONS },
];

describe('backend section catalog', () => {
  // Behaviour pin: the exact per-type default order shipped before the
  // catalog consolidation. Reorder deliberately — PDFs change with it.
  const EXPECTED_DEFAULT_ORDER = {
    financial: [
      'executiveSummary',
      'cashflowTrend',
      'categoryBreakdown',
      'topRecipients',
      'bankBalances',
      'rollingAverages',
      'plannedOutlook',
    ],
    portfolio: [
      'portfolioExecutiveSummary',
      'portfolioAllocation',
      'topHoldings',
      'performanceTrend',
      'assetClassDetail',
      'dividendIncome',
    ],
    tax: [
      'taxExecutiveSummary',
      'taxTypeBreakdown',
      'taxByAssetClass',
      'taxMonthlyTrend',
      'topInvestmentsByCost',
      'feeBreakdown',
      'belgianRulesSummary',
    ],
  };

  it.each(CASES)('$type: default sections render in the pinned order', ({ type, backend }) => {
    const defaultIds = backend.filter((s) => s.default).map((s) => s.id);
    expect(defaultIds).toEqual(EXPECTED_DEFAULT_ORDER[type]);
  });

  it.each(CASES)('$type: every section id is unique', ({ backend }) => {
    // Renderer presence/wiring is enforced separately by reconcile() in
    // index.js, which throws at module load if a catalog id has no renderer
    // (or vice-versa); asserting it here would import that heavy render graph.
    const ids = backend.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('frontend mirror (reportSections.ts)', () => {
  it.each(CASES)('$type: export dialog offers exactly the backend IDs, in backend order', ({ backend, frontend }) => {
    expect(frontend.map((s) => s.id)).toEqual(backend.map((s) => s.id));
  });

  it.each(CASES)('$type: every offered section has an export.section.* label key', ({ frontend }) => {
    for (const section of frontend) {
      expect(section.labelKey, `labelKey for "${section.id}"`).toBe(`export.section.${section.id}`);
    }
  });
});
