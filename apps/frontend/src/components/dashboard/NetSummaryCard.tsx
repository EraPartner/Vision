import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CardSheen } from "@/components/shared/CardSheen";
import { Badge } from "@/components/ui/badge";
import { Sparkline as ChartSparkline } from "@/components/charts";
import { RollingNumber } from "@/components/shared/RollingNumber";
import { ArrowUpRight, DollarSign, TrendingDown } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { numberFormatToLocale } from "@/utils/currency";
import { useChartCurrencyFormatter } from "@/hooks/useChartCurrencyFormatter";
import { formatMonthYearWithAppSettings } from "@/components/shared/dateUtils";
import type { NetHistoryPoint } from "@/hooks/useFilteredDashboardStats";

interface NetSummaryCardProps {
  netBalance: number;
  income: number;
  spending: number;
  history: NetHistoryPoint[];
}

export function NetSummaryCard({ netBalance, income, spending, history }: NetSummaryCardProps) {
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const { formatCompact } = useChartCurrencyFormatter();

  // Scrubbing the sparkline drives the hero number through netHistory;
  // releasing/leaving snaps back to the live month. Card-level tint and the
  // header icon deliberately stay bound to the live value so the whole card
  // doesn't strobe while scrubbing.
  const [scrubIndex, setScrubIndex] = useState<number | undefined>(undefined);
  const scrubPoint = scrubIndex !== undefined ? history[scrubIndex] : undefined;

  const scrubFromEvent = (e: React.PointerEvent<HTMLDivElement>) => {
    if (history.length < 2) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const frac = (e.clientX - rect.left) / rect.width;
    const idx = Math.round(frac * (history.length - 1));
    setScrubIndex(Math.max(0, Math.min(history.length - 1, idx)));
  };

  const isPositive = netBalance >= 0;

  const savingsRate = income > 0 ? ((income - spending) / income) * 100 : null;
  const incomeTotal = Math.max(income, 0);
  const spendingTotal = Math.max(spending, 0);
  const splitTotal = incomeTotal + spendingTotal;
  const incomePct = splitTotal > 0 ? (incomeTotal / splitTotal) * 100 : 50;
  const spendingPct = splitTotal > 0 ? (spendingTotal / splitTotal) * 100 : 50;

  const chartData = history.map((p) => ({
    label: formatMonthYearWithAppSettings(new Date(p.year, p.month - 1, 1), appSettings.dateFormat, locale),
    net: p.net,
  }));

  const trendGradient = isPositive ? "from-gain/10 to-gain/5" : "from-loss/10 to-loss/5";
  const areaStroke = isPositive ? "hsl(var(--gain))" : "hsl(var(--loss))";

  const shownNet = scrubPoint ? scrubPoint.net : netBalance;
  const netColor = shownNet >= 0 ? "amount-gain" : "amount-loss";
  const netCompact = formatCompact(shownNet);
  const incomeCompact = formatCompact(incomeTotal);
  const spendingCompact = formatCompact(spendingTotal);

  return (
    <Card
      variant="interactive"
      className="glass-elevated group overflow-hidden flex flex-col h-full">
      <div className={`absolute inset-0 pointer-events-none rounded-[inherit] bg-gradient-to-br ${trendGradient}`} />
      <CardSheen animated />

      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
        <div>
          <CardTitle className="text-sm font-semibold text-muted-foreground">
            {t('dashboard.stat.lastMonthNet')}
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            {isPositive ? t('dashboard.stat.positiveCashFlow') : t('dashboard.stat.negativeCashFlow')}
          </p>
        </div>
        <div className={`h-11 w-11 rounded-xl flex items-center justify-center shadow-[0_2px_8px_-2px_hsl(var(--primary)/0.25)] transition-transform duration-300 group-hover:scale-105 bg-gradient-to-br ${isPositive ? 'from-gain/20 to-gain/10 text-gain' : 'from-loss/20 to-loss/10 text-loss'}`}>
          <DollarSign className="h-5 w-5" />
        </div>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-4">
        <div className="flex items-end gap-3 flex-wrap">
          <div className={`text-4xl md:text-5xl font-bold tabular-nums ${netColor}`}>
            <span title={netCompact.isCompact ? netCompact.full : undefined}>
              <RollingNumber value={netCompact.display} />
            </span>
          </div>
          {savingsRate !== null && (
            <Badge variant="outline" className="font-semibold text-xs">
              {t('dashboard.stat.savingsRate')}: {savingsRate.toFixed(1)}%
            </Badge>
          )}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{t('dashboard.stat.incomeVsSpending')}</span>
          </div>
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted/50 flex">
            <div
              role="img"
              className="h-full bg-gain transition-[width] duration-700"
              style={{ width: `${incomePct}%` }}
              aria-label={t('dashboard.stat.income')}
            />
            <div
              role="img"
              className="h-full bg-loss transition-[width] duration-700"
              style={{ width: `${spendingPct}%` }}
              aria-label={t('dashboard.stat.spending')}
            />
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              <ArrowUpRight className="h-3.5 w-3.5 text-gain" />
              <span className="tabular-nums text-foreground" title={incomeCompact.isCompact ? incomeCompact.full : undefined}>{incomeCompact.display}</span>
            </span>
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              <span className="tabular-nums text-foreground" title={spendingCompact.isCompact ? spendingCompact.full : undefined}>{spendingCompact.display}</span>
              <TrendingDown className="h-3.5 w-3.5 text-loss" />
            </span>
          </div>
        </div>

        {chartData.length > 1 && (
          <div
            className="mt-auto cursor-crosshair select-none"
            style={{ touchAction: "pan-y" }}
            onPointerMove={scrubFromEvent}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              scrubFromEvent(e);
            }}
            onPointerUp={() => setScrubIndex(undefined)}
            onPointerCancel={() => setScrubIndex(undefined)}
            onPointerLeave={() => setScrubIndex(undefined)}
          >
            <p className={`text-xs mb-1 ${scrubPoint ? "font-medium text-foreground" : "text-muted-foreground"}`}>
              {scrubPoint && scrubIndex !== undefined
                ? chartData[scrubIndex].label
                : t('dashboard.stat.netTrend', { n: chartData.length })}
            </p>
            <ChartSparkline data={chartData.map((d) => d.net)} height={80} color={areaStroke} fillArea strokeWidth={2} activeIndex={scrubIndex} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
