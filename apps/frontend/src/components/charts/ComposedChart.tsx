/**
 * ComposedChart — visx multi-series chart with a shared time x-axis, independent
 * left + right y-axes, and per-series rendering as line / area / bar /
 * candlestick. Backs the Research chart builder (ADR-081). Reuses the shared
 * axis/tooltip/palette infrastructure so it matches the other chart primitives.
 */
import { curveMonotoneX } from "@visx/curve";
import { Group } from "@visx/group";
import { ParentSize } from "@visx/responsive";
import { scaleLinear, scaleLog, scaleTime } from "@visx/scale";
import { AreaClosed, Line, LinePath } from "@visx/shape";
import { bisector, extent } from "d3-array";
import { memo, useCallback, useMemo, useRef, useState } from "react";

import { BottomAxis, LeftAxis, RightAxis } from "./ChartAxis";
import { ChartTooltip, type ChartTooltipDatum } from "./ChartTooltip";
import { CHART_NEUTRAL, getChartColor } from "./palette";

export type ComposedSeriesType = "line" | "area" | "bar" | "candlestick";

export interface ComposedSeries<Datum> {
  readonly key: string;
  readonly label?: string;
  readonly type: ComposedSeriesType;
  readonly axis?: "left" | "right";
  readonly color?: string;
  readonly dashed?: boolean;
  readonly strokeWidth?: number;
  readonly fillOpacity?: number;
  /** Value accessor for line / area / bar series. */
  readonly accessor?: (d: Datum) => number | null | undefined;
  /** OHLC accessors for candlestick series. */
  readonly open?: (d: Datum) => number | null | undefined;
  readonly high?: (d: Datum) => number | null | undefined;
  readonly low?: (d: Datum) => number | null | undefined;
  readonly close?: (d: Datum) => number | null | undefined;
}

export interface ComposedChartProps<Datum> {
  readonly data: ReadonlyArray<Datum>;
  readonly xAccessor: (d: Datum) => Date | number;
  readonly series: ReadonlyArray<ComposedSeries<Datum>>;
  readonly height?: number;
  readonly xIsDate?: boolean;
  /** Log-scale the left axis (falls back to linear if the domain is non-positive). */
  readonly logLeft?: boolean;
  readonly xTickFormat?: (v: Date | number) => string;
  readonly leftTickFormat?: (v: number) => string;
  readonly rightTickFormat?: (v: number) => string;
  readonly tooltipTitle?: (d: Datum) => string;
  readonly tooltipValueFormat?: (v: number, seriesKey: string) => string;
  readonly ariaLabel?: string;
}

const MARGIN = { top: 16, right: 64, bottom: 28, left: 72 };
const UP = "hsl(var(--gain))";
const DOWN = "hsl(var(--loss))";

/** The representative scalar of a series at a datum (close for candlesticks). */
function repValue<Datum>(s: ComposedSeries<Datum>, d: Datum): number | null {
  const fn = s.type === "candlestick" ? s.close : s.accessor;
  const v = fn?.(d);
  return v != null && Number.isFinite(v) ? (v as number) : null;
}

type ComposedYScale = ReturnType<typeof scaleLinear<number>> | ReturnType<typeof scaleLog<number>>;
type ComposedXScale = ReturnType<typeof scaleTime<number>> | ReturnType<typeof scaleLinear<number>>;

interface ComposedSeriesLayerProps<Datum> {
  readonly data: ReadonlyArray<Datum>;
  readonly series: ReadonlyArray<ComposedSeries<Datum>>;
  readonly xAccessor: (d: Datum) => Date | number;
  readonly xScale: ComposedXScale;
  readonly leftScale: ComposedYScale;
  readonly rightScale: ComposedYScale | null;
  readonly innerHeight: number;
  readonly barWidth: number;
}

/**
 * All series marks (bars, areas, candlesticks, lines) behind React.memo:
 * hover state changes in Inner fire per pointermove and must not re-render
 * every datum's rect/path. All props are referentially stable across those
 * renders.
 */
