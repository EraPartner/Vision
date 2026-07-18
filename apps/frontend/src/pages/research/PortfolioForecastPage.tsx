import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { TrendingUp, Activity, Target, AlertTriangle, Sparkles, Wallet } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { numberFormatToLocale, formatCurrency } from "@/utils/currency";
import { formatDateWithAppSettings } from "@/components/shared/dateUtils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SegmentedButtons } from "@/components/shared/SegmentedButtons";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LineChart, type LineSeries } from "@/components/charts";
import { PageHeader } from "@/components/shared/PageHeader";
import { StatCard } from "@/components/dashboard/StatCard";
import { useDebounce } from "@/hooks/useDebounce";
import { apiClient } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { ForecastMethod, ForecastPoint } from "@/types/research";

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
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const currency = appSettings.defaultCurrency || "EUR";

  const [horizonMonths, setHorizonMonths] = useState(60);
  const [monthlyContribution, setMonthlyContribution] = useState("");
  const [returnSource, setReturnSource] = useState<ReturnSource>("historical");
  const [blendPct, setBlendPct] = useState(50);
  const [method, setMethod] = useState<ForecastMethod>("parametric");
  const [paths, setPaths] = useState(1000);
  const [targetValue, setTargetValue] = useState("");

  const fmtMoney = (v: number | null | undefined) =>
    v == null || isNaN(v) ? "—" : formatCurrency(v, currency, locale, 0);
  const fmtPct = (v: number | null | undefined, signed = false) =>
    v == null || isNaN(v) ? "—" : `${signed && v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;

  const input = useMemo(
    () => ({
      horizonMonths,
      monthlyContribution: Number(monthlyContribution) || 0,
      forwardBlend: returnSource === "blended" ? blendPct / 100 : 0,
      method,
      paths,
      targetValue: Number(targetValue) || undefined,
      currency,
    }),
    [horizonMonths, monthlyContribution, returnSource, blendPct, method, paths, targetValue, currency],
  );
  const debouncedInput = useDebounce(input, 450);

  const { data: result, isFetching, isError } = useQuery({
    queryKey: ["portfolio-forecast", debouncedInput],
    queryFn: () => apiClient.getPortfolioForecast(debouncedInput),
    staleTime: 5 * 60 * 1000,
  });
  const forecast = result?.data;

  const { rows, series } = useMemo(() => {
    const points = forecast?.points ?? [];
    const r: ForecastRow[] = points.map((p) => ({ ...p, ts: new Date(p.date).getTime() }));
    const s: LineSeries<ForecastRow>[] = [
      { key: "p90", label: t("research.forecast.p90"), accessor: (d) => d.p90, color: "hsl(var(--accent))", strokeWidth: 1, dashed: true },
      { key: "p75", label: t("research.forecast.p75"), accessor: (d) => d.p75, color: "hsl(var(--accent))", strokeWidth: 1 },
      { key: "p50", label: t("research.forecast.p50"), accessor: (d) => d.p50, color: "hsl(var(--primary))", strokeWidth: 2.5 },
      { key: "p25", label: t("research.forecast.p25"), accessor: (d) => d.p25, color: "hsl(var(--destructive))", strokeWidth: 1 },
      { key: "p10", label: t("research.forecast.p10"), accessor: (d) => d.p10, color: "hsl(var(--destructive))", strokeWidth: 1, dashed: true },
      { key: "netInvested", label: t("research.forecast.netInvested"), accessor: (d) => d.netInvested, color: "hsl(var(--muted-foreground))", strokeWidth: 1.5, dashed: true },
    ];
    return { rows: r, series: s };
  }, [forecast, t]);

  const unavailable = forecast && forecast.available === false;

  return (
    <div className="space-y-6 animate-in">
      <PageHeader
        title={t("research.forecast.title")}
        subtitle={t("research.forecast.subtitle")}
        icon={TrendingUp}
      />

      {/* Controls */}
      <Card className="glass-regular">
        <CardContent className="grid gap-6 pt-6 md:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-2">
            <Label>{t("research.forecast.horizon")}</Label>
            <SegmentedButtons
              options={HORIZONS}
              getKey={(h) => h.months}
              getLabel={(h) => t(h.labelKey)}
              isSelected={(h) => horizonMonths === h.months}
              onSelect={(h) => setHorizonMonths(h.months)}
              buttonClassName="h-8 px-3 text-xs"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="contribution">{t("research.forecast.monthlyContribution")}</Label>
            <Input
              id="contribution"
              type="number"
              min={0}
              inputMode="decimal"
              placeholder="0"
              value={monthlyContribution}
              onChange={(e) => setMonthlyContribution(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="target">{t("research.forecast.targetValue")}</Label>
            <Input
              id="target"
              type="number"
              min={0}
              inputMode="decimal"
              placeholder={t("research.forecast.targetPlaceholder")}
              value={targetValue}
              onChange={(e) => setTargetValue(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label>{t("research.forecast.returnSource")}</Label>
            <Tabs value={returnSource} onValueChange={(v) => setReturnSource(v as ReturnSource)}>
              <TabsList className="h-8">
                <TabsTrigger value="historical" className="text-xs">{t("research.forecast.sourceHistorical")}</TabsTrigger>
                <TabsTrigger value="blended" className="text-xs">{t("research.forecast.sourceBlended")}</TabsTrigger>
              </TabsList>
            </Tabs>
            {returnSource === "blended" && (
              <div className="pt-1">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>{t("research.forecast.blendHistorical")}</span>
                  <span className="tabular-nums">{blendPct}% {t("research.forecast.blendForward")}</span>
                </div>
                <Slider
                  className="mt-2"
                  value={[blendPct]}
                  min={0}
                  max={100}
                  step={5}
                  onValueChange={(v) => setBlendPct(v[0])}
                />
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label>{t("research.forecast.method")}</Label>
            <Tabs value={method} onValueChange={(v) => setMethod(v as ForecastMethod)}>
              <TabsList className="h-8">
                <TabsTrigger value="parametric" className="text-xs">{t("research.forecast.methodParametric")}</TabsTrigger>
                <TabsTrigger value="block_bootstrap" className="text-xs">{t("research.forecast.methodBootstrap")}</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          <div className="space-y-2">
            <Label>{t("research.forecast.paths")}</Label>
            <SegmentedButtons
              options={PATH_OPTIONS}
              getKey={(p) => p}
              getLabel={(p) => p}
              isSelected={(p) => paths === p}
              onSelect={setPaths}
              buttonClassName="h-8 px-3 text-xs tabular-nums"
            />
          </div>
        </CardContent>
      </Card>

      {isError && (
        <Card className="glass-regular"><CardContent className="py-8 text-center text-sm text-destructive">{t("research.forecast.error")}</CardContent></Card>
      )}

      {unavailable && (
        <Card className="glass-regular">
          <CardContent className="flex flex-col items-center gap-2 py-16 text-center">
            <AlertTriangle className="h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground max-w-sm">
              {forecast?.reason === "no_holdings"
                ? t("research.forecast.noHoldings")
                : t("research.forecast.insufficientHistory")}
            </p>
          </CardContent>
        </Card>
      )}

      {!unavailable && (
        <>
          {/* Summary */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              icon={Wallet}
              title={t("research.forecast.projectedMedian")}
              loading={isFetching && !forecast}
              value={fmtMoney(forecast?.projected?.p50)}
              subtitle={forecast ? `${fmtMoney(forecast.projected?.p10)} – ${fmtMoney(forecast.projected?.p90)}` : undefined}
            />
            <StatCard
              icon={TrendingUp}
              title={t("research.forecast.expectedReturn")}
              loading={isFetching && !forecast}
              value={fmtPct(forecast?.expectedAnnualReturn, true)}
              subtitle={forecast?.usedForward ? t("research.forecast.blendedHint") : t("research.forecast.historicalHint")}
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
              title={forecast?.targetValue ? t("research.forecast.probTarget") : t("research.forecast.probBelowInvested")}
              loading={isFetching && !forecast}
              value={fmtPct(forecast?.targetValue ? forecast?.probTarget : forecast?.probBelowInvested)}
              subtitle={forecast?.targetValue ? fmtMoney(forecast.targetValue) : fmtMoney(forecast?.netInvested)}
            />
          </div>

          {/* Fan chart */}
          <Card className="glass-regular">
            <CardHeader className="pb-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-base">{t("research.forecast.chartTitle")}</CardTitle>
                {forecast?.lowConfidence && (
                  <Badge variant="outline" className="border-warning/40 text-warning text-[10px]">
                    {t("research.forecast.lowConfidence")}
                  </Badge>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {isFetching && !forecast ? (
                <Skeleton className="h-[360px] w-full rounded-lg" />
              ) : rows.length > 0 ? (
                <LineChart<ForecastRow>
                  data={rows}
                  xAccessor={(d) => new Date(d.ts)}
                  xIsDate
                  height={360}
                  series={series}
                  xTickFormat={(v) => formatDateWithAppSettings(v as Date, appSettings.dateFormat)}
                  yTickFormat={(v) => formatCurrency(v, currency, locale, 0)}
                  tooltipTitle={(d) => formatDateWithAppSettings(new Date(d.ts), appSettings.dateFormat)}
                  tooltipValueFormat={(v) => formatCurrency(v, currency, locale, 0)}
                />
              ) : (
                <div className="flex h-[360px] items-center justify-center text-sm text-muted-foreground">
                  {t("research.forecast.noData")}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Forward inputs provenance */}
          {forecast?.usedForward && forecast.forwardHoldings && forecast.forwardHoldings.length > 0 && (
            <Card className="glass-regular">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Sparkles className="h-4 w-4 text-primary" />
                  {t("research.forecast.forwardInputs")}
                </CardTitle>
                <p className="text-xs text-muted-foreground">{t("research.forecast.forwardInputsHint")}</p>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {forecast.forwardHoldings.map((h) => (
                  <Badge key={h.symbol} variant="secondary" className="gap-1.5 py-1">
                    <span className="font-mono">{h.symbol}</span>
                    <span className={cn("tabular-nums", h.expectedAnnual >= 0 ? "amount-gain" : "amount-loss")}>
                      {fmtPct(h.expectedAnnual, true)}
                    </span>
                  </Badge>
                ))}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

