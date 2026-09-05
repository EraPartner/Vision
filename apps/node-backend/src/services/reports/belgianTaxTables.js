/**
 * Belgian tax bracket data for PDF report generation.
 *
 * Static copy of the year-specific rates. Must remain in sync with
 * apps/frontend/src/lib/belgianTax/constants.ts. Add a new year entry
 * when the government publishes new rates; do not modify past entries.
 */

// The cap is a function of the rate, not the instrument:
// 0.12% → €1,300; 0.35% → €1,600; 1.32% → €4,000.
const TOB_DEFAULT = {
  bonds:             { rate: 0.0012, cap: 1300 },
  sharesAndOther:    { rate: 0.0035, cap: 1600 },
  accumulatingFunds: { rate: 0.0132, cap: 4000 },
  distributingFunds: { rate: 0.0012, cap: 1300 },
};

/**
 * One TOB (beurstaks) instrument bracket.
 * @typedef {{ rate: number; cap: number }} TobBracket
 */

/**
 * A year's Belgian tax bracket data.
 * @typedef {{
 *   year: number,
 *   dividendExemption: number,
 *   dividendWHTRate: number,
 *   capitalGainsTaxRate: number,
 *   capitalGainsTaxExemptionSingle: number,
 *   capitalGainsTaxExemptionMarried: number,
 *   reyndersTaxRate: number,
 *   reyndersBondThreshold: number,
 *   tob: {
 *     bonds: TobBracket,
 *     sharesAndOther: TobBracket,
 *     accumulatingFunds: TobBracket,
 *     distributingFunds: TobBracket,
 *   },
 * }} TaxYearTable
 */

/** @type {Record<number, TaxYearTable>} */
const TABLES = {
  2024: {
    year: 2024,
    dividendExemption: 833,
    dividendWHTRate: 0.30,
    // CGT on financial assets entered force 1 Jan 2026 — 0 for earlier years.
    capitalGainsTaxRate: 0,
    capitalGainsTaxExemptionSingle: 0,
    capitalGainsTaxExemptionMarried: 0,
    reyndersTaxRate: 0.30,
    reyndersBondThreshold: 0.10,
    tob: TOB_DEFAULT,
  },
  2025: {
    year: 2025,
    dividendExemption: 859,
    dividendWHTRate: 0.30,
    capitalGainsTaxRate: 0,
    capitalGainsTaxExemptionSingle: 0,
    capitalGainsTaxExemptionMarried: 0,
    reyndersTaxRate: 0.30,
    reyndersBondThreshold: 0.10,
    tob: TOB_DEFAULT,
  },
  2026: {
    year: 2026,
    // Dividend exemption/WHT and TOB unchanged from 2025 (mirrors TABLE_2026 in
    // constants.ts, which spreads TABLE_2025). The 2026 reform adds the flat 10%
    // capital-gains tax with €10k single / €20k married exemptions.
    dividendExemption: 859,
    dividendWHTRate: 0.30,
    capitalGainsTaxRate: 0.10,
    capitalGainsTaxExemptionSingle: 10_000,
    capitalGainsTaxExemptionMarried: 20_000,
    reyndersTaxRate: 0.30,
    reyndersBondThreshold: 0.10,
    tob: TOB_DEFAULT,
  },
};

const LATEST_YEAR = 2026;

/**
 * Return the tax table for a given year. For an unknown year, returns the
 * latest known table with `approximated: true` so report sections can render a
 * "rates approximated from <latestYear>" note instead of silently using stale numbers.
 *
 * @param {number} year
 * @returns {TaxYearTable & { approximated?: boolean, approximatedFrom?: number }}
 */
export function getTaxTable(year) {
  if (TABLES[year]) return TABLES[year];
  return { ...TABLES[LATEST_YEAR], approximated: true, approximatedFrom: LATEST_YEAR };
}

/**
 * Return all available tax years in ascending order.
 *
 * @returns {number[]}
 */
 function getAvailableYears() {
  return Object.keys(TABLES).map(Number).sort((a, b) => a - b);
}

export { getAvailableYears as __getAvailableYears };
