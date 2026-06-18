/**
 * Per-account net-worth history (ADR-100). Stacks each account's rebuilt daily
 * holdings series so the composition of total holdings over time is visible by
 * account. Σ stacked == the aggregate holdings line by construction (parity).
 */

import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AreaChart, type AreaSeries } from "@/components/charts";
import { getChartColor } from "@/components/charts/palette";
import { parseLocalDateFromYmd } from "@/components/shared/dateUtils";
import type { NetWorthByAccountRow } from "@/lib/api/info";

interface NetWorthByAccountChartProps {
  accounts: NetWorthByAccountRow[];
  fmt: (val: number) => string;
  title: string;
  description: string;
  unassignedLabel: string;
}

interface Datum {
  date: Date;
  values: Record<string, number>;
}

const keyOf = (row: NetWorthByAccountRow) => String(row.accountId ?? "unassigned");

export function NetWorthByAccountChart({
  accounts,
  fmt,
  title,
  description,
  unassignedLabel,
}: NetWorthByAccountChartProps) {
  const { data, series } = useMemo(() => {
    const active = accounts.filter((a) => a.holdingsSeries && a.holdingsSeries.length > 0);

    // Align every account on the union of dates; a missing day means the account
    // held nothing then (the builder only emits accounts with value > 0), so 0.
    const byDate = new Map<string, Record<string, number>>();
    for (const a of active) {
      const k = keyOf(a);
      for (const pt of a.holdingsSeries) {
        let row = byDate.get(pt.date);
        if (!row) {
          row = {};
          byDate.set(pt.date, row);
        }
        row[k] = pt.holdings;
      }
    }

    const sortedDates = [...byDate.keys()].sort();
    const builtData: Datum[] = sortedDates.map((d) => ({
      date: parseLocalDateFromYmd(d),
      values: byDate.get(d)!,
    }));

    const builtSeries: AreaSeries<Datum>[] = active.map((a, i) => {
      const k = keyOf(a);
      return {
        key: k,
        label: a.name ?? unassignedLabel,
        accessor: (datum: Datum) => datum.values[k] ?? 0,
        color: getChartColor(i),
        fillOpacity: 0.45,
        strokeWidth: 1.5,
      };
    });

    return { data: builtData, series: builtSeries };
  }, [accounts, unassignedLabel]);

  // Need at least two points and one account to draw a meaningful history.
  if (data.length < 2 || series.length === 0) return null;

  return (
    <Card className="glass-regular">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <p className="text-xs text-muted-foreground">{description}</p>
      </CardHeader>
      <CardContent>
        <AreaChart
          data={data}
          xAccessor={(d) => d.date}
          xIsDate
          series={series}
          stacked
          height={300}
          yTickFormat={fmt}
          tooltipValueFormat={(value) => fmt(value)}
          ariaLabel={title}
        />
      </CardContent>
    </Card>
  );
}
