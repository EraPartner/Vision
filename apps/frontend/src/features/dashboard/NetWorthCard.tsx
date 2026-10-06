import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Money } from "@/components/shared/Money";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useNetWorthSummary } from "@/features/portfolio/usePortfolioQueries";
import { cn } from "@/lib/utils";

interface NetWorthCardProps {
    currency: string;
}

/** Home net-worth card (ADR-181): the number, this month's change, assets against debt. */
export function NetWorthCard({ currency }: NetWorthCardProps) {
    const { t } = useLanguage();
    const { data, isLoading } = useNetWorthSummary(currency);
    const current = data?.current;
    const assets = (current?.liquid ?? 0) + (current?.investments ?? 0);
    const debt = Math.abs(current?.liabilities ?? 0);
    const scale = Math.max(assets, debt, 1);
    const change = data?.monthlyChange ?? 0;
    const hasData = !!data && (assets !== 0 || debt !== 0 || data.snapshots.length > 0);

    return (
        <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-3 pb-3">
                <CardTitle variant="sm">{t("home.netWorth.title")}</CardTitle>
                <Button asChild variant="link" size="sm" className="h-auto p-0">
                    <Link to="/portfolio/net-worth">{t("home.netWorth.details")}</Link>
                </Button>
            </CardHeader>
            <CardContent className="space-y-4">
                {isLoading ? (
                    <Skeleton className="h-10 w-40" />
                ) : !hasData ? (
                    <p className="type-callout text-label-secondary">
                        {t("home.netWorth.empty")}{" "}
                        <Link to="/accounts" className="text-primary underline-offset-4 hover:underline">
                            {t("home.accounts.title")}
                        </Link>
                    </p>
                ) : (
                    <>
                        <div>
                            <p className="type-title-1 tabular-nums text-foreground">
                                <Money amount={current?.netWorth ?? 0} currency={currency} />
                            </p>
                            <p
                                className={cn(
                                    "type-footnote tabular-nums",
                                    change > 0 ? "text-gain" : change < 0 ? "text-loss" : "text-label-secondary",
                                )}
                            >
                                <Money amount={change} currency={currency} signed />{" "}
                                {t("home.netWorth.change")}
                                {data?.monthlyChangePercent ? ` (${change > 0 ? "+" : ""}${data.monthlyChangePercent.toFixed(1)}%)` : ""}
                            </p>
                        </div>
                        <dl className="space-y-2">
                            {[
                                { key: "assets", label: t("home.netWorth.assets"), value: assets, tone: "bg-gain" },
                                { key: "debt", label: t("home.netWorth.debt"), value: debt, tone: "bg-loss" },
                            ].map((bar) => (
                                <div key={bar.key} className="space-y-1">
                                    <div className="flex items-baseline justify-between type-footnote">
                                        <dt className="text-label-secondary">{bar.label}</dt>
                                        <dd className="tabular-nums text-foreground">
                                            <Money amount={bar.value} currency={currency} />
                                        </dd>
                                    </div>
                                    <div className="h-1.5 overflow-hidden rounded-chip bg-foreground/[0.06]">
                                        <div
                                            className={cn("h-full rounded-chip", bar.tone)}
                                            style={{ width: `${Math.min(100, (bar.value / scale) * 100)}%` }}
                                        />
                                    </div>
                                </div>
                            ))}
                        </dl>
                    </>
                )}
            </CardContent>
        </Card>
    );
}
