import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiClient } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { VirtualDataTable } from "@/components/shared/VirtualDataTable";
import { numberFormatToLocale } from "@/utils/currency";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from "recharts";
import { TrendingUp, TrendingDown, Wallet, Landmark, PiggyBank } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDateWithAppSettings, parseLocalDateFromYmd } from "@/components/shared/dateUtils";
import { downsampleLTTB } from "@/utils/downsample";

function fmtDay(date: string, appDateFormat: string) {
  return formatDateWithAppSettings(parseLocalDateFromYmd(date), appDateFormat);
}

const EMPTY_SNAPSHOTS: Array<{ date: string; netWorth: number; liquid: number; investments: number }> = [];
const DAY_WIDTH_OPTIONS = [20, 16, 12, 10, 8, 6, 5, 4, 3, 2, 1, 0.75, 0.5, 0.25, 0.15, 0.1, 0.05, 0.03] as const;
const MIN_CHART_WIDTH = 320;
const DOMAIN_SCROLL_THRESHOLD_PX = 24;
const DOMAIN_SCROLL_IDLE_MS = 120;
type NetWorthSeries = 'netWorth' | 'liquid' | 'investments';

function normalizeYmd(value: string) {
  if (!value) return value;
  if (value.includes('T')) return value.split('T')[0];
  if (value.length > 10) return value.slice(0, 10);
  return value;
}


function formatMonthTickLabel(dateYmd: string, formatter: Intl.DateTimeFormat) {
  const normalized = normalizeYmd(dateYmd);
  const parsed = parseLocalDateFromYmd(normalized);
  if (Number.isNaN(parsed.getTime())) return normalized;
  return formatter.format(parsed);
}


function computeYDomain(
  points: Array<{ netWorth: number; liquid: number; investments: number }>,
  series: NetWorthSeries[] = ['netWorth', 'liquid', 'investments'],
): [number, number] {
  let minValue = Number.POSITIVE_INFINITY;
  let maxValue = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    for (let j = 0; j < series.length; j++) {
      const value = point[series[j]];
      if (Number.isFinite(value)) {
        if (value < minValue) minValue = value;
        if (value > maxValue) maxValue = value;
      }
    }
  }

  if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) return [0, 100];

  const span = maxValue - minValue;
  const padding = span === 0
    ? Math.max(Math.abs(maxValue) * 0.03, 1)
    : Math.max(span * 0.03, 1);

  const lower = Math.floor((minValue - padding) * 100) / 100;
  const upper = Math.ceil((maxValue + padding) * 100) / 100;
  return [lower, upper];
}

function computeSeriesDomainForRange(
  points: Array<{ netWorth: number; liquid: number; investments: number }>,
  series: NetWorthSeries,
  startIndex: number,
  endIndex: number,
): [number, number] {
  if (points.length === 0) return [0, 100];
  const safeStart = Math.max(0, startIndex);
  const safeEnd = Math.min(points.length - 1, endIndex);
  if (safeEnd < safeStart) return [0, 100];

  let minValue = Number.POSITIVE_INFINITY;
  let maxValue = Number.NEGATIVE_INFINITY;

  for (let index = safeStart; index <= safeEnd; index += 1) {
    const point = points[index];
    const value = point?.[series];
    if (!Number.isFinite(value)) continue;
    if (value < minValue) minValue = value;
    if (value > maxValue) maxValue = value;
  }

  if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) {
    return [0, 100];
  }

  const span = maxValue - minValue;
  const padding = span === 0
    ? Math.max(Math.abs(maxValue) * 0.03, 1)
    : Math.max(span * 0.03, 1);

  const lower = Math.floor((minValue - padding) * 100) / 100;
  const upper = Math.ceil((maxValue + padding) * 100) / 100;
  return [lower, upper];
}

function niceStep(roughStep: number) {
  if (!Number.isFinite(roughStep) || roughStep <= 0) return 100;

  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;

  let niceNormalized;
  if (normalized <= 1) niceNormalized = 1;
  else if (normalized <= 2) niceNormalized = 2;
  else if (normalized <= 5) niceNormalized = 5;
  else niceNormalized = 10;

  return niceNormalized * magnitude;
}

