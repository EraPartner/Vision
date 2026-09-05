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
} from "recharts";
import { getChartColor } from "@/components/charts";
import { usePercentFormatter } from "@/hooks/useCurrencyFormatter";

type Row = Record<string, unknown>;

export interface ToolResultChartProps {
    kind: "line" | "bar" | "pie";
    rows: Row[];
    xKey?: string;
    yKeys?: string[];
}

function pickNumericKeys(rows: Row[], exclude: string): string[] {
    if (rows.length === 0) return [];
    return Object.keys(rows[0]).filter(
        (key) => key !== exclude && typeof rows[0][key] === "number",
    );
}

function resolveAxes(rows: Row[], xKey?: string, yKeys?: string[]) {
    const xk = xKey ?? (rows.length > 0 ? Object.keys(rows[0])[0] : "");
    const yk = yKeys && yKeys.length > 0 ? yKeys : pickNumericKeys(rows, xk);
    return { xk, yk };
}

const tooltipStyle = {
    backgroundColor: "hsl(var(--popover))",
    border: "1px solid hsl(var(--border))",
    borderRadius: "8px",
    fontSize: "11px",
    color: "hsl(var(--popover-foreground))",
};

function CartesianChart({
    rows,
    xKey,
    yKeys,
    kind,
}: ToolResultChartProps & { kind: "line" | "bar" }) {
    const { xk, yk } = resolveAxes(rows, xKey, yKeys);
    if (rows.length === 0 || yk.length === 0) {
        return <p className="text-xs text-muted-foreground">No chart data.</p>;
    }
    const frame = [
        <CartesianGrid
            key="grid"
            strokeDasharray="3 3"
            stroke="hsl(var(--border))"
            opacity={0.3}
        />,
        <XAxis
            key="x"
            dataKey={xk}
            tick={{
                className: "tabular-nums",
                fill: "hsl(var(--muted-foreground))",
                fontFamily: "inherit",
                fontSize: 11,
            }}
            stroke="hsl(var(--muted-foreground))"
        />,
        <YAxis
            key="y"
            tick={{
                className: "tabular-nums",
                fill: "hsl(var(--muted-foreground))",
                fontFamily: "inherit",
                fontSize: 11,
            }}
            stroke="hsl(var(--muted-foreground))"
        />,
        <Tooltip key="tooltip" contentStyle={tooltipStyle} />,
        ...(yk.length > 1
            ? [<Legend key="legend" wrapperStyle={{ fontSize: 11 }} />]
            : []),
        ...yk.map((key, i) =>
            kind === "line" ? (
                <Line
                    key={key}
                    type="monotone"
                    dataKey={key}
                    stroke={getChartColor(i)}
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                />
            ) : (
                <Bar
                    key={key}
                    dataKey={key}
                    fill={getChartColor(i)}
                    radius={[4, 4, 0, 0]}
                    isAnimationActive={false}
                />
            ),
        ),
    ];
    return (
        <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
                {kind === "line" ? (
                    <LineChart
                        data={rows}
                        margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
                    >
                        {frame}
                    </LineChart>
                ) : (
                    <BarChart
                        data={rows}
                        margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
                    >
                        {frame}
                    </BarChart>
                )}
            </ResponsiveContainer>
        </div>
    );
}

function PieResultChart({ rows, xKey, yKeys }: ToolResultChartProps) {
    const formatPercent = usePercentFormatter();
    const { xk, yk } = resolveAxes(rows, xKey, yKeys);
    const valueKey = yk[0];
    if (rows.length === 0 || !valueKey) {
        return <p className="text-xs text-muted-foreground">No chart data.</p>;
    }
    const data = rows.map((row) => ({
        name: String(row[xk] ?? ""),
        value:
            typeof row[valueKey] === "number" ? (row[valueKey] as number) : 0,
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
                            `${name} ${formatPercent((percent ?? 0) * 100, { digits: 0 })}`
                        }
                        labelLine={{ strokeWidth: 1 }}
                        isAnimationActive={false}
                    >
                        {data.map((entry, index) => (
                            <Cell
                                key={`${entry.name}-${index}`}
                                fill={getChartColor(index)}
                            />
                        ))}
                    </Pie>
                    <Tooltip contentStyle={tooltipStyle} />
                </PieChart>
            </ResponsiveContainer>
        </div>
    );
}

export default function ToolResultChart(props: ToolResultChartProps) {
    return props.kind === "pie" ? (
        <PieResultChart {...props} />
    ) : (
        <CartesianChart {...props} kind={props.kind} />
    );
}
