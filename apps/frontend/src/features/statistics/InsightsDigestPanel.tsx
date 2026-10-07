import { useId, useState } from "react";
import {
    useDismissInsight,
    useInsightsDigest,
} from "@/hooks/useInsightsDigest";
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
import { List, ListRow } from "@/components/ui/list";
import type { CategoryOutlier } from "@/lib/api/info";
import { DeltaPill } from "@/components/shared/DeltaPill";
import {
    useCurrencyFormatter,
    usePercentFormatter,
} from "@/hooks/useCurrencyFormatter";

/**
 * AI-insights digest for the Statistics page (detection layer, no LLM):
 * new subscriptions, subscription price changes, category overspend, and a
 * month-end cash-forecast line. Row dismissals are persisted through the
 * server-backed insights API; the cash forecast is a standing read.
 *
 * Structure mirrors RecurringDetectionPanel (glass card, Sparkles title,
 * expand/collapse, X-dismiss rows).
 */
export function InsightsDigestPanel() {
    const formatPercent = usePercentFormatter();
    const formatCurrency = useCurrencyFormatter();
    const { t } = useLanguage();
    const [expanded, setExpanded] = useState(false);
    const findingsId = useId();
    const { data, isLoading, error } = useInsightsDigest();
    const dismissMutation = useDismissInsight();

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
        findingType: "new" | "priceChange",
    ) => {
        dismissMutation.mutate({
            kind:
                findingType === "new"
                    ? "subscription_new"
                    : "subscription_price_change",
            recipient_id: recipientId,
        });
    };

    const handleDismissOutlier = (outlier: CategoryOutlier) => {
        dismissMutation.mutate({
            kind: "category_outlier",
            category_id: outlier.categoryId,
            month_key: outlier.monthKey,
        });
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

    const {
        subscriptionCreep: { new: newSubscriptions, priceChanges },
        categoryOutliers,
        cashForecast,
    } = data;
    const count =
        newSubscriptions.length +
        priceChanges.length +
        categoryOutliers.length +
        (cashForecast?.prominence === "alert" ? 1 : 0);

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
                    <p className="type-body font-medium text-foreground">
                        {t("insights.panel.empty")}
                    </p>
                </CardContent>
            </Card>
        );
    }

    const findingCount =
        newSubscriptions.length + priceChanges.length + categoryOutliers.length;
    const sections = [
        {
            label: t("insights.panel.newSubscriptions"),
            count: newSubscriptions.length,
        },
        { label: t("insights.panel.priceChanges"), count: priceChanges.length },
        {
            label: t("insights.panel.categoryOverspend"),
            count: categoryOutliers.length,
        },
    ].filter((section) => section.count > 0);
    const forecastAlert = cashForecast?.prominence === "alert";

    return (
        <Card>
            <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center justify-between gap-3">
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
                    {findingCount > 0 && (
                        <Button
                            variant="ghost"
                            size="sm"
                            className="gap-2"
                            aria-expanded={expanded}
                            aria-controls={findingsId}
                            onClick={() => setExpanded(!expanded)}
                        >
                            {t(
                                expanded
                                    ? "insights.panel.hideDetails"
                                    : "insights.panel.showDetails",
                            )}
                            {expanded ? (
                                <ChevronUp className="h-4 w-4" />
                            ) : (
                                <ChevronDown className="h-4 w-4" />
                            )}
                        </Button>
                    )}
                </div>
            </CardHeader>
            <CardContent className="space-y-4">
                {!expanded && sections.length > 0 && (
                    <ul className="flex flex-wrap gap-x-5 gap-y-2 type-callout text-label-secondary">
                        {sections.map((section) => (
                            <li
                                key={section.label}
                                className="flex items-center gap-2"
                            >
                                <span className="type-body font-medium tabular-nums text-foreground">
                                    {section.count}
                                </span>
                                {section.label}
                            </li>
                        ))}
                    </ul>
                )}
                <div id={findingsId} hidden={!expanded} className="space-y-5">
                    {newSubscriptions.length > 0 && (
                        <section className="space-y-2">
                            <SectionLabel>
                                {t("insights.panel.newSubscriptions")}
                            </SectionLabel>
                            <List>
                                {newSubscriptions.map((finding) => (
                                    <ListRow
                                        key={`new-${finding.recipientId}`}
                                        leading={<CreditCard />}
                                        title={finding.recipientName}
                                        subtitle={
                                            PATTERN_LABELS[
                                                finding.detectedPattern
                                            ] || finding.detectedPattern
                                        }
                                        trailing={
                                            <>
                                                <span className="font-medium text-foreground">
                                                    {formatCurrency(
                                                        finding.latestAmount,
                                                        {
                                                            currency:
                                                                finding.currency,
                                                        },
                                                    )}
                                                </span>
                                                <DismissButton
                                                    label={t(
                                                        "insights.dismissFinding",
                                                        {
                                                            kind: t(
                                                                "insights.panel.newSubscriptions",
                                                            ),
                                                            name: finding.recipientName,
                                                        },
                                                    )}
                                                    onClick={() =>
                                                        handleDismissSubscription(
                                                            finding.recipientId,
                                                            "new",
                                                        )
                                                    }
                                                />
                                            </>
                                        }
                                    />
                                ))}
                            </List>
                        </section>
                    )}

                    {priceChanges.length > 0 && (
                        <section className="space-y-2">
                            <SectionLabel>
                                {t("insights.panel.priceChanges")}
                            </SectionLabel>
                            <List>
                                {priceChanges.map((finding) => {
                                    const increased =
                                        finding.direction === "increased";
                                    return (
                                        <ListRow
                                            key={`price-${finding.recipientId}`}
                                            title={finding.recipientName}
                                            subtitle={
                                                <span className="inline-flex flex-wrap items-center gap-2">
                                                    <span className="line-through">
                                                        {formatCurrency(
                                                            finding.previousAmount,
                                                            {
                                                                currency:
                                                                    finding.currency,
                                                            },
                                                        )}
                                                    </span>
                                                    <span aria-hidden="true">
                                                        →
                                                    </span>
                                                    <span
                                                        className={cn(
                                                            "font-medium",
                                                            increased
                                                                ? "text-loss"
                                                                : "text-gain",
                                                        )}
                                                    >
                                                        {formatCurrency(
                                                            finding.newAmount,
                                                            {
                                                                currency:
                                                                    finding.currency,
                                                            },
                                                        )}
                                                    </span>
                                                </span>
                                            }
                                            trailing={
                                                <>
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
                                                    <DismissButton
                                                        label={t(
                                                            "insights.dismissFinding",
                                                            {
                                                                kind: t(
                                                                    "insights.panel.priceChanges",
                                                                ),
                                                                name: finding.recipientName,
                                                            },
                                                        )}
                                                        onClick={() =>
                                                            handleDismissSubscription(
                                                                finding.recipientId,
                                                                "priceChange",
                                                            )
                                                        }
                                                    />
                                                </>
                                            }
                                        />
                                    );
                                })}
                            </List>
                        </section>
                    )}

                    {categoryOutliers.length > 0 && (
                        <section className="space-y-2">
                            <SectionLabel>
                                {t("insights.panel.categoryOverspend")}
                            </SectionLabel>
                            <List>
                                {categoryOutliers.map((outlier) => (
                                    <ListRow
                                        key={`outlier-${outlier.categoryId}-${outlier.monthKey}`}
                                        leading={
                                            <PieChart className="text-loss" />
                                        }
                                        title={outlier.categoryName}
                                        subtitle={
                                            <>
                                                <span className="font-medium text-loss">
                                                    {formatCurrency(
                                                        outlier.currentAmount,
                                                    )}
                                                </span>{" "}
                                                {t("insights.panel.thisMonth", {
                                                    day: outlier.comparisonEndDay,
                                                })}
                                                {" · "}
                                                {t("insights.panel.vsTypical", {
                                                    amount: formatCurrency(
                                                        outlier.baselineMedian,
                                                    ),
                                                    day: outlier.comparisonEndDay,
                                                })}
                                            </>
                                        }
                                        trailing={
                                            <DismissButton
                                                label={t(
                                                    "insights.dismissFinding",
                                                    {
                                                        kind: t(
                                                            "insights.panel.categoryOverspend",
                                                        ),
                                                        name: outlier.categoryName,
                                                    },
                                                )}
                                                onClick={() =>
                                                    handleDismissOutlier(
                                                        outlier,
                                                    )
                                                }
                                            />
                                        }
                                    />
                                ))}
                            </List>
                        </section>
                    )}
                </div>
                {cashForecast && (
                    <section className="space-y-2">
                        <SectionLabel>
                            {t("insights.panel.cashForecast")}
                        </SectionLabel>
                        <div
                            className={cn(
                                "flex items-center gap-3 rounded-card corner-continuous border p-3",
                                forecastAlert
                                    ? "border-destructive/40 bg-destructive/5"
                                    : "border-border/60 bg-card/70",
                            )}
                        >
                            {forecastAlert ? (
                                <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
                            ) : (
                                <Wallet className="h-4 w-4 shrink-0 text-label-secondary" />
                            )}
                            <div className="min-w-0 flex-1">
                                <p
                                    className={cn(
                                        "type-body",
                                        forecastAlert
                                            ? "font-medium text-foreground"
                                            : "text-label-secondary",
                                    )}
                                >
                                    {t("insights.panel.monthEndNetCashflow", {
                                        amount: formatCurrency(
                                            cashForecast.monthEndNetCashflow,
                                            {
                                                currency: cashForecast.currency,
                                            },
                                        ),
                                    })}
                                </p>
                                {cashForecast.movedSignificantly && (
                                    <p className="mt-0.5 type-footnote text-destructive">
                                        {t("insights.panel.significantMove")}
                                    </p>
                                )}
                            </div>
                        </div>
                    </section>
                )}
            </CardContent>
        </Card>
    );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
    return <h3 className="type-headline text-foreground">{children}</h3>;
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
            className="h-8 w-8 shrink-0 text-label-secondary hover:text-foreground"
            aria-label={label}
            onClick={onClick}
        >
            <X />
        </Button>
    );
}
