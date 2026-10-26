/**
 * Portfolio import column-mapping field definitions, shared by the mapper (to
 * render the dropdowns) and the import page (to highlight mapped columns in the
 * FileHeadersPanel). Kept out of the component file so it stays component-only.
 */

import type { PortfolioCustomConfig } from "@/lib/api/portfolioImports";
import type { TranslationKey } from "@/locales/keys";

/** Config keys that name a CSV column (as opposed to options and mappings). */
export type PortfolioColumnKey =
  | "dateColumn"
  | "typeColumn"
  | "symbolColumn"
  | "nameColumn"
  | "unitsColumn"
  | "priceColumn"
  | "amountColumn"
  | "feesColumn"
  | "taxesColumn"
  | "currencyColumn"
  | "fxRateColumn"
  | "noteColumn";

// (config key, i18n label key, required)
export const PORTFOLIO_COLUMN_FIELDS: Array<[PortfolioColumnKey, TranslationKey, boolean]> = [
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

// Saved parser configs come from the server, so a column can be missing or null
// at runtime even though the type promises a string.
function columnText(value: string | null | undefined): string {
  return value ?? "";
}

/** The CSV column `config` maps to `key`, or "" when unmapped. */
export function portfolioColumnValue(
  config: PortfolioCustomConfig,
  key: PortfolioColumnKey,
): string {
  return columnText(config[key]);
}

/** The CSV columns currently mapped by `config` — used to highlight them in the
 * shared FileHeadersPanel. */
export function portfolioMappedColumns(config: PortfolioCustomConfig): string[] {
  return PORTFOLIO_COLUMN_FIELDS.map(([key]) => portfolioColumnValue(config, key)).filter(Boolean);
}
