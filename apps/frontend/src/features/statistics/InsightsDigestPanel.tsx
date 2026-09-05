import { useState } from "react";
import { useInsightsDigest } from "@/hooks/useInsightsDigest";
import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
    AlertTriangle,
    CheckCircle2,
    ChevronDown,
    ChevronUp,
    CreditCard,
    PieChart,
    Wallet,
    X,
} from "lucide-react";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { cn } from "@/lib/utils";
import { SectionLoader } from "@/components/shared/SectionLoader";
import {
    countUndismissed,
    dismissOutlier,
    dismissSubscription,
    filterDigest,
    loadDismissState,
    type SubscriptionFindingType,
} from "@/lib/insightsDismiss";
import type { CategoryOutlier } from "@/lib/api/info";
import { DeltaPill } from "@/components/shared/DeltaPill";
import {
    useCurrencyFormatter,
    usePercentFormatter,
} from "@/hooks/useCurrencyFormatter";

/**
 * AI-insights digest for the Statistics page (detection layer, no LLM):
 * new subscriptions, subscription price changes, category overspend, and a
 * month-end cash-forecast line. Rows are dismissible client-side via
 * insightsDismiss (localStorage); the cash forecast is a standing read.
 *
 * Structure mirrors RecurringDetectionPanel (glass card, Sparkles title,
 * expand/collapse, X-dismiss rows).
 */
