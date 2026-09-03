/**
 * Shared hook for currency formatting in chart components.
 * Eliminates the repeated `formatCurrency` / `currencySymbol` pattern
 * that was duplicated across every statistics chart component.
 */

import { useCallback, useMemo } from "react";
import {
    useCurrencyFormatter,
    useCurrencyFormatSettings,
} from "@/hooks/useCurrencyFormatter";
import {
    formatCurrencyAxisCompact,
    formatCurrencyCompact,
    getCurrencySymbol,
    type CompactFormatResult,
} from "@/utils/currency";

export interface ChartCurrencyFormatter {
    formatCurrency: (val: number) => string;
    formatCompact: (val: number, signed?: boolean) => CompactFormatResult;
    formatAxisCompact: (val: number) => string;
    currencySymbol: string;
    locale: string;
    currency: string;
}

export function useChartCurrencyFormatter(): ChartCurrencyFormatter {
    const {
        currency,
        locale,
        decimals: fractionDigits,
    } = useCurrencyFormatSettings();
    const currencyFormatter = useCurrencyFormatter(currency);
    const currencySymbol = getCurrencySymbol(currency);

    const formatCurrency = useCallback(
        (val: number) => currencyFormatter(val),
        [currencyFormatter],
    );

    const formatCompact = useCallback(
        (val: number, signed = false) =>
            formatCurrencyCompact(
                val,
                currency,
                locale,
                fractionDigits,
                signed,
            ),
        [currency, locale, fractionDigits],
    );

    const formatAxisCompact = useCallback(
        (val: number) => formatCurrencyAxisCompact(val, currency, locale),
        [currency, locale],
    );

    return useMemo(
        () => ({
            formatCurrency,
            formatCompact,
            formatAxisCompact,
            currencySymbol,
            locale,
            currency,
        }),
        [
            formatCurrency,
            formatCompact,
            formatAxisCompact,
            currencySymbol,
            locale,
            currency,
        ],
    );
}
