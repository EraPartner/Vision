/**
 * Portfolio import column-mapping field definitions, shared by the mapper (to
 * render the dropdowns) and the import page (to highlight mapped columns in the
 * FileHeadersPanel). Kept out of the component file so it stays component-only.
 */

import type { PortfolioCustomConfig } from "@/lib/api/portfolioImports";

// (config key, i18n label key, required)
export const PORTFOLIO_COLUMN_FIELDS: Array<[keyof PortfolioCustomConfig, string, boolean]> = [
  ["dateColumn", "portfolioImport.col.date", true],
  ["typeColumn", "portfolioImport.col.type", false],
  ["symbolColumn", "portfolioImport.col.symbol", false],
  ["nameColumn", "portfolioImport.col.name", false],
  ["unitsColumn", "portfolioImport.col.units", false],
  ["priceColumn", "portfolioImport.col.price", false],
  ["amountColumn", "portfolioImport.col.amount", false],
  ["feesColumn", "portfolioImport.col.fees", false],
  ["taxesColumn", "portfolioImport.col.taxes", false],
  ["currencyColumn", "portfolioImport.col.currency", false],
  ["fxRateColumn", "portfolioImport.col.fxRate", false],
  ["noteColumn", "portfolioImport.col.note", false],
];

/** The CSV columns currently mapped by `config` — used to highlight them in the
 * shared FileHeadersPanel. */
export function portfolioMappedColumns(config: PortfolioCustomConfig): string[] {
  return PORTFOLIO_COLUMN_FIELDS.map(([key]) => String(config[key] ?? "")).filter(Boolean);
}
