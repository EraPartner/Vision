import { Fragment, useState, useMemo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useStatistics, type StatisticsData } from "@/hooks/useStatistics";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ExclusionToggle } from "@/components/shared/ExclusionToggle";
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer,
  Area, AreaChart,
} from "recharts";
import { TrendingUp, TrendingDown, DollarSign, BarChart3, Import } from "lucide-react";
import { PageHeader } from "@/components/shared/PageHeader";
import { format, parseISO } from "date-fns";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { RecipientInsightsTab } from "@/components/statistics/RecipientInsightsTab";
import { CustomCategoryChart } from "@/components/statistics/CustomCategoryChart";
import { useSavedCharts } from "@/hooks/useSavedCharts";
import { WidgetVisibilityDialog } from "@/components/shared/WidgetVisibilityDialog";
import { useWidgetVisibility, type WidgetDefinition } from "@/hooks/useWidgetVisibility";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { getCurrencySymbol, numberFormatToLocale } from "@/utils/currency";

type PivotValueMode = "absolute" | "net" | "income" | "expense";

const STATISTICS_WIDGETS: Array<WidgetDefinition & { labelKey?: string }> = [
  { id: "summaryCards",      labelKey: 'statsPage.widget.summaryCards',      defaultVisible: true },
  { id: "monthly",           labelKey: 'statsPage.widget.monthly',            defaultVisible: true },
  { id: "netTrend",          labelKey: 'statsPage.widget.netTrend',           defaultVisible: true },
  { id: "categoryPie",       labelKey: 'statsPage.widget.categoryPie',        defaultVisible: true },
  { id: "categoryTrend",     labelKey: 'statsPage.widget.categoryTrend',      defaultVisible: true },
  { id: "pivotTable",        labelKey: 'statsPage.widget.pivotTable',        defaultVisible: true },
  { id: "topRecipients",     labelKey: 'statsPage.widget.topRecipients',     defaultVisible: true },
  { id: "yearlyComparison",  labelKey: 'statsPage.widget.yearlyComparison',  defaultVisible: true },
  { id: "yearlySummary",     labelKey: 'statsPage.widget.yearlySummary',     defaultVisible: true },
];

const CHART_COLORS = [
  "hsl(217, 91%, 60%)",
  "hsl(142, 76%, 36%)",
  "hsl(45, 93%, 47%)",
  "hsl(280, 87%, 65%)",
  "hsl(340, 82%, 52%)",
  "hsl(190, 80%, 45%)",
  "hsl(30, 90%, 55%)",
  "hsl(260, 70%, 55%)",
  "hsl(170, 65%, 40%)",
  "hsl(350, 75%, 60%)",
];

const RECHARTS_TOOLTIP_STYLE = {
  backgroundColor: "hsl(var(--card))",
  border: "1px solid hsl(var(--border))",
  borderRadius: "var(--radius)",
  color: "hsl(var(--card-foreground))",
};

function formatPeriodLabel(period: string) {
  try {
    return format(parseISO(`${period}-01`), "MMM yyyy");
  } catch {
    return period;
  }
}

function formatPeriodShort(period: string) {
  try {
    return format(parseISO(`${period}-01`), "MMM yy");
  } catch {
    return period;
  }
}


