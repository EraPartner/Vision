import { memo, useMemo, useState } from "react";
import { BarChart, type BarSeries, type BarOverlay } from "@/components/charts";
import { useLanguage } from "@/contexts/LanguageContext";
import { useChartCurrencyFormatter } from "@/hooks/useChartCurrencyFormatter";
import { formatPeriodShort } from "./statisticsUtils";
import { computeRollingAverage } from "@/utils/rollingAverage";
import type { StatisticsData } from "@/hooks/useStatistics";

const ROLLING_WINDOW = 3;

interface IncomeSpendingDatum {
  period: string;
  income: number;
  spending: number;
  incomeAvg: number | null;
  spendingAvg: number | null;
}

interface MonthlyChartProps {
  data: StatisticsData;
}

export const MonthlyChart = memo(function MonthlyChart({ data }: MonthlyChartProps) {
  const { t } = useLanguage();
  const { formatCurrency, currencySymbol } = useChartCurrencyFormatter();
  const [showOverlay, setShowOverlay] = useState(false);

  const chartData: IncomeSpendingDatum[] = useMemo(() => {
    const raw = data.monthlyData.map((m) => ({
      period: formatPeriodShort(m.period),
      income: Math.round(m.income),
      spending: Math.round(m.spending),
    }));

    const incomeAvgs = computeRollingAverage(raw.map((d) => d.income), ROLLING_WINDOW);
    const spendingAvgs = computeRollingAverage(raw.map((d) => d.spending), ROLLING_WINDOW);

    return raw.map((d, i) => ({
      ...d,
      incomeAvg: incomeAvgs[i] !== null ? Math.round(incomeAvgs[i]!) : null,
      spendingAvg: spendingAvgs[i] !== null ? Math.round(spendingAvgs[i]!) : null,
    }));
  }, [data.monthlyData]);

  const series: BarSeries<IncomeSpendingDatum>[] = useMemo(() => [
    { key: "income", label: t("statsPage.income"), accessor: (d) => d.income, color: "hsl(var(--gain))" },
    { key: "spending", label: t("statsPage.spending"), accessor: (d) => d.spending, color: "hsl(var(--loss))" },
  ], [t]);

  const overlays: BarOverlay<IncomeSpendingDatum>[] = useMemo(() => {
    if (!showOverlay) return [];
    return [
      {
        key: "incomeAvg",
        label: t("statsPage.incomeAvg", { n: String(ROLLING_WINDOW) }),
        accessor: (d) => d.incomeAvg,
        color: "hsl(var(--gain) / 0.7)",
        strokeWidth: 2,
        strokeDasharray: "4 3",
      },
      {
        key: "spendingAvg",
        label: t("statsPage.spendingAvg", { n: String(ROLLING_WINDOW) }),
        accessor: (d) => d.spendingAvg,
        color: "hsl(var(--loss) / 0.7)",
        strokeWidth: 2,
        strokeDasharray: "4 3",
      },
    ];
  }, [showOverlay, t]);

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <button
          onClick={() => setShowOverlay((v) => !v)}
          className={`text-xs px-2 py-1 rounded-md border transition-colors ${
            showOverlay
              ? "bg-primary/10 border-primary/30 text-primary"
              : "border-border text-muted-foreground hover:text-foreground hover:border-border/80"
          }`}
        >
          {t("statsPage.toggleRollingAvg", { n: ROLLING_WINDOW })}
        </button>
      </div>
      <BarChart<IncomeSpendingDatum>
        data={chartData}
        categoryAccessor={(d) => d.period}
        series={series}
        overlays={overlays}
        height={350}
        valueTickFormat={(v) => `${currencySymbol}${(v / 1000).toFixed(0)}k`}
        tooltipValueFormat={(v) => formatCurrency(v)}
      />
    </div>
  );
});