function computeNiceYDomain(domain: [number, number], tickCount = 7): [number, number] {
  const [rawMin, rawMax] = domain;
  if (!Number.isFinite(rawMin) || !Number.isFinite(rawMax)) return [0, 1000];

  if (rawMin === rawMax) {
    const base = Math.max(100, niceStep(Math.abs(rawMax) / 5));
    const center = rawMax;
    const min = Math.floor((center - base * 2) / base) * base;
    const max = Math.ceil((center + base * 2) / base) * base;
    return min >= max ? [0, Math.max(base, max)] : [min, max];
  }

  const steps = Math.max(2, tickCount - 1);
  const roughStep = (rawMax - rawMin) / steps;
  const step = Math.max(1, niceStep(roughStep));
  const min = Math.floor(rawMin / step) * step;
  const max = Math.ceil(rawMax / step) * step;

  return min >= max ? [0, Math.max(step, max)] : [min, max];
}

export default function NetWorthPage() {
  const { t, language } = useLanguage();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const targetCurrency = appSettings.defaultCurrency || "EUR";
  const { data, isLoading, error } = useQuery({
    queryKey: ["net-worth", targetCurrency],
    queryFn: () => apiClient.getNetWorth({ currency: targetCurrency }),
    staleTime: 60_000,
  });
  const chartScrollRef = useRef<HTMLDivElement | null>(null);
  const [yDomain, setYDomain] = useState<[number, number] | undefined>(undefined);
  const [isAtLatest, setIsAtLatest] = useState(true);
  const [zoomStep, setZoomStep] = useState(0);
  const [selectedSeries, setSelectedSeries] = useState<NetWorthSeries>('netWorth');
  const scrollRafRef = useRef<number | null>(null);
  const scrollIdleTimerRef = useRef<number | null>(null);
  const rangeRef = useRef<{ startIndex: number; endIndex: number } | null>(null);
  const lastDomainScrollLeftRef = useRef<number>(-1);
  const pendingZoomScrollRatioRef = useRef<number | null>(null);
  const snapshots = useMemo(() => {
    const raw = data?.snapshots ?? EMPTY_SNAPSHOTS;
    const result: typeof EMPTY_SNAPSHOTS = [];
    for (let i = 0; i < raw.length; i++) {
      const s = raw[i];
      const date = normalizeYmd(s.date);
      if (date && Number.isFinite(s.netWorth) && Number.isFinite(s.liquid) && Number.isFinite(s.investments)) {
        // Avoid object spread — only create new object when date changed
        result.push(date !== s.date ? { date, netWorth: s.netWorth, liquid: s.liquid, investments: s.investments } : s);
      }
    }
    return result;
  }, [data?.snapshots]);

  const dayWidth = DAY_WIDTH_OPTIONS[zoomStep] ?? DAY_WIDTH_OPTIONS[0];

  const chartSnapshots = useMemo(() => {
    const scrollWidth = chartScrollRef.current?.clientWidth || 800;
    const maxPointsForZoom = Math.max(150, Math.min(500, Math.round(scrollWidth / dayWidth)));
    const threshold = Math.min(maxPointsForZoom, 400);
    if (snapshots.length <= threshold) return snapshots;
    return downsampleLTTB(snapshots, threshold, (_item, i) => i, (item) => item[selectedSeries]);
  }, [snapshots, selectedSeries, dayWidth]);

  const currencyFormatter = useMemo(() => new Intl.NumberFormat(locale, {
    style: "currency",
    currency: appSettings.defaultCurrency || "EUR",
    minimumFractionDigits: appSettings.showDecimalPlaces,
    maximumFractionDigits: appSettings.showDecimalPlaces,
  }), [appSettings.defaultCurrency, appSettings.showDecimalPlaces, locale]);

  const monthLabelLocale = useMemo(() => (language === 'nl' ? 'nl-NL' : 'en-US'), [language]);

  const monthTickFormatter = useMemo(
    () => new Intl.DateTimeFormat(monthLabelLocale, { month: 'short', year: '2-digit' }),
    [monthLabelLocale],
  );

  const scrollToLatest = () => {
    const scrollEl = chartScrollRef.current;
    if (!scrollEl) return;
    scrollEl.scrollTo({
      left: Math.max(0, scrollEl.scrollWidth - scrollEl.clientWidth),
      behavior: "smooth",
    });
  };

  const captureZoomAnchor = useCallback(() => {
    const scrollEl = chartScrollRef.current;
    if (!scrollEl) return;

    const maxScrollLeft = Math.max(0, scrollEl.scrollWidth - scrollEl.clientWidth);
    if (maxScrollLeft <= 0) {
      pendingZoomScrollRatioRef.current = 1;
      return;
    }

    const isLatestView = scrollEl.scrollLeft >= maxScrollLeft - 8;
    pendingZoomScrollRatioRef.current = isLatestView
      ? 1
      : Math.min(1, Math.max(0, scrollEl.scrollLeft / maxScrollLeft));
  }, []);

  const tooltipLabelFormatter = useCallback((v: string) => fmtDay(v, appSettings.dateFormat), [appSettings.dateFormat]);
  const tooltipValueFormatter = useCallback((value: number, name: string) => [fmt(value), name], [fmt]);
  const tooltipContentStyle = useMemo(() => ({
    backgroundColor: "hsl(var(--card))",
    border: "1px solid hsl(var(--border))",
    borderRadius: "var(--radius)",
    color: "hsl(var(--card-foreground))",
  }), []);



  const current = data?.current ?? { liquid: 0, investments: 0, netWorth: 0 };
  const monthlyChange = data?.monthlyChange ?? 0;
  const monthlyChangePercent = data?.monthlyChangePercent ?? 0;
  const isPositiveChange = monthlyChange >= 0;


  const chartWidth = useMemo(() => {
    const dayCount = Math.max(chartSnapshots.length, 1);
    return Math.max(MIN_CHART_WIDTH, dayCount * dayWidth);
  }, [chartSnapshots.length, dayWidth]);

  const displaySnapshots = chartSnapshots;

  const fallbackYDomain = useMemo(
    () => computeNiceYDomain(computeYDomain(displaySnapshots, [selectedSeries])),
    [displaySnapshots, selectedSeries],
  );

  const monthlyTicks = useMemo(() => {
    return displaySnapshots
      .filter((snapshot, idx) => idx === 0 || snapshot.date.slice(0, 7) !== displaySnapshots[idx - 1].date.slice(0, 7))
      .map((snapshot) => snapshot.date);
  }, [displaySnapshots]);

  const breakdownRows = useMemo(() => {
    const rows = [] as Array<{
      date: string;
      liquid: number;
      investments: number;
      netWorth: number;
      change: number | undefined;
    }>;

    for (let idx = snapshots.length - 1; idx >= 0; idx -= 1) {
      const s = snapshots[idx];
      const prev = idx > 0 ? snapshots[idx - 1] : undefined;
      rows.push({
        date: s.date,
        liquid: s.liquid,
        investments: s.investments,
        netWorth: s.netWorth,
        change: prev ? s.netWorth - prev.netWorth : undefined,
      });
    }

    return rows;
  }, [snapshots]);

  const breakdownColumns = useMemo(() => [
    {
      key: 'date',
      header: t('networth.date'),
      render: (row: { date: string }) => (
        <span className="font-medium">{fmtDay(row.date, appSettings.dateFormat)}</span>
      ),
    },
    {
      key: 'liquid',
      header: t('networth.liquid'),
      className: 'text-right tabular-nums',
      render: (row: { liquid: number }) => fmt(row.liquid),
    },
    {
      key: 'investments',
      header: t('networth.investments'),
      className: 'text-right tabular-nums',
      render: (row: { investments: number }) => fmt(row.investments),
    },
    {
      key: 'netWorth',
      header: t('networth.title'),
      className: 'text-right tabular-nums font-bold',
      render: (row: { netWorth: number }) => fmt(row.netWorth),
    },
    {
      key: 'change',
      header: t('networth.change'),
      className: 'text-right tabular-nums',
      render: (row: { change: number | undefined }) => {
        if (row.change === undefined) return '—';
        return (
          <span className={cn("font-medium", row.change >= 0 ? "text-accent" : "text-destructive")}>
            {row.change >= 0 ? "+" : ""}{fmt(row.change)}
          </span>
        );
      },
    },
  ], [appSettings.dateFormat, fmt, t]);

  useEffect(() => {
    if (displaySnapshots.length === 0) {
      setYDomain(undefined);
      setIsAtLatest(true);
      rangeRef.current = null;
      lastDomainScrollLeftRef.current = -1;
      return;
    }

    const scrollEl = chartScrollRef.current;
    if (!scrollEl) {
      setYDomain(computeNiceYDomain(computeYDomain(displaySnapshots, [selectedSeries])));
      setIsAtLatest(true);
      return;
    }

    const updateVisibleDomain = (force = false) => {
      const totalPoints = displaySnapshots.length;
      if (totalPoints === 0) return;

      const maxScrollLeft = Math.max(0, scrollEl.scrollWidth - scrollEl.clientWidth);
      const nextIsAtLatest = maxScrollLeft <= 2 || scrollEl.scrollLeft >= maxScrollLeft - 8;
      setIsAtLatest((prev) => (prev === nextIsAtLatest ? prev : nextIsAtLatest));

      if (
        !force
        && lastDomainScrollLeftRef.current >= 0
        && Math.abs(scrollEl.scrollLeft - lastDomainScrollLeftRef.current) < DOMAIN_SCROLL_THRESHOLD_PX
      ) {
        return;
      }
      lastDomainScrollLeftRef.current = scrollEl.scrollLeft;

      const maxIndex = totalPoints - 1;
      const safeScrollWidth = Math.max(scrollEl.scrollWidth, 1);
      const startRatio = scrollEl.scrollLeft / safeScrollWidth;
      const endRatio = (scrollEl.scrollLeft + scrollEl.clientWidth) / safeScrollWidth;

      const startIndex = Math.max(0, Math.floor(startRatio * maxIndex) - 1);
      const endIndex = Math.min(maxIndex, Math.ceil(endRatio * maxIndex) + 1);
      const previousRange = rangeRef.current;
      const rangeUnchanged = previousRange
        && previousRange.startIndex === startIndex
        && previousRange.endIndex === endIndex;

      if (force || !rangeUnchanged) {
        rangeRef.current = { startIndex, endIndex };
        const hasVisibleRange = endIndex >= startIndex;
        const nextDomain = hasVisibleRange
          ? computeNiceYDomain(computeSeriesDomainForRange(displaySnapshots, selectedSeries, startIndex, endIndex))
          : computeNiceYDomain(computeYDomain(displaySnapshots, [selectedSeries]));
        const safeDomain: [number, number] = Number.isFinite(nextDomain[0])
          && Number.isFinite(nextDomain[1])
          && nextDomain[1] > nextDomain[0]
          ? nextDomain
          : computeNiceYDomain(computeYDomain(displaySnapshots, [selectedSeries]));
        setYDomain((prev) => {
          if (prev && prev[0] === safeDomain[0] && prev[1] === safeDomain[1]) return prev;
          return safeDomain;
        });
      }
    };

    const scheduleUpdate = () => {
      if (scrollRafRef.current !== null) return;
      scrollRafRef.current = window.requestAnimationFrame(() => {
        scrollRafRef.current = null;
        updateVisibleDomain();
      });
    };

    const onScroll = () => scheduleUpdate();
    const onResize = () => scheduleUpdate();

    const onScrollWithIdle = () => {
      onScroll();
      if (scrollIdleTimerRef.current !== null) {
        window.clearTimeout(scrollIdleTimerRef.current);
      }
      scrollIdleTimerRef.current = window.setTimeout(() => {
        scrollIdleTimerRef.current = null;
        updateVisibleDomain(true);
      }, DOMAIN_SCROLL_IDLE_MS);
    };

    scrollEl.addEventListener('scroll', onScrollWithIdle, { passive: true });
    window.addEventListener('resize', onResize);

    const rafId = window.requestAnimationFrame(() => {
      const nextMaxScrollLeft = Math.max(0, scrollEl.scrollWidth - scrollEl.clientWidth);
      const pendingRatio = pendingZoomScrollRatioRef.current;

      if (pendingRatio !== null) {
        scrollEl.scrollLeft = pendingRatio >= 1 ? nextMaxScrollLeft : pendingRatio * nextMaxScrollLeft;
        pendingZoomScrollRatioRef.current = null;
      } else if (rangeRef.current === null) {
        scrollEl.scrollLeft = nextMaxScrollLeft;
      }

      lastDomainScrollLeftRef.current = scrollEl.scrollLeft;
      updateVisibleDomain(true);
    });

    return () => {
      window.cancelAnimationFrame(rafId);
      if (scrollRafRef.current !== null) {
        window.cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
      if (scrollIdleTimerRef.current !== null) {
        window.clearTimeout(scrollIdleTimerRef.current);
        scrollIdleTimerRef.current = null;
      }
      scrollEl.removeEventListener('scroll', onScrollWithIdle);
      window.removeEventListener('resize', onResize);
    };
  }, [chartWidth, displaySnapshots, selectedSeries, zoomStep]);

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

  // Min/max for chart (avoid spread on large arrays)
  let peak = -Infinity;
  let trough = Infinity;
  for (const s of snapshots) {
    if (s.netWorth > peak) peak = s.netWorth;
    if (s.netWorth < trough) trough = s.netWorth;
  }
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
      desc: `${current.netWorth > 0 ? ((current.liquid / current.netWorth) * 100).toFixed(0) : 0} ${t('networth.ofNetWorth')}`,
      cls: "text-foreground",
    },
    {
      title: t('networth.investments'),
      value: fmt(current.investments),
      icon: PiggyBank,
      desc: `${current.netWorth > 0 ? ((current.investments / current.netWorth) * 100).toFixed(0) : 0} ${t('networth.ofNetWorth')}`,
      cls: "text-foreground",
    },
  ];

  const selectedSeriesConfig = {
    netWorth: {
      label: t('networth.title'),
      stroke: 'hsl(var(--primary))',
      strokeWidth: 2.5,
      fill: 'url(#gradNetWorth)',
      dash: undefined,
    },
    liquid: {
      label: t('networth.liquid'),
      stroke: 'hsl(var(--accent))',
      strokeWidth: 2,
      fill: 'url(#gradLiquid)',
      dash: '4 2',
    },
    investments: {
      label: t('networth.investments'),
      stroke: 'hsl(217, 91%, 60%)',
      strokeWidth: 2,
      fill: 'url(#gradInvest)',
      dash: '4 2',
    },
  }[selectedSeries];

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
        <CardHeader className="sm:flex-row sm:items-start sm:justify-between gap-3">
          <div>
            <CardTitle>{t('networth.overTime')}</CardTitle>
            <CardDescription>{t('networth.chartDesc')}</CardDescription>
          </div>
          <div className="flex items-center gap-1 self-start">
            <Button
              variant={selectedSeries === 'netWorth' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setSelectedSeries('netWorth')}
            >
              {t('networth.seriesTotal')}
            </Button>
            <Button
              variant={selectedSeries === 'investments' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setSelectedSeries('investments')}
            >
              {t('networth.seriesInvestments')}
            </Button>
            <Button
              variant={selectedSeries === 'liquid' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setSelectedSeries('liquid')}
            >
              {t('networth.seriesLiquid')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground"
              onClick={() => {
                captureZoomAnchor();
                setZoomStep((prev) => Math.max(0, prev - 1));
              }}
              disabled={zoomStep <= 0}
            >
              {t('networth.zoomin')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground"
              onClick={() => {
                captureZoomAnchor();
                setZoomStep((prev) => Math.min(DAY_WIDTH_OPTIONS.length - 1, prev + 1));
              }}
              disabled={zoomStep >= DAY_WIDTH_OPTIONS.length - 1}
            >
              {t('networth.zoomout')}
            </Button>
            {!isAtLatest && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-muted-foreground"
                onClick={scrollToLatest}
              >
                {t('networth.latest')}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div ref={chartScrollRef} className="overflow-x-auto pb-2">
            <div className="min-w-full" style={{ width: chartWidth }}>
              <ResponsiveContainer width="100%" height={420}>
                <AreaChart data={displaySnapshots} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
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
                    dataKey="date"
                    ticks={monthlyTicks}
                    tickFormatter={(v: string) => formatMonthTickLabel(v, monthTickFormatter)}
                    tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
                    axisLine={{ stroke: "hsl(var(--border))" }}
                    height={36}
                    minTickGap={24}
                  />
                  <YAxis
                    domain={yDomain ?? fallbackYDomain}
                    allowDataOverflow
                    tickFormatter={(v) => fmt(v)}
                    tickCount={7}
                    tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
                    axisLine={{ stroke: "hsl(var(--border))" }}
                    width={90}
                    orientation="right"
                  />
                  <ReferenceLine
                    y={current[selectedSeries]}
                    stroke="hsl(var(--muted-foreground))"
                    strokeDasharray="2 4"
                    strokeOpacity={0.5}
                  />
                  <Tooltip
                    contentStyle={tooltipContentStyle}
                    labelFormatter={tooltipLabelFormatter}
                    formatter={tooltipValueFormatter}
                  />
                  <Area
                    type="monotone"
                    dataKey={selectedSeries}
                    name={selectedSeriesConfig.label}
                    stroke={selectedSeriesConfig.stroke}
                    strokeWidth={selectedSeriesConfig.strokeWidth}
                    fill={selectedSeriesConfig.fill}
                    strokeDasharray={selectedSeriesConfig.dash}
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
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
            <CardTitle className="text-sm font-medium text-muted-foreground">{t('networth.daysTracked')}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xl font-bold text-foreground">{snapshots.length}</p>
          </CardContent>
        </Card>
      </div>

      {/* Daily Breakdown Table */}
      {snapshots.length > 0 && (
        <VirtualDataTable
          title={t('networth.dailyBreakdown')}
          columns={breakdownColumns}
          data={breakdownRows}
          maxHeight={520}
        />
      )}
    </div>
  );
}