// ─── Summary Cards ────────────────────────────────────────
function SummaryCards({ data }: { data: StatisticsData }) {
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const formatCurrency = (val: number) => new Intl.NumberFormat(locale, {
    style: "currency",
    currency: appSettings.defaultCurrency || "EUR",
    minimumFractionDigits: appSettings.showDecimalPlaces,
    maximumFractionDigits: appSettings.showDecimalPlaces,
  }).format(val);

  const cards = [
    {
      title: t('statsPage.totalIncome'),
      value: formatCurrency(data.totalIncome),
      icon: TrendingUp,
      description: t('statsPage.avgPerMonth', { amount: formatCurrency(data.averageMonthlyIncome) }),
      className: "text-accent",
    },
    {
      title: t('statsPage.totalSpending'),
      value: formatCurrency(data.totalSpending),
      icon: TrendingDown,
      description: t('statsPage.avgPerMonth', { amount: formatCurrency(data.averageMonthlySpending) }),
      className: "text-destructive",
    },
    {
      title: t('statsPage.netBalance'),
      value: formatCurrency(data.totalIncome - data.totalSpending),
      icon: DollarSign,
      description: t('statsPage.overMonths', { n: data.monthlyData.length }),
      className: data.totalIncome - data.totalSpending >= 0 ? "text-accent" : "text-destructive",
    },
    {
      title: t('statsPage.monthsTracked'),
      value: data.monthlyData.length.toString(),
      icon: BarChart3,
      description: t('statsPage.years', { n: data.allYears.length }),
      className: "text-primary",
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 animate-stagger">
      {cards.map((card) => (
        <Card key={card.title} className="border-none shadow-lg card-elevated hover:shadow-xl transition-all duration-300 hover:-translate-y-0.5">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{card.title}</CardTitle>
            <card.icon className={`h-4 w-4 ${card.className}`} />
          </CardHeader>
          <CardContent>
            <p className={`text-2xl font-bold ${card.className}`}>{card.value}</p>
            <p className="text-xs text-muted-foreground mt-1">{card.description}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ─── Monthly Income/Expense Chart ─────────────────────────
function MonthlyChart({ data }: { data: StatisticsData }) {
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const currencySymbol = getCurrencySymbol(appSettings.defaultCurrency || "EUR");
  const formatCurrency = (val: number) => new Intl.NumberFormat(locale, {
    style: "currency",
    currency: appSettings.defaultCurrency || "EUR",
    minimumFractionDigits: appSettings.showDecimalPlaces,
    maximumFractionDigits: appSettings.showDecimalPlaces,
  }).format(val);
  const chartData = data.monthlyData.map((m) => ({
    period: formatPeriodShort(m.period),
    [t('statsPage.income')]: Math.round(m.income),
    [t('statsPage.spending')]: Math.round(m.spending),
  }));

  return (
    <ResponsiveContainer width="100%" height={350}>
      <BarChart data={chartData}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
        <XAxis dataKey="period" className="text-xs fill-muted-foreground" tick={{ fontSize: 11 }} />
        <YAxis className="text-xs fill-muted-foreground" tick={{ fontSize: 11 }} tickFormatter={(v) => `${currencySymbol}${(v / 1000).toFixed(0)}k`} />
        <RechartsTooltip contentStyle={RECHARTS_TOOLTIP_STYLE} formatter={(value: number) => formatCurrency(value)} />
        <Legend />
        <Bar dataKey={t('statsPage.income')} fill="hsl(142, 76%, 36%)" radius={[4, 4, 0, 0]} />
        <Bar dataKey={t('statsPage.spending')} fill="hsl(0, 84%, 60%)" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ─── Net Balance Trend ────────────────────────────────────
function NetTrendChart({ data }: { data: StatisticsData }) {
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const currencySymbol = getCurrencySymbol(appSettings.defaultCurrency || "EUR");
  const formatCurrency = (val: number) => new Intl.NumberFormat(locale, {
    style: "currency",
    currency: appSettings.defaultCurrency || "EUR",
    minimumFractionDigits: appSettings.showDecimalPlaces,
    maximumFractionDigits: appSettings.showDecimalPlaces,
  }).format(val);
  const chartData = data.monthlyData.map((m) => ({
    period: formatPeriodShort(m.period),
    [t('statsPage.net')]: Math.round(m.net),
  }));

  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={chartData}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
        <XAxis dataKey="period" tick={{ fontSize: 11 }} className="fill-muted-foreground" />
        <YAxis tick={{ fontSize: 11 }} className="fill-muted-foreground" tickFormatter={(v) => `${currencySymbol}${(v / 1000).toFixed(0)}k`} />
        <RechartsTooltip contentStyle={RECHARTS_TOOLTIP_STYLE} formatter={(value: number) => formatCurrency(value)} />
        <defs>
          <linearGradient id="netGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="hsl(217, 91%, 60%)" stopOpacity={0.3} />
            <stop offset="95%" stopColor="hsl(217, 91%, 60%)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area type="monotone" dataKey={t('statsPage.net')} stroke="hsl(217, 91%, 60%)" fill="url(#netGradient)" strokeWidth={2} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ─── Year-over-Year Comparison ────────────────────────────
function YearlyComparisonChart({ data }: { data: StatisticsData }) {
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const currencySymbol = getCurrencySymbol(appSettings.defaultCurrency || "EUR");
  const formatCurrency = (val: number) => new Intl.NumberFormat(locale, {
    style: "currency",
    currency: appSettings.defaultCurrency || "EUR",
    minimumFractionDigits: appSettings.showDecimalPlaces,
    maximumFractionDigits: appSettings.showDecimalPlaces,
  }).format(val);
  const chartData = data.yearlyComparison.map((y) => ({
    year: y.year.toString(),
    [t('statsPage.income')]: Math.round(y.totalIncome),
    [t('statsPage.spending')]: Math.round(y.totalSpending),
  }));

  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={chartData}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
        <XAxis dataKey="year" tick={{ fontSize: 12 }} className="fill-muted-foreground" />
        <YAxis tick={{ fontSize: 11 }} className="fill-muted-foreground" tickFormatter={(v) => `${currencySymbol}${(v / 1000).toFixed(0)}k`} />
        <RechartsTooltip contentStyle={RECHARTS_TOOLTIP_STYLE} formatter={(value: number) => formatCurrency(value)} />
        <Legend />
        <Bar dataKey={t('statsPage.income')} fill="hsl(142, 76%, 36%)" radius={[4, 4, 0, 0]} />
        <Bar dataKey={t('statsPage.spending')} fill="hsl(0, 84%, 60%)" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ─── Top Recipients ───────────────────────────────────────
function TopRecipientsChart({ data }: { data: StatisticsData }) {
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const [yearFilter, setYearFilter] = useState<string>("all");
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const currencySymbol = getCurrencySymbol(appSettings.defaultCurrency || "EUR");
  const formatCurrency = (val: number) => new Intl.NumberFormat(locale, {
    style: "currency",
    currency: appSettings.defaultCurrency || "EUR",
    minimumFractionDigits: appSettings.showDecimalPlaces,
    maximumFractionDigits: appSettings.showDecimalPlaces,
  }).format(val);
  const filteredRecipients = yearFilter === "all"
    ? data.topRecipients
    : (data.topRecipientsByYear[yearFilter] || []);

  const chartData = filteredRecipients.slice(0, 10).map((r) => ({
    name: r.name.length > 20 ? r.name.substring(0, 20) + "…" : r.name,
    fullName: r.name,
    amount: Math.round(r.total),
    count: r.count,
  }));

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Select value={yearFilter} onValueChange={setYearFilter}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder={t('statistics.selectYear')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('statsPage.allYears')}</SelectItem>
            {data.allYears.map((year) => (
              <SelectItem key={year} value={year.toString()}>{year}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <ResponsiveContainer width="100%" height={350}>
        <BarChart data={chartData} layout="vertical">
          <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
          <XAxis type="number" tick={{ fontSize: 11 }} className="fill-muted-foreground" tickFormatter={(v) => `${currencySymbol}${(v / 1000).toFixed(0)}k`} />
          <YAxis type="category" dataKey="name" width={150} tick={{ fontSize: 11 }} className="fill-muted-foreground" />
          <RechartsTooltip
            contentStyle={RECHARTS_TOOLTIP_STYLE}
            formatter={(value: number) => formatCurrency(value)}
            labelFormatter={(label: string, payload?: Array<{ payload?: { fullName?: string } }>) => payload?.[0]?.payload?.fullName || label}
          />
          <Bar dataKey="amount" radius={[0, 4, 4, 0]}>
            {chartData.map((_entry, index) => (
              <Cell key={`recipient-bar-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Category Spending Pie ────────────────────────────────
function CategoryPieChart({ data }: { data: StatisticsData }) {
  const [yearFilter, setYearFilter] = useState<string>("all");
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const formatCurrency = (val: number) => new Intl.NumberFormat(locale, {
    style: "currency",
    currency: appSettings.defaultCurrency || "EUR",
    minimumFractionDigits: appSettings.showDecimalPlaces,
    maximumFractionDigits: appSettings.showDecimalPlaces,
  }).format(val);
  const filteredPeriods = useMemo(() => {
    if (yearFilter === "all") return data.allPeriods;
    return data.allPeriods.filter((period) => period.startsWith(yearFilter));
  }, [yearFilter, data.allPeriods]);

  const pieData = useMemo(() => {
    const totals = data.categoryPivot
      .map((category) => {
        const totalForPeriods = filteredPeriods.reduce((sum, period) => sum + (category.months[period] || 0), 0);
        return {
          name: category.categoryName,
          value: Math.round(totalForPeriods),
        };
      })
      .filter((item) => item.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);

    return totals.map((item, index) => ({
      ...item,
      color: CHART_COLORS[index % CHART_COLORS.length],
    }));
  }, [data.categoryPivot, filteredPeriods]);

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Select value={yearFilter} onValueChange={setYearFilter}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder={t('statistics.selectYear')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('statsPage.allYears')}</SelectItem>
            {data.allYears.map((year) => (
              <SelectItem key={year} value={year.toString()}>{year}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <ResponsiveContainer width="100%" height={350}>
        <PieChart>
          <Pie
            data={pieData}
            cx="50%"
            cy="50%"
            outerRadius={120}
            innerRadius={60}
            dataKey="value"
            label={({ name, percent }) => {
              const parts = name.split(":");
              const general = parts[0]?.trim() || name;
              return `${general} ${(percent * 100).toFixed(0)}%`;
            }}
            labelLine={{ strokeWidth: 1 }}
          >
            {pieData.map((entry, index) => (
              <Cell key={index} fill={entry.color} />
            ))}
          </Pie>
          <RechartsTooltip contentStyle={RECHARTS_TOOLTIP_STYLE} formatter={(value: number) => formatCurrency(value)} />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Category Pivot Table ─────────────────────────────────
function CategoryPivotTable({
  data,
  graphKey,
  isFiltered,
  onToggle,
  exclusionsApply
}: {
  data: StatisticsData;
  graphKey: string;
  isFiltered: boolean;
  onToggle: (key: string) => void;
  exclusionsApply: boolean;
}) {
  const [yearFilter, setYearFilter] = useState<string>("all");
  const [valueMode, setValueMode] = useState<PivotValueMode>("absolute");
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const formatCurrency = (val: number) => new Intl.NumberFormat(locale, {
    style: "currency",
    currency: appSettings.defaultCurrency || "EUR",
    minimumFractionDigits: appSettings.showDecimalPlaces,
    maximumFractionDigits: appSettings.showDecimalPlaces,
  }).format(val);

  const filteredPeriods = useMemo(() => {
    if (yearFilter === "all") return data.allPeriods;
    return data.allPeriods.filter((p) => p.startsWith(yearFilter));
  }, [yearFilter, data.allPeriods]);

  const getPeriodValue = (cat: StatisticsData['categoryPivot'][number], period: string) => {
    if (valueMode === "net") return cat.netMonths[period] || 0;
    if (valueMode === "income") return cat.incomeMonths[period] || 0;
    if (valueMode === "expense") return cat.expenseMonths[period] || 0;
    return cat.months[period] || 0;
  };

  const filteredCategories = useMemo(() => {
    return data.categoryPivot
      .map((cat) => {
        const filteredTotal = filteredPeriods.reduce((s, p) => s + getPeriodValue(cat, p), 0);
        return { ...cat, filteredTotal };
      })
      .filter((cat) => {
        if (valueMode === "net") return cat.filteredTotal !== 0;
        return cat.filteredTotal > 0;
      })
      .sort((a, b) => valueMode === "net"
        ? Math.abs(b.filteredTotal) - Math.abs(a.filteredTotal)
        : b.filteredTotal - a.filteredTotal);
  }, [data.categoryPivot, filteredPeriods, valueMode]);

  const hierarchicalCategories = useMemo(() => {
    type PivotItem = (typeof filteredCategories)[number];
    const grouped = new Map<string, {
      general: string;
      total: number;
      months: Record<string, number>;
      children: Array<PivotItem & { detailName: string }>;
    }>();

    for (const cat of filteredCategories) {
      // Parse "GENERAL: DETAIL" format - the colon is followed by space in normalized names
      const [rawGeneral, ...detailParts] = String(cat.categoryName || t('txPage.field.uncategorized')).split(":");
      const general = rawGeneral?.trim() || t('txPage.field.uncategorized');
      // Remove leading space from detail if present (from "GENERAL: DETAIL" format)
      const detailName = detailParts.length > 0 ? detailParts.join(":").replace(/^ /, '') : general;

      if (!grouped.has(general)) {
        const initialMonths: Record<string, number> = {};
        for (const period of filteredPeriods) {
          initialMonths[period] = 0;
        }

        grouped.set(general, {
          general,
          total: 0,
          months: initialMonths,
          children: [],
        });
      }

      const group = grouped.get(general)!;
      group.total += cat.filteredTotal;
      for (const period of filteredPeriods) {
        group.months[period] += getPeriodValue(cat, period);
      }
      group.children.push({ ...cat, detailName });
    }

    return Array.from(grouped.values())
      .map((group) => ({
        ...group,
        children: group.children.sort((a, b) => valueMode === "net"
          ? Math.abs(b.filteredTotal) - Math.abs(a.filteredTotal)
          : b.filteredTotal - a.filteredTotal),
      }))
      .sort((a, b) => valueMode === "net"
        ? Math.abs(b.total) - Math.abs(a.total)
        : b.total - a.total);
  }, [filteredCategories, filteredPeriods, t, valueMode]);

  const columnTotals = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const period of filteredPeriods) {
      totals[period] = filteredCategories.reduce((s, cat) => s + getPeriodValue(cat, period), 0);
    }
    return totals;
  }, [filteredCategories, filteredPeriods, valueMode]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between flex-wrap gap-4">
        <div>
          {/** translation */}
          <CardTitle>{t('statsPage.pivotTitle')}</CardTitle>
          <CardDescription>{t('statsPage.pivotDesc')}</CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Select value={valueMode} onValueChange={(v) => setValueMode(v as PivotValueMode)}>
            <SelectTrigger className="w-[150px]">
              <SelectValue placeholder={t('statsPage.pivot.metric')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="absolute">{t('statsPage.pivot.metric.absolute')}</SelectItem>
              <SelectItem value="net">{t('statsPage.pivot.metric.net')}</SelectItem>
              <SelectItem value="income">{t('statsPage.pivot.metric.income')}</SelectItem>
              <SelectItem value="expense">{t('statsPage.pivot.metric.expense')}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={yearFilter} onValueChange={setYearFilter}>
            <SelectTrigger className="w-[120px]">
              <SelectValue placeholder={t('statistics.selectYear')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('statsPage.allYears')}</SelectItem>
              {data.allYears.map((y) => (
                <SelectItem key={y} value={y.toString()}>{y}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <ExclusionToggle
            graphKey={graphKey}
            isFiltered={isFiltered}
            onToggle={onToggle}
            exclusionsApply={exclusionsApply}
          />
        </div>
      </CardHeader>
      <CardContent>
        <ScrollArea className="w-full">
          <div className="min-w-[800px]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 px-3 font-medium text-muted-foreground sticky left-0 bg-card z-10">{t('statsPage.category')}</th>
                  {filteredPeriods.map((p) => (
                    <th key={p} className="text-right py-2 px-3 font-medium text-muted-foreground whitespace-nowrap">
                      {formatPeriodShort(p)}
                    </th>
                  ))}
                  <th className="text-right py-2 px-3 font-bold text-foreground">{t('statsPage.total')}</th>
                </tr>
              </thead>
              <tbody>
                {hierarchicalCategories.map((group) => (
                  <Fragment key={`group-${group.general}`}>
                    <tr key={`group-${group.general}`} className="border-b border-border/50 bg-muted/30">
                        <td className="py-2 px-3 font-semibold sticky left-0 bg-card z-10 whitespace-nowrap">{group.general}</td>
                      {filteredPeriods.map((p) => {
                        const val = group.months[p] || 0;
                        return (
                          <td key={p} className={`text-right py-2 px-3 tabular-nums font-semibold ${val === 0 ? "text-muted-foreground/40" : ""} ${val < 0 ? "text-destructive" : ""}`}>
                            {val === 0 ? "—" : formatCurrency(val)}
                          </td>
                        );
                      })}
                      <td className={`text-right py-2 px-3 font-bold tabular-nums ${group.total < 0 ? "text-destructive" : ""}`}>{formatCurrency(group.total)}</td>
                    </tr>
                    {group.children.map((cat) => (
                      <tr key={cat.categoryId} className="border-b border-border/50 hover:bg-muted/50 transition-colors">
                        <td className="py-2 px-3 pl-8 text-muted-foreground sticky left-0 bg-card z-10 whitespace-nowrap">
                          {cat.detailName}
                        </td>
                        {filteredPeriods.map((p) => {
                          const val = getPeriodValue(cat, p);
                          return (
                            <td key={p} className={`text-right py-2 px-3 tabular-nums ${val === 0 ? "text-muted-foreground/40" : ""} ${val < 0 ? "text-destructive" : ""}`}>
                            {val === 0 ? "—" : formatCurrency(val)}
                          </td>
                        );
                      })}
                        <td className={`text-right py-2 px-3 font-medium tabular-nums ${cat.filteredTotal < 0 ? "text-destructive" : ""}`}>{formatCurrency(cat.filteredTotal)}</td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border font-bold">
                  <td className="py-2 px-3 sticky left-0 bg-card z-10">{t('statsPage.total')}</td>
                  {filteredPeriods.map((p) => (
                    <td key={p} className="text-right py-2 px-3 tabular-nums">{formatCurrency(columnTotals[p] || 0)}</td>
                  ))}
                  <td className="text-right py-2 px-3 tabular-nums">
                    {formatCurrency(filteredCategories.reduce((s, c) => s + c.filteredTotal, 0))}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

// ─── Spending Trend by Category ───────────────────────────
function CategoryTrendChart({ data }: { data: StatisticsData }) {
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const currencySymbol = getCurrencySymbol(appSettings.defaultCurrency || "EUR");
  const formatCurrency = (val: number) => new Intl.NumberFormat(locale, {
    style: "currency",
    currency: appSettings.defaultCurrency || "EUR",
    minimumFractionDigits: appSettings.showDecimalPlaces,
    maximumFractionDigits: appSettings.showDecimalPlaces,
  }).format(val);
  const topCategories = data.categoryPivot.slice(0, 5);
  const chartData = data.allPeriods.map((period) => {
    const point: Record<string, number | string> = { period: formatPeriodShort(period) };
    for (const cat of topCategories) {
      point[cat.categoryName] = Math.round(cat.months[period] || 0);
    }
    return point;
  });

  return (
    <ResponsiveContainer width="100%" height={350}>
      <LineChart data={chartData}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
        <XAxis dataKey="period" tick={{ fontSize: 11 }} className="fill-muted-foreground" />
        <YAxis tick={{ fontSize: 11 }} className="fill-muted-foreground" tickFormatter={(v) => `${currencySymbol}${(v / 1000).toFixed(0)}k`} />
        <RechartsTooltip contentStyle={RECHARTS_TOOLTIP_STYLE} formatter={(value: number) => formatCurrency(value)} />
        <Legend />
        {topCategories.map((cat, i) => (
          <Line
            key={cat.categoryId}
            type="monotone"
            dataKey={cat.categoryName}
            stroke={CHART_COLORS[i % CHART_COLORS.length]}
            strokeWidth={2}
            dot={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

// ─── Chart Card with per-graph exclusion toggle ───────────
function ChartCard({
  title,
  description,
  graphKey,
  getGraphData,
  graphExclusions,
  toggleGraphExclusion,
  exclusionsApply,
  children,
}: {
  title: string;
  description: string;
  graphKey: string;
  getGraphData: (key: string) => StatisticsData | null;
  graphExclusions: Record<string, boolean>;
  toggleGraphExclusion: (key: string) => void;
  exclusionsApply: boolean;
  children: (data: StatisticsData) => ReactNode;
}) {
  const data = getGraphData(graphKey);
  if (!data) return null;
  const isFiltered = graphExclusions[graphKey] ?? true;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        <ExclusionToggle
          graphKey={graphKey}
          isFiltered={isFiltered}
          onToggle={toggleGraphExclusion}
          exclusionsApply={exclusionsApply}
        />
      </CardHeader>
      <CardContent>
        {children(data)}
      </CardContent>
    </Card>
  );
}

// ─── Saved Charts Section ─────────────────────────────────
function SavedChartsSection({
  data,
  getGraphData,
  graphExclusions,
  toggleGraphExclusion,
  exclusionsApply,
}: {
  data: StatisticsData;
  getGraphData: (key: string) => StatisticsData | null;
  graphExclusions: Record<string, boolean>;
  toggleGraphExclusion: (key: string) => void;
  exclusionsApply: boolean;
}) {
  const { data: savedCharts, isLoading } = useSavedCharts();
  if (isLoading || !savedCharts || savedCharts.length === 0) return null;

  return (
    <>
      {savedCharts.map((chart) => {
        const graphKey = `savedChart_${chart.id}`;
        return (
          <CustomCategoryChart
            key={chart.id}
            data={getGraphData(graphKey) || data}
            graphKey={graphKey}
            isFiltered={graphExclusions[graphKey] ?? true}
            onToggle={toggleGraphExclusion}
            exclusionsApply={exclusionsApply}
            savedChart={chart}
          />
        );
      })}
    </>
  );
}

// ─── Main Page ────────────────────────────────────────────
export default function StatisticsPage() {
  const {
    data, isLoading, isError, error,
    getGraphData, graphExclusions, toggleGraphExclusion, exclusionsApply,
  } = useStatistics();
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const formatCurrency = (val: number) => new Intl.NumberFormat(locale, {
    style: "currency",
    currency: appSettings.defaultCurrency || "EUR",
    minimumFractionDigits: appSettings.showDecimalPlaces,
    maximumFractionDigits: appSettings.showDecimalPlaces,
  }).format(val);

  const { isVisible, setWidgetVisible, setAllVisible, resetToDefaults, widgets: widgetDefs } = useWidgetVisibility('statistics', STATISTICS_WIDGETS);
  const widgets = useMemo(
    () => widgetDefs.map((w) => ({ ...w, label: (w as typeof w & { labelKey?: string }).labelKey ? t((w as typeof w & { labelKey?: string }).labelKey!) : (w.label ?? w.id) })),
    [widgetDefs, t],
  );

  if (isLoading) {
    return (
      <div className="space-y-6 animate-in">
        <PageHeader title={t('statsPage.title')} icon={BarChart3} />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <Card key={i}><CardContent className="pt-6"><Skeleton className="h-20 w-full" /></CardContent></Card>
          ))}
        </div>
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="space-y-6 animate-in">
        <PageHeader title={t('statsPage.title')} icon={BarChart3} />
        <Card>
          <CardContent className="pt-6">
            <p className="text-destructive">{t('statsPage.error', { msg: error?.message })}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!data || data.monthlyData.length === 0) {
    return (
      <div className="space-y-6 animate-in">
        <div className="flex items-center justify-between">
          <PageHeader title={t('statsPage.title')} subtitle={t('statsPage.subtitle')} icon={BarChart3} />
          <WidgetVisibilityDialog
              widgets={widgets}
              isVisible={isVisible}
              setWidgetVisible={setWidgetVisible}
              setAllVisible={setAllVisible}
              resetToDefaults={resetToDefaults}
          />
        </div>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <BarChart3 className="h-12 w-12 text-muted-foreground/40 mb-4" />
            <h3 className="text-lg font-semibold text-foreground mb-2">{t('statsPage.noDataTitle')}</h3>
            <p className="text-sm text-muted-foreground mb-4 max-w-sm">{t('statsPage.noDataDesc')}</p>
            <Button asChild size="sm">
              <Link to="/import"><Import className="h-4 w-4 mr-2" />{t('statsPage.importBtn')}</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const chartCardProps = { getGraphData, graphExclusions, toggleGraphExclusion, exclusionsApply };

  return (
    <div className="space-y-6 animate-in">
      <div className="flex items-center justify-between">
        <PageHeader title={t('statsPage.title')} subtitle={t('statsPage.subtitle')} icon={BarChart3} />
        <WidgetVisibilityDialog
          widgets={widgets}
          isVisible={isVisible}
          setWidgetVisible={setWidgetVisible}
          setAllVisible={setAllVisible}
          resetToDefaults={resetToDefaults}
        />
      </div>

      {isVisible('summaryCards') && <SummaryCards data={data} />}

      <Tabs defaultValue="overview" className="space-y-4">
          <TabsList>
            <TabsTrigger value="overview">{t('statsPage.tab.overview')}</TabsTrigger>
            <TabsTrigger value="categories">{t('statsPage.tab.categories')}</TabsTrigger>
            <TabsTrigger value="recipients">{t('statsPage.tab.recipients')}</TabsTrigger>
            <TabsTrigger value="yearly">{t('statsPage.tab.yearly')}</TabsTrigger>
          </TabsList>

        <TabsContent value="overview" className="space-y-6">
            {isVisible('monthly') && (
                <ChartCard title={t('statsPage.chart.monthlyTitle')} description={t('statsPage.chart.monthlyDesc')} graphKey="monthly" {...chartCardProps}>
                  {(d) => <MonthlyChart data={d} />}
                </ChartCard>
            )}
            {isVisible('netTrend') && (
                <ChartCard title={t('statsPage.chart.netTitle')} description={t('statsPage.chart.netDesc')} graphKey="netTrend" {...chartCardProps}>
                  {(d) => <NetTrendChart data={d} />}
                </ChartCard>
            )}
        </TabsContent>

        <TabsContent value="categories" className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {isVisible('categoryPie') && (
                <ChartCard title={t('statsPage.chart.categoryPieTitle')} description={t('statsPage.chart.categoryPieDesc')} graphKey="categoryPie" {...chartCardProps}>
                  {(d) => <CategoryPieChart data={d} />}
                </ChartCard>
            )}
            {isVisible('categoryTrend') && (
                <ChartCard title={t('statsPage.chart.categoryTrendTitle')} description={t('statsPage.chart.categoryTrendDesc')} graphKey="categoryTrend" {...chartCardProps}>
                  {(d) => <CategoryTrendChart data={d} />}
                </ChartCard>
            )}
          </div>
          {isVisible('pivotTable') && (
              <CategoryPivotTable
                  data={getGraphData("pivotTable") || data}
                  graphKey="pivotTable"
                  isFiltered={graphExclusions["pivotTable"] ?? true}
                  onToggle={toggleGraphExclusion}
                  exclusionsApply={exclusionsApply}
              />
          )}
        </TabsContent>
        <TabsContent value="recipients" className="space-y-6">
            {isVisible('topRecipients') && (
                <RecipientInsightsTab
                    statisticsTopRecipientsChart={
                      <ChartCard title={t('statsPage.chart.topRecipientsTitle')} description={t('statsPage.chart.topRecipientsDesc')} graphKey="topRecipients" {...chartCardProps}>
                        {(d) => <TopRecipientsChart data={d} />}
                      </ChartCard>
                    }
                />
            )}
        </TabsContent>
        <TabsContent value="yearly" className="space-y-6">
            {isVisible('yearlyComparison') && (
                <ChartCard title={t('statsPage.chart.yearlyTitle')} description={t('statsPage.chart.yearlyDesc')} graphKey="yearlyComparison" {...chartCardProps}>
                  {(d) => <YearlyComparisonChart data={d} />}
              </ChartCard>
            )}
            {isVisible('yearlySummary') && (
                <Card>
                  <CardHeader>
                  <CardTitle>{t('statsPage.yearly.title')}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <table className="w-full text-sm">
                      <thead>
                      <tr className="border-b border-border">
                        <th className="text-left py-2 px-3 font-medium text-muted-foreground">{t('statsPage.yearly.year')}</th>
                        <th className="text-right py-2 px-3 font-medium text-muted-foreground">{t('statsPage.yearly.income')}</th>
                        <th className="text-right py-2 px-3 font-medium text-muted-foreground">{t('statsPage.yearly.spending')}</th>
                        <th className="text-right py-2 px-3 font-medium text-muted-foreground">{t('statsPage.yearly.net')}</th>
                        <th className="text-right py-2 px-3 font-medium text-muted-foreground">{t('statsPage.yearly.transactions')}</th>
                      </tr>
                      </thead>
                    <tbody>
                    {data.yearlyComparison.map((y) => (
                        <tr key={y.year} className="border-b border-border/50 hover:bg-muted/50">
                          <td className="py-2 px-3 font-medium">{y.year}</td>
                          <td className="text-right py-2 px-3 text-accent tabular-nums">{formatCurrency(y.totalIncome)}</td>
                          <td className="text-right py-2 px-3 text-destructive tabular-nums">{formatCurrency(y.totalSpending)}</td>
                          <td className={`text-right py-2 px-3 font-bold tabular-nums ${y.net >= 0 ? "text-accent" : "text-destructive"}`}>
                            {formatCurrency(y.net)}
                          </td>
                          <td className="text-right py-2 px-3 tabular-nums">{new Intl.NumberFormat(locale).format(y.transactionCount)}</td>
                        </tr>
                    ))}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
