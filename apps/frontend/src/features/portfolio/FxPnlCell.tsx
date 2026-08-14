/**
 * FxPnlCell — the FX-attribution holdings-table cell shared by StocksPage and
 * CryptoPage, which previously carried a byte-identical 16-line inline IIFE.
 *
 * Renders an em-dash for holdings already denominated in the target currency
 * (or without backend FX attribution), otherwise the signed FX gain with the
 * fallback-rate marker.
 */

import { cn } from '@/lib/utils';

interface FxPnlCellProps {
  holding: { originalCurrency?: string; currency?: string };
  /** Backend per-investment summary entry (has the historical-rate FX split). */
  fxInfo?: { fxGain?: number; usedFallbackRate?: boolean };
  targetCurrency: string;
  fmt: (value: number) => string;
  t: (key: string) => string;
}

export function FxPnlCell({ holding, fxInfo, targetCurrency, fmt, t }: FxPnlCellProps) {
  const isForeign = (holding.originalCurrency || holding.currency || 'EUR').toUpperCase() !== targetCurrency.toUpperCase();
  const fxGain = fxInfo?.fxGain;
  if (!isForeign || typeof fxGain !== 'number') {
    return <td className="text-right py-2 px-3 tabular-nums text-muted-foreground">—</td>;
  }
  return (
    <td
      className={cn("text-right py-2 px-3 tabular-nums", fxGain >= 0 ? "amount-gain" : "amount-loss")}
      title={fxInfo?.usedFallbackRate ? t('portfolio.fxFallbackNote') : undefined}
    >
      {fxGain >= 0 ? "+" : ""}{fmt(fxGain)}{fxInfo?.usedFallbackRate ? " ⚠" : ""}
    </td>
  );
}
