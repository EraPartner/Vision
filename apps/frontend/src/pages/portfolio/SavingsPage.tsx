import { useState } from "react";
import { PAGE_ICONS } from "@/lib/pageIcons";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Banknote, Calendar, PiggyBank, Shield } from "lucide-react";
import { usePortfolio } from "@/hooks/usePortfolio";
import { usePortfolioSummaryQuery } from "@/hooks/portfolio/usePortfolioSummary";
import { findHoldingTotals } from "@/hooks/portfolio/assetGroupTotals";
import { AddInvestmentDialog } from "@/features/portfolio/AddInvestmentDialog";
import {
    AssetPageActions,
    FactRow,
    Figure,
} from "@/features/portfolio/assetPageParts";
import { toneClass } from "@/features/portfolio/holdingTone";
import { useHoldingActions } from "@/features/portfolio/useHoldingActions";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { usePercentFormatter } from "@/hooks/useCurrencyFormatter";
import { formatDateStringWithAppSettings } from "@/lib/dateUtils";
import { parseYmd, daysBetween } from "@/lib/timezone";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageError } from "@/components/shared/PageError";
import { Skeleton } from "@/components/ui/skeleton";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import { EmptyState } from "@/components/shared/EmptyState";
import { Money } from "@/components/shared/Money";
import { PageShell } from "@/components/shared/PageShell";
import { ExportDialog } from "@/features/reports/ExportDialog";

const PageIcon = PAGE_ICONS["/portfolio/savings"];
const ALLOWED_ASSET_CLASSES = ["savings", "bond"] as const;

function daysUntil(dateStr?: string) {
    if (!dateStr) return null;
    return Math.ceil(daysBetween(new Date(), parseYmd(dateStr)));
}

