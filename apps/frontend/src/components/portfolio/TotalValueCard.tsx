/**
 * TotalValueCard — enriched portfolio "Total Value" tile.
 *
 * Presentational: renders the headline total alongside:
 *   1. A 30-day cost-basis sparkline (derived from transaction flow)
 *   2. Asset-class mini bars (split by group)
 *   3. Best / worst performer rows
 *
 * All data is supplied by the parent; no hooks, no side effects.
 */

import { Sparkline as ChartSparkline } from '@/components/charts';
import { Money } from "@/components/shared/Money";
import { ArrowDownRight, ArrowUpRight, DollarSign, TrendingDown, TrendingUp } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

const SPARK_COLOR_POSITIVE = 'hsl(142, 76%, 36%)';
const SPARK_COLOR_NEGATIVE = 'hsl(0, 84%, 60%)';
const SPARK_COLOR_NEUTRAL = 'hsl(217, 91%, 60%)';

export interface AllocationSlice {
  name: string;
  value: number;
}

export interface PerformerEntry {
  id: number;
  name: string;
  symbol?: string;
  gainLossPercent: number;
  gainLossInTarget: number;
}

export interface SparklinePoint {
  t: number;
  v: number;
}

export interface TotalValueCardProps {
  /** Headline formatted currency string. */
  formattedTotal: string;
  /** Raw numeric total — used for % splits. */
  totalValue: number;
  /** Labels. */
  labels: {
    title: string;
    investments: string;
    assetSplit: string;
    bestPerformer: string;
    worstPerformer: string;
    sparkline: string;
  };
  /** Asset-class allocation slices in target currency. */
  allocation: AllocationSlice[];
  /** Best and worst performer (can be the same item for single-asset portfolios). */
  bestPerformer?: PerformerEntry;
  worstPerformer?: PerformerEntry;
  /** Sparkline points, chronological. Omit/empty to hide. */
  sparkline?: SparklinePoint[];
  /** When the sparkline series is net contributions (no win/lose valence),
   *  render the trend badge + line in a neutral colour, not green/red. */
  neutralSparkline?: boolean;
  /** Format numeric value as currency. */
  formatCurrency: (value: number) => string;
}

