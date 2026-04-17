import React, { useMemo } from "react";
import { VirtualDataTable } from "@/components/shared/VirtualDataTable";
import { cn } from "@/lib/utils";
import { NetWorthSnapshot, fmtDay } from "./netWorthChartUtils";

interface SnapshotDataTableProps {
  snapshots: NetWorthSnapshot[];
  fmt: (val: number) => string;
  dateFormat: string;
  t: (key: string) => string;
}

type BreakdownRow = {
  date: string;
  liquid: number;
  investments: number;
  netWorth: number;
  change: number | undefined;
};

export function SnapshotDataTable({ snapshots, fmt, dateFormat, t }: SnapshotDataTableProps) {
  const rows = useMemo<BreakdownRow[]>(() => {
    const result: BreakdownRow[] = [];
    for (let idx = snapshots.length - 1; idx >= 0; idx -= 1) {
      const s = snapshots[idx];
      const prev = idx > 0 ? snapshots[idx - 1] : undefined;
      result.push({
        date: s.date,
        liquid: s.liquid,
        investments: s.investments,
        netWorth: s.netWorth,
        change: prev ? s.netWorth - prev.netWorth : undefined,
      });
    }
    return result;
  }, [snapshots]);

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
      render: (row: BreakdownRow) => fmt(row.liquid),
    },
    {
      key: 'investments',
      header: t('networth.investments'),
      className: 'text-right tabular-nums',
      render: (row: BreakdownRow) => fmt(row.investments),
    },
    {
      key: 'netWorth',
      header: t('networth.title'),
      className: 'text-right tabular-nums font-bold',
      render: (row: BreakdownRow) => fmt(row.netWorth),
    },
    {
      key: 'change',
      header: t('networth.change'),
      className: 'text-right tabular-nums',
      render: (row: BreakdownRow) => {
        if (row.change === undefined) return '—';
        return (
          <span className={cn("font-medium", row.change >= 0 ? "text-accent" : "text-destructive")}>
            {row.change >= 0 ? "+" : ""}{fmt(row.change)}
          </span>
        );
      },
    },
  ], [dateFormat, fmt, t]);

  if (snapshots.length === 0) return null;

  return (
    <VirtualDataTable
      title={t('networth.dailyBreakdown')}
      columns={columns}
      data={rows}
      maxHeight={520}
    />
  );
}
