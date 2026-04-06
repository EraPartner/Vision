import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Line, LineChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend, ReferenceLine } from "recharts";
import { Activity } from "lucide-react";
import { formatCurrency, numberFormatToLocale } from "@/utils/currency";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { formatMonthYearWithAppSettings } from "@/components/shared/dateUtils";
import { chartTooltipStyle } from "@/components/shared/chartStyles";

interface DayData {
  day: number;
  average: number;
  current: number | null;
}

interface CashFlowComparisonProps {
  withoutPlanned: DayData[];
  withPlanned: DayData[];
  currentDay: number;
  month: number;
  year: number;
  embedded?: boolean;
}

function CashFlowLineChart({ data, currentDay }: { data: DayData[]; currentDay: number }) {
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const defaultCurrency = appSettings.defaultCurrency || 'EUR';
  const lastActual = data.slice(0, currentDay).at(-1);
  const avgAtCurrentDay = lastActual ? data[currentDay - 1]?.average : null;
  const diff = lastActual?.current !== null && lastActual?.current !== undefined && avgAtCurrentDay !== null
    ? lastActual.current - (avgAtCurrentDay ?? 0)
    : null;
  // Higher net cash flow = better (spent less / earned more than average)
  const isBetterThanAverage = diff !== null ? diff > 0 : null;

  return (
    <div>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={data} margin={{ top: 10, right: 10, left: 10, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border" opacity={0.4} />
          <XAxis
            dataKey="day"
            tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
            tickFormatter={(v) => String(v)}
            label={{ value: t('cashflow.dayOfMonth'), position: 'insideBottom', offset: -2, fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
            height={40}
          />
          <YAxis
            tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
            tickFormatter={(v) => formatCurrency(v, defaultCurrency, locale)}
            width={70}
          />
          <Tooltip
            contentStyle={chartTooltipStyle}
            formatter={(value: number, name: string) => [
              formatCurrency(value, defaultCurrency, locale),
              name === 'average' ? t('cashflow.24monthAvg') : t('cashflow.thisMonth'),
            ]}
            labelFormatter={(label) => t('cashflow.day', { n: String(label) })}
          />
          <Legend
            verticalAlign="top"
            height={36}
            formatter={(value) => value === 'average' ? t('cashflow.24monthAvg') : t('cashflow.thisMonth')}
          />
          <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" opacity={0.5} />
          <Line
            type="monotone"
            dataKey="average"
            stroke="hsl(var(--muted-foreground))"
            strokeWidth={2}
            strokeDasharray="8 4"
            dot={false}
            name="average"
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="current"
            stroke="hsl(var(--primary))"
            strokeWidth={2.5}
            dot={false}
            name="current"
            connectNulls={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>

      {isBetterThanAverage !== null && diff !== null && lastActual && (
        <div className={`mt-4 flex items-center gap-2 p-3 rounded-lg border ${isBetterThanAverage
          ? 'bg-accent/10 border-accent/30'
          : 'bg-destructive/10 border-destructive/30'
          }`}>
          <div className={`w-2.5 h-2.5 rounded-full ${isBetterThanAverage ? 'bg-accent' : 'bg-destructive'}`} />
          <p className="text-sm font-medium text-foreground">
            {isBetterThanAverage
              ? `${t('cashflow.savingMore')} `
              : `${t('cashflow.spendingMore')} `}
            <span className="font-bold">
              {formatCurrency(Math.abs(diff), defaultCurrency, locale)}
            </span>
            {isBetterThanAverage ? ` ${t('cashflow.better')}` : ` ${t('cashflow.worse')}`}{' '}{t('cashflow.comparedTo')} {currentDay}
          </p>
        </div>
      )}
    </div>
  );
}

export function CashFlowComparisonChart({ withoutPlanned, withPlanned, currentDay, month, year, embedded = false }: CashFlowComparisonProps) {
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const monthName = formatMonthYearWithAppSettings(new Date(year, month - 1, 1), appSettings.dateFormat, locale);

  const chartContent = (
    <Tabs defaultValue="without" className="w-full">
      <TabsList className="grid w-full grid-cols-2 mb-4">
        <TabsTrigger value="without">{t('cashflow.withoutPlanned')}</TabsTrigger>
        <TabsTrigger value="with">{t('cashflow.withPlanned')}</TabsTrigger>
      </TabsList>
      <TabsContent value="without">
        <CashFlowLineChart data={withoutPlanned} currentDay={currentDay} />
      </TabsContent>
      <TabsContent value="with">
        <CashFlowLineChart data={withPlanned} currentDay={currentDay} />
      </TabsContent>
    </Tabs>
  );

  if (embedded) {
    return chartContent;
  }

  return (
    <Card className="relative overflow-hidden border-none shadow-lg hover:shadow-xl transition-all duration-300 hover:-translate-y-1 bg-card backdrop-blur-sm lg:col-span-2">
      <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-primary/10 to-transparent rounded-full -mr-16 -mt-16" />
      <CardHeader className="space-y-3">
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center shadow-sm text-primary">
            <Activity className="h-6 w-6" />
          </div>
          <div className="flex-1">
            <CardTitle className="text-xl">{t('cashflow.title')}</CardTitle>
            <CardDescription className="text-base">
              {t('cashflow.chartDesc', { monthName })}
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
