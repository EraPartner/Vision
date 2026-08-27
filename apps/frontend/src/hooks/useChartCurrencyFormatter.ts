/**
 * Shared hook for currency formatting in chart components.
 * Eliminates the repeated `formatCurrency` / `currencySymbol` pattern
 * that was duplicated across every statistics chart component.
 */

import { useCallback, useMemo } from "react";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import {
  formatCurrencyAxisCompact,
  formatCurrencyCompact,
  getCurrencySymbol,
  numberFormatToLocale,
  type CompactFormatResult,
} from "@/utils/currency";

export interface ChartCurrencyFormatter {
  formatCurrency: (val: number) => string;
  formatCompact: (val: number) => CompactFormatResult;
  formatAxisCompact: (val: number) => string;
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

  // A single Intl.NumberFormat instance reused across every call — these
  // formatters run once per axis tick / table cell, so rebuilding the
  // (relatively expensive) formatter per call is wasteful.
  const currencyNumberFormat = useMemo(
    () => {
      try {
        return new Intl.NumberFormat(locale, {
          style: "currency",
          currency,
          minimumFractionDigits: fractionDigits,
          maximumFractionDigits: fractionDigits,
        });
      } catch {
        return undefined;
      }
    },
    [locale, currency, fractionDigits],
  );

  const formatCurrency = useCallback(
    (val: number) => currencyNumberFormat?.format(val) ?? `${val}`,
    [currencyNumberFormat],
  );

  const formatCompact = useCallback(
    (val: number) => formatCurrencyCompact(val, currency, locale, fractionDigits),
    [currency, locale, fractionDigits],
  );

  const formatAxisCompact = useCallback(
    (val: number) => formatCurrencyAxisCompact(val, currency, locale),
    [currency, locale],
  );

  return useMemo(
    () => ({ formatCurrency, formatCompact, formatAxisCompact, currencySymbol, locale, currency }),
    [formatCurrency, formatCompact, formatAxisCompact, currencySymbol, locale, currency],
  );
}
