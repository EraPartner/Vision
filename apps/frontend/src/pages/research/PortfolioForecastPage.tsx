import { useMemo, useState } from "react";
import {
    TrendingUp,
    Activity,
    Target,
    AlertTriangle,
    Wallet,
} from "lucide-react";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { formatCurrency, numberFormatToLocale } from "@/utils/currency";
import {
    formatDateWithAppSettings,
    parseLocalDateFromYmd,
} from "@/lib/dateUtils";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SegmentedButtons } from "@/components/shared/SegmentedButtons";
import {
    SegmentedControl,
    SegmentedControlItem,
} from "@/components/ui/segmented-control";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Skeleton } from "@/components/ui/skeleton";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import { LineChart, type LineSeries } from "@/components/charts";
import { PageHeader } from "@/components/shared/PageHeader";
import { StateBlock } from "@/components/shared/StateBlock";
import { StatCard } from "@/components/shared/StatCard";
import { Money } from "@/components/shared/Money";
import { RollingNumber } from "@/components/shared/RollingNumber";
import {
    useCurrencyPartsFormatter,
    usePercentFormatter,
} from "@/hooks/useCurrencyFormatter";
import { useDebounce } from "@/hooks/useDebounce";
import { cn } from "@/lib/utils";
import type { ForecastMethod, ForecastPoint } from "@/types/research";
import { EmptyState } from "@/components/shared/EmptyState";
import { PAGE_ICONS } from "@/lib/pageIcons";
import { PageShell } from "@/components/shared/PageShell";
import { usePortfolioForecastQuery } from "@/features/research/useResearchQueries";
import { parseDecimal } from "@/lib/decimal";
import LifeScenarioPanel from "./LifeScenarioPanel";

const HORIZONS = [
    { labelKey: "research.forecast.h1y", months: 12 },
    { labelKey: "research.forecast.h3y", months: 36 },
    { labelKey: "research.forecast.h5y", months: 60 },
    { labelKey: "research.forecast.h10y", months: 120 },
];
const PATH_OPTIONS = [500, 1000, 2000];

type ReturnSource = "historical" | "blended";

interface ForecastRow extends ForecastPoint {
    ts: number;
}

