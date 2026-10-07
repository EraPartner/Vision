import { Skeleton } from "@/components/ui/skeleton";
import { List, ListRow } from "@/components/ui/list";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import { TrendingUp, TrendingDown, ArrowUpDown } from "lucide-react";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { formatDateStringWithAppSettings } from "@/lib/dateUtils";
import { cn } from "@/lib/utils";
import { ProvenanceBadge } from "@/features/research/ProvenanceBadge";
import { ResearchUnavailableNote } from "@/features/research/ResearchUnavailableNote";
import { useResearchAnalystQuery } from "./useResearchQueries";

interface ResearchAnalystTabProps {
    symbol: string;
    enabled: boolean;
}

function gradeColor(grade: string): string {
    const g = grade.toLowerCase();
    if (/buy|outperform|overweight|accumulate/.test(g)) return "text-success";
    if (/sell|underperform|underweight|reduce/.test(g))
        return "text-destructive";
    return "text-warning";
}

export function ResearchAnalystTab({
    symbol,
    enabled,
}: ResearchAnalystTabProps) {
    const { t } = useLanguage();
    const loadingSurfaceProps = useLoadingSurfaceProps();
    const { appSettings } = useAppSettings();

    const { data: result, isFetching } = useResearchAnalystQuery(
        symbol,
        enabled,
    );

    if (isFetching && !result) {
        return (
            <div {...loadingSurfaceProps} className="space-y-3">
                {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-6 w-full" />
                ))}
            </div>
        );
    }

    if (result?.meta.source === "unavailable") {
        return <ResearchUnavailableNote provider={result.meta.provider} />;
    }

    const a = result?.data;
    const consensus = a?.consensus;
    const total = consensus
        ? consensus.strongBuy +
          consensus.buy +
          consensus.hold +
          consensus.sell +
          consensus.strongSell
        : 0;

    if (!a || total === 0) {
        return (
            <p className="py-4 text-center type-callout text-label-secondary">
                {t("research.analyst.none")}
            </p>
        );
    }

    const { strongBuy, buy, hold, sell, strongSell } = consensus!;
    const bullPct = (strongBuy + buy) / total;
    const bearPct = (sell + strongSell) / total;
    const verdict =
        bullPct >= 0.6
            ? t("market.strongBuy")
            : bullPct >= 0.45
              ? t("market.buy")
              : bearPct >= 0.6
                ? t("market.strongSell")
                : bearPct >= 0.45
                  ? t("market.sell")
                  : t("market.hold");
    const verdictColor =
        bullPct >= 0.45
            ? "text-success"
            : bearPct >= 0.45
              ? "text-destructive"
              : "text-warning";

    return (
        <div className="space-y-5">
            <div className="flex justify-end">
                <ProvenanceBadge meta={result?.meta} />
            </div>
            <div className="flex items-start gap-6">
                <div className="shrink-0 text-center">
                    <p className={cn("type-title-1", verdictColor)}>
                        {verdict}
                    </p>
                    <p className="mt-0.5 type-footnote text-label-secondary">
                        {total !== 1
                            ? t("market.analystCountPlural", { n: total })
                            : t("market.analystCount", { n: total })}
                    </p>
                </div>
                <div className="flex-1 space-y-2">
                    {[
                        {
                            label: t("market.strongBuy"),
                            count: strongBuy,
                            barClass: "bg-success",
                        },
                        {
                            label: t("market.buy"),
                            count: buy,
                            barClass: "bg-success/60",
                        },
                        {
                            label: t("market.hold"),
                            count: hold,
                            barClass: "bg-warning",
                        },
                        {
                            label: t("market.sell"),
                            count: sell,
                            barClass: "bg-destructive/60",
                        },
                        {
                            label: t("market.strongSell"),
                            count: strongSell,
                            barClass: "bg-destructive",
                        },
                    ].map(({ label, count, barClass }) => (
                        <div
                            key={label}
                            className="flex items-center gap-2 type-footnote"
                        >
                            <span className="w-20 shrink-0 text-label-secondary">
                                {label}
                            </span>
                            <div className="h-2 flex-1 overflow-hidden rounded-full bg-foreground/[0.08]">
                                <div
                                    className={cn(
                                        "h-full rounded-full",
                                        barClass,
                                    )}
                                    style={{
                                        width: `${(count / total) * 100}%`,
                                    }}
                                />
                            </div>
                            <span className="w-4 text-right tabular-nums text-label-secondary">
                                {count}
                            </span>
                        </div>
                    ))}
                </div>
            </div>

            {(a.targetMean != null ||
                a.targetLow != null ||
                a.targetHigh != null) && (
                <div className="grid grid-cols-3 gap-3 border-t border-border/50 pt-4 text-center">
                    <TargetCell
                        label={t("research.analyst.targetLow")}
                        value={a.targetLow}
                    />
                    <TargetCell
                        label={t("research.analyst.targetMean")}
                        value={a.targetMean}
                    />
                    <TargetCell
                        label={t("research.analyst.targetHigh")}
                        value={a.targetHigh}
                    />
                </div>
            )}

            {a.recentActions && a.recentActions.length > 0 && (
                <section className="space-y-2">
                    <h3 className="type-headline text-foreground">
                        {t("market.recentActions")}
                    </h3>
                    <List>
                        {a.recentActions.map((action, i) => (
                            <ListRow
                                key={`${action.date}-${action.firm}-${i}`}
                                leading={
                                    action.action === "up" ||
                                    action.action === "upgrade" ? (
                                        <TrendingUp className="text-success" />
                                    ) : action.action === "down" ||
                                      action.action === "downgrade" ? (
                                        <TrendingDown className="text-destructive" />
                                    ) : (
                                        <ArrowUpDown />
                                    )
                                }
                                title={action.firm}
                                subtitle={formatDateStringWithAppSettings(
                                    String(action.date),
                                    appSettings.dateFormat,
                                )}
                                trailing={
                                    <span
                                        className={cn(
                                            "type-callout",
                                            gradeColor(action.toGrade),
                                        )}
                                    >
                                        {action.toGrade}
                                        {action.fromGrade &&
                                            action.fromGrade !==
                                                action.toGrade && (
                                                <span className="text-label-secondary">
                                                    {" "}
                                                    ← {action.fromGrade}
                                                </span>
                                            )}
                                    </span>
                                }
                            />
                        ))}
                    </List>
                </section>
            )}
        </div>
    );
}

function TargetCell({ label, value }: { label: string; value: number | null }) {
    return (
        <div>
            <p className="type-caption text-label-tertiary">{label}</p>
            <p className="type-title-3 tabular-nums text-foreground">
                {value != null ? value.toFixed(2) : "—"}
            </p>
        </div>
    );
}