function formatPercent(pct: number, digits = 1): string {
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(digits)}%`;
}

function AssetSplitBars({
  allocation,
  total,
  formatCurrency,
}: {
  allocation: AllocationSlice[];
  total: number;
  formatCurrency: (v: number) => string;
}) {
  if (allocation.length === 0 || total <= 0) return null;
  const palette = [
    'hsl(217, 91%, 60%)',
    'hsl(142, 76%, 36%)',
    'hsl(45, 93%, 47%)',
    'hsl(280, 87%, 65%)',
    'hsl(340, 82%, 52%)',
  ];
  return (
    <div className="space-y-2">
      {allocation.map((slice, idx) => {
        const pct = (slice.value / total) * 100;
        const color = palette[idx % palette.length];
        return (
          <div key={slice.name} className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-1.5 min-w-0">
                <span
                  className="inline-block h-2 w-2 rounded-full shrink-0"
                  style={{ backgroundColor: color }}
                  aria-hidden
                />
                <span className="truncate text-muted-foreground">{slice.name}</span>
              </div>
              <span className="tabular-nums font-medium shrink-0 ml-2">
                {pct.toFixed(0)}%
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full transition-all"
                style={{ width: `${Math.max(pct, 2)}%`, backgroundColor: color }}
                title={formatCurrency(slice.value)}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PerformerRow({
  entry,
  label,
  kind,
}: {
  entry?: PerformerEntry;
  label: string;
  kind: 'best' | 'worst';
  formatCurrency: (v: number) => string;
}) {
  if (!entry) return null;
  const positive = entry.gainLossPercent >= 0;
  const Icon = kind === 'best' ? ArrowUpRight : ArrowDownRight;
  const tone = positive ? 'text-accent' : 'text-destructive';
  return (
    <div className="flex items-center justify-between gap-2 py-1.5">
      <div className="flex items-center gap-2 min-w-0">
        <Icon className={cn('h-3.5 w-3.5 shrink-0', tone)} aria-hidden />
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground leading-none">
            {label}
          </p>
          <p className="text-xs font-medium truncate">
            {entry.symbol ? (
              <span className="font-mono mr-1.5">{entry.symbol}</span>
            ) : null}
            <span className="text-muted-foreground">{entry.name}</span>
          </p>
        </div>
      </div>
      <div className={cn('text-right shrink-0 tabular-nums', tone)}>
        <p className="text-xs font-semibold leading-none">
          {formatPercent(entry.gainLossPercent)}
        </p>
        <p className="text-[10px] leading-tight mt-0.5">
          {entry.gainLossInTarget >= 0 ? '+' : ''}
          <Money amount={entry.gainLossInTarget} />
        </p>
      </div>
    </div>
  );
}

function Sparkline({ points, label, neutral = false }: { points: SparklinePoint[]; label: string; neutral?: boolean }) {
  if (points.length < 2) return null;
  const first = points[0].v;
  const last = points[points.length - 1].v;
  const delta = last - first;
  // `neutral` = the series is net contributions (cost-basis flow), which has no
  // win/lose valence — buying more isn't a "gain". Render it in a neutral colour
  // so it isn't misread as 30-day performance (the Performance page uses value).
  const color = neutral
    ? SPARK_COLOR_NEUTRAL
    : delta > 0 ? SPARK_COLOR_POSITIVE : delta < 0 ? SPARK_COLOR_NEGATIVE : SPARK_COLOR_NEUTRAL;
  const Trend = delta >= 0 ? TrendingUp : TrendingDown;
  const pct = first > 0 ? (delta / first) * 100 : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
        <span>{label}</span>
        <span
          className={cn(
            'flex items-center gap-1 tabular-nums',
            neutral ? 'text-muted-foreground' : delta >= 0 ? 'text-accent' : 'text-destructive'
          )}
        >
          <Trend className="h-3 w-3" aria-hidden />
          {formatPercent(pct)}
        </span>
      </div>
      <ChartSparkline data={points.map((p) => p.v)} height={64} color={color} fillArea strokeWidth={2} />
    </div>
  );
}

export function TotalValueCard({
  formattedTotal,
  totalValue,
  labels,
  allocation,
  bestPerformer,
  worstPerformer,
  sparkline = [],
  neutralSparkline = false,
  formatCurrency,
}: TotalValueCardProps) {
  const hasSparkline = sparkline.length >= 2;
  const hasAllocation = allocation.length > 0 && totalValue > 0;
  const hasPerformers = Boolean(bestPerformer || worstPerformer);

  return (
    <Card className="liquid-glass micro-lift border h-full">
      <CardHeader className="flex flex-row items-start justify-between pb-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            {labels.title}
          </CardTitle>
          <p className="text-3xl font-bold text-primary tabular-nums">{formattedTotal}</p>
          <p className="text-xs text-muted-foreground">{labels.investments}</p>
        </div>
        <DollarSign className="h-4 w-4 text-primary shrink-0" aria-hidden />
      </CardHeader>

      <CardContent className="space-y-4 pt-0">
        {hasSparkline && <Sparkline points={sparkline} label={labels.sparkline} neutral={neutralSparkline} />}

        {hasAllocation && (
          <div className="space-y-2">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {labels.assetSplit}
            </p>
            <AssetSplitBars
              allocation={allocation}
              total={totalValue}
              formatCurrency={formatCurrency}
            />
          </div>
        )}

        {hasPerformers && (
          <div className="border-t border-border/60 pt-2 divide-y divide-border/40">
            <PerformerRow
              entry={bestPerformer}
              label={labels.bestPerformer}
              kind="best"
              formatCurrency={formatCurrency}
            />
            <PerformerRow
              entry={worstPerformer}
              label={labels.worstPerformer}
              kind="worst"
              formatCurrency={formatCurrency}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
