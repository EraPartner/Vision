import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { Banknote, Info, TrendingDown, TrendingUp } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { usePortfolio } from "@/hooks/usePortfolio";
import { usePortfolioSummaryQuery } from "@/hooks/portfolio/usePortfolioSummary";
import { useFxAwarePnl } from "@/hooks/portfolio/useFxAwarePnl";
import { useCurrencyConverter } from "@/hooks/useCurrencyConverter";
import { usePercentFormatter } from "@/hooks/useCurrencyFormatter";
import { AddInvestmentDialog } from "@/features/portfolio/AddInvestmentDialog";
import { AssetPageActions, Figure } from "@/features/portfolio/assetPageParts";
import {
    toneClass,
    useHoldingActions,
} from "@/features/portfolio/useHoldingActions";
import { StalePriceIndicator } from "@/features/portfolio/StalePriceIndicator";
import { StalePricesBanner } from "@/features/portfolio/StalePricesBanner";
import {
    PriceFreshnessCaption,
    usePriceFreshnessLabel,
} from "@/features/portfolio/PriceFreshnessCaption";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import type { AssetClass } from "@/types/portfolio";
import { useMemo } from "react";
import { PageHeader } from "@/components/shared/PageHeader";
import { PAGE_ICONS } from "@/lib/pageIcons";
import { PageError } from "@/components/shared/PageError";
import { TouchDisclosure } from "@/components/shared/TouchDisclosure";
import { Skeleton } from "@/components/ui/skeleton";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import { EmptyState } from "@/components/shared/EmptyState";
import { DeltaPill } from "@/components/shared/DeltaPill";
import { FxPnlCell } from "@/features/portfolio/FxPnlCell";
import { Money } from "@/components/shared/Money";
import { PageShell } from "@/components/shared/PageShell";
import { TextLink } from "@/components/shared/TextLink";
import { PortfolioOversoldBadge } from "@/features/portfolio/PortfolioOversoldBadge";
import { addAll, subtract, toNumber } from "@vision/shared-utils/money";

interface StocksPageProps {
    assetClasses?: AssetClass[];
    titleKey?: string;
    /** i18n key for the PageError heading shown when the portfolio fails to load. */
    errorTitleKey?: string;
    emptyTitleKey?: string;
    emptyDescriptionKey?: string;
    allowedAddAssetClasses?: AssetClass[];
    enableFxAwarePnl?: boolean;
    /** Page icon shown in the header, empty state, and (combined variant) asset cell. */
    icon?: LucideIcon;
    /** i18n key for the "how it works" note under the holdings. */
    howItWorksKey?: string;
    /** i18n keys for the delete-confirmation dialog (description key receives {name}). */
    deleteTitleKey?: string;
    deleteDescriptionKey?: string;
    /** Whether the header ••• menu offers the portfolio PDF export (Stocks/Metals: yes, Crypto: no). */
    showEmptyStateExport?: boolean;
    /**
     * Whether dividends are surfaced: hero figure, table column, and the
     * dividends term inside the net-return figure. Crypto hides all three.
     */
    showDividends?: boolean;
    /** Unrealized-P&L figure icon follows the sign (up/down) instead of a fixed TrendingUp (Crypto). */
    dynamicUnrealizedIcon?: boolean;
    /**
     * 'split' = separate Symbol and Name columns with an asset-class badge
     * (Stocks/Metals); 'combined' = single Asset column with an icon avatar,
     * symbol, and name stacked (Crypto).
     */
    assetCellVariant?: "split" | "combined";
    /** Decimal places for the units column (Stocks: 4, Crypto: 8). */
    unitsDecimals?: number;
    /** Render the units column in a monospace font (Crypto). */
    unitsMonospace?: boolean;
    /**
     * Show avg-cost/price/value converted to the display currency instead of the
     * holding's native currency (Crypto converts, Stocks/Metals stay native).
     */
    priceColumnsInTargetCurrency?: boolean;
    /**
     * Percentage shown in the unrealized pill when enableFxAwarePnl is false:
     * 'costBasis' = unrealizedGain / cost-of-held-units; 'totalReturn' = the
     * legacy gainLossPercent figure (incl. dividends + realized) that CryptoPage
     * has always displayed. Ignored while FX-aware P&L is enabled.
     */
    simplePnlPercentSource?: "costBasis" | "totalReturn";
}

