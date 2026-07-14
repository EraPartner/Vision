import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { numberFormatToLocale } from "@/utils/currency";

interface MoneyProps {
    amount: number;
    /** ISO currency code; falls back to the app's default currency. */
    currency?: string;
    /** Override fraction digits; falls back to the app's showDecimalPlaces. */
    fractionDigits?: number;
    /** Render an explicit leading + for positive amounts. */
    signed?: boolean;
    className?: string;
}

// Intl.NumberFormat construction is ~50-200µs; a Money instance renders 30-50
// times per virtual-scroll batch. Cache one formatter per distinct
// locale/currency/digits/signed combination so only formatToParts(amount) runs
// per render.
const currencyFormatterCache = new Map<string, Intl.NumberFormat>();

function getCurrencyFormatter(
    locale: string,
    currency: string,
    digits: number,
    signed: boolean,
): Intl.NumberFormat {
    const key = `${locale}:${currency}:${digits}:${signed}`;
    let fmt = currencyFormatterCache.get(key);
    if (!fmt) {
        fmt = new Intl.NumberFormat(locale, {
            style: "currency",
            currency,
            minimumFractionDigits: digits,
            maximumFractionDigits: digits,
            signDisplay: signed ? "exceptZero" : "auto",
        });
        currencyFormatterCache.set(key, fmt);
    }
    return fmt;
}

/**
 * Currency micro-typography: the symbol renders small and raised, decimals
 * (separator + fraction) render at reduced size/opacity — the Apple Wallet
 * treatment. Built on Intl.NumberFormat.formatToParts so it is correct for
 * every locale/currency combination the app supports.
 */
export function Money({ amount, currency, fractionDigits, signed = false, className }: MoneyProps) {
    const { appSettings } = useAppSettings();
    const resolvedCurrency = currency || appSettings.defaultCurrency || "EUR";
    const locale = numberFormatToLocale(appSettings.numberFormat);
    const digits = fractionDigits ?? appSettings.showDecimalPlaces ?? 2;

    const parts = useMemo(() => {
        try {
            return getCurrencyFormatter(locale, resolvedCurrency, digits, signed).formatToParts(amount);
        } catch {
            return [{ type: "literal" as const, value: `${amount}` }];
        }
    }, [amount, resolvedCurrency, locale, digits, signed]);

    return (
        <span className={cn("inline-flex items-baseline tabular-nums whitespace-nowrap", className)}>
            {parts.map((part, i) => {
                if (part.type === "currency") {
                    return (
                        <span key={i} className="text-[0.85em] font-medium opacity-85 self-start mt-[0.04em] mr-[0.06em]">
                            {part.value}
                        </span>
                    );
                }
                if (part.type === "decimal" || part.type === "fraction") {
                    return (
                        <span key={i} className="text-[0.88em] opacity-75">
                            {part.value}
                        </span>
                    );
                }
                return <span key={i}>{part.value}</span>;
            })}
        </span>
    );
}
