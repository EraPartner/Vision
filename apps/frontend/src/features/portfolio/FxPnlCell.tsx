/**
 * FxPnlCell — the FX-attribution holdings-table cell shared by StocksPage and
 * CryptoPage, which previously carried a byte-identical 16-line inline IIFE.
 *
 * Renders an em-dash for holdings already denominated in the target currency
 * (or without backend FX attribution), otherwise the signed FX gain with the
 * fallback-rate marker.
 */

import { cn } from "@/lib/utils";
import { Money } from "@/components/shared/Money";
import { TouchDisclosure } from "@/components/shared/TouchDisclosure";

interface FxPnlCellProps {
    holding: { originalCurrency?: string; currency?: string };
    /** Backend per-investment summary entry (has the historical-rate FX split). */
    fxInfo?: { fxGain?: number; usedFallbackRate?: boolean };
    targetCurrency: string;
    t: (key: string) => string;
}

export function FxPnlCell({
    holding,
    fxInfo,
    targetCurrency,
    t,
}: FxPnlCellProps) {
    const isForeign =
        (
            holding.originalCurrency ||
            holding.currency ||
            "EUR"
        ).toUpperCase() !== targetCurrency.toUpperCase();
    const fxGain = fxInfo?.fxGain;
    if (!isForeign || typeof fxGain !== "number") {
        return (
            <td className="text-right py-2 px-3 tabular-nums text-muted-foreground">
                —
            </td>
        );
    }
    return (
        <td
            className={cn(
                "text-right py-2 px-3 tabular-nums",
                fxGain >= 0 ? "text-gain" : "text-loss",
            )}
        >
            <Money amount={fxGain} currency={targetCurrency} signed />
            {fxInfo?.usedFallbackRate ? (
                <TouchDisclosure
                    label={t("portfolio.fxFallbackNote")}
                    content={t("portfolio.fxFallbackNote")}
                    className="ml-1 text-warning [@media(pointer:coarse)]:min-h-10 [@media(pointer:coarse)]:min-w-10 [@media(pointer:coarse)]:justify-center"
                >
                    <span aria-hidden="true">⚠</span>
                </TouchDisclosure>
            ) : null}
        </td>
    );
}
