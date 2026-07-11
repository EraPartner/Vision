import { useMemo } from 'react';
import {
    Bar,
    BarChart,
    CartesianGrid,
    Cell,
    Legend,
    Line,
    LineChart,
    Pie,
    PieChart,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from 'recharts';
import { getChartColor } from '@/components/charts';
import { cn } from '@/lib/utils';
import type { ToolErrorDetail, ToolRenderAs, ToolResultPayload } from '@/types/aiChat';

function formatToolError(error: ToolResultPayload['error']): string {
    if (!error) return 'Tool failed.';
    if (typeof error === 'string') return error;
    const detail = error as ToolErrorDetail;
    const parts: string[] = [];
    if (detail.field) parts.push(detail.field);
    if (detail.message) parts.push(detail.message);
    if (parts.length === 0) {
        if (detail.code) parts.push(detail.code);
        else {
            try { return JSON.stringify(detail); } catch { return 'Tool failed.'; }
        }
    }
    return parts.join(': ');
}

interface ToolResultCardProps {
    toolName?: string | null;
    result: ToolResultPayload;
}


type Row = Record<string, unknown>;

function asRows(data: unknown): Row[] {
    if (Array.isArray(data)) {
        return data.filter((r): r is Row => r !== null && typeof r === 'object');
    }
    if (data && typeof data === 'object') {
        return [data as Row];
    }
    return [];
}

function formatCell(value: unknown): string {
    if (value === null || value === undefined) return '—';
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return String(value);
        if (Number.isInteger(value)) return value.toLocaleString();
        return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
    }
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function inferColumns(rows: Row[], preferred?: string[]): string[] {
    if (preferred && preferred.length > 0) return preferred;
    if (rows.length === 0) return [];
    return Object.keys(rows[0]);
}

function pickNumericKeys(rows: Row[], exclude: string): string[] {
    if (rows.length === 0) return [];
    return Object.keys(rows[0]).filter(
        (key) => key !== exclude && typeof rows[0][key] === 'number',
    );
}

export function ToolResultCard({ toolName, result }: ToolResultCardProps) {
    const rows = useMemo(() => asRows(result.ok ? result.data : null), [result]);
    const meta = result.meta;
    const renderAs: ToolRenderAs | 'json' = meta?.renderAs ?? (rows.length > 0 ? 'table' : 'json');

    if (!result.ok) {
        return (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
                <p className="text-xs font-medium text-destructive">
                    {toolName ? `${toolName}: ` : ''}
                    {formatToolError(result.error)}
                </p>
            </div>
        );
    }

    return (
        <div className="space-y-2">
            {renderAs === 'table' && <TableView rows={rows} columns={meta?.columns} />}
            {renderAs === 'line' && (
                <LineChartView rows={rows} xKey={meta?.xKey} yKeys={meta?.yKeys} />
            )}
            {renderAs === 'bar' && (
                <BarChartView rows={rows} xKey={meta?.xKey} yKeys={meta?.yKeys} />
            )}
            {renderAs === 'pie' && (
                <PieChartView rows={rows} xKey={meta?.xKey} yKeys={meta?.yKeys} />
            )}
            {renderAs === 'json' && <JsonView data={result.data} />}
            <Footer meta={meta} rowCount={rows.length} />
        </div>
    );
}

function TableView({ rows, columns }: { rows: Row[]; columns?: string[] }) {
    const cols = inferColumns(rows, columns);
    if (cols.length === 0 || rows.length === 0) {
        return <p className="text-xs text-muted-foreground">No rows.</p>;
    }
    return (
        <div className="max-h-72 overflow-auto rounded-lg border border-border/40 bg-background/60">
            <table className="w-full border-collapse text-[11px]">
                <thead className="sticky top-0 bg-muted/40 text-muted-foreground backdrop-blur-sm">
                    <tr>
                        {cols.map((col) => (
                            <th
                                key={col}
                                className="border-b border-border/40 px-2 py-1.5 text-left font-medium uppercase tracking-wide"
                            >
                                {col}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row, idx) => (
                        <tr
                            key={`${idx}-${cols.map((c) => String(row[c] ?? '')).join('|').slice(0, 80)}`}
                            className={cn(
                                'border-b border-border/20 last:border-b-0',
                                idx % 2 === 1 && 'bg-muted/20',
                            )}
                        >
                            {cols.map((col) => {
                                const val = row[col];
                                const numeric = typeof val === 'number';
                                return (
                                    <td
                                        key={col}
                                        className={cn(
                                            'px-2 py-1 text-foreground/90',
                                            numeric && 'text-right tabular-nums',
                                        )}
                                    >
                                        {formatCell(val)}
                                    </td>
                                );
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

interface ChartViewProps {
    rows: Row[];
    xKey?: string;
    yKeys?: string[];
}

function resolveAxes(rows: Row[], xKey?: string, yKeys?: string[]) {
    const xk = xKey ?? (rows.length > 0 ? Object.keys(rows[0])[0] : '');
    const yk = yKeys && yKeys.length > 0 ? yKeys : pickNumericKeys(rows, xk);
    return { xk, yk };
}

function LineChartView({ rows, xKey, yKeys }: ChartViewProps) {
    const { xk, yk } = resolveAxes(rows, xKey, yKeys);
    if (rows.length === 0 || yk.length === 0) {
        return <p className="text-xs text-muted-foreground">No chart data.</p>;
    }
    return (
        <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
                <LineChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                    <XAxis dataKey={xk} tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                    <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                    <Tooltip contentStyle={tooltipStyle} />
                    {yk.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
                    {yk.map((key, i) => (
                        <Line
                            key={key}
                            type="monotone"
                            dataKey={key}
                            stroke={getChartColor(i)}
                            strokeWidth={2}
                            dot={false}
                            isAnimationActive={false}
                        />
                    ))}
                </LineChart>
            </ResponsiveContainer>
        </div>
    );
}

function BarChartView({ rows, xKey, yKeys }: ChartViewProps) {
    const { xk, yk } = resolveAxes(rows, xKey, yKeys);
    if (rows.length === 0 || yk.length === 0) {
        return <p className="text-xs text-muted-foreground">No chart data.</p>;
    }
    return (
        <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
                <BarChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                    <XAxis dataKey={xk} tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                    <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                    <Tooltip contentStyle={tooltipStyle} />
                    {yk.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
                    {yk.map((key, i) => (
                        <Bar
                            key={key}
                            dataKey={key}
                            fill={getChartColor(i)}
                            radius={[4, 4, 0, 0]}
                            isAnimationActive={false}
                        />
                    ))}
                </BarChart>
            </ResponsiveContainer>
        </div>
    );
}

function PieChartView({ rows, xKey, yKeys }: ChartViewProps) {
    const { xk, yk } = resolveAxes(rows, xKey, yKeys);
    const valueKey = yk[0];
    if (rows.length === 0 || !valueKey) {
        return <p className="text-xs text-muted-foreground">No chart data.</p>;
    }
    const data = rows.map((r) => ({
        name: String(r[xk] ?? ''),
        value: typeof r[valueKey] === 'number' ? (r[valueKey] as number) : 0,
    }));
    return (
        <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                    <Pie
                        data={data}
                        cx="50%"
                        cy="50%"
                        outerRadius={80}
                        innerRadius={40}
                        dataKey="value"
                        label={({ name, percent }) =>
                            `${name} ${((percent ?? 0) * 100).toFixed(0)}%`
                        }
                        labelLine={{ strokeWidth: 1 }}
                        isAnimationActive={false}
                    >
                        {data.map((entry, i) => (
                            <Cell key={`${entry.name}-${i}`} fill={getChartColor(i)} />
                        ))}
                    </Pie>
                    <Tooltip contentStyle={tooltipStyle} />
                </PieChart>
            </ResponsiveContainer>
        </div>
    );
}

function JsonView({ data }: { data: unknown }) {
    return (
        <pre className="max-h-64 overflow-auto rounded-md border border-border/40 bg-background/60 p-2 text-[11px] leading-snug text-foreground/80">
            {JSON.stringify(data, null, 2)}
        </pre>
    );
}

function Footer({
    meta,
    rowCount,
}: {
    meta?: ToolResultPayload['meta'];
    rowCount: number;
}) {
    const total = typeof meta?.total === 'number' ? meta.total : undefined;
    if (total === undefined && rowCount === 0) return null;
    const shown = rowCount;
    const label =
        total !== undefined && total !== shown
            ? `Showing ${shown} of ${total}`
            : `${shown} row${shown === 1 ? '' : 's'}`;
    return (
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground/80">
            {label}
        </p>
    );
}

const tooltipStyle = {
    backgroundColor: 'hsl(var(--popover))',
    border: '1px solid hsl(var(--border))',
    borderRadius: '8px',
    fontSize: '11px',
    color: 'hsl(var(--popover-foreground))',
};
