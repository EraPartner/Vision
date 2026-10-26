import { toolResultAxes as resolveAxes } from "@vision/shared-utils/ai-chat/toolPresentation";
import {
    BarChart,
    ChartLegend,
    DonutChart,
    LineChart,
    getChartColor,
} from "@/components/charts";
import { usePercentFormatter } from "@/hooks/useCurrencyFormatter";
import { useLanguage } from "@/stores/hydration/LanguageHydration";

type Row = Record<string, unknown>;
type IndexedRow = { row: Row; index: number };

export interface ToolResultChartProps {
    kind: "line" | "bar" | "pie";
    rows: Row[];
    xKey?: string | undefined;
    yKeys?: string[] | undefined;
}

const HEIGHT = 224;
const MARGIN = { top: 8, right: 12, bottom: 28, left: 48 };

/** Category label for a row; tool rows are untyped JSON. */
function label(row: Row, key: string): string {
    const value = row[key];
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value;
    if (
        typeof value === "number" ||
        typeof value === "boolean" ||
        typeof value === "bigint"
    )
        return String(value);
    return JSON.stringify(value);
}

/** Non-numeric cells plot as gaps (lines) or zero-height bars, as before. */
function numeric(row: Row, key: string): number | null {
    const value = row[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function NoData() {
    const { t } = useLanguage();
    return (
        <p className="type-footnote text-label-secondary">
            {t("aiChat.noChartData")}
        </p>
    );
}

function CartesianChart({
    rows,
    xKey,
    yKeys,
    kind,
}: ToolResultChartProps & { kind: "line" | "bar" }) {
    const { xk, yk } = resolveAxes(rows, xKey, yKeys);
    if (rows.length === 0 || yk.length === 0) return <NoData />;
    const legend =
        yk.length > 1 ? (
            <ChartLegend
                className="mt-2"
                align="center"
                items={yk.map((key, i) => ({ label: key, color: getChartColor(i) }))}
            />
        ) : null;
    // Rows are categories in order, whatever the x values are, so the line
    // chart plots by row index and labels ticks with the x value.
    const indexed: IndexedRow[] = rows.map((row, index) => ({ row, index }));
    return (
        <div className="w-full">
            {kind === "line" ? (
                <LineChart<IndexedRow>
                    data={indexed}
                    xAccessor={(d) => d.index}
                    xIsDate={false}
                    xTickFormat={(value) => {
                        const index = Number(value);
                        const row = Number.isInteger(index) ? rows[index] : undefined;
                        return row ? label(row, xk) : "";
                    }}
                    tooltipTitle={(d) => label(d.row, xk)}
                    series={yk.map((key, i) => ({
                        key,
                        accessor: (d) => numeric(d.row, key),
                        color: getChartColor(i),
                    }))}
                    height={HEIGHT}
                    margin={MARGIN}
                />
            ) : (
                <BarChart<Row>
                    data={rows}
                    categoryAccessor={(row) => label(row, xk)}
                    tooltipTitle={(row) => label(row, xk)}
                    series={yk.map((key, i) => ({
                        key,
                        accessor: (row) => numeric(row, key) ?? 0,
                        color: getChartColor(i),
                    }))}
                    height={HEIGHT}
                    margin={MARGIN}
                />
            )}
            {legend}
        </div>
    );
}

function PieResultChart({ rows, xKey, yKeys }: ToolResultChartProps) {
    const formatPercent = usePercentFormatter();
    const { xk, yk } = resolveAxes(rows, xKey, yKeys);
    const valueKey = yk[0];
    if (rows.length === 0 || !valueKey) return <NoData />;
    const data = rows.map((row, index) => ({
        name: label(row, xk),
        value: numeric(row, valueKey) ?? 0,
        color: getChartColor(index),
    }));
    const total = data.reduce((sum, d) => sum + d.value, 0);
    // A slice needs a positive share; recharts drew nothing for an all
    // non-positive set either.
    const slices = data.filter((d) => d.value > 0);
    if (slices.length === 0 || !(total > 0)) return <NoData />;
    return (
        <div className="w-full">
            <DonutChart data={slices} height={HEIGHT} innerRadiusRatio={0.5} />
            <ChartLegend
                className="mt-2"
                align="center"
                items={data.map((d) => ({
                    label: `${d.name} ${formatPercent((d.value / total) * 100, { digits: 0 })}`,
                    color: d.color,
                }))}
            />
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
