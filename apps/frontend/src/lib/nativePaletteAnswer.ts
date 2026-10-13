import { type QueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { apiClient } from "@/lib/api";
import { type ExchangeRatesData } from "@/lib/api/info";
import { evaluateArithmetic, parseFxQuery } from "@/lib/commandPalette";
import { exchangeRateKeys } from "@/lib/queryKeys";
import {
    formatCurrency,
    NUMBER_FORMATS,
    numberFormatToLocale,
} from "@/utils/currency";

export interface NativePaletteAnswer {
    kind: "fx" | "arithmetic";
    text: string;
}

export type NativePaletteAnswerCallback = (
    query: unknown,
    numberFormat: unknown,
    currency: unknown,
    decimals: unknown,
) => Promise<NativePaletteAnswer | null>;

export interface NativePaletteWindow {
    readonly __VISION_NATIVE_PALETTE__?: boolean;
    readonly __visionNativePaletteAnswer?: NativePaletteAnswerCallback;
}

const requestSchema = z.object({
    query: z.string(),
    numberFormat: z.enum(NUMBER_FORMATS),
    currency: z.string(),
    decimals: z.number().finite(),
});

/** Shares the existing guarded parser and currency formatting with the web palette. */
export async function nativePaletteAnswer(
    query: unknown,
    numberFormat: unknown,
    currency: unknown,
    decimals: unknown,
    readRates: () => Promise<ExchangeRatesData | undefined>,
): Promise<NativePaletteAnswer | null> {
    const parsed = requestSchema.safeParse({ query, numberFormat, currency, decimals });
    if (!parsed.success) return null;
    const request = parsed.data;
    const trimmed = request.query.trim();
    const locale = numberFormatToLocale(request.numberFormat);
    const fx = parseFxQuery(trimmed, request.numberFormat);
    if (!fx) {
        const value = evaluateArithmetic(trimmed, request.numberFormat);
        return value === null
            ? null
            : {
                  kind: "arithmetic",
                  text: new Intl.NumberFormat(locale, {
                      maximumFractionDigits: 6,
                  }).format(value),
              };
    }
    const target = fx.to ?? (request.currency || "EUR");
    if (fx.from === target) return null;
    // useCurrencyConverter deliberately keeps the source amount when a rate is absent.
    const data = await readRates().catch(() => undefined);
    const rates: Record<string, number> = {
        ...data?.fallback_rates,
        EUR: 1,
        ...Object.fromEntries(
            (data?.rates ?? []).map((rate) => [rate.currency, Number(rate.rate_to_eur)]),
        ),
    };
    const fromRate = rates[fx.from.toUpperCase()];
    const toRate = rates[target.toUpperCase()];
    const value = fromRate && toRate ? (fx.amount * fromRate) / toRate : fx.amount;
    if (!Number.isFinite(value)) return null;
    const text = formatCurrency(value, target, locale, request.decimals);
    return {
        kind: "fx",
        text: text === `${value}` ? `${value.toFixed(2)} ${target}` : text,
    };
}

interface Registration {
    queryClient: QueryClient;
    active: boolean;
}

const registrations = new WeakMap<NativePaletteWindow, Set<Registration>>();

/** An immutable entry point with removable owners supports React StrictMode remounts. */
export function registerNativePaletteAnswerBridge(
    queryClient: QueryClient,
    target: NativePaletteWindow = window as NativePaletteWindow,
): () => void {
    if (target.__VISION_NATIVE_PALETTE__ !== true) return () => {};
    let owners = registrations.get(target);
    if (!owners) {
        if (Object.getOwnPropertyDescriptor(target, "__visionNativePaletteAnswer"))
            return () => {};
        owners = new Set();
        const fixedOwners = owners;
        const callback: NativePaletteAnswerCallback = async (query, format, currency, decimals) => {
            const owner = [...fixedOwners].at(-1);
            if (!owner?.active) return null;
            const answer = await nativePaletteAnswer(query, format, currency, decimals, async () => {
                try {
                    return await owner.queryClient.fetchQuery({
                        queryKey: exchangeRateKeys.all,
                        queryFn: () => apiClient.getExchangeRates({ dbOnly: true }),
                        staleTime: 10 * 60_000,
                        gcTime: 30 * 60_000,
                    });
                } catch {
                    return owner.queryClient.getQueryData<ExchangeRatesData>(exchangeRateKeys.all);
                }
            });
            return owner.active ? answer : null;
        };
        Object.defineProperty(target, "__visionNativePaletteAnswer", {
            value: callback,
            writable: false,
            configurable: false,
            enumerable: false,
        });
        registrations.set(target, owners);
    }
    const owner = { queryClient, active: true };
    owners.add(owner);
    return () => {
        owner.active = false;
        owners.delete(owner);
    };
}
