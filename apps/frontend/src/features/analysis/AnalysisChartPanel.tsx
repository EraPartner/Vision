import { useId } from "react";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { getChartColor } from "@/components/charts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
    SegmentedControl,
    SegmentedControlItem,
} from "@/components/ui/segmented-control";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { formatAnalysisValue } from "./analysisPresentation";
import { formatDateStringWithAppSettings } from "@/lib/dateUtils";
import { numberFormatToLocale } from "@/utils/currency";
import type { AnalysisResult } from "@/lib/api/analysis";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import {
    analysisChartData,
    type AnalysisChartSpec,
} from "./analysisChartModel";

const NO_AXIS = "__none__";
const statusClass = "type-callout text-label-secondary";

export function AnalysisChartPanel({
    result,
    spec,
    onChange,
}: {
    result: AnalysisResult;
    spec: AnalysisChartSpec;
    onChange: (spec: AnalysisChartSpec) => void;
}) {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const typeLabelId = useId();
    const xAxisId = useId();
    const tickFormat = new Intl.NumberFormat(
        numberFormatToLocale(appSettings.numberFormat),
        { maximumSignificantDigits: 5 },
    );
    const displayValue = (value: unknown, id: string) => {
        const column = (
            result.declaredColumns?.length
                ? result.declaredColumns
                : result.columns
        ).find((c) => c.id === id);
        if (
            column?.type === "date" &&
            typeof value === "string" &&
            /^\d{4}-\d{2}-\d{2}$/.test(value)
        )
            return formatDateStringWithAppSettings(
                value,
                appSettings.dateFormat,
            );
        return formatAnalysisValue(
            value as string | number | null,
            column?.type ?? "string",
            id,
            appSettings.numberFormat,
        );
    };
    const columns = result.declaredColumns?.length
        ? result.declaredColumns
        : result.columns;
    const data = analysisChartData(result, spec);
    const numeric = columns.filter((c) =>
        /decimal|number|integer|numeric|float|double/.test(c.type),
    );
    const W = 900,
        H = 340,
        left = 75,
        right = 20,
        top = 20,
        bottom = 60;
    const plotW = W - left - right,
        plotH = H - top - bottom;
    const raw = data.rows.flatMap((r) =>
        r.values.filter((v): v is number => v !== null),
    );
    let cumulative = 0;
    const waterfalls = data.rows.map((r) => {
        const start = cumulative;
        cumulative += r.values[0] ?? 0;
        return { start, end: cumulative };
    });
    const domain =
        spec.kind === "waterfall"
            ? waterfalls.flatMap((r) => [r.start, r.end])
            : spec.kind === "stacked-bar"
              ? data.rows.flatMap((r) => [
                    r.values.reduce<number>(
                        (a, v) => a + Math.max(v ?? 0, 0),
                        0,
                    ),
                    r.values.reduce<number>(
                        (a, v) => a + Math.min(v ?? 0, 0),
                        0,
                    ),
                ])
              : raw;
    const min = Math.min(0, ...domain),
        max = Math.max(0, ...domain),
        span = max - min || 1;
    const y = (v: number) => top + ((max - v) / span) * plotH;
    const step = plotW / Math.max(1, data.rows.length);
    const xs = data.rows.filter((r) => Number.isFinite(r.x)).map((r) => r.x),
        xmin = Math.min(...xs),
        xmax = Math.max(...xs);
    const x = (i: number) => left + step * (i + 0.5);
    const seriesLabel = (id: string) => {
        const metadata = columns.find((c) => c.id === id);
        const unit = metadata?.unit;
        const label =
            metadata && "label" in metadata ? String(metadata.label) : id;
        if (!unit) return label;
        const scope =
            typeof unit === "string"
                ? unit
                : [
                      [
                          "money",
                          "quantity",
                          "ratio",
                          "number",
                          "dimensionless",
                          "currency",
                      ].includes(unit.kind)
                          ? t(`analysis.ext.chart.unit.${unit.kind}`)
                          : unit.kind,
                      unit.currency ??
                          (unit.currencyColumn
                              ? String(
                                    result.rows[0]?.[unit.currencyColumn] ?? "",
                                )
                              : ""),
                  ]
                      .filter(Boolean)
                      .join(" ");
        return `${label} (${scope})`;
    };
    const colors = [0, 1, 2, 3, 4].map(getChartColor);
    const gain = "hsl(var(--gain))";
    const loss = "hsl(var(--loss))";
    return (
        <div className="min-w-0 space-y-3">
            <div className="grid items-start gap-4 sm:grid-cols-2">
                <div className="min-w-0 space-y-1.5 sm:col-span-2">
                    <Label id={typeLabelId}>
                        {t("analysis.ext.chart.type")}
                    </Label>
                    <SegmentedControl
                        aria-labelledby={typeLabelId}
                        value={spec.kind}
                        onValueChange={(kind) =>
                            onChange({
                                ...spec,
                                kind: kind as AnalysisChartSpec["kind"],
                            })
                        }
                        className="w-full"
                    >
                        {(
                            [
                                "bar",
                                "line",
                                "stacked-bar",
                                "scatter",
                                "waterfall",
                            ] as const
                        ).map((k) => (
                            <SegmentedControlItem key={k} value={k}>
                                {t(`analysis.ext.chart.${k}`)}
                            </SegmentedControlItem>
                        ))}
                    </SegmentedControl>
                </div>
                <div className="min-w-0 space-y-1.5">
                    <Label htmlFor={xAxisId}>{t("analysis.ext.chart.x")}</Label>
                    <Select
                        value={spec.x || NO_AXIS}
                        onValueChange={(value) =>
                            onChange({
                                ...spec,
                                x: value === NO_AXIS ? "" : value,
                            })
                        }
                    >
                        <SelectTrigger id={xAxisId}>
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value={NO_AXIS}>—</SelectItem>
                            {columns.map((c) => (
                                <SelectItem key={c.id} value={c.id}>
                                    {String("label" in c ? c.label : c.id)}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                <fieldset className="min-w-0 sm:col-span-2">
                    <legend className="mb-2 type-body font-medium">
                        {t("analysis.ext.chart.series")}
                    </legend>
                    <div className="flex flex-wrap gap-2">
                        {numeric.map((c) => (
                            <label
                                key={c.id}
                                className="flex min-h-9 min-w-0 max-w-full items-center gap-2 rounded-chip border border-border/60 bg-card/70 px-3 type-callout [overflow-wrap:anywhere]"
                            >
                                <Checkbox
                                    checked={spec.y.includes(c.id)}
                                    onCheckedChange={(checked) =>
                                        onChange({
                                            ...spec,
                                            y:
                                                checked === true
                                                    ? [...spec.y, c.id]
                                                    : spec.y.filter(
                                                          (id) => id !== c.id,
                                                      ),
                                        })
                                    }
                                />
                                {String("label" in c ? c.label : c.id)}
                            </label>
                        ))}
                    </div>
                </fieldset>
            </div>
            {!data.complete ? (
                <p role="status" className={statusClass}>
                    {t("analysis.ext.chart.complete")}
                </p>
            ) : data.incompatible ? (
                <p role="status" className={statusClass}>
                    {t("analysis.ext.chart.units")}
                </p>
            ) : !spec.x || !spec.y.length ? (
                <p className={statusClass}>{t("analysis.ext.chart.select")}</p>
            ) : spec.kind === "waterfall" && data.omitted > 0 ? (
                <p role="status" className={statusClass}>
                    {t("analysis.ext.chart.waterfallMissing")}
                </p>
            ) : spec.kind === "waterfall" && spec.y.length !== 1 ? (
                <p className={statusClass}>
                    {t("analysis.ext.chart.oneSeries")}
                </p>
            ) : !data.rows.length ? (
                <Alert role="status">
                    <AlertDescription>
                        {t("analysis.ext.chart.empty")}
                    </AlertDescription>
                </Alert>
            ) : (
                <>
                    <p className="type-footnote text-label-secondary">
                        {t("analysis.ext.chart.coverage", {
                            rows: data.rows.length,
                            missing: data.omitted,
                        })}
                    </p>
                    <svg
                        viewBox={`0 0 ${W} ${H}`}
                        className="w-full"
                        role="img"
                        aria-label={t(`analysis.ext.chart.${spec.kind}`)}
                    >
                        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
                            const v = min + span * f;
                            return (
                                <g key={f}>
                                    <line
                                        x1={left}
                                        x2={W - right}
                                        y1={y(v)}
                                        y2={y(v)}
                                        stroke="currentColor"
                                        opacity=".15"
                                    />
                                    <text
                                        x={left - 6}
                                        y={y(v) + 4}
                                        textAnchor="end"
                                        fontSize="11"
                                        fill="currentColor"
                                    >
                                        {tickFormat.format(v)}
                                    </text>
                                </g>
                            );
                        })}
                        <line
                            x1={left}
                            x2={W - right}
                            y1={y(0)}
                            y2={y(0)}
                            stroke="currentColor"
                        />
                        {spec.kind === "line"
                            ? spec.y.map((id, s) => {
                                  let path = "",
                                      segment = false;
                                  data.rows.forEach((r) => {
                                      const v = r.values[s];
                                      if (v === null) {
                                          segment = false;
                                          return;
                                      }
                                      path += `${segment ? "L" : "M"}${x(r.index)},${y(v)} `;
                                      segment = true;
                                  });
                                  return (
                                      <path
                                          key={id}
                                          d={path}
                                          stroke={colors[s % colors.length]}
                                          strokeWidth="2"
                                          fill="none"
                                      />
                                  );
                              })
                            : data.rows.map((r) => {
                                  let pos = 0,
                                      neg = 0;
                                  return (
                                      <g key={r.index}>
                                          {r.values.map((v, s) => {
                                              if (
                                                  v === null ||
                                                  (spec.kind === "waterfall" &&
                                                      s > 0)
                                              )
                                                  return null;
                                              if (spec.kind === "scatter")
                                                  return Number.isFinite(
                                                      r.x,
                                                  ) ? (
                                                      <circle
                                                          key={s}
                                                          cx={
                                                              left +
                                                              ((r.x - xmin) /
                                                                  (xmax -
                                                                      xmin ||
                                                                      1)) *
                                                                  plotW
                                                          }
                                                          cy={y(v)}
                                                          r="4"
                                                          fill={
                                                              colors[
                                                                  s %
                                                                      colors.length
                                                              ]
                                                          }
                                                      >
                                                          <title>{`${displayValue(r.label, spec.x)}: ${seriesLabel(spec.y[s])} ${displayValue(r.rawValues[s], spec.y[s])}`}</title>
                                                      </circle>
                                                  ) : null;
                                              let start = 0,
                                                  end = v;
                                              if (spec.kind === "stacked-bar") {
                                                  start = v >= 0 ? pos : neg;
                                                  end = start + v;
                                                  if (v >= 0) pos = end;
                                                  else neg = end;
                                              }
                                              if (spec.kind === "waterfall") {
                                                  start =
                                                      waterfalls[r.index].start;
                                                  end = waterfalls[r.index].end;
                                              }
                                              const width =
                                                  spec.kind === "bar"
                                                      ? (step * 0.8) /
                                                        spec.y.length
                                                      : step * 0.8;
                                              return (
                                                  <rect
                                                      key={s}
                                                      x={
                                                          left +
                                                          step * r.index +
                                                          step * 0.1 +
                                                          (spec.kind === "bar"
                                                              ? s * width
                                                              : 0)
                                                      }
                                                      y={Math.min(
                                                          y(start),
                                                          y(end),
                                                      )}
                                                      width={Math.max(
                                                          0.5,
                                                          width,
                                                      )}
                                                      height={Math.abs(
                                                          y(start) - y(end),
                                                      )}
                                                      fill={
                                                          spec.kind ===
                                                          "waterfall"
                                                              ? v < 0
                                                                  ? loss
                                                                  : gain
                                                              : colors[
                                                                    s %
                                                                        colors.length
                                                                ]
                                                      }
                                                  >
                                                      <title>{`${displayValue(r.label, spec.x)}: ${seriesLabel(spec.y[s])} ${displayValue(r.rawValues[s], spec.y[s])}`}</title>
                                                  </rect>
                                              );
                                          })}
                                      </g>
                                  );
                              })}
                        {data.rows
                            .filter(
                                (r, i) =>
                                    (spec.kind !== "scatter" ||
                                        Number.isFinite(r.x)) &&
                                    i %
                                        Math.max(
                                            1,
                                            Math.ceil(data.rows.length / 10),
                                        ) ===
                                        0,
                            )
                            .map((r) => (
                                <text
                                    key={r.index}
                                    x={
                                        spec.kind === "scatter"
                                            ? left +
                                              ((r.x - xmin) /
                                                  (xmax - xmin || 1)) *
                                                  plotW
                                            : x(r.index)
                                    }
                                    y={H - 35}
                                    textAnchor="middle"
                                    fontSize="10"
                                    fill="currentColor"
                                >
                                    {displayValue(r.label, spec.x).slice(0, 20)}
                                </text>
                            ))}
                    </svg>
                    <ul className="flex flex-wrap gap-x-4 gap-y-2 type-callout">
                        {spec.y.map((id, s) => (
                            <li key={id} className="flex items-center gap-2">
                                <span
                                    aria-hidden="true"
                                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                                    style={{
                                        backgroundColor:
                                            colors[s % colors.length],
                                    }}
                                />
                                {seriesLabel(id)}
                            </li>
                        ))}
                    </ul>
                    <details className="rounded-card corner-continuous border border-border/60">
                        <summary className="cursor-pointer rounded-card px-4 py-2.5 type-headline focus-ring">
                            {t("analysis.ext.chart.table")}
                        </summary>
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{seriesLabel(spec.x)}</TableHead>
                                    {spec.y.map((id) => (
                                        <TableHead
                                            key={id}
                                            className="text-right"
                                        >
                                            {seriesLabel(id)}
                                        </TableHead>
                                    ))}
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {data.rows.map((r) => (
                                    <TableRow key={r.index}>
                                        <TableCell className="py-2">
                                            {displayValue(r.label, spec.x)}
                                        </TableCell>
                                        {r.values.map((_v, s) => (
                                            <TableCell
                                                key={s}
                                                className="py-2 text-right tabular-nums"
                                            >
                                                {displayValue(
                                                    r.rawValues[s],
                                                    spec.y[s],
                                                )}
                                            </TableCell>
                                        ))}
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </details>
                </>
            )}
        </div>
    );
}
