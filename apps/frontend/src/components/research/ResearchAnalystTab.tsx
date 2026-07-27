import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { loadingSurfaceProps } from "@/lib/loadingSurface";
import { TrendingUp, TrendingDown, ArrowUpDown } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { formatDateStringWithAppSettings } from "@/components/shared/dateUtils";
import { cn } from "@/lib/utils";
import { apiClient } from "@/lib/api";
import { ProvenanceBadge } from "@/components/research/ProvenanceBadge";
import { ResearchUnavailableNote } from "@/components/research/ResearchUnavailableNote";

interface ResearchAnalystTabProps {
  symbol: string;
  enabled: boolean;
}

function gradeColor(grade: string): string {
  const g = grade.toLowerCase();
  if (/buy|outperform|overweight|accumulate/.test(g)) return "text-success";
  if (/sell|underperform|underweight|reduce/.test(g)) return "text-destructive";
  return "text-yellow-500 dark:text-yellow-400";
}

export function ResearchAnalystTab({ symbol, enabled }: ResearchAnalystTabProps) {
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();

  const { data: result, isFetching } = useQuery({
    queryKey: ["research-analyst", symbol],
    queryFn: () => apiClient.getResearchAnalyst(symbol),
    enabled: enabled && !!symbol,
    staleTime: 24 * 60 * 60 * 1000,
  });

  if (isFetching && !result) {
    return <div {...loadingSurfaceProps} className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-6 w-full" />)}</div>;
  }

  if (result?.meta.source === "unavailable") {
    return <ResearchUnavailableNote provider={result.meta.provider} />;
  }

  const a = result?.data;
  const consensus = a?.consensus;
  const total = consensus
    ? consensus.strongBuy + consensus.buy + consensus.hold + consensus.sell + consensus.strongSell
    : 0;

  if (!a || total === 0) {
    return <p className="text-sm text-muted-foreground py-4 text-center">{t('research.analyst.none')}</p>;
  }

  const { strongBuy, buy, hold, sell, strongSell } = consensus!;
  const bullPct = (strongBuy + buy) / total;
  const bearPct = (sell + strongSell) / total;
  const verdict =
    bullPct >= 0.6 ? t('market.strongBuy')
      : bullPct >= 0.45 ? t('market.buy')
        : bearPct >= 0.6 ? t('market.strongSell')
          : bearPct >= 0.45 ? t('market.sell')
            : t('market.hold');
  const verdictColor = bullPct >= 0.45 ? "text-success" : bearPct >= 0.45 ? "text-destructive" : "text-yellow-500 dark:text-yellow-400";

  return (
    <div className="space-y-4">
      <div className="flex justify-end"><ProvenanceBadge meta={result?.meta} /></div>
      <div className="flex items-start gap-6">
        <div className="text-center shrink-0">
          <div className={cn("text-2xl font-bold", verdictColor)}>{verdict}</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {total !== 1 ? t('market.analystCountPlural', { n: total }) : t('market.analystCount', { n: total })}
          </div>
        </div>
        <div className="flex-1 space-y-2">
          {([
            { label: t('market.strongBuy'), count: strongBuy, barClass: "bg-success" },
            { label: t('market.buy'), count: buy, barClass: "bg-success/60" },
            { label: t('market.hold'), count: hold, barClass: "bg-yellow-400" },
            { label: t('market.sell'), count: sell, barClass: "bg-destructive/60" },
            { label: t('market.strongSell'), count: strongSell, barClass: "bg-destructive" },
          ]).map(({ label, count, barClass }) => (
            <div key={label} className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground w-20 shrink-0">{label}</span>
              <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                <div className={cn("h-full rounded-full", barClass)} style={{ width: `${(count / total) * 100}%` }} />
              </div>
              <span className="w-4 text-right tabular-nums text-muted-foreground">{count}</span>
            </div>
          ))}
        </div>
      </div>

      {(a.targetMean != null || a.targetLow != null || a.targetHigh != null) && (
        <div className="grid grid-cols-3 gap-3 border-t border-border pt-3 text-center">
          <TargetCell label={t('research.analyst.targetLow')} value={a.targetLow} />
          <TargetCell label={t('research.analyst.targetMean')} value={a.targetMean} />
          <TargetCell label={t('research.analyst.targetHigh')} value={a.targetHigh} />
        </div>
      )}

      {a.recentActions && a.recentActions.length > 0 && (
        <div className="border-t border-border pt-3">
          <p className="text-xs font-medium text-muted-foreground mb-2">{t('market.recentActions')}</p>
          <div className="space-y-2">
            {a.recentActions.map((action, i) => (
              <div key={`${action.date}-${action.firm}-${i}`} className="flex items-center gap-2 text-xs">
                {action.action === "up" || action.action === "upgrade"
                  ? <TrendingUp className="h-3 w-3 text-success shrink-0" />
                  : action.action === "down" || action.action === "downgrade"
                    ? <TrendingDown className="h-3 w-3 text-destructive shrink-0" />
                    : <ArrowUpDown className="h-3 w-3 text-muted-foreground shrink-0" />}
                <span className="text-muted-foreground shrink-0 w-20 tabular-nums whitespace-nowrap">
                  {formatDateStringWithAppSettings(String(action.date), appSettings.dateFormat)}
                </span>
                <span className="font-medium text-foreground truncate flex-1">{action.firm}</span>
                <span className={cn("shrink-0", gradeColor(action.toGrade))}>
                  {action.toGrade}
                  {action.fromGrade && action.fromGrade !== action.toGrade && (
                    <span className="text-muted-foreground font-normal"> ← {action.fromGrade}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TargetCell({ label, value }: { label: string; value: number | null }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold tabular-nums">{value != null ? value.toFixed(2) : "—"}</p>
    </div>
  );
}
