/**
 * Shared hook for currency formatting in chart components.
 * Eliminates the repeated `formatCurrency` / `currencySymbol` pattern
 * that was duplicated across every statistics chart component.
 */

import { useAppSettings } from "@/contexts/AppSettingsContext";
import { getCurrencySymbol, numberFormatToLocale } from "@/utils/currency";

export interface ChartCurrencyFormatter {
  formatCurrency: (val: number) => string;
  currencySymbol: string;
  locale: string;
  currency: string;
}

export function useChartCurrencyFormatter(): ChartCurrencyFormatter {
  const { appSettings } = useAppSettings();
  const currency = appSettings.defaultCurrency || "EUR";
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const currencySymbol = getCurrencySymbol(currency);

  const formatCurrency = (val: number) =>
    new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: appSettings.showDecimalPlaces,
      maximumFractionDigits: appSettings.showDecimalPlaces,
    }).format(val);

  return { formatCurrency, currencySymbol, locale, currency };
}
