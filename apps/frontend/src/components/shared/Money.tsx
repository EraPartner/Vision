import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { useCurrencyPartsFormatter } from "@/hooks/useCurrencyFormatter";

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

/**
 * Currency micro-typography: the symbol renders small and raised, decimals
 * (separator + fraction) render at reduced size/opacity — the Apple Wallet
 * treatment. Built on Intl.NumberFormat.formatToParts so it is correct for
 * every locale/currency combination the app supports.
 */
export function Money({
    amount,
    currency,
    fractionDigits,
    signed = false,
    className,
}: MoneyProps) {
    const formatParts = useCurrencyPartsFormatter(currency);

    const parts = useMemo(
        () =>
            formatParts(amount, { currency, decimals: fractionDigits, signed }),
        [amount, currency, formatParts, fractionDigits, signed],
    );

    return (
        <span
            className={cn(
                "inline-flex items-baseline tabular-nums whitespace-nowrap",
                className,
            )}
        >
            {parts.map((part, i) => {
                if (part.type === "currency") {
                    return (
                        <span
                            key={i}
                            className="text-[0.85em] font-medium opacity-85 self-start mt-[0.04em] mr-[0.06em]"
                        >
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
