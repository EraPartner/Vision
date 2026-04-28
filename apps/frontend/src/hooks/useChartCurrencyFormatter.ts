/**
 * Shared hook for currency formatting in chart components.
 * Eliminates the repeated `formatCurrency` / `currencySymbol` pattern
 * that was duplicated across every statistics chart component.
 */

import { useAppSettings } from "@/contexts/AppSettingsContext";
import { getCurrencySymbol, numberFormatToLocale, formatCurrencyCompact, type CompactFormatResult } from "@/utils/currency";

export interface ChartCurrencyFormatter {
  formatCurrency: (val: number) => string;
  formatCompact: (val: number) => CompactFormatResult;
  currencySymbol: string;
  locale: string;
  currency: string;
}

export function useChartCurrencyFormatter(): ChartCurrencyFormatter {
  const { appSettings } = useAppSettings();
  const currency = appSettings.defaultCurrency || "EUR";
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const currencySymbol = getCurrencySymbol(currency);
  const fractionDigits = appSettings.showDecimalPlaces;

  const formatCurrency = (val: number) =>
    new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(val);

  const formatCompact = (val: number) =>
    formatCurrencyCompact(val, currency, locale, fractionDigits);

  return { formatCurrency, formatCompact, currencySymbol, locale, currency };
}