export function InsightsDigestPanel() {
    const formatPercent = usePercentFormatter();
    const formatCurrency = useCurrencyFormatter();
    const { t } = useLanguage();
    const [expanded, setExpanded] = useState(true);
    const [dismissState, setDismissState] = useState(loadDismissState);

    const { data, isLoading, error } = useInsightsDigest();

    const PATTERN_LABELS: Record<string, string> = {
        weekly: t("recurring.pattern.weekly"),
        biweekly: t("recurring.pattern.biweekly"),
        monthly: t("recurring.pattern.monthly"),
        quarterly: t("recurring.pattern.quarterly"),
        yearly: t("recurring.pattern.yearly"),
        custom: t("recurring.pattern.custom"),
    };

    const handleDismissSubscription = (
        recipientId: number,
        findingType: SubscriptionFindingType,
    ) => {
        setDismissState(dismissSubscription(recipientId, findingType));
    };

    const handleDismissOutlier = (outlier: CategoryOutlier) => {
        setDismissState(dismissOutlier(outlier));
    };

    if (isLoading) {
        return (
            <Card>
                <CardHeader className="pb-3">
                    <CardTitle variant="sm">
                        {t("insights.panel.loading")}
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <SectionLoader />
                </CardContent>
            </Card>
        );
    }

    if (error || !data) return null;

    const { newSubscriptions, priceChanges, categoryOutliers, cashForecast } =
        filterDigest(data, dismissState);
    const count = countUndismissed(data, dismissState);

    if (
        newSubscriptions.length === 0 &&
        priceChanges.length === 0 &&
        categoryOutliers.length === 0 &&
        !cashForecast
    ) {
        return (
            <Card className="!border-dashed">
                <CardContent variant="row" className="flex items-center gap-3">
                    <CheckCircle2 className="h-5 w-5 text-accent shrink-0" />
                    <p className="text-sm font-medium text-foreground">
                        {t("insights.panel.empty")}
                    </p>
                </CardContent>
            </Card>
        );
    }

    const forecastAlert = cashForecast?.prominence === "alert";

    return (
        <Card>
            <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                    <div>
                        <CardTitle variant="sm">
                            {t("insights.panel.title")}
                            {count > 0 && (
                                <Badge variant="secondary" className="ml-1">
                                    {count}
                                </Badge>
                            )}
                        </CardTitle>
                        <CardDescription className="mt-1">
                            {t("insights.panel.desc")}
                        </CardDescription>
                    </div>
                    <Button
                        variant="ghost"
                        size="icon"
                        className="icon-touch-target"
                        aria-label={expanded ? "Collapse" : "Expand"}
                        onClick={() => setExpanded(!expanded)}
                    >
                        {expanded ? (
                            <ChevronUp className="h-4 w-4" />
                        ) : (
                            <ChevronDown className="h-4 w-4" />
                        )}
                    </Button>
                </div>
            </CardHeader>
            {expanded && (
                <CardContent className="space-y-5">
                    {newSubscriptions.length > 0 && (
                        <section className="space-y-2">
                            <SectionLabel>
                                {t("insights.panel.newSubscriptions")}
                            </SectionLabel>
                            {newSubscriptions.map((finding) => (
                                <div
                                    key={`new-${finding.recipientId}`}
                                    className="flex items-center gap-3 rounded-lg border bg-card p-3 hover:shadow-sm transition-shadow"
                                >
                                    <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                                        <CreditCard className="h-4 w-4 text-primary" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm font-semibold text-foreground truncate">
                                            {finding.recipientName}
                                        </p>
                                        <Badge
                                            variant="outline"
                                            className="text-xs mt-0.5"
                                        >
                                            {PATTERN_LABELS[
                                                finding.detectedPattern
                                            ] || finding.detectedPattern}
                                        </Badge>
                                    </div>
                                    <span className="text-sm font-bold text-foreground shrink-0">
                                        {formatCurrency(
                                            finding.latestAmount,
                                            finding.currency,
                                        )}
                                    </span>
                                    <DismissButton
                                        label={t("insights.dismiss")}
                                        onClick={() =>
                                            handleDismissSubscription(
                                                finding.recipientId,
                                                "new",
                                            )
                                        }
                                    />
                                </div>
                            ))}
                        </section>
                    )}

                    {priceChanges.length > 0 && (
                        <section className="space-y-2">
                            <SectionLabel>
                                {t("insights.panel.priceChanges")}
                            </SectionLabel>
                            {priceChanges.map((finding) => {
                                const increased =
                                    finding.direction === "increased";
                                return (
                                    <div
                                        key={`price-${finding.recipientId}`}
                                        className="flex items-center gap-3 rounded-lg border bg-card p-3 hover:shadow-sm transition-shadow"
                                    >
                                        <div className="min-w-0 flex-1">
                                            <p className="text-sm font-semibold text-foreground truncate">
                                                {finding.recipientName}
                                            </p>
                                            <div className="flex items-center gap-2 mt-1 flex-wrap">
                                                <span className="text-xs text-muted-foreground line-through">
                                                    {formatCurrency(
                                                        finding.previousAmount,
                                                        finding.currency,
                                                    )}
                                                </span>
                                                <span className="text-xs">
                                                    →
                                                </span>
                                                <span
                                                    className={cn(
                                                        "text-xs font-bold",
                                                        increased
                                                            ? "text-loss"
                                                            : "text-gain",
                                                    )}
                                                >
                                                    {formatCurrency(
                                                        finding.newAmount,
                                                        finding.currency,
                                                    )}
                                                </span>
                                                <DeltaPill
                                                    value={
                                                        finding.percentChange
                                                    }
                                                    invert
                                                    label={formatPercent(
                                                        finding.percentChange,
                                                        {
                                                            digits: 1,
                                                            signed: true,
                                                        },
                                                    )}
                                                />
                                            </div>
                                        </div>
                                        <DismissButton
                                            label={t("insights.dismiss")}
                                            onClick={() =>
                                                handleDismissSubscription(
                                                    finding.recipientId,
                                                    "priceChange",
                                                )
                                            }
                                        />
                                    </div>
                                );
                            })}
                        </section>
                    )}

                    {categoryOutliers.length > 0 && (
                        <section className="space-y-2">
                            <SectionLabel>
                                {t("insights.panel.categoryOverspend")}
                            </SectionLabel>
                            {categoryOutliers.map((outlier) => (
                                <div
                                    key={`outlier-${outlier.categoryId}-${outlier.monthKey}`}
                                    className="flex items-center gap-3 rounded-lg border bg-card p-3 hover:shadow-sm transition-shadow"
                                >
                                    <div className="h-9 w-9 rounded-lg bg-loss/10 flex items-center justify-center shrink-0">
                                        <PieChart className="h-4 w-4 text-loss" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm font-semibold text-foreground truncate">
                                            {outlier.categoryName}
                                        </p>
                                        <p className="text-xs text-muted-foreground mt-0.5">
                                            <span className="font-bold text-loss">
                                                {formatCurrency(
                                                    outlier.currentAmount,
                                                )}
                                            </span>{" "}
                                            {t("insights.panel.thisMonth")}
                                            {" · "}
                                            {t("insights.panel.vsTypical", {
                                                amount: formatCurrency(
                                                    outlier.baselineMedian,
                                                ),
                                            })}
                                        </p>
                                    </div>
                                    <DismissButton
                                        label={t("insights.dismiss")}
                                        onClick={() =>
                                            handleDismissOutlier(outlier)
                                        }
                                    />
                                </div>
                            ))}
                        </section>
                    )}

                    {cashForecast && (
                        <section className="space-y-2">
                            <SectionLabel>
                                {t("insights.panel.cashForecast")}
                            </SectionLabel>
                            <div
                                className={cn(
                                    "flex items-center gap-3 rounded-lg p-3",
                                    forecastAlert
                                        ? "border border-destructive/40 bg-destructive/5"
                                        : "border bg-card",
                                )}
                            >
                                {forecastAlert ? (
                                    <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
                                ) : (
                                    <Wallet className="h-4 w-4 text-muted-foreground shrink-0" />
                                )}
                                <div className="min-w-0 flex-1">
                                    <p
                                        className={cn(
                                            "text-sm",
                                            forecastAlert
                                                ? "font-semibold text-foreground"
                                                : "text-muted-foreground",
                                        )}
                                    >
                                        {t("insights.panel.monthEndProjected", {
                                            amount: formatCurrency(
                                                cashForecast.monthEndProjected,
                                                cashForecast.currency,
                                            ),
                                        })}
                                    </p>
                                    {forecastAlert && (
                                        <p className="text-xs text-destructive mt-0.5">
                                            {cashForecast.crossesZero
                                                ? t(
                                                      "insights.panel.overdraftRisk",
                                                  )
                                                : t(
                                                      "insights.panel.significantMove",
                                                  )}
                                        </p>
                                    )}
                                </div>
                            </div>
                        </section>
                    )}
                </CardContent>
            )}
        </Card>
    );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
    return <p className="eyebrow">{children}</p>;
}

function DismissButton({
    label,
    onClick,
}: {
    label: string;
    onClick: () => void;
}) {
    return (
        <Button
            variant="ghost"
            size="icon"
            className="icon-touch-target shrink-0 text-muted-foreground hover:text-foreground"
            aria-label={label}
            onClick={onClick}
        >
            <X className="h-3.5 w-3.5" />
        </Button>
    );
}
