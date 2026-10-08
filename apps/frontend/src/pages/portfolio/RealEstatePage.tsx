import { PAGE_ICONS } from "@/lib/pageIcons";
import { useMemo } from "react";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { usePercentFormatter } from "@/hooks/useCurrencyFormatter";
import { Banknote, Building2, MapPin } from "lucide-react";
import { usePortfolio } from "@/hooks/usePortfolio";
import { AddInvestmentDialog } from "@/features/portfolio/AddInvestmentDialog";
import {
    AssetPageActions,
    FactRow,
    Figure,
} from "@/features/portfolio/assetPageParts";
import {
    toneClass,
    useHoldingActions,
} from "@/features/portfolio/useHoldingActions";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { numberFormatToLocale } from "@/utils/currency";
import { useCurrencyConverter } from "@/hooks/useCurrencyConverter";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageError } from "@/components/shared/PageError";
import { Skeleton } from "@/components/ui/skeleton";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import { EmptyState } from "@/components/shared/EmptyState";
import { DeltaPill } from "@/components/shared/DeltaPill";
import { Money } from "@/components/shared/Money";
import { PageShell } from "@/components/shared/PageShell";

const PageIcon = PAGE_ICONS["/portfolio/real-estate"];

export default function RealEstatePage() {
    const formatPercent = usePercentFormatter();
    const { t } = useLanguage();
    const loadingSurfaceProps = useLoadingSurfaceProps();
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);
    const targetCurrency = appSettings.defaultCurrency || "EUR";
    const { byAssetClass, isLoading, isError, error, refetch } =
        usePortfolio();
    const { dialogs, renderMenu } = useHoldingActions({
        deleteTitleKey: "realestate.deleteProperty",
        deleteDescriptionKey: "realestate.deletePropertyDesc",
    });
    const properties = byAssetClass("real_estate");

    const { convertToTarget } = useCurrencyConverter(targetCurrency);

    // One Intl.NumberFormat per (locale, decimals) instead of one per formatted
    // value (~50-200µs a piece) — the memoized-formatter pattern NetWorthPage
    // uses, widened to the `decimals` argument this page's call sites pass. The
    // cache lives inside the memo, so a locale change replaces it wholesale.
    const fmtNum = useMemo(() => {
        const cache = new Map<number, Intl.NumberFormat>();
        return (val: number, decimals = 2) => {
            let formatter = cache.get(decimals);
            if (!formatter) {
                formatter = new Intl.NumberFormat(locale, {
                    minimumFractionDigits: decimals,
                    maximumFractionDigits: decimals,
                });
                cache.set(decimals, formatter);
            }
            return formatter.format(val);
        };
    }, [locale]);

    const totalValue = properties.reduce(
        (s, p) => s + convertToTarget(p.currentValue, p.currency),
        0,
    );
    const totalCost = properties.reduce(
        (s, p) => s + convertToTarget(p.totalBuyCost, p.currency),
        0,
    );
    const totalAppreciation = properties.reduce(
        (s, p) => s + convertToTarget(p.totalAppreciation, p.currency),
        0,
    );
    const totalRentIncome = properties.reduce(
        (s, p) => s + convertToTarget(p.totalIncome, p.currency),
        0,
    );
    const totalFees = properties.reduce(
        (s, p) => s + convertToTarget(p.totalFees, p.currency),
        0,
    );
    const totalTaxes = properties.reduce(
        (s, p) => s + convertToTarget(p.totalTaxes, p.currency),
        0,
    );

    // Estimate monthly rent from most recent rent_income transactions
    const estimatedMonthlyRent = properties.reduce((s, p) => {
        const rentTxns = p.transactions.filter((t) => t.type === "rent_income");
        if (rentTxns.length === 0) return s;
        // Use most recent rent as monthly estimate
        return s + convertToTarget(rentTxns[0]?.amount ?? 0, p.currency);
    }, 0);

    const annualYield =
        totalValue > 0 ? ((estimatedMonthlyRent * 12) / totalValue) * 100 : 0;
    const totalReturn =
        totalAppreciation + totalRentIncome - totalFees - totalTaxes;
    const roi = totalCost > 0 ? (totalReturn / totalCost) * 100 : 0;

    const headerActions = (
        <AssetPageActions allowedAssetClasses={["real_estate"]} />
    );

    if (isLoading) {
        return (
            <PageShell {...loadingSurfaceProps} className="">
                <PageHeader title={t("realestate.title")} icon={PageIcon} />
                <Skeleton className="h-40 w-full rounded-card" />
                <Skeleton className="h-64 w-full rounded-card" />
            </PageShell>
        );
    }
    if (isError) {
        return (
            <PageShell className="">
                <PageHeader title={t("realestate.title")} icon={PageIcon} />
                <PageError
                    title={t("realestate.pageErrorTitle")}
                    message={error?.message ?? t("common.error")}
                    onRetry={() => refetch()}
                />
            </PageShell>
        );
    }

    if (properties.length === 0) {
        return (
            <PageShell className="">
                <PageHeader
                    title={t("realestate.title")}
                    icon={PageIcon}
                    actions={headerActions}
                />
                <Card>
                    <CardContent variant="state">
                        <EmptyState
                            icon={PageIcon}
                            title={t("realestate.noProperties")}
                            description={t("realestate.noPropertiesDesc")}
                            action={
                                <AddInvestmentDialog
                                    allowedAssetClasses={["real_estate"]}
                                />
                            }
                        />
                    </CardContent>
                </Card>
            </PageShell>
        );
    }

    return (
        <>
            <PageShell className="">
                <PageHeader
                    title={t("realestate.title")}
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
                                {t("portfolio.totalValue")}
                            </p>
                            <p className="type-large-title tabular-nums text-foreground">
                                <Money
                                    amount={totalValue}
                                    currency={targetCurrency}
                                />
                            </p>
                            <p className="type-footnote tabular-nums text-label-secondary">
                                {t("portfolio.totalCost")}{" "}
                                <Money
                                    amount={totalCost}
                                    currency={targetCurrency}
                                />
                            </p>
                        </div>
                        <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-2 lg:col-span-3">
                            <Figure
                                label={t("portfolio.appreciation")}
                                tone={toneClass(totalAppreciation)}
                                value={
                                    <Money
                                        amount={totalAppreciation}
                                        currency={targetCurrency}
                                        signed
                                    />
                                }
                            />
                            <Figure
                                label={t("portfolio.rentalIncome")}
                                tone={toneClass(totalRentIncome)}
                                value={
                                    <Money
                                        amount={totalRentIncome}
                                        currency={targetCurrency}
                                        signed
                                    />
                                }
                                detail={
                                    <>
                                        <span aria-hidden="true">~</span>
                                        <Money
                                            amount={estimatedMonthlyRent}
                                            currency={targetCurrency}
                                        />
                                        {t("realestate.perMonth")}
                                    </>
                                }
                            />
                            <Figure
                                label={t("portfolio.yield")}
                                value={formatPercent(annualYield, {
                                    digits: 1,
                                })}
                                detail={t("portfolio.annual")}
                            />
                            <Figure
                                label={t("portfolio.totalReturn")}
                                tone={toneClass(totalReturn)}
                                value={
                                    <Money
                                        amount={totalReturn}
                                        currency={targetCurrency}
                                        signed
                                    />
                                }
                                detail={
                                    <span className="inline-flex items-center gap-1.5">
                                        <DeltaPill
                                            value={roi}
                                            label={formatPercent(roi, {
                                                digits: 1,
                                                signed: true,
                                            })}
                                        />
                                        {t("portfolio.totalROI")}
                                    </span>
                                }
                            />
                        </div>
                    </CardContent>
                </Card>

                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                    {properties.map((p) => {
                        const propertyCost = convertToTarget(
                            p.totalBuyCost,
                            p.currency,
                        );
                        const propertyReturn = convertToTarget(
                            p.totalAppreciation +
                                p.totalIncome -
                                p.totalFees -
                                p.totalTaxes,
                            p.currency,
                        );
                        const propertyROI =
                            propertyCost > 0
                                ? (propertyReturn / propertyCost) * 100
                                : 0;
                        const monthlyRent = convertToTarget(
                            p.transactions.filter(
                                (t) => t.type === "rent_income",
                            )[0]?.amount ?? 0,
                            p.currency,
                        );
                        const currentValueInTarget = convertToTarget(
                            p.currentValue,
                            p.currency,
                        );
                        const propertyYield =
                            currentValueInTarget > 0
                                ? ((monthlyRent * 12) / currentValueInTarget) *
                                  100
                                : 0;
                        const appreciation = convertToTarget(
                            p.totalAppreciation,
                            p.currency,
                        );
                        const hasCadastral =
                            p.cadastral_income !== undefined &&
                            p.cadastral_income !== null;
                        const hasTaxRate =
                            p.municipality_tax_rate !== undefined &&
                            p.municipality_tax_rate !== null;

                        return (
                            <Card key={p.id}>
                                <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
                                    <div className="flex min-w-0 items-center gap-3">
                                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control corner-continuous bg-primary/12 text-primary">
                                            <Building2
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
                                                {p.name}
                                            </CardTitle>
                                            {p.location && (
                                                <CardDescription className="flex items-center gap-1">
                                                    <MapPin
                                                        className="h-3 w-3 shrink-0"
                                                        aria-hidden
                                                    />
                                                    <span className="truncate">
                                                        {p.location}
                                                    </span>
                                                </CardDescription>
                                            )}
                                        </div>
                                    </div>
                                    {renderMenu(p, "-mr-2 -mt-1")}
                                </CardHeader>

                                <CardContent className="space-y-3">
                                    <div className="grid grid-cols-2 gap-4">
                                        <div>
                                            <p className="type-caption text-label-tertiary">
                                                {t("portfolio.purchasePrice")}
                                            </p>
                                            <p className="type-title-2 tabular-nums">
                                                <Money
                                                    amount={propertyCost}
                                                    currency={targetCurrency}
                                                />
                                            </p>
                                        </div>
                                        <div className="text-right">
                                            <p className="type-caption text-label-tertiary">
                                                {t("portfolio.currentValue")}
                                            </p>
                                            <p className="type-title-2 tabular-nums text-primary">
                                                <Money
                                                    amount={currentValueInTarget}
                                                    currency={targetCurrency}
                                                />
                                            </p>
                                        </div>
                                    </div>

                                    <dl className="divide-y divide-border/50 border-t border-border/50">
                                        <FactRow
                                            label={t("portfolio.appreciation")}
                                            tone={toneClass(appreciation)}
                                            value={
                                                <Money
                                                    amount={appreciation}
                                                    currency={targetCurrency}
                                                    signed
                                                />
                                            }
                                        />
                                        <FactRow
                                            label={t("portfolio.rentalIncome")}
                                            tone={toneClass(p.totalIncome)}
                                            value={
                                                <Money
                                                    amount={convertToTarget(
                                                        p.totalIncome,
                                                        p.currency,
                                                    )}
                                                    currency={targetCurrency}
                                                    signed
                                                />
                                            }
                                            detail={
                                                monthlyRent > 0 ? (
                                                    <>
                                                        <span aria-hidden="true">
                                                            ~
                                                        </span>
                                                        <Money
                                                            amount={monthlyRent}
                                                            currency={
                                                                targetCurrency
                                                            }
                                                        />
                                                        {t(
                                                            "realestate.perMonth",
                                                        )}
                                                    </>
                                                ) : undefined
                                            }
                                        />
                                        {p.municipality && (
                                            <FactRow
                                                label={t(
                                                    "invDetail.municipality",
                                                )}
                                                value={p.municipality}
                                            />
                                        )}
                                        {hasCadastral && (
                                            <FactRow
                                                label={t(
                                                    "invDetail.cadastralIncome",
                                                )}
                                                value={
                                                    <Money
                                                        amount={convertToTarget(
                                                            p.cadastral_income ||
                                                                0,
                                                            p.currency,
                                                        )}
                                                        currency={
                                                            targetCurrency
                                                        }
                                                    />
                                                }
                                            />
                                        )}
                                        {hasTaxRate && (
                                            <FactRow
                                                label={t(
                                                    "invDetail.municipalityTaxRate",
                                                )}
                                                value={`${fmtNum(
                                                    p.municipality_tax_rate ||
                                                        0,
                                                )}%`}
                                            />
                                        )}
                                        <FactRow
                                            label={t("portfolio.yield")}
                                            value={`${formatPercent(
                                                propertyYield,
                                                { digits: 1 },
                                            )} ${t("portfolio.annual")}`}
                                        />
                                        <FactRow
                                            label={t("portfolio.totalROI")}
                                            value={
                                                <DeltaPill
                                                    value={propertyROI}
                                                    label={formatPercent(
                                                        propertyROI,
                                                        {
                                                            digits: 1,
                                                            signed: true,
                                                        },
                                                    )}
                                                />
                                            }
                                        />
                                        {(p.totalFees > 0 ||
                                            p.totalTaxes > 0) && (
                                            <FactRow
                                                label={t(
                                                    "portfolio.feesAndTaxes",
                                                )}
                                                tone="text-loss"
                                                value={
                                                    <Money
                                                        amount={
                                                            -convertToTarget(
                                                                p.totalFees +
                                                                    p.totalTaxes,
                                                                p.currency,
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
                                </CardContent>
                            </Card>
                        );
                    })}
                </div>

                <p className="type-footnote text-label-secondary">
                    {t("realestate.howItWorks")}
                </p>
            </PageShell>
            {dialogs}
        </>
    );
}
