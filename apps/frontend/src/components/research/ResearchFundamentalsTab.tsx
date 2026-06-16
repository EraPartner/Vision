import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { numberFormatToLocale } from "@/utils/currency";
import { apiClient } from "@/lib/api";
import { ProvenanceBadge } from "@/components/research/ProvenanceBadge";
import { ResearchUnavailableNote } from "@/components/research/ResearchUnavailableNote";

interface ResearchFundamentalsTabProps {
  symbol: string;
  enabled: boolean;
}

function fmtLargeNum(val: number | null | undefined): string {
  if (val == null || isNaN(val)) return "—";
  const abs = Math.abs(val);
  if (abs >= 1e12) return `${(val / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(val / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(val / 1e6).toFixed(2)}M`;
  return String(val);
}

export function ResearchFundamentalsTab({ symbol, enabled }: ResearchFundamentalsTabProps) {
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);

  const fmtPct = useCallback((val: number | null | undefined) =>
    val == null || isNaN(val) ? "—" : `${(val * 100).toFixed(2)}%`, []);
  const fmtRatio = useCallback((val: number | null | undefined) =>
    val == null || isNaN(val) ? "—" : val.toFixed(2), []);

  const { data: result, isFetching } = useQuery({
    queryKey: ["research-fundamentals", symbol],
    queryFn: () => apiClient.getResearchFundamentals(symbol),
    enabled: enabled && !!symbol,
    staleTime: 24 * 60 * 60 * 1000,
  });

  if (isFetching && !result) {
    return (
      <div className="grid gap-2 sm:grid-cols-2">
        {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
      </div>
    );
  }

  if (result?.meta.source === "unavailable") {
    return <ResearchUnavailableNote provider={result.meta.provider} />;
  }

  const f = result?.data;
  if (!f) {
    return <p className="text-sm text-muted-foreground py-4 text-center">{t('research.fundamentals.none')}</p>;
  }

  const currency = f.currency || "USD";
  const fmtPrice = (val: number | null | undefined) =>
    val == null || isNaN(val) ? "—" : new Intl.NumberFormat(locale, {
      style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format(val);

  const rows: { label: string; value: string }[] = [
    { label: t('market.marketCap'), value: fmtLargeNum(f.marketCap) },
    { label: t('market.pe'), value: fmtRatio(f.pe) },
    { label: t('market.forwardPE'), value: fmtRatio(f.forwardPE) },
    { label: t('market.eps'), value: fmtPrice(f.eps) },
    { label: t('market.divYield'), value: fmtPct(f.dividendYield) },
    { label: t('market.beta'), value: fmtRatio(f.beta) },
    { label: t('market.priceBook'), value: fmtRatio(f.priceToBook) },
    { label: t('research.fundamentals.profitMargin'), value: fmtPct(f.profitMargin) },
    { label: t('research.fundamentals.revenue'), value: fmtLargeNum(f.revenue) },
    { label: t('research.fundamentals.roe'), value: fmtPct(f.returnOnEquity) },
  ];

  return (
    <div className="space-y-3">
      <div className="flex justify-end"><ProvenanceBadge meta={result?.meta} /></div>
      <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
        {rows.map(({ label, value }) => (
          <div key={label} className="flex justify-between items-center py-1.5 border-b border-border/50">
            <span className="text-sm text-muted-foreground">{label}</span>
            <span className="text-sm font-medium tabular-nums text-foreground">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
