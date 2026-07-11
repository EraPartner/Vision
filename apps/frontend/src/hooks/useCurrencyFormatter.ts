import { useCallback, useRef } from "react";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { numberFormatToLocale } from "@/utils/currency";

export type CurrencyFormatter = (val: number, currency?: string, decimals?: number) => string;

/**
 * Shared currency formatter for the portfolio value-table pages (stocks,
 * savings, crypto, overview). Formats a number as currency using the app's
 * locale (from the number-format setting) and decimal-places setting, caching
 * one `Intl.NumberFormat` per (locale, currency, decimals) so repeated
 * per-row/per-cell formatting doesn't re-instantiate the formatter.
 *
 * `currency` defaults to `defaultCurrency` (or the app's default currency);
 * `decimals` defaults to the `showDecimalPlaces` setting. Pass overrides at the
 * call site for foreign-currency holdings or fixed-precision columns.
 */
export function useCurrencyFormatter(defaultCurrency?: string): CurrencyFormatter {
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const fallbackCurrency = defaultCurrency || appSettings.defaultCurrency || "EUR";
  const decimalsSetting = appSettings.showDecimalPlaces;
  const cacheRef = useRef<Map<string, Intl.NumberFormat>>(new Map());

  return useCallback(
    (val: number, currency: string = fallbackCurrency, decimals: number = decimalsSetting) => {
      const key = `${locale}:${currency}:${decimals}`;
      let formatter = cacheRef.current.get(key);
      if (!formatter) {
        formatter = new Intl.NumberFormat(locale, {
          style: "currency",
          currency,
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        });
        cacheRef.current.set(key, formatter);
      }
      return formatter.format(val);
    },
    [locale, fallbackCurrency, decimalsSetting],
  );
}

export type CurrencyPartsFormatter = (
  val: number,
  opts?: { currency?: string; decimals?: number; signed?: boolean },
) => Intl.NumberFormatPart[];

/**
 * Parts sibling of `useCurrencyFormatter` — same locale/currency/decimals
 * resolution and formatter caching, but returns `formatToParts` output so the
 * value can carry the Money micro-typography (raised symbol, de-emphasized
 * cents) through `<RollingNumber parts>` instead of a plain string.
 * `signed: true` renders a locale-correct leading sign for non-zero amounts.
 */
export function useCurrencyPartsFormatter(defaultCurrency?: string): CurrencyPartsFormatter {
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const fallbackCurrency = defaultCurrency || appSettings.defaultCurrency || "EUR";
  const decimalsSetting = appSettings.showDecimalPlaces;
  const cacheRef = useRef<Map<string, Intl.NumberFormat>>(new Map());

  return useCallback(
    (val: number, opts: { currency?: string; decimals?: number; signed?: boolean } = {}) => {
      const currency = opts.currency ?? fallbackCurrency;
      const decimals = opts.decimals ?? decimalsSetting;
      const signed = opts.signed ?? false;
      const key = `${locale}:${currency}:${decimals}:${signed ? "s" : "a"}`;
      let formatter = cacheRef.current.get(key);
      if (!formatter) {
        formatter = new Intl.NumberFormat(locale, {
          style: "currency",
          currency,
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
          signDisplay: signed ? "exceptZero" : "auto",
        });
        cacheRef.current.set(key, formatter);
      }
      return formatter.formatToParts(val);
    },
    [locale, fallbackCurrency, decimalsSetting],
  );
}