function ComposedSeriesLayerInner<Datum>({
  data,
  series,
  xAccessor,
  xScale,
  leftScale,
  rightScale,
  innerHeight,
  barWidth,
}: ComposedSeriesLayerProps<Datum>) {
  const scaleFor = (s: ComposedSeries<Datum>) => (s.axis === "right" && rightScale ? rightScale : leftScale);
  const cx = (d: Datum) => xScale(xAccessor(d) as never) ?? 0;

  return (
    <>
      {/* bars (behind) */}
      {series.map((s, i) => {
        if (s.type !== "bar") return null;
        const yS = scaleFor(s);
        const color = s.color ?? getChartColor(i);
        const base = yS(Math.max(0, (yS.domain() as number[])[0])) ?? innerHeight;
        return (
          <g key={s.key} opacity={s.fillOpacity ?? 0.5}>
            {data.map((d, j) => {
              const v = s.accessor?.(d);
              if (v == null || !Number.isFinite(v)) return null;
              const y = yS(v as number) ?? 0;
              return (
                <rect
                  key={j}
                  x={cx(d) - barWidth / 2}
                  y={Math.min(y, base)}
                  width={barWidth}
                  height={Math.abs(base - y)}
                  fill={color}
                />
              );
            })}
          </g>
        );
      })}

      {/* areas */}
      {series.map((s, i) => {
        if (s.type !== "area") return null;
        const yS = scaleFor(s);
        const color = s.color ?? getChartColor(i);
        return (
          <AreaClosed<Datum>
            key={s.key}
            data={data as Datum[]}
            x={(d) => cx(d)}
            y={(d) => yS(s.accessor?.(d) ?? 0) ?? 0}
            yScale={yS as never}
            curve={curveMonotoneX}
            fill={color}
            fillOpacity={s.fillOpacity ?? 0.18}
            stroke={color}
            strokeWidth={s.strokeWidth ?? 1.5}
            defined={(d) => {
              const v = s.accessor?.(d);
              return v != null && Number.isFinite(v);
            }}
          />
        );
      })}

      {/* candlesticks */}
      {series.map((s) => {
        if (s.type !== "candlestick") return null;
        const yS = scaleFor(s);
        return (
          <g key={s.key}>
            {data.map((d, j) => {
              const o = s.open?.(d);
              const h = s.high?.(d);
              const l = s.low?.(d);
              const c = s.close?.(d);
              if ([o, h, l, c].some((v) => v == null || !Number.isFinite(v))) return null;
              const up = (c as number) >= (o as number);
              const color = up ? UP : DOWN;
              const x = cx(d);
              const yHigh = yS(h as number) ?? 0;
              const yLow = yS(l as number) ?? 0;
              const yOpen = yS(o as number) ?? 0;
              const yClose = yS(c as number) ?? 0;
              const bodyTop = Math.min(yOpen, yClose);
              const bodyH = Math.max(1, Math.abs(yClose - yOpen));
              const bw = Math.max(1, barWidth);
              return (
                <g key={j}>
                  <line x1={x} x2={x} y1={yHigh} y2={yLow} stroke={color} strokeWidth={1} />
                  <rect x={x - bw / 2} y={bodyTop} width={bw} height={bodyH} fill={color} />
                </g>
              );
            })}
          </g>
        );
      })}

      {/* lines (front) */}
      {series.map((s, i) => {
        if (s.type !== "line") return null;
        const yS = scaleFor(s);
        const color = s.color ?? getChartColor(i);
        const filtered = (data as Datum[]).filter((d) => {
          const v = s.accessor?.(d);
          return v != null && Number.isFinite(v);
        });
        return (
          <LinePath<Datum>
            key={s.key}
            data={filtered}
            x={(d) => cx(d)}
            y={(d) => yS(s.accessor?.(d) ?? 0) ?? 0}
            curve={curveMonotoneX}
            stroke={color}
            strokeWidth={s.strokeWidth ?? 2}
            strokeDasharray={s.dashed ? "5 4" : undefined}
            fill="none"
          />
        );
      })}
    </>
  );
}

// memo() erases the generic signature; the cast restores it for callers.
const ComposedSeriesLayer = memo(ComposedSeriesLayerInner) as typeof ComposedSeriesLayerInner;

export function ComposedChart<Datum>(props: ComposedChartProps<Datum>) {
  const { height = 360 } = props;
  return (
    <div style={{ width: "100%", height }}>
      <ParentSize>
        {({ width: w, height: h }) => (w > 0 && h > 0 ? <Inner {...props} width={w} height={h} /> : null)}
      </ParentSize>
    </div>
  );
}

