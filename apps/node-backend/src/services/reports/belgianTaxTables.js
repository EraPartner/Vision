/**
 * Belgian tax bracket data for PDF report generation.
 *
 * Static copy of the year-specific rates. Must remain in sync with
 * apps/frontend/src/lib/belgianTax/constants.ts. Add a new year entry
 * when the government publishes new rates; do not modify past entries.
 */

const TABLES = {
  2024: {
    year: 2024,
    dividendExemption: 833,
    dividendWHTRate: 0.30,
    tob: {
      bonds:             { rate: 0.0012, cap: 1300 },
      sharesAndOther:    { rate: 0.0035, cap: 4000 },
      accumulatingFunds: { rate: 0.0132, cap: 4000 },
      distributingFunds: { rate: 0.0012, cap: 1300 },
    },
  },
  2025: {
    year: 2025,
    dividendExemption: 859,
    dividendWHTRate: 0.30,
    tob: {
      bonds:             { rate: 0.0012, cap: 1300 },
      sharesAndOther:    { rate: 0.0035, cap: 4000 },
      accumulatingFunds: { rate: 0.0132, cap: 4000 },
      distributingFunds: { rate: 0.0012, cap: 1300 },
    },
  },
};

const LATEST_YEAR = 2025;

/**
 * Return the tax table for a given year, falling back to the latest known year.
 *
 * @param {number} year
 * @returns {typeof TABLES[keyof typeof TABLES]}
 */
export function getTaxTable(year) {
  return TABLES[year] ?? TABLES[LATEST_YEAR];
}

/**
 * Return all available tax years in ascending order.
 *
 * @returns {number[]}
 */
export function getAvailableYears() {
  return Object.keys(TABLES).map(Number).sort((a, b) => a - b);
}
