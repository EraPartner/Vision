import { useMemo } from "react";
import { VirtualDataTable } from "@/components/shared/VirtualDataTable";
import { cn } from "@/lib/utils";
import { NetWorthSnapshot, fmtDay } from "./netWorthChartUtils";
import { Money } from "@/components/shared/Money";

interface SnapshotDataTableProps {
  snapshots: NetWorthSnapshot[];
  currency: string;
  dateFormat: string;
  t: (key: string) => string;
  totalItems?: number;
  isFetchingMore?: boolean;
  hasMore?: boolean;
  onLoadMore?: () => void;
}

type BreakdownRow = {
  date: string;
  liquid: number;
  liabilities: number;
  investments: number;
  netWorth: number;
  change: number | undefined;
};

export function SnapshotDataTable({
  snapshots,
  currency,
  dateFormat,
  t,
  totalItems,
  isFetchingMore,
  hasMore,
  onLoadMore,
}: SnapshotDataTableProps) {
  // Snapshots arrive newest-first from the paginated endpoint. Row N's "change"
  // compares to the snapshot immediately older (next in the array).
  const rows = useMemo<BreakdownRow[]>(() => {
    const result: BreakdownRow[] = [];
    for (let idx = 0; idx < snapshots.length; idx += 1) {
      const s = snapshots[idx];
      const older = idx < snapshots.length - 1 ? snapshots[idx + 1] : undefined;
      result.push({
        date: s.date,
        liquid: s.liquid,
        liabilities: s.liabilities ?? 0,
        investments: s.investments,
        netWorth: s.netWorth,
        change: older ? s.netWorth - older.netWorth : undefined,
      });
    }
    return result;
  }, [snapshots]);

  // Only show the liabilities column when some day carries debt, so debt-free
  // portfolios keep the original column set.
  const hasLiabilities = useMemo(
    () => snapshots.some((s) => Math.abs(s.liabilities ?? 0) > 0.005),
    [snapshots],
  );

  const columns = useMemo(() => [
    {
      key: 'date',
      header: t('networth.date'),
      render: (row: BreakdownRow) => (
        <span className="font-medium">{fmtDay(row.date, dateFormat)}</span>
      ),
    },
    {
      key: 'liquid',
      header: t('networth.liquid'),
      className: 'text-right tabular-nums',
      render: (row: BreakdownRow) => <Money amount={row.liquid} currency={currency} />,
    },
    ...(hasLiabilities ? [{
      key: 'liabilities',
      header: t('networth.liabilities'),
      className: 'text-right tabular-nums',
      render: (row: BreakdownRow) => <Money amount={row.liabilities} currency={currency} />,
    }] : []),
    {
      key: 'investments',
      header: t('networth.investments'),
      className: 'text-right tabular-nums',
      render: (row: BreakdownRow) => <Money amount={row.investments} currency={currency} />,
    },
    {
      key: 'netWorth',
      header: t('networth.title'),
      className: 'text-right tabular-nums font-bold',
      render: (row: BreakdownRow) => <Money amount={row.netWorth} currency={currency} />,
    },
    {
      key: 'change',
      header: t('networth.change'),
      className: 'text-right tabular-nums',
      render: (row: BreakdownRow) => {
        if (row.change === undefined) return '—';
        return (
          <span className={cn("font-medium", row.change >= 0 ? "text-gain" : "text-loss")}>
            <Money amount={row.change} currency={currency} signed />
          </span>
        );
      },
    },
  ], [currency, dateFormat, t, hasLiabilities]);

  if (snapshots.length === 0) return null;

  return (
    <VirtualDataTable
      title={t('networth.dailyBreakdown')}
      columns={columns}
      data={rows}
      maxHeight={520}
      serverMode={{ pagination: { totalItems, isFetchingMore, hasMore, onLoadMore } }}
    />
  );
}
