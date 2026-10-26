import { useCallback, useMemo } from "react";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import {
    formatCurrency,
    formatCurrencyParts,
    formatPercent,
    DEFAULT_CURRENCY,
    numberFormatToLocale,
    type PercentFormatOptions,
    currencyOr,
} from "@/utils/currency";
import type { CurrencyCode } from "@vision/types/brands";

export interface CurrencyFormatterOptions {
    currency?: string | undefined;
    decimals?: number | undefined;
    /** Render a locale-correct sign for non-zero amounts. */
    signed?: boolean | undefined;
}

export type CurrencyFormatter = (
    val: number,
    options?: CurrencyFormatterOptions,
) => string;

/**
 * `currency` is the settings currency, a `CurrencyCode`, unless the caller
 * passed its own display currency, which may be any label Intl accepts.
 */
export interface ResolvedCurrencyFormatSettings<
    TCurrency extends string = CurrencyCode,
> {
    currency: TCurrency;
    locale: string;
    decimals: number;
}

export function useCurrencyFormatSettings(): ResolvedCurrencyFormatSettings;
export function useCurrencyFormatSettings(
    defaultCurrency: string | undefined,
): ResolvedCurrencyFormatSettings<string>;
export function useCurrencyFormatSettings(
    defaultCurrency?: string,
): ResolvedCurrencyFormatSettings<string> {
    const { appSettings } = useAppSettings();
    return useMemo(
        () => ({
            currency:
                defaultCurrency ||
                currencyOr(appSettings.defaultCurrency, DEFAULT_CURRENCY),
            locale: numberFormatToLocale(appSettings.numberFormat),
            decimals: appSettings.showDecimalPlaces,
        }),
        [
            appSettings.defaultCurrency,
            appSettings.numberFormat,
            appSettings.showDecimalPlaces,
            defaultCurrency,
        ],
    );
}

/**
 * Shared currency formatter for the portfolio value-table pages (stocks,
 * savings, crypto, overview). Formats a number as currency using the app's
 * locale (from the number-format setting) and decimal-places setting. The pure
 * currency utility owns the shared formatter cache, so every rendered surface
 * uses the same construction and fallback contract.
 *
 * `currency` defaults to `defaultCurrency` (or the app's default currency);
 * `decimals` defaults to the `showDecimalPlaces` setting. Pass the options form
 * when a display also needs the house `signed: true` / `exceptZero` convention.
 */
export function useCurrencyFormatter(
    defaultCurrency?: string,
): CurrencyFormatter {
    const {
        currency: fallbackCurrency,
        locale,
        decimals: decimalsSetting,
    } = useCurrencyFormatSettings(defaultCurrency);

    return useCallback(
        (val: number, options: CurrencyFormatterOptions = {}) => {
            const currency = options.currency ?? fallbackCurrency;
            const resolvedDecimals = options.decimals ?? decimalsSetting;
            const signed = options.signed ?? false;
            // Same guard as the parts sibling below: degrade to the byte-identical
            // bare-number text instead of throwing RangeError into the error
            // boundary, so both formatters on a page fail the same way for the same
            // bad currency/decimals. A throwing constructor caches nothing, so a
            // failure never poisons the cache.
            return formatCurrency(
                val,
                currency,
                locale,
                resolvedDecimals,
                signed,
            );
        },
        [locale, fallbackCurrency, decimalsSetting],
    );
}

export type CurrencyPartsFormatter = (
    val: number,
    opts?: {
        currency?: string | undefined;
        decimals?: number | undefined;
        signed?: boolean | undefined;
    },
) => Intl.NumberFormatPart[];

/**
 * Parts sibling of `useCurrencyFormatter` — same locale/currency/decimals
 * resolution and formatter caching, but returns `formatToParts` output so the
 * value can carry the Money micro-typography (raised symbol, de-emphasized
 * cents) through `<RollingNumber parts>` instead of a plain string.
 * `signed: true` renders a locale-correct leading sign for non-zero amounts.
 */
export function useCurrencyPartsFormatter(
    defaultCurrency?: string,
): CurrencyPartsFormatter {
    const {
        currency: fallbackCurrency,
        locale,
        decimals: decimalsSetting,
    } = useCurrencyFormatSettings(defaultCurrency);

    return useCallback(
        (
            val: number,
            opts: {
                currency?: string | undefined;
                decimals?: number | undefined;
                signed?: boolean | undefined;
            } = {},
        ) => {
            const currency = opts.currency ?? fallbackCurrency;
            const decimals = opts.decimals ?? decimalsSetting;
            const signed = opts.signed ?? false;
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
            return formatCurrencyParts(val, currency, locale, decimals, signed);
        },
        [locale, fallbackCurrency, decimalsSetting],
    );
}

export type PercentFormatterOptions = Omit<PercentFormatOptions, "locale">;
export type PercentFormatter = (
    value: number,
    options?: PercentFormatterOptions,
) => string;

export function usePercentFormatter(): PercentFormatter {
    const { locale } = useCurrencyFormatSettings();
    return useCallback(
        (value: number, options: PercentFormatterOptions = {}) =>
            formatPercent(value, { ...options, locale }),
        [locale],
    );
}
