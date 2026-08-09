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
      // Same guard as the parts sibling below: degrade to the byte-identical
      // bare-number text instead of throwing RangeError into the error
      // boundary, so both formatters on a page fail the same way for the same
      // bad currency/decimals. A throwing constructor caches nothing, so a
      // failure never poisons the cache.
      try {
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
      } catch {
        return `${val}`;
      }
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
      // Mirrors Money.tsx's guard, and like Money's it is deliberately wide:
      // it catches any RangeError the Intl.NumberFormat constructor throws —
      // a malformed-but-non-empty currency code (e.g. "US") or out-of-range
      // fraction digits. Settings-sourced values are schema-validated at the
      // store boundary (storedAppSettingsSchema), but the per-call
      // currency/decimals overrides come from data (holdings, accounts), so
      // the guard stays as defense in depth. Money degrades to a bare number
      // rather than throwing into the error boundary; this path must degrade
      // identically, or the same bad input renders on one surface and crashes
      // the other. A throwing constructor caches nothing, so a failure never
      // poisons the cache.
      try {
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
      } catch {
        return [{ type: "literal" as const, value: `${val}` }];
      }
    },
    [locale, fallbackCurrency, decimalsSetting],
  );
}
