import { useQuery } from "@tanstack/react-query";
import { apiClient, type NetWorthSnapshot } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { numberFormatToLocale } from "@/utils/currency";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from "recharts";
import { TrendingUp, TrendingDown, Wallet, Landmark, PiggyBank } from "lucide-react";
import { cn } from "@/lib/utils";

function fmtMonth(month: string, lang: string) {
  const [y, m] = month.split("-");
  const date = new Date(Number(y), Number(m) - 1);
  // Use language (eg. 'en'|'nl') for month localization while preserving numeric locale for currency elsewhere
  return date.toLocaleDateString(lang, { month: "short", year: "2-digit" });
}

export default function NetWorthPage() {
  const { t, language } = useLanguage();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const { data, isLoading, error } = useQuery({
    queryKey: ["net-worth"],
    queryFn: () => apiClient.getNetWorth(),
    staleTime: 60_000,
  });

  function fmt(val: number) {
    return new Intl.NumberFormat(locale, {
      style: "currency", currency: "EUR",
      minimumFractionDigits: 0, maximumFractionDigits: 0,
    }).format(val);
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold text-foreground">{t('networth.title')}</h1>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[1, 2, 3].map(i => (
            <Card key={i}><CardContent className="pt-6"><Skeleton className="h-16 w-full" /></CardContent></Card>
          ))}
        </div>
        <Card><CardContent className="pt-6"><Skeleton className="h-[400px] w-full" /></CardContent></Card>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold text-foreground">{t('networth.title')}</h1>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Wallet className="h-12 w-12 text-muted-foreground/40 mb-4" />
            <h3 className="text-lg font-semibold text-foreground mb-1">{t('networth.unableToLoad')}</h3>
            <p className="text-muted-foreground text-sm">
              {error instanceof Error ? error.message : t('networth.tryAgain')}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { current, monthlyChange, monthlyChangePercent, snapshots } = data;
  const isPositiveChange = monthlyChange >= 0;

  // Min/max for chart
  const allValues = snapshots.map(s => s.netWorth);
  const peak = Math.max(...allValues);
  const trough = Math.min(...allValues);
  const firstNetWorth = snapshots[0]?.netWorth ?? 0;
  const allTimeChange = current.netWorth - firstNetWorth;
  const allTimePercent = firstNetWorth !== 0 ? (allTimeChange / Math.abs(firstNetWorth)) * 100 : 0;

  const cards = [
    {
      title: t('networth.title'),
      value: fmt(current.netWorth),
      icon: Wallet,
      desc: (
        <span className={cn("text-xs font-medium", isPositiveChange ? "text-accent" : "text-destructive")}>
          {isPositiveChange ? "+" : ""}{fmt(monthlyChange)} ({monthlyChangePercent >= 0 ? "+" : ""}{monthlyChangePercent.toFixed(1)}%) {t('networth.thisMonth')}
        </span>
      ),
      cls: "text-primary",
    },
    {
      title: t('networth.liquid'),
      value: fmt(current.liquid),
      icon: Landmark,
      desc: `${current.netWorth > 0 ? ((current.liquid / current.netWorth) * 100).toFixed(0) : 0}% ${t('networth.ofNetWorth')}`,
      cls: "text-foreground",
    },
    {
      title: t('networth.investments'),
      value: fmt(current.investments),
      icon: PiggyBank,
      desc: `${current.netWorth > 0 ? ((current.investments / current.netWorth) * 100).toFixed(0) : 0}% ${t('networth.ofNetWorth')}`,
      cls: "text-foreground",
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-foreground">{t('networth.title')}</h1>
        <Badge variant="outline" className={cn(
          "text-sm px-3 py-1",
          allTimeChange >= 0 ? "border-accent/30 text-accent" : "border-destructive/30 text-destructive"
        )}>
          {allTimeChange >= 0 ? <TrendingUp className="h-3.5 w-3.5 mr-1" /> : <TrendingDown className="h-3.5 w-3.5 mr-1" />}
          {allTimeChange >= 0 ? "+" : ""}{fmt(allTimeChange)} {t('networth.allTime')} ({allTimePercent >= 0 ? "+" : ""}{allTimePercent.toFixed(1)}%)
        </Badge>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {cards.map((c) => (
          <Card key={c.title}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{c.title}</CardTitle>
              <c.icon className={`h-4 w-4 ${c.cls}`} />
            </CardHeader>
            <CardContent>
              <p className={`text-2xl font-bold ${c.cls}`}>{c.value}</p>
              <p className="text-xs text-muted-foreground mt-1">{c.desc}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Main Chart */}
      <Card>
        <CardHeader>
          <CardTitle>{t('networth.overTime')}</CardTitle>
          <CardDescription>{t('networth.chartDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={420}>
            <AreaChart data={snapshots} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
              <defs>
                <linearGradient id="gradNetWorth" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gradLiquid" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(var(--accent))" stopOpacity={0.2} />
                  <stop offset="95%" stopColor="hsl(var(--accent))" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gradInvest" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(217, 91%, 60%)" stopOpacity={0.2} />
                  <stop offset="95%" stopColor="hsl(217, 91%, 60%)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis
                dataKey="month"
                tickFormatter={(v: string) => fmtMonth(v, language)}
                tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
                axisLine={{ stroke: "hsl(var(--border))" }}
              />
              <YAxis
                tickFormatter={(v) => fmt(v)}
                tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
                axisLine={{ stroke: "hsl(var(--border))" }}
                width={80}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--card))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "var(--radius)",
                  color: "hsl(var(--card-foreground))",
                }}
                 labelFormatter={(v: string) => fmtMonth(v, language)}
                formatter={(value: number, name: string) => [fmt(value), name]}
              />
              <Legend />
              <Area
                type="monotone"
                dataKey="netWorth"
                name={t('networth.title')}
                stroke="hsl(var(--primary))"
                strokeWidth={2.5}
                fill="url(#gradNetWorth)"
              />
              <Area
                type="monotone"
                dataKey="liquid"
                name={t('networth.liquid')}
                stroke="hsl(var(--accent))"
                strokeWidth={1.5}
                fill="url(#gradLiquid)"
                strokeDasharray="4 2"
              />
              <Area
                type="monotone"
                dataKey="investments"
                name={t('networth.investments')}
                stroke="hsl(217, 91%, 60%)"
                strokeWidth={1.5}
                fill="url(#gradInvest)"
                strokeDasharray="4 2"
              />
            </AreaChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Stats Row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{t('networth.peak')}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xl font-bold text-foreground">{fmt(peak)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{t('networth.lowest')}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xl font-bold text-foreground">{fmt(trough)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{t('networth.monthsTracked')}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xl font-bold text-foreground">{snapshots.length}</p>
          </CardContent>
        </Card>
      </div>

      {/* Monthly Breakdown Table */}
      {snapshots.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t('networth.monthlyBreakdown')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    {[
                      t('networth.month'),
                      t('networth.liquid'),
                      t('networth.investments'),
                      t('networth.title'),
                      t('networth.change'),
                    ].map(h => (
                      <th key={h} className={cn("py-2 px-3 font-medium text-muted-foreground", h !== t('networth.month') ? "text-right" : "text-left")}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...snapshots].reverse().map((s, idx, arr) => {
                    const prev = arr[idx + 1];
                    const change = prev ? s.netWorth - prev.netWorth : 0;
                    return (
                      <tr key={s.month} className="border-b border-border/50 hover:bg-muted/50 transition-colors">
                        <td className="py-2 px-3 font-medium">{fmtMonth(s.month, language)}</td>
                        <td className="text-right py-2 px-3 tabular-nums">{fmt(s.liquid)}</td>
                        <td className="text-right py-2 px-3 tabular-nums">{fmt(s.investments)}</td>
                        <td className="text-right py-2 px-3 tabular-nums font-bold">{fmt(s.netWorth)}</td>
                        <td className={cn("text-right py-2 px-3 tabular-nums font-medium",
                          change >= 0 ? "text-accent" : "text-destructive"
                        )}>
                          {prev ? `${change >= 0 ? "+" : ""}${fmt(change)}` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
