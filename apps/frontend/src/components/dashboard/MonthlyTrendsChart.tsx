import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from "recharts";
import { TrendingUp } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { formatCurrency, numberFormatToLocale } from "@/utils/currency";
import { chartTooltipStyle, chartTooltipLabelStyle } from "@/components/shared/chartStyles";
import { formatMonthYearWithAppSettings } from "@/components/shared/dateUtils";

interface MonthlyTrendsChartProps {
  data: Array<{
    month: number;
    year: number;
    period_start: string;
    period_end: string;
    total_spending: number;
    total_income: number;
    net_amount: number;
    transaction_count: number;
  }>;
  embedded?: boolean;
}

export function MonthlyTrendsChart({ data, embedded = false }: MonthlyTrendsChartProps) {
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const defaultCurrency = appSettings.defaultCurrency || "EUR";

  const formatCompactCurrency = (value: number) => new Intl.NumberFormat(locale, {
    style: "currency",
    currency: defaultCurrency,
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
  // Transform data for the chart
  const chartData = data.map((monthData) => {
    const date = new Date(monthData.year, monthData.month - 1, 1);

    return {
      month: formatMonthYearWithAppSettings(date, appSettings.dateFormat, locale),
      income: monthData.total_income,
      spending: Math.abs(monthData.total_spending),
      transactions: monthData.transaction_count,
    };
  });

  const totalIncome = data.reduce((sum, m) => sum + m.total_income, 0);
  const totalSpending = Math.abs(data.reduce((sum, m) => sum + m.total_spending, 0));

  const chartContent = (
    <>
      <ResponsiveContainer width="100%" height={320}>
        <BarChart data={chartData} margin={{ top: 10, right: 10, left: 10, bottom: 20 }}>
          <defs>
            <linearGradient id="incomeGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="hsl(142 76% 36%)" stopOpacity={0.8} />
              <stop offset="95%" stopColor="hsl(142 76% 36%)" stopOpacity={0.3} />
            </linearGradient>
            <linearGradient id="spendingGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="hsl(0 84% 60%)" stopOpacity={0.8} />
              <stop offset="95%" stopColor="hsl(0 84% 60%)" stopOpacity={0.3} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border" opacity={0.5} />
          <XAxis
            dataKey="month"
            tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
            angle={-15}
            textAnchor="end"
            height={60}
            interval="preserveStartEnd"
            minTickGap={20}
          />
          <YAxis
            tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
            tickFormatter={(value) => formatCompactCurrency(value)}
          />
          <Tooltip
            contentStyle={chartTooltipStyle}
            formatter={(value: number, name: string) => {
              const formattedValue = formatCurrency(value, defaultCurrency, locale);
              const label = name === "income" ? t('monthlyTrends.income') : name === "spending" ? t('monthlyTrends.spending') : t('monthlyTrends.transactions');
              return [formattedValue, label];
            }}
            labelStyle={chartTooltipLabelStyle}
            cursor={{ fill: "hsl(var(--muted) / 0.3)" }}
          />
          <Legend
            verticalAlign="top"
            height={36}
            iconType="square"
            formatter={(value) => (value === "income" ? t('monthlyTrends.income') : t('monthlyTrends.spending'))}
          />
          <Bar dataKey="income" fill="url(#incomeGradient)" radius={[8, 8, 0, 0]} maxBarSize={40} isAnimationActive animationDuration={800} animationEasing="ease-out" />
          <Bar dataKey="spending" fill="url(#spendingGradient)" radius={[8, 8, 0, 0]} maxBarSize={40} isAnimationActive animationDuration={800} animationEasing="ease-out" animationBegin={200} />
        </BarChart>
      </ResponsiveContainer>

      <div className="mt-6 grid grid-cols-2 gap-3">
        <div className="flex items-center gap-2 p-3 rounded-lg bg-accent/10 border border-accent/30">
          <div className="w-3 h-3 rounded-full flex-shrink-0 bg-accent"></div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-accent">{t('monthlyTrends.totalIncome')}</p>
            <p className="text-sm font-bold text-accent">{formatCurrency(totalIncome, defaultCurrency, locale)}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 border border-destructive/30">
          <div className="w-3 h-3 rounded-full flex-shrink-0 bg-destructive"></div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-destructive">{t('monthlyTrends.totalSpending')}</p>
            <p className="text-sm font-bold text-destructive">{formatCurrency(totalSpending, defaultCurrency, locale)}</p>
          </div>
        </div>
      </div>
    </>
  );

  if (embedded) {
    return chartContent;
  }

  return (
    <Card className="relative overflow-hidden surface-elevated premium-frame micro-lift bg-card backdrop-blur-sm">
      <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-white/50 to-transparent dark:from-white/10 rounded-full -mr-16 -mt-16"></div>
      <CardHeader className="space-y-3">
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center shadow-sm text-primary">
            <TrendingUp className="h-6 w-6" />
          </div>
          <div className="flex-1">
            <CardTitle className="text-xl">{t('monthlyTrends.title')}</CardTitle>
            <CardDescription className="text-base">
              {t('monthlyTrends.desc')}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {chartContent}
      </CardContent>
    </Card>
  );
}