const DEFAULT_STOCKS_ASSET_CLASSES: AssetClass[] = ["stock", "etf"];
const DEFAULT_STOCKS_ALLOWED_ADD_ASSET_CLASSES: AssetClass[] = ["stock", "etf"];
const headCellClass = "whitespace-nowrap text-right";

export default function StocksPage({
    assetClasses = DEFAULT_STOCKS_ASSET_CLASSES,
    titleKey = "stocks.title",
    errorTitleKey = "stocks.pageErrorTitle",
    emptyTitleKey = "stocks.noStocks",
    emptyDescriptionKey = "stocks.noStocksDesc",
    allowedAddAssetClasses = DEFAULT_STOCKS_ALLOWED_ADD_ASSET_CLASSES,
    enableFxAwarePnl = true,
    icon: PageIcon = PAGE_ICONS["/portfolio/stocks"],
    howItWorksKey = "stocks.howItWorks",
    deleteTitleKey = "portfolio.deleteInvestment",
    deleteDescriptionKey = "portfolio.deleteInvestmentDesc",
    showEmptyStateExport = true,
    showDividends = true,
    dynamicUnrealizedIcon = false,
    assetCellVariant = "split",
    unitsDecimals = 4,
    unitsMonospace = false,
    priceColumnsInTargetCurrency = false,
    simplePnlPercentSource = "costBasis",
}: StocksPageProps = {}) {
    const formatPercent = usePercentFormatter();
    const { t } = useLanguage();
    const loadingSurfaceProps = useLoadingSurfaceProps();
    const { appSettings } = useAppSettings();
    const {
        byAssetClass,
        refreshPrices,
        isRefreshingPrices,
        isLoading,
        isError,
        error,
        refetch,
    } = usePortfolio();
    const { dialogs, renderMenu } = useHoldingActions({
        deleteTitleKey,
        deleteDescriptionKey,
    });
    const holdings = useMemo(
        () => byAssetClass(assetClasses),
        [byAssetClass, assetClasses],
    );
    const priceFreshnessLabel = usePriceFreshnessLabel(holdings);
    const targetCurrency = appSettings.defaultCurrency || "EUR";

    const { convertToTarget } = useCurrencyConverter(targetCurrency);
    const computeFxAwarePnl = useFxAwarePnl(targetCurrency);

    // Per-investment FX attribution comes from the backend summary (it has the
    // historical-rate machinery); only shown when a holding is in a foreign currency.
    const { data: apiSummary } = usePortfolioSummaryQuery(targetCurrency);
    const fxInfoById = useMemo(
        () => new Map((apiSummary?.summaries ?? []).map((s) => [s.id, s])),
        [apiSummary],
    );
    const pageHasFxExposure = useMemo(
        () =>
            holdings.some(
                (h) =>
                    (
                        h.originalCurrency ||
                        h.currency ||
                        "EUR"
                    ).toUpperCase() !== targetCurrency.toUpperCase(),
            ),
        [holdings, targetCurrency],
    );

    const displayedPnlByHoldingId = useMemo(() => {
        const map: Record<
            number,
            {
                realizedTarget: number;
                unrealizedTarget: number;
                unrealizedPercent: number;
            }
        > = {};
        for (const holding of holdings) {
            if (enableFxAwarePnl) {
                const pnl = computeFxAwarePnl(holding);
                if (pnl) map[holding.id] = pnl;
                continue;
            }

            // True unrealized % = unrealizedGain / cost-of-held-units (a currency-free
            // ratio). gainLossPercent is total-return (incl. dividends + realized) —
            // the wrong label for an "unrealized %" column — but CryptoPage has always
            // displayed it, so the 'totalReturn' source preserves that page's pill
            // verbatim while 'costBasis' stays the correct default.
            const heldCost =
                (Number(holding.avgCostBasis) || 0) *
                (Number(holding.totalUnits) || 0);
            map[holding.id] = {
                realizedTarget: convertToTarget(
                    holding.realizedGain,
                    holding.currency,
                ),
                unrealizedTarget: convertToTarget(
                    holding.unrealizedGain,
                    holding.currency,
                ),
                unrealizedPercent:
                    simplePnlPercentSource === "totalReturn"
                        ? holding.gainLossPercent
                        : heldCost > 0
                          ? ((Number(holding.unrealizedGain) || 0) / heldCost) *
                            100
                          : 0,
            };
        }
        return map;
    }, [
        holdings,
        enableFxAwarePnl,
        computeFxAwarePnl,
        convertToTarget,
        simplePnlPercentSource,
    ]);

    const totals = useMemo(() => {
        return holdings.reduce(
            (acc, holding) => {
                acc.totalValue += convertToTarget(
                    holding.currentValue,
                    holding.currency,
                );
                acc.totalRealizedGain +=
                    displayedPnlByHoldingId[holding.id]?.realizedTarget || 0;
                acc.totalUnrealizedGain +=
                    displayedPnlByHoldingId[holding.id]?.unrealizedTarget || 0;
                acc.totalDividends += convertToTarget(
                    holding.totalDividends,
                    holding.currency,
                );
                acc.totalInKindIncome += convertToTarget(
                    holding.totalInKindIncome ?? 0,
                    holding.currency,
                );
                acc.totalFees += convertToTarget(
                    holding.totalFees,
                    holding.currency,
                );
                acc.totalTaxes += convertToTarget(
                    holding.totalTaxes,
                    holding.currency,
                );
                return acc;
            },
            {
                totalValue: 0,
                totalRealizedGain: 0,
                totalUnrealizedGain: 0,
                totalDividends: 0,
                totalInKindIncome: 0,
                totalFees: 0,
                totalTaxes: 0,
            },
        );
    }, [holdings, displayedPnlByHoldingId, convertToTarget]);

    const {
        totalValue,
        totalRealizedGain,
        totalUnrealizedGain,
        totalDividends,
        totalFees,
        totalTaxes,
    } = totals;
    // Canonical gainLoss includes custody fees and standalone deductions.
    // These pages include only the income they surface in their hero figures.
    const netGain = toNumber(
        addAll(
            holdings.map((holding) =>
                addAll([
                    subtract(holding.gainLoss, holding.totalIncome),
                    showDividends ? holding.totalDividends : 0,
                ]),
            ),
        ),
    );

    // Stocks/Metals show avg-cost/price/value in the holding's native currency;
    // Crypto shows them converted to the display currency.
    const moneyPriceCol = (value: number, holdingCurrency?: string) => (
        <Money
            amount={
                priceColumnsInTargetCurrency
                    ? convertToTarget(value, holdingCurrency)
                    : value
            }
            currency={
                priceColumnsInTargetCurrency ? targetCurrency : holdingCurrency
            }
        />
    );

    const headerActions = (
        <AssetPageActions
            allowedAssetClasses={allowedAddAssetClasses}
            showExport={showEmptyStateExport}
        />
    );

    if (isLoading) {
        return (
            <PageShell {...loadingSurfaceProps} className="">
                <PageHeader title={t(titleKey)} icon={PageIcon} />
                <Skeleton className="h-40 w-full rounded-card" />
                <Skeleton className="h-64 w-full rounded-card" />
            </PageShell>
        );
    }
    if (isError) {
        return (
            <PageShell className="">
                <PageHeader title={t(titleKey)} icon={PageIcon} />
                <PageError
                    title={t(errorTitleKey)}
                    message={error?.message ?? t("common.error")}
                    onRetry={() => refetch()}
                />
            </PageShell>
        );
    }

    if (holdings.length === 0) {
        return (
            <PageShell className="">
                <PageHeader
                    title={t(titleKey)}
                    icon={PageIcon}
                    actions={headerActions}
                />
                <Card>
                    <CardContent variant="state">
                        <EmptyState
                            icon={PageIcon}
                            title={t(emptyTitleKey)}
                            description={t(emptyDescriptionKey)}
                            action={
                                <AddInvestmentDialog
                                    allowedAssetClasses={allowedAddAssetClasses}
                                />
                            }
                        />
                    </CardContent>
                </Card>
            </PageShell>
        );
    }

    const feesAndTaxes = -(totalFees + totalTaxes);
    const unrealizedIcon =
        dynamicUnrealizedIcon && totalUnrealizedGain < 0
            ? TrendingDown
            : TrendingUp;

    return (
        <>
            <PageShell className="">
                <PageHeader
                    title={t(titleKey)}
                    icon={PageIcon}
                    actions={headerActions}
                />

                <StalePricesBanner
                    investments={holdings}
                    onRefresh={refreshPrices}
                    isRefreshing={isRefreshingPrices}
                />

                <Card className="overflow-hidden">
                    <CardContent
                        variant="headerless"
                        className="grid gap-6 lg:grid-cols-5"
                    >
                        <div className="space-y-2 lg:col-span-2">
                            <p className="eyebrow flex items-center gap-1.5">
                                <Banknote className="h-3.5 w-3.5" aria-hidden />
                                {t("portfolio.portfolioValue")}
                            </p>
                            <p className="type-large-title tabular-nums text-foreground">
                                <Money
                                    amount={totalValue}
                                    currency={targetCurrency}
                                />
                            </p>
                            <PriceFreshnessCaption investments={holdings} />
                        </div>
                        <div
                            className={cn(
                                "grid grid-cols-2 gap-x-6 gap-y-4 lg:col-span-3",
                                showDividends
                                    ? "sm:grid-cols-3"
                                    : "sm:grid-cols-2",
                            )}
                        >
                            <Figure
                                label={t("portfolio.realizedPnl")}
                                tone={toneClass(totalRealizedGain)}
                                value={
                                    <Money
                                        amount={totalRealizedGain}
                                        currency={targetCurrency}
                                        signed
                                    />
                                }
                            />
                            <Figure
                                label={t("portfolio.unrealizedPnl")}
                                icon={unrealizedIcon}
                                tone={toneClass(totalUnrealizedGain)}
                                value={
                                    <Money
                                        amount={totalUnrealizedGain}
                                        currency={targetCurrency}
                                        signed
                                    />
                                }
                            />
                            {showDividends && (
                                <Figure
                                    label={t("portfolio.dividends")}
                                    tone={toneClass(totalDividends)}
                                    value={
                                        <Money
                                            amount={totalDividends}
                                            currency={targetCurrency}
                                            signed
                                        />
                                    }
                                />
                            )}
                            <Figure
                                label={t("portfolio.feesAndTaxes")}
                                tone={toneClass(feesAndTaxes)}
                                value={
                                    <Money
                                        amount={feesAndTaxes}
                                        currency={targetCurrency}
                                        signed
                                    />
                                }
                            />
                            <Figure
                                label={t("portfolio.netReturn")}
                                tone={toneClass(netGain)}
                                value={
                                    <Money
                                        amount={netGain}
                                        currency={targetCurrency}
                                        signed
                                    />
                                }
                            />
                        </div>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle variant="sm" level={2}>
                            {t("portfolio.holdings")}
                        </CardTitle>
                    </CardHeader>
                    <CardContent variant="flush">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    {assetCellVariant === "split" ? (
                                        <>
                                            <TableHead>
                                                {t("portfolio.symbol")}
                                            </TableHead>
                                            <TableHead>
                                                {t("portfolio.name")}
                                            </TableHead>
                                        </>
                                    ) : (
                                        <TableHead>
                                            {t("portfolio.asset")}
                                        </TableHead>
                                    )}
                                    <TableHead className={headCellClass}>
                                        {t("portfolio.units")}
                                    </TableHead>
                                    <TableHead className={headCellClass}>
                                        {t("portfolio.avgCost")}
                                    </TableHead>
                                    <TableHead className={headCellClass}>
                                        {priceFreshnessLabel ? (
                                            <TooltipProvider>
                                                <Tooltip>
                                                    <TooltipTrigger asChild>
                                                        <Button
                                                            type="button"
                                                            variant="ghost"
                                                            size="sm"
                                                            aria-label={t(
                                                                "portfolio.priceFreshnessLabel",
                                                                {
                                                                    price: t(
                                                                        "portfolio.price",
                                                                    ),
                                                                    freshness:
                                                                        priceFreshnessLabel,
                                                                },
                                                            )}
                                                            className="-mr-2 h-7 gap-1 px-2 type-footnote font-medium text-label-secondary"
                                                        >
                                                            {t(
                                                                "portfolio.price",
                                                            )}
                                                            <Info
                                                                className="h-3 w-3"
                                                                aria-hidden
                                                            />
                                                        </Button>
                                                    </TooltipTrigger>
                                                    <TooltipContent>
                                                        {priceFreshnessLabel}
                                                    </TooltipContent>
                                                </Tooltip>
                                            </TooltipProvider>
                                        ) : (
                                            t("portfolio.price")
                                        )}
                                    </TableHead>
                                    <TableHead className={headCellClass}>
                                        {t("portfolio.value")}
                                    </TableHead>
                                    <TableHead className={headCellClass}>
                                        {t("portfolio.unrealized")}
                                    </TableHead>
                                    <TableHead className={headCellClass}>
                                        {t("portfolio.realized")}
                                    </TableHead>
                                    {pageHasFxExposure && (
                                        <TableHead className={headCellClass}>
                                            <TouchDisclosure
                                                label={t("portfolio.fxEffect")}
                                                content={t(
                                                    "portfolio.fxEffect",
                                                )}
                                            >
                                                {t("portfolio.fxPnl")}
                                            </TouchDisclosure>
                                        </TableHead>
                                    )}
                                    {showDividends && (
                                        <TableHead className={headCellClass}>
                                            {t("portfolio.dividends")}
                                        </TableHead>
                                    )}
                                    <TableHead className="w-12">
                                        <span className="sr-only">
                                            {t("portfolio.menu")}
                                        </span>
                                    </TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {holdings.map((h) => {
                                    const pnl = displayedPnlByHoldingId[h.id];
                                    const unrealized =
                                        pnl?.unrealizedTarget || 0;
                                    const realized = pnl?.realizedTarget || 0;
                                    const researchHref = h.symbol
                                        ? `/research/market?symbol=${encodeURIComponent(h.symbol)}&investmentId=${h.id}`
                                        : undefined;
                                    return (
                                        <TableRow key={h.id}>
                                            {assetCellVariant === "split" ? (
                                                <>
                                                    <TableCell className="font-mono text-primary">
                                                        {h.symbol || "—"}
                                                    </TableCell>
                                                    <TableCell>
                                                        <span className="inline-flex flex-wrap items-center gap-2">
                                                            {researchHref ? (
                                                                <TextLink
                                                                    to={
                                                                        researchHref
                                                                    }
                                                                    className="font-medium"
                                                                >
                                                                    {h.name}
                                                                </TextLink>
                                                            ) : (
                                                                <span className="font-medium">
                                                                    {h.name}
                                                                </span>
                                                            )}
                                                            <Badge
                                                                variant="outline"
                                                                size="sm"
                                                            >
                                                                {h.assetClass ===
                                                                "etf"
                                                                    ? t(
                                                                          "stocks.etf",
                                                                      )
                                                                    : h.assetClass ===
                                                                        "metals"
                                                                      ? t(
                                                                            "portfolio.assetClass.metals",
                                                                        )
                                                                      : t(
                                                                            "stocks.stock",
                                                                        )}
                                                            </Badge>
                                                            <PortfolioOversoldBadge
                                                                oversold={
                                                                    h.oversold
                                                                }
                                                            />
                                                        </span>
                                                    </TableCell>
                                                </>
                                            ) : (
                                                <TableCell>
                                                    <div className="flex items-center gap-3">
                                                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/12 text-primary">
                                                            <PageIcon
                                                                className="h-4 w-4"
                                                                aria-hidden
                                                            />
                                                        </span>
                                                        <span className="flex min-w-0 flex-col">
                                                            <span className="font-mono">
                                                                {h.symbol ||
                                                                    "?"}
                                                            </span>
                                                            {researchHref ? (
                                                                <TextLink
                                                                    to={
                                                                        researchHref
                                                                    }
                                                                    tone="muted"
                                                                    className="type-footnote"
                                                                >
                                                                    {h.name}
                                                                </TextLink>
                                                            ) : (
                                                                <span className="type-footnote text-label-secondary">
                                                                    {h.name}
                                                                </span>
                                                            )}
                                                        </span>
                                                        <PortfolioOversoldBadge
                                                            oversold={
                                                                h.oversold
                                                            }
                                                        />
                                                    </div>
                                                </TableCell>
                                            )}
                                            <TableCell
                                                className={cn(
                                                    "text-right tabular-nums",
                                                    unitsMonospace &&
                                                        "font-mono",
                                                )}
                                            >
                                                {h.totalUnits.toFixed(
                                                    unitsDecimals,
                                                )}
                                            </TableCell>
                                            <TableCell className="text-right tabular-nums text-label-secondary">
                                                {moneyPriceCol(
                                                    h.avgCostBasis,
                                                    h.currency,
                                                )}
                                            </TableCell>
                                            <TableCell className="text-right tabular-nums">
                                                <span className="inline-flex items-center justify-end gap-1">
                                                    {moneyPriceCol(
                                                        h.currentPrice ?? 0,
                                                        h.currency,
                                                    )}
                                                    <StalePriceIndicator
                                                        priceProvider={
                                                            h.price_provider
                                                        }
                                                        priceUpdatedAt={
                                                            h.price_updated_at
                                                        }
                                                    />
                                                </span>
                                            </TableCell>
                                            <TableCell className="text-right tabular-nums font-medium">
                                                {moneyPriceCol(
                                                    h.currentValue,
                                                    h.currency,
                                                )}
                                            </TableCell>
                                            <TableCell
                                                className={cn(
                                                    "whitespace-nowrap text-right tabular-nums font-medium",
                                                    toneClass(unrealized),
                                                )}
                                            >
                                                <Money
                                                    amount={unrealized}
                                                    currency={targetCurrency}
                                                    signed
                                                />
                                                <DeltaPill
                                                    value={
                                                        pnl?.unrealizedPercent ||
                                                        0
                                                    }
                                                    label={formatPercent(
                                                        pnl?.unrealizedPercent ||
                                                            0,
                                                        {
                                                            digits: 2,
                                                            signed: true,
                                                        },
                                                    )}
                                                    className="ml-1.5"
                                                />
                                            </TableCell>
                                            <TableCell
                                                className={cn(
                                                    "text-right tabular-nums",
                                                    realized !== 0
                                                        ? toneClass(realized)
                                                        : "text-label-secondary",
                                                )}
                                            >
                                                {realized !== 0 ? (
                                                    <Money
                                                        amount={realized}
                                                        currency={
                                                            targetCurrency
                                                        }
                                                        signed
                                                    />
                                                ) : (
                                                    "—"
                                                )}
                                            </TableCell>
                                            {pageHasFxExposure && (
                                                <FxPnlCell
                                                    holding={h}
                                                    fxInfo={fxInfoById.get(
                                                        h.id,
                                                    )}
                                                    targetCurrency={
                                                        targetCurrency
                                                    }
                                                    t={t}
                                                />
                                            )}
                                            {showDividends && (
                                                <TableCell
                                                    className={cn(
                                                        "text-right tabular-nums",
                                                        h.totalDividends > 0
                                                            ? "text-gain"
                                                            : "text-label-secondary",
                                                    )}
                                                >
                                                    {h.totalDividends > 0 ? (
                                                        <Money
                                                            amount={convertToTarget(
                                                                h.totalDividends,
                                                                h.currency,
                                                            )}
                                                            currency={
                                                                targetCurrency
                                                            }
                                                            signed
                                                        />
                                                    ) : (
                                                        "—"
                                                    )}
                                                </TableCell>
                                            )}
                                            <TableCell className="py-1 text-right">
                                                {renderMenu(h)}
                                            </TableCell>
                                        </TableRow>
                                    );
                                })}
                            </TableBody>
                        </Table>
                    </CardContent>
                </Card>

                <p className="type-footnote text-label-secondary">
                    {t(howItWorksKey)}
                </p>
            </PageShell>
            {dialogs}
        </>
    );
}
