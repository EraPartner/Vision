/**
 * Provides a stable convertToTarget(amount, fromCurrency?) callback and
 * the ratesToEur map for pages that need direct rate access.
 *
 * Domain totals are computed on the server (ADR-216); this hook is for
 * previews of unsaved input (the command palette's quick FX calculator) and
 * the portfolio and tax pages that have not moved to server figures yet.
 */

import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { exchangeRateKeys } from "@/lib/queryKeys";

export function useCurrencyConverter(targetCurrency: string) {
    // The endpoint's response does not depend on targetCurrency (conversion
    // happens client-side from the rate map), so the key must not include it —
    // keying per display currency cached a duplicate copy of the identical
    // payload for every currency in view. One flat key shares a single cache
    // entry with useExchangeRates and ExchangeRatesPage; staleTime/gcTime match
    // useExchangeRates (the backend scheduler owns refreshes, and the manual
    // refresh invalidates this namespace).
    const {
        data: exchangeData,
        isLoading,
        error,
        refetch,
    } = useQuery({
        queryKey: exchangeRateKeys.all,
        queryFn: () => apiClient.getExchangeRates({ dbOnly: true }),
        staleTime: 10 * 60_000,
        gcTime: 30 * 60_000,
    });

    // Stored rates only: a currency without a stored rate is unavailable
    // here, never converted at a constant (ADR-216).
    const ratesToEur: Record<string, number> = useMemo(
        () => ({
            EUR: 1,
            ...Object.fromEntries(
                (exchangeData?.rates ?? []).map((r) => [
                    r.currency,
                    Number(r.rate_to_eur),
                ]),
            ),
        }),
        [exchangeData],
    );

    const convertToTargetIfAvailable = useCallback(
        (amount: number, fromCurrency?: string): number | undefined => {
            const from = (fromCurrency ?? "EUR").toUpperCase();
            const to = targetCurrency.toUpperCase();
            if (from === to) return amount;
            const rateFrom = ratesToEur[from];
            const rateTo = ratesToEur[to];
            // A missing or zero rate cannot convert (rateTo is the divisor).
            if (
                rateFrom === undefined ||
                rateFrom === 0 ||
                rateTo === undefined ||
                rateTo === 0
            )
                return undefined;
            return (amount * rateFrom) / rateTo;
        },
        [ratesToEur, targetCurrency],
    );

    // Legacy display consumers intentionally retain the original-amount fallback.
    // Aggregates must use convertToTargetIfAvailable so a missing rate cannot blend
    // source and target currencies into one total.
    const convertToTarget = useCallback(
        (amount: number, fromCurrency?: string): number =>
            convertToTargetIfAvailable(amount, fromCurrency) ?? amount,
        [convertToTargetIfAvailable],
    );

    return {
        convertToTarget,
        convertToTargetIfAvailable,
        ratesToEur,
        isLoading,
        error,
        refetch,
    };
}