export default function PortfolioForecastPage() {
    const { t, language } = useLanguage();
    const loadingSurfaceProps = useLoadingSurfaceProps();
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);
    const currency = appSettings.defaultCurrency || "EUR";
    const formatPercent = usePercentFormatter();

    const [horizonMonths, setHorizonMonths] = useState(60);
    const [monthlyContribution, setMonthlyContribution] = useState("");
    const [returnSource, setReturnSource] =
        useState<ReturnSource>("historical");
    const [blendPct, setBlendPct] = useState(50);
    const [method, setMethod] = useState<ForecastMethod>("parametric");
    const [paths, setPaths] = useState(1000);
    const [targetValue, setTargetValue] = useState("");

    // Stat-tile money: same currency/locale/0-decimals resolution the chart axis
    // uses (formatCurrency(v, currency, locale, 0)), rendered with the Money
    // micro-typography. Same null/NaN → "—" gap handling as before.
    const moneyNode = (v: number | null | undefined) =>
        v == null || isNaN(v) ? (
            "—"
        ) : (
            <Money amount={v} currency={currency} fractionDigits={0} />
        );
    // Headline tile keeps the odometer it had when it took a plain string, with
    // the Money treatment riding along inside it.
    const fmtParts = useCurrencyPartsFormatter();
    const moneyOdometer = (v: number | null | undefined) =>
        v == null || isNaN(v) ? (
            "—"
        ) : (
            <RollingNumber parts={fmtParts(v, { currency, decimals: 0 })} />
        );
    const fmtPct = (v: number | null | undefined, signed = false) =>
        v == null || isNaN(v)
            ? "—"
            : formatPercent(v * 100, { digits: 1, signed });

    const input = useMemo(
        () => ({
            horizonMonths,
            monthlyContribution: parseDecimal(
                monthlyContribution,
                appSettings.numberFormat,
            ),
            forwardBlend: returnSource === "blended" ? blendPct / 100 : 0,
            method,
            paths,
            targetValue:
                parseDecimal(targetValue, appSettings.numberFormat, NaN) ||
                undefined,
            currency,
        }),
        [
            horizonMonths,
            monthlyContribution,
            returnSource,
            blendPct,
            method,
            paths,
            targetValue,
            currency,
            appSettings.numberFormat,
        ],
    );
    const debouncedInput = useDebounce(input, 450);

    const {
        data: result,
        isFetching,
        isError,
    } = usePortfolioForecastQuery(debouncedInput);
    const forecast = result?.data;

    const { rows, series } = useMemo(() => {
        const points = forecast?.points ?? [];
        const r: ForecastRow[] = points.map((p) => ({
            ...p,
            ts: parseLocalDateFromYmd(p.date).getTime(),
        }));
        const s: LineSeries<ForecastRow>[] = [
            {
                key: "p90",
                label: t("research.forecast.p90"),
                accessor: (d) => d.p90,
                color: "hsl(var(--accent))",
                strokeWidth: 1,
                dashed: true,
            },
            {
                key: "p75",
                label: t("research.forecast.p75"),
                accessor: (d) => d.p75,
                color: "hsl(var(--accent))",
                strokeWidth: 1,
            },
            {
                key: "p50",
                label: t("research.forecast.p50"),
                accessor: (d) => d.p50,
                color: "hsl(var(--primary))",
                strokeWidth: 2.5,
            },
            {
                key: "p25",
                label: t("research.forecast.p25"),
                accessor: (d) => d.p25,
                color: "hsl(var(--destructive))",
                strokeWidth: 1,
            },
            {
                key: "p10",
                label: t("research.forecast.p10"),
                accessor: (d) => d.p10,
                color: "hsl(var(--destructive))",
                strokeWidth: 1,
                dashed: true,
            },
            {
                key: "netInvested",
                label: t("research.forecast.netInvested"),
                accessor: (d) => d.netInvested,
                color: "hsl(var(--muted-foreground))",
                strokeWidth: 1.5,
                dashed: true,
            },
        ];
        return { rows: r, series: s };
    }, [forecast, t]);

    const unavailable = forecast && forecast.available === false;

    return (
        <PageShell className="">
            <PageHeader
                title={t("research.forecast.title")}
                subtitle={t("research.forecast.subtitle")}
                icon={PAGE_ICONS["/research/forecast"]}
            />

            {/* Controls */}
            <Card>
                <CardContent
                    variant="headerless"
                    className="grid gap-6 md:grid-cols-2 lg:grid-cols-3"
                >
                    <div className="space-y-2">
                        <p
                            id="forecast-horizon-label"
                            className="type-body font-medium text-foreground"
                        >
                            {t("research.forecast.horizon")}
                        </p>
                        <SegmentedButtons
                            aria-labelledby="forecast-horizon-label"
                            options={HORIZONS}
                            getKey={(h) => h.months}
                            getLabel={(h) => t(h.labelKey)}
                            isSelected={(h) => horizonMonths === h.months}
                            onSelect={(h) => setHorizonMonths(h.months)}
                        />
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="contribution">
                            {t("research.forecast.monthlyContribution")}
                        </Label>
                        <Input
                            id="contribution"
                            type="text"
                            inputMode="decimal"
                            placeholder="0"
                            value={monthlyContribution}
                            onChange={(e) =>
                                setMonthlyContribution(e.target.value)
                            }
                        />
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="target">
                            {t("research.forecast.targetValue")}
                        </Label>
                        <Input
                            id="target"
                            type="text"
                            inputMode="decimal"
                            placeholder={t(
                                "research.forecast.targetPlaceholder",
                            )}
                            value={targetValue}
                            onChange={(e) => setTargetValue(e.target.value)}
                        />
                    </div>

                    <details className="group rounded-card corner-continuous border border-border/60 md:col-span-2 lg:col-span-3">
                        <summary className="cursor-pointer rounded-card px-4 py-3 type-body text-foreground marker:text-label-tertiary focus-ring">
                            <span className="font-medium">
                                {t("research.forecast.assumptions")}
                            </span>
                            <span className="mt-1 block type-footnote text-label-secondary">
                                {t(
                                    returnSource === "historical"
                                        ? "research.forecast.sourceHistorical"
                                        : "research.forecast.sourceBlended",
                                )}
                                {returnSource === "blended" &&
                                    ` (${t("research.forecast.blendValue", { historical: 100 - blendPct, forward: blendPct })})`}
                                {" · "}
                                {t(
                                    method === "parametric"
                                        ? "research.forecast.methodParametric"
                                        : "research.forecast.methodBootstrap",
                                )}
                                {" · "}
                                {t("research.forecast.paths")}:{" "}
                                {paths.toLocaleString(locale)}
                            </span>
                        </summary>
                        <div className="grid gap-6 border-t border-border/60 p-4 md:grid-cols-2 lg:grid-cols-3">
                            <div className="space-y-2">
                                <p
                                    id="forecast-return-source-label"
                                    className="type-body font-medium text-foreground"
                                >
                                    {t("research.forecast.returnSource")}
                                </p>
                                <SegmentedControl
                                    size="sm"
                                    value={returnSource}
                                    onValueChange={(v) =>
                                        setReturnSource(v as ReturnSource)
                                    }
                                    aria-labelledby="forecast-return-source-label"
                                >
                                    <SegmentedControlItem value="historical">
                                        {t("research.forecast.sourceHistorical")}
                                    </SegmentedControlItem>
                                    <SegmentedControlItem value="blended">
                                        {t("research.forecast.sourceBlended")}
                                    </SegmentedControlItem>
                                </SegmentedControl>
                                {returnSource === "blended" && (
                                    <div className="pt-1">
                                        <div className="flex justify-between type-footnote text-label-secondary">
                                            <span>
                                                {100 - blendPct}%{" "}
                                                {t(
                                                    "research.forecast.blendHistorical",
                                                )}
                                            </span>
                                            <span className="tabular-nums">
                                                {blendPct}%{" "}
                                                {t(
                                                    "research.forecast.blendForward",
                                                )}
                                            </span>
                                        </div>
                                        <Slider
                                            className="mt-2"
                                            aria-label={t(
                                                "research.forecast.blendLabel",
                                            )}
                                            aria-valuetext={t(
                                                "research.forecast.blendValue",
                                                {
                                                    historical: 100 - blendPct,
                                                    forward: blendPct,
                                                },
                                            )}
                                            value={[blendPct]}
                                            min={0}
                                            max={100}
                                            step={5}
                                            onValueChange={(v) =>
                                                setBlendPct(v[0])
                                            }
                                        />
                                    </div>
                                )}
                            </div>

                            <div className="space-y-2">
                                <p
                                    id="forecast-method-label"
                                    className="type-body font-medium text-foreground"
                                >
                                    {t("research.forecast.method")}
                                </p>
                                <SegmentedControl
                                    size="sm"
                                    value={method}
                                    onValueChange={(v) =>
                                        setMethod(v as ForecastMethod)
                                    }
                                    aria-labelledby="forecast-method-label"
                                >
                                    <SegmentedControlItem value="parametric">
                                        {t("research.forecast.methodParametric")}
                                    </SegmentedControlItem>
                                    <SegmentedControlItem value="block_bootstrap">
                                        {t("research.forecast.methodBootstrap")}
                                    </SegmentedControlItem>
                                </SegmentedControl>
                            </div>

                            <div className="space-y-2">
                                <p
                                    id="forecast-paths-label"
                                    className="type-body font-medium text-foreground"
                                >
                                    {t("research.forecast.paths")}
                                </p>
                                <SegmentedButtons
                                    aria-labelledby="forecast-paths-label"
                                    options={PATH_OPTIONS}
                                    getKey={(p) => p}
                                    getLabel={(p) => p}
                                    isSelected={(p) => paths === p}
                                    onSelect={setPaths}
                                    buttonClassName="tabular-nums"
                                />
                            </div>
                        </div>
                    </details>
                </CardContent>
            </Card>

            {isError && (
                <Card>
                    <CardContent variant="flush">
                        <StateBlock
                            size="compact"
                            tone="destructive"
                            icon={AlertTriangle}
                            title={t("research.forecast.error")}
                        />
                    </CardContent>
                </Card>
            )}

            {unavailable && (
                <Card>
                    <CardContent variant="flush">
                        <EmptyState
                            size="compact"
                            icon={AlertTriangle}
                            title={
                                forecast?.reason === "no_holdings"
                                    ? t("research.forecast.noHoldings")
                                    : t("research.forecast.insufficientHistory")
                            }
                        />
                    </CardContent>
                </Card>
            )}

            {!unavailable && (
                <>
                    {/* Summary — the four StatCards go busy together, so the grid
              announces once for the row instead of each card announcing. */}
                    <div
                        {...(isFetching && !forecast
                            ? loadingSurfaceProps
                            : {})}
                        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
                    >
                        <StatCard
                            icon={Wallet}
                            title={t("research.forecast.projectedMedian")}
                            loading={isFetching && !forecast}
                            value={moneyOdometer(forecast?.projected?.p50)}
                            subtitle={
                                forecast ? (
                                    <>
                                        {moneyNode(forecast.projected?.p10)} –{" "}
                                        {moneyNode(forecast.projected?.p90)}
                                    </>
                                ) : undefined
                            }
                        />
                        <StatCard
                            icon={TrendingUp}
                            title={t("research.forecast.expectedReturn")}
                            loading={isFetching && !forecast}
                            value={fmtPct(forecast?.expectedAnnualReturn, true)}
                            subtitle={
                                forecast?.usedForward
                                    ? t("research.forecast.blendedHint")
                                    : t("research.forecast.historicalHint")
                            }
                        />
                        <StatCard
                            icon={Activity}
                            title={t("research.forecast.volatility")}
                            loading={isFetching && !forecast}
                            value={fmtPct(forecast?.annualVolatility)}
                            subtitle={t("research.forecast.annualized")}
                        />
                        <StatCard
                            icon={Target}
                            title={
                                forecast?.targetValue
                                    ? t("research.forecast.probTarget")
                                    : t("research.forecast.probBelowInvested")
                            }
                            loading={isFetching && !forecast}
                            value={fmtPct(
                                forecast?.targetValue
                                    ? forecast?.probTarget
                                    : forecast?.probBelowInvested,
                            )}
                            subtitle={
                                forecast?.targetValue
                                    ? moneyNode(forecast.targetValue)
                                    : moneyNode(forecast?.netInvested)
                            }
                        />
                    </div>

                    {/* Fan chart */}
                    <Card>
                        <CardHeader className="pb-2">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <CardTitle variant="sm">
                                    {t("research.forecast.chartTitle")}
                                </CardTitle>
                                {forecast?.lowConfidence && (
                                    <Badge variant="warning" size="sm">
                                        {t("research.forecast.lowConfidence")}
                                    </Badge>
                                )}
                            </div>
                        </CardHeader>
                        <CardContent>
                            {isFetching && !forecast ? (
                                <Skeleton
                                    {...loadingSurfaceProps}
                                    className="h-[360px] w-full"
                                />
                            ) : rows.length > 0 ? (
                                <LineChart<ForecastRow>
                                    data={rows}
                                    xAccessor={(d) => new Date(d.ts)}
                                    xIsDate
                                    height={360}
                                    series={series}
                                    xTickFormat={(v) =>
                                        new Intl.DateTimeFormat(language, {
                                            month: "short",
                                            year: "numeric",
                                        }).format(v as Date)
                                    }
                                    yTickFormat={(v) =>
                                        formatCurrency(v, currency, locale, 0)
                                    }
                                    tooltipTitle={(d) =>
                                        formatDateWithAppSettings(
                                            new Date(d.ts),
                                            appSettings.dateFormat,
                                        )
                                    }
                                    tooltipValueFormat={(v) =>
                                        formatCurrency(v, currency, locale, 0)
                                    }
                                />
                            ) : (
                                <div className="flex h-[360px] items-center justify-center type-callout text-label-secondary">
                                    {t("research.forecast.noData")}
                                </div>
                            )}
                        </CardContent>
                    </Card>

                    {/* Forward inputs provenance */}
                    {forecast?.usedForward &&
                        forecast.forwardHoldings &&
                        forecast.forwardHoldings.length > 0 && (
                            <Card>
                                <CardHeader className="pb-2">
                                    <CardTitle variant="sm">
                                        {t("research.forecast.forwardInputs")}
                                    </CardTitle>
                                    <CardDescription>
                                        {t(
                                            "research.forecast.forwardInputsHint",
                                        )}
                                    </CardDescription>
                                </CardHeader>
                                <CardContent className="flex flex-wrap gap-2">
                                    {forecast.forwardHoldings.map((h) => (
                                        <Badge
                                            key={h.symbol}
                                            variant="secondary"
                                            className="gap-1.5 py-1"
                                        >
                                            <span className="font-mono">
                                                {h.symbol}
                                            </span>
                                            <span
                                                className={cn(
                                                    "tabular-nums",
                                                    h.expectedAnnual >= 0
                                                        ? "text-gain"
                                                        : "text-loss",
                                                )}
                                            >
                                                {fmtPct(h.expectedAnnual, true)}
                                            </span>
                                        </Badge>
                                    ))}
                                </CardContent>
                            </Card>
                        )}
                </>
            )}
            <LifeScenarioPanel
                forecastInput={input}
                currency={currency}
                locale={locale}
                numberFormat={appSettings.numberFormat}
            />
        </PageShell>
    );
}