function Inner<Datum>({
  data,
  xAccessor,
  series,
  xIsDate = true,
  logLeft = false,
  xTickFormat,
  leftTickFormat,
  rightTickFormat,
  tooltipTitle,
  tooltipValueFormat,
  ariaLabel,
  width,
  height,
}: ComposedChartProps<Datum> & { width: number; height: number }) {
  const innerWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerHeight = Math.max(0, height - MARGIN.top - MARGIN.bottom);

  const hasRight = series.some((s) => s.axis === "right");

  // Same inline-accessor stabilizer as AreaChart/LineChart — keeps the scale,
  // bisector, and memoized series layer valid across consumer re-renders.
  const xAccessorRef = useRef(xAccessor);
  xAccessorRef.current = xAccessor;
  const stableXAccessor = useCallback((d: Datum) => xAccessorRef.current(d), []);

  const xScale = useMemo(() => {
    const xs = data.map((d) => stableXAccessor(d));
    if (xIsDate) {
      const [lo, hi] = extent(xs as Date[]);
      return scaleTime({ range: [0, innerWidth], domain: [lo ?? new Date(), hi ?? new Date()] });
    }
    const nums = xs as number[];
    return scaleLinear({ range: [0, innerWidth], domain: [Math.min(...nums), Math.max(...nums)] });
  }, [data, innerWidth, stableXAccessor, xIsDate]);

  const buildYScale = useCallback(
    (axis: "left" | "right") => {
      const values: number[] = [];
      for (const s of series) {
        if ((s.axis ?? "left") !== axis) continue;
        for (const d of data) {
          if (s.type === "candlestick") {
            const hi = s.high?.(d);
            const lo = s.low?.(d);
            if (hi != null && Number.isFinite(hi)) values.push(hi as number);
            if (lo != null && Number.isFinite(lo)) values.push(lo as number);
          } else {
            const v = s.accessor?.(d);
            if (v != null && Number.isFinite(v)) values.push(v as number);
          }
        }
      }
      const lo = values.length ? Math.min(...values) : 0;
      const hi = values.length ? Math.max(...values) : 1;
      if (axis === "left" && logLeft && lo > 0) {
        return scaleLog({ range: [innerHeight, 0], domain: [lo * 0.95, hi * 1.05] });
      }
      const pad = (hi - lo) * 0.08 || 1;
      return scaleLinear({ range: [innerHeight, 0], domain: [lo - pad, hi + pad], nice: true });
    },
    [data, innerHeight, logLeft, series],
  );

  const leftScale = useMemo(() => buildYScale("left"), [buildYScale]);
  const rightScale = useMemo(() => (hasRight ? buildYScale("right") : null), [buildYScale, hasRight]);

  const step = innerWidth / Math.max(1, data.length);
  const barWidth = Math.max(1, step * 0.6);

  const bisect = useMemo(() => bisector<Datum, Date | number>((d) => stableXAccessor(d) as Date).center, [stableXAccessor]);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const handleMove = useCallback(
    (event: React.PointerEvent<SVGRectElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const x0 = xScale.invert(event.clientX - rect.left);
      const idx = bisect(data, x0 as never);
      setHoverIdx(idx >= 0 && idx < data.length ? idx : null);
    },
    [bisect, data, xScale],
  );

  const hoverDatum = hoverIdx != null ? data[hoverIdx] : null;
  const tooltipItems: ChartTooltipDatum[] = useMemo(() => {
    if (!hoverDatum) return [];
    return series
      .map((s, i) => {
        const v = repValue(s, hoverDatum);
        if (v == null) return null;
        return {
          label: s.label ?? s.key,
          color: s.color ?? getChartColor(i),
          value: tooltipValueFormat ? tooltipValueFormat(v, s.key) : String(v),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }, [hoverDatum, series, tooltipValueFormat]);

  const cx = (d: Datum) => xScale(stableXAccessor(d) as never) ?? 0;

  return (
    <div style={{ position: "relative", width, height }}>
      <svg width={width} height={height} role="img" aria-label={ariaLabel ?? "Composed chart"}>
        <Group left={MARGIN.left} top={MARGIN.top}>
          {leftScale.ticks(5).map((tick: number) => (
            <line
              key={`grid-${tick}`}
              x1={0}
              x2={innerWidth}
              y1={leftScale(tick)}
              y2={leftScale(tick)}
              stroke={CHART_NEUTRAL.grid}
              strokeOpacity={0.35}
              strokeDasharray="2 4"
            />
          ))}

          {/* Series marks — memoized so pointermove renders never re-render
              every datum's rect/path (see ComposedSeriesLayer). */}
          <ComposedSeriesLayer
            data={data}
            series={series}
            xAccessor={stableXAccessor}
            xScale={xScale}
            leftScale={leftScale}
            rightScale={rightScale}
            innerHeight={innerHeight}
            barWidth={barWidth}
          />

          {hoverDatum != null && (
            <Line
              from={{ x: cx(hoverDatum), y: 0 }}
              to={{ x: cx(hoverDatum), y: innerHeight }}
              stroke={CHART_NEUTRAL.label}
              strokeWidth={1}
              strokeDasharray="3 3"
              strokeOpacity={0.5}
            />
          )}

          <BottomAxis
            scale={xScale}
            top={innerHeight}
            numTicks={Math.max(2, Math.floor(innerWidth / 90))}
            tickFormat={xTickFormat ? (v) => xTickFormat(v as Date | number) : undefined}
          />
          <LeftAxis scale={leftScale} numTicks={5} tickFormat={leftTickFormat ? (v) => leftTickFormat(v as number) : undefined} />
          {rightScale && (
            <RightAxis
              scale={rightScale}
              left={innerWidth}
              numTicks={5}
              tickFormat={rightTickFormat ? (v) => rightTickFormat(v as number) : undefined}
            />
          )}

          <rect
            x={0}
            y={0}
            width={innerWidth}
            height={innerHeight}
            fill="transparent"
            onPointerMove={handleMove}
            onPointerLeave={() => setHoverIdx(null)}
          />
        </Group>
      </svg>

      <ChartTooltip
        open={hoverDatum != null}
        left={hoverDatum != null ? MARGIN.left + cx(hoverDatum) : 0}
        top={MARGIN.top}
        title={
          hoverDatum && tooltipTitle
            ? tooltipTitle(hoverDatum)
            : hoverDatum
              ? String(xAccessor(hoverDatum) instanceof Date ? (xAccessor(hoverDatum) as Date).toLocaleDateString() : xAccessor(hoverDatum))
              : undefined
        }
        items={tooltipItems}
      />
    </div>
  );
}
