import { useState, useMemo } from "react";
import { useStatistics, type StatisticsData } from "@/hooks/useStatistics";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  Tooltip as UITooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer,
  Area, AreaChart,
} from "recharts";
import { TrendingUp, TrendingDown, DollarSign, BarChart3, Filter, FilterX } from "lucide-react";
import { format, parseISO } from "date-fns";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";

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

function formatCurrency(val: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(val);
}

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

// ─── Exclusion Toggle Button ──────────────────────────────
function ExclusionToggle({
  graphKey,
  isFiltered,
  onToggle,
  exclusionsApply,
}: {
  graphKey: string;
  isFiltered: boolean;
  onToggle: (key: string) => void;
  exclusionsApply: boolean;
}) {
  if (!exclusionsApply) return null;

  return (
    <TooltipProvider>
      <UITooltip>
        <TooltipTrigger asChild>
          <Button
            variant={isFiltered ? "default" : "outline"}
            size="icon"
            className="h-7 w-7"
            onClick={() => onToggle(graphKey)}
          >
            {isFiltered ? <Filter className="h-3.5 w-3.5" /> : <FilterX className="h-3.5 w-3.5" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {isFiltered ? "Exclusions applied — click to show all data" : "Showing all data — click to apply exclusions"}
        </TooltipContent>
      </UITooltip>
    </TooltipProvider>
  );
}

// ─── Summary Cards ────────────────────────────────────────
function SummaryCards({ data }: { data: StatisticsData }) {
  const cards = [
    {
      title: "Total Income",
      value: formatCurrency(data.totalIncome),
      icon: TrendingUp,
      description: `Avg ${formatCurrency(data.averageMonthlyIncome)}/mo`,
      className: "text-accent",
    },
    {
      title: "Total Spending",
      value: formatCurrency(data.totalSpending),
      icon: TrendingDown,
      description: `Avg ${formatCurrency(data.averageMonthlySpending)}/mo`,
      className: "text-destructive",
    },
    {
      title: "Net Balance",
      value: formatCurrency(data.totalIncome - data.totalSpending),
      icon: DollarSign,
      description: `Over ${data.monthlyData.length} months`,
      className: data.totalIncome - data.totalSpending >= 0 ? "text-accent" : "text-destructive",
    },
    {
      title: "Months Tracked",
      value: data.monthlyData.length.toString(),
      icon: BarChart3,
      description: `${data.allYears.length} year(s)`,
      className: "text-primary",
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map((card) => (
        <Card key={card.title}>
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
  const chartData = data.monthlyData.map((m) => ({
    period: formatPeriodShort(m.period),
    Income: Math.round(m.income),
    Spending: Math.round(m.spending),
    Net: Math.round(m.net),
  }));

  return (
    <ResponsiveContainer width="100%" height={350}>
      <BarChart data={chartData}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
        <XAxis dataKey="period" className="text-xs fill-muted-foreground" tick={{ fontSize: 11 }} />
        <YAxis className="text-xs fill-muted-foreground" tick={{ fontSize: 11 }} tickFormatter={(v) => `€${(v / 1000).toFixed(0)}k`} />
        <RechartsTooltip contentStyle={RECHARTS_TOOLTIP_STYLE} formatter={(value: number) => formatCurrency(value)} />
        <Legend />
        <Bar dataKey="Income" fill="hsl(142, 76%, 36%)" radius={[4, 4, 0, 0]} />
        <Bar dataKey="Spending" fill="hsl(0, 84%, 60%)" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ─── Net Balance Trend ────────────────────────────────────
function NetTrendChart({ data }: { data: StatisticsData }) {
  const chartData = data.monthlyData.map((m) => ({
    period: formatPeriodShort(m.period),
    Net: Math.round(m.net),
  }));

  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={chartData}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
        <XAxis dataKey="period" tick={{ fontSize: 11 }} className="fill-muted-foreground" />
        <YAxis tick={{ fontSize: 11 }} className="fill-muted-foreground" tickFormatter={(v) => `€${(v / 1000).toFixed(0)}k`} />
        <RechartsTooltip contentStyle={RECHARTS_TOOLTIP_STYLE} formatter={(value: number) => formatCurrency(value)} />
        <defs>
          <linearGradient id="netGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="hsl(217, 91%, 60%)" stopOpacity={0.3} />
            <stop offset="95%" stopColor="hsl(217, 91%, 60%)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area type="monotone" dataKey="Net" stroke="hsl(217, 91%, 60%)" fill="url(#netGradient)" strokeWidth={2} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ─── Year-over-Year Comparison ────────────────────────────
function YearlyComparisonChart({ data }: { data: StatisticsData }) {
  const chartData = data.yearlyComparison.map((y) => ({
    year: y.year.toString(),
    Income: Math.round(y.totalIncome),
    Spending: Math.round(y.totalSpending),
    Net: Math.round(y.net),
  }));

  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={chartData}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
        <XAxis dataKey="year" tick={{ fontSize: 12 }} className="fill-muted-foreground" />
        <YAxis tick={{ fontSize: 11 }} className="fill-muted-foreground" tickFormatter={(v) => `€${(v / 1000).toFixed(0)}k`} />
        <RechartsTooltip contentStyle={RECHARTS_TOOLTIP_STYLE} formatter={(value: number) => formatCurrency(value)} />
        <Legend />
        <Bar dataKey="Income" fill="hsl(142, 76%, 36%)" radius={[4, 4, 0, 0]} />
        <Bar dataKey="Spending" fill="hsl(0, 84%, 60%)" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ─── Top Recipients ───────────────────────────────────────
function TopRecipientsChart({ data }: { data: StatisticsData }) {
  const chartData = data.topRecipients.slice(0, 10).map((r) => ({
    name: r.name.length > 20 ? r.name.substring(0, 20) + "…" : r.name,
    fullName: r.name,
    amount: Math.round(r.total),
    count: r.count,
  }));

  return (
    <ResponsiveContainer width="100%" height={350}>
      <BarChart data={chartData} layout="vertical">
        <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
        <XAxis type="number" tick={{ fontSize: 11 }} className="fill-muted-foreground" tickFormatter={(v) => `€${(v / 1000).toFixed(0)}k`} />
        <YAxis type="category" dataKey="name" width={150} tick={{ fontSize: 11 }} className="fill-muted-foreground" />
        <RechartsTooltip
          contentStyle={RECHARTS_TOOLTIP_STYLE}
          formatter={(value: number) => formatCurrency(value)}
          labelFormatter={(label: string, payload: any[]) => payload?.[0]?.payload?.fullName || label}
        />
        <Bar dataKey="amount" fill="hsl(217, 91%, 60%)" radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ─── Category Spending Pie ────────────────────────────────
function CategoryPieChart({ data }: { data: StatisticsData }) {
  const pieData = data.categoryPivot.slice(0, 10).map((c, i) => ({
    name: c.categoryName,
    value: Math.round(c.total),
    color: CHART_COLORS[i % CHART_COLORS.length],
  }));

  return (
    <ResponsiveContainer width="100%" height={350}>
      <PieChart>
        <Pie
          data={pieData}
          cx="50%"
          cy="50%"
          outerRadius={120}
          innerRadius={60}
          dataKey="value"
          label={({ name, percent }) => `${name.split(":")[0]} ${(percent * 100).toFixed(0)}%`}
          labelLine={{ strokeWidth: 1 }}
        >
          {pieData.map((entry, index) => (
            <Cell key={index} fill={entry.color} />
          ))}
        </Pie>
        <RechartsTooltip contentStyle={RECHARTS_TOOLTIP_STYLE} formatter={(value: number) => formatCurrency(value)} />
      </PieChart>
    </ResponsiveContainer>
  );
}

// ─── Category Pivot Table ─────────────────────────────────
function CategoryPivotTable({ data }: { data: StatisticsData }) {
  const [yearFilter, setYearFilter] = useState<string>("all");

  const filteredPeriods = useMemo(() => {
    if (yearFilter === "all") return data.allPeriods;
    return data.allPeriods.filter((p) => p.startsWith(yearFilter));
  }, [yearFilter, data.allPeriods]);

  const filteredCategories = useMemo(() => {
    return data.categoryPivot
      .map((cat) => {
        const filteredTotal = filteredPeriods.reduce((s, p) => s + (cat.months[p] || 0), 0);
        return { ...cat, filteredTotal };
      })
      .filter((cat) => cat.filteredTotal > 0)
      .sort((a, b) => b.filteredTotal - a.filteredTotal);
  }, [data.categoryPivot, filteredPeriods]);

  const columnTotals = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const period of filteredPeriods) {
      totals[period] = filteredCategories.reduce((s, cat) => s + (cat.months[period] || 0), 0);
    }
    return totals;
  }, [filteredCategories, filteredPeriods]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>Category Pivot Table</CardTitle>
          <CardDescription>Category spending broken down by month</CardDescription>
        </div>
        <Select value={yearFilter} onValueChange={setYearFilter}>
          <SelectTrigger className="w-[120px]">
            <SelectValue placeholder="Year" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Years</SelectItem>
            {data.allYears.map((y) => (
              <SelectItem key={y} value={y.toString()}>{y}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent>
        <ScrollArea className="w-full">
          <div className="min-w-[800px]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 px-3 font-medium text-muted-foreground sticky left-0 bg-card z-10">Category</th>
                  {filteredPeriods.map((p) => (
                    <th key={p} className="text-right py-2 px-3 font-medium text-muted-foreground whitespace-nowrap">
                      {formatPeriodShort(p)}
                    </th>
                  ))}
                  <th className="text-right py-2 px-3 font-bold text-foreground">Total</th>
                </tr>
              </thead>
              <tbody>
                {filteredCategories.map((cat) => (
                  <tr key={cat.categoryId} className="border-b border-border/50 hover:bg-muted/50 transition-colors">
                    <td className="py-2 px-3 font-medium sticky left-0 bg-card z-10 whitespace-nowrap">{cat.categoryName}</td>
                    {filteredPeriods.map((p) => {
                      const val = cat.months[p] || 0;
                      return (
                        <td key={p} className={`text-right py-2 px-3 tabular-nums ${val === 0 ? "text-muted-foreground/40" : ""}`}>
                          {val === 0 ? "—" : formatCurrency(val)}
                        </td>
                      );
                    })}
                    <td className="text-right py-2 px-3 font-bold tabular-nums">{formatCurrency(cat.filteredTotal)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border font-bold">
                  <td className="py-2 px-3 sticky left-0 bg-card z-10">Total</td>
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
  const topCategories = data.categoryPivot.slice(0, 5);
  const chartData = data.allPeriods.map((period) => {
    const point: Record<string, any> = { period: formatPeriodShort(period) };
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
        <YAxis tick={{ fontSize: 11 }} className="fill-muted-foreground" tickFormatter={(v) => `€${(v / 1000).toFixed(0)}k`} />
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
  children: (data: StatisticsData) => React.ReactNode;
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

// ─── Main Page ────────────────────────────────────────────
export default function StatisticsPage() {
  const {
    data, isLoading, isError, error,
    getGraphData, graphExclusions, toggleGraphExclusion, exclusionsApply,
  } = useStatistics();

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold text-foreground">Statistics</h1>
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
      <div className="space-y-6">
        <h1 className="text-3xl font-bold text-foreground">Statistics</h1>
        <Card>
          <CardContent className="pt-6">
            <p className="text-destructive">Failed to load statistics: {error?.message}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!data || data.monthlyData.length === 0) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold text-foreground">Statistics</h1>
        <Card>
          <CardContent className="pt-6">
            <p className="text-muted-foreground">No transaction data available yet. Import some transactions to see statistics.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const chartCardProps = { getGraphData, graphExclusions, toggleGraphExclusion, exclusionsApply };

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold text-foreground">Statistics</h1>

      <SummaryCards data={data} />

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="categories">Categories</TabsTrigger>
          <TabsTrigger value="recipients">Recipients</TabsTrigger>
          <TabsTrigger value="yearly">Yearly</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          <ChartCard title="Monthly Income vs Spending" description="Track your cash flow over time" graphKey="monthly" {...chartCardProps}>
            {(d) => <MonthlyChart data={d} />}
          </ChartCard>
          <ChartCard title="Net Balance Trend" description="Monthly net (income − spending)" graphKey="netTrend" {...chartCardProps}>
            {(d) => <NetTrendChart data={d} />}
          </ChartCard>
        </TabsContent>

        <TabsContent value="categories" className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <ChartCard title="Spending by Category" description="Overall distribution across categories" graphKey="categoryPie" {...chartCardProps}>
              {(d) => <CategoryPieChart data={d} />}
            </ChartCard>
            <ChartCard title="Top Category Trends" description="Monthly spending for top 5 categories" graphKey="categoryTrend" {...chartCardProps}>
              {(d) => <CategoryTrendChart data={d} />}
            </ChartCard>
          </div>
          <CategoryPivotTable data={getGraphData("pivotTable") || data} />
        </TabsContent>

        <TabsContent value="recipients" className="space-y-6">
          <ChartCard title="Top Recipients by Spending" description="Where your money goes most" graphKey="topRecipients" {...chartCardProps}>
            {(d) => <TopRecipientsChart data={d} />}
          </ChartCard>
        </TabsContent>

        <TabsContent value="yearly" className="space-y-6">
          <ChartCard title="Year-over-Year Comparison" description="Annual totals compared" graphKey="yearlyComparison" {...chartCardProps}>
            {(d) => <YearlyComparisonChart data={d} />}
          </ChartCard>
          {/* Yearly summary table */}
          <Card>
            <CardHeader>
              <CardTitle>Yearly Summary</CardTitle>
            </CardHeader>
            <CardContent>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-2 px-3 font-medium text-muted-foreground">Year</th>
                    <th className="text-right py-2 px-3 font-medium text-muted-foreground">Income</th>
                    <th className="text-right py-2 px-3 font-medium text-muted-foreground">Spending</th>
                    <th className="text-right py-2 px-3 font-medium text-muted-foreground">Net</th>
                    <th className="text-right py-2 px-3 font-medium text-muted-foreground">Transactions</th>
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
                      <td className="text-right py-2 px-3 tabular-nums">{y.transactionCount.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