export default function SavingsPage() {
    const formatPercent = usePercentFormatter();
    const { t } = useLanguage();
    const loadingSurfaceProps = useLoadingSurfaceProps();
    const { appSettings } = useAppSettings();
    const targetCurrency = appSettings.defaultCurrency || "EUR";
    const { byAssetClass, isLoading, isError, error, refetch } = usePortfolio();
    const { dialogs, renderMenu } = useHoldingActions({
        deleteTitleKey: "savings.deleteAccount",
        deleteDescriptionKey: "savings.deleteAccountDesc",
    });
    const accounts = byAssetClass([...ALLOWED_ASSET_CLASSES]);

    // Page totals come from the server summary, in targetCurrency.
    const { data: summary } = usePortfolioSummaryQuery(targetCurrency);
    const {
        totalPortfolioValue: totalBalance,
        totalIncome: totalInterestEarned,
        totalProjectedAnnualInterest: totalProjectedAnnual,
        totalAccruedInterest: totalAccrued,
        valueWeightedInterestRate: weightedRate,
    } = findHoldingTotals(summary, ALLOWED_ASSET_CLASSES);

    const [exportOpen, setExportOpen] = useState(false);
    const exportDialog = (
        <ExportDialog
            defaultType="portfolio"
            trigger={null}
            open={exportOpen}
            onOpenChange={setExportOpen}
        />
    );

    const headerActions = (
        <AssetPageActions
            onExport={() => setExportOpen(true)}
            allowedAssetClasses={[...ALLOWED_ASSET_CLASSES]}
        />
    );

    if (isLoading) {
        return (
            <>
                {exportDialog}
                <PageShell {...loadingSurfaceProps} className="">
                    <PageHeader title={t("savings.title")} icon={PageIcon} />
                    <Skeleton className="h-40 w-full rounded-card" />
                    <Skeleton className="h-64 w-full rounded-card" />
                </PageShell>
            </>
        );
    }
    if (isError) {
        return (
            <>
                {exportDialog}
                <PageShell className="">
                    <PageHeader title={t("savings.title")} icon={PageIcon} />
                    <PageError
                        title={t("savings.pageErrorTitle")}
                        message={error?.message ?? t("common.error")}
                        onRetry={() => refetch()}
                    />
                </PageShell>
            </>
        );
    }

    if (accounts.length === 0) {
        return (
            <>
                {exportDialog}
                <PageShell className="">
                    <PageHeader
                        title={t("savings.title")}
                        icon={PageIcon}
                        actions={headerActions}
                    />
                    <Card>
                        <CardContent variant="state">
                            <EmptyState
                                icon={PageIcon}
                                title={t("savings.noAccounts")}
                                description={t("savings.noAccountsDesc")}
                                action={
                                    <AddInvestmentDialog
                                        allowedAssetClasses={[
                                            ...ALLOWED_ASSET_CLASSES,
                                        ]}
                                    />
                                }
                            />
                        </CardContent>
                    </Card>
                </PageShell>
            </>
        );
    }

    return (
        <>
            {exportDialog}
            <PageShell className="">
                <PageHeader
                    title={t("savings.title")}
                    icon={PageIcon}
                    actions={headerActions}
                />

                <Card className="overflow-hidden">
                    <CardContent
                        variant="headerless"
                        className="grid gap-6 lg:grid-cols-5"
                    >
                        <div className="space-y-2 lg:col-span-2">
                            <p className="eyebrow flex items-center gap-1.5">
                                <Banknote className="h-3.5 w-3.5" aria-hidden />
                                {t("portfolio.totalBalance")}
                            </p>
                            <p className="type-large-title tabular-nums text-foreground">
                                <Money
                                    amount={totalBalance}
                                    currency={targetCurrency}
                                />
                            </p>
                        </div>
                        <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:col-span-3">
                            <Figure
                                label={t("portfolio.avgInterestRate")}
                                value={formatPercent(weightedRate, {
                                    digits: 2,
                                })}
                            />
                            <Figure
                                label={t("portfolio.interestEarned")}
                                tone={toneClass(totalInterestEarned)}
                                value={
                                    <Money
                                        amount={totalInterestEarned}
                                        currency={targetCurrency}
                                        signed
                                    />
                                }
                            />
                            <Figure
                                label={t("portfolio.projectedAnnual")}
                                value={
                                    <Money
                                        amount={totalProjectedAnnual}
                                        currency={targetCurrency}
                                        signed
                                    />
                                }
                                detail={
                                    totalAccrued > 0 ? (
                                        <>
                                            <Money
                                                amount={totalAccrued}
                                                currency={targetCurrency}
                                            />{" "}
                                            {t("portfolio.accrued")}
                                        </>
                                    ) : undefined
                                }
                            />
                        </div>
                    </CardContent>
                </Card>

                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    {accounts.map((a) => {
                        const daysToMaturity = daysUntil(a.maturityDate);
                        const isMaturingSoon =
                            daysToMaturity !== null &&
                            daysToMaturity <= 30 &&
                            daysToMaturity > 0;
                        const isMatured =
                            daysToMaturity !== null && daysToMaturity <= 0;
                        const isSavings = a.assetClass === "savings";
                        const Glyph = isSavings ? PiggyBank : Shield;
                        const interestEarned = a.totalIncome;

                        return (
                            <Card
                                key={a.id}
                                className={cn(
                                    isMatured && "!border-accent/60",
                                    isMaturingSoon && "!border-primary/60",
                                )}
                            >
                                <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
                                    <div className="flex min-w-0 items-center gap-3">
                                        <span
                                            className={cn(
                                                "flex h-10 w-10 shrink-0 items-center justify-center rounded-control corner-continuous",
                                                isSavings
                                                    ? "bg-primary/12 text-primary"
                                                    : "bg-accent/12 text-accent",
                                            )}
                                        >
                                            <Glyph
                                                className="h-5 w-5"
                                                aria-hidden
                                            />
                                        </span>
                                        <div className="min-w-0">
                                            <CardTitle
                                                variant="sm"
                                                level={3}
                                                className="truncate"
                                            >
                                                {a.name}
                                            </CardTitle>
                                            <CardDescription className="flex flex-wrap items-center gap-2">
                                                <Badge
                                                    variant="secondary"
                                                    size="sm"
                                                >
                                                    {isSavings
                                                        ? t("portfolio.savings")
                                                        : t("portfolio.bond")}
                                                </Badge>
                                                {a.interestRate != null &&
                                                a.interestRate !== 0 ? (
                                                    <span className="tabular-nums text-accent">
                                                        {formatPercent(
                                                            a.interestRate,
                                                            { digits: 2 },
                                                        )}{" "}
                                                        {t("savings.pa")}
                                                    </span>
                                                ) : null}
                                            </CardDescription>
                                        </div>
                                    </div>
                                    {renderMenu(a, "-mr-2 -mt-1")}
                                </CardHeader>

                                <CardContent className="space-y-3">
                                    <div className="grid grid-cols-2 gap-4">
                                        <div>
                                            <p className="type-caption text-label-tertiary">
                                                {t("portfolio.currentBalance")}
                                            </p>
                                            <p className="type-title-2 tabular-nums">
                                                <Money
                                                    amount={a.currentValue}
                                                    currency={targetCurrency}
                                                />
                                            </p>
                                        </div>
                                        <div className="text-right">
                                            <p className="type-caption text-label-tertiary">
                                                {t("portfolio.interestEarned")}
                                            </p>
                                            <p
                                                className={cn(
                                                    "type-title-2 tabular-nums",
                                                    toneClass(interestEarned),
                                                )}
                                            >
                                                <Money
                                                    amount={interestEarned}
                                                    currency={targetCurrency}
                                                    signed
                                                />
                                            </p>
                                        </div>
                                    </div>

                                    {(Boolean(
                                        (a.interestRate ?? 0) !== 0 &&
                                        a.projectedAnnualInterest > 0,
                                    ) ||
                                        a.maturityDate ||
                                        a.totalFees > 0 ||
                                        a.totalTaxes > 0) && (
                                        <dl className="divide-y divide-border/50 border-t border-border/50">
                                            {(a.interestRate ?? 0) !== 0 &&
                                            a.projectedAnnualInterest > 0 ? (
                                                <>
                                                    <FactRow
                                                        label={t(
                                                            "portfolio.projectedAnnualInterest",
                                                        )}
                                                        tone="text-primary"
                                                        value={
                                                            <Money
                                                                amount={
                                                                    a.projectedAnnualInterest
                                                                }
                                                                currency={
                                                                    targetCurrency
                                                                }
                                                                signed
                                                            />
                                                        }
                                                    />
                                                    {a.accruedInterest > 0 && (
                                                        <FactRow
                                                            label={t(
                                                                "portfolio.accruedUnpaid",
                                                            )}
                                                            tone="text-gain"
                                                            value={
                                                                <Money
                                                                    amount={
                                                                        a.accruedInterest
                                                                    }
                                                                    currency={
                                                                        targetCurrency
                                                                    }
                                                                    signed
                                                                />
                                                            }
                                                        />
                                                    )}
                                                </>
                                            ) : null}
                                            {a.maturityDate && (
                                                <FactRow
                                                    label={
                                                        <span className="inline-flex items-center gap-1.5">
                                                            <Calendar
                                                                className="h-3.5 w-3.5"
                                                                aria-hidden
                                                            />
                                                            {isMatured
                                                                ? t(
                                                                      "portfolio.matured",
                                                                  )
                                                                : t(
                                                                      "portfolio.matures",
                                                                  )}
                                                        </span>
                                                    }
                                                    tone={cn(
                                                        isMatured &&
                                                            "text-accent",
                                                        isMaturingSoon &&
                                                            "text-primary",
                                                    )}
                                                    value={formatDateStringWithAppSettings(
                                                        a.maturityDate,
                                                        appSettings.dateFormat,
                                                    )}
                                                    detail={
                                                        !isMatured &&
                                                        daysToMaturity !== null
                                                            ? t(
                                                                  "portfolio.daysRemaining",
                                                                  {
                                                                      days: String(
                                                                          daysToMaturity,
                                                                      ),
                                                                  },
                                                              )
                                                            : undefined
                                                    }
                                                />
                                            )}
                                            {(a.totalFees > 0 ||
                                                a.totalTaxes > 0) && (
                                                <FactRow
                                                    label={t(
                                                        "portfolio.feesAndTaxesPaid",
                                                    )}
                                                    tone="text-loss"
                                                    value={
                                                        <Money
                                                            amount={
                                                                -(
                                                                    a.feesAndTaxes ??
                                                                    0
                                                                )
                                                            }
                                                            currency={
                                                                targetCurrency
                                                            }
                                                            signed
                                                        />
                                                    }
                                                />
                                            )}
                                        </dl>
                                    )}
                                </CardContent>
                            </Card>
                        );
                    })}
                </div>

                <p className="type-footnote text-label-secondary">
                    {t("savings.howItWorks")}
                </p>
            </PageShell>
            {dialogs}
        </>
    );
}
