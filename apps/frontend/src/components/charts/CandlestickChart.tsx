/**
 * CandlestickChart — convenience wrapper over ComposedChart for a single OHLC
 * series. Use ComposedChart directly when mixing candlesticks with other series.
 */
import { ComposedChart } from "./ComposedChart";

export interface CandlePoint {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface CandlestickChartProps<Datum extends CandlePoint> {
  readonly data: ReadonlyArray<Datum>;
  readonly height?: number;
  readonly label?: string;
  readonly xTickFormat?: (v: Date | number) => string;
  readonly yTickFormat?: (v: number) => string;
  readonly tooltipTitle?: (d: Datum) => string;
  readonly tooltipValueFormat?: (v: number, seriesKey: string) => string;
}

export function CandlestickChart<Datum extends CandlePoint>({
  data,
  height = 360,
  label = "OHLC",
  xTickFormat,
  yTickFormat,
  tooltipTitle,
  tooltipValueFormat,
}: CandlestickChartProps<Datum>) {
  return (
    <ComposedChart<Datum>
      data={data}
      height={height}
      xAccessor={(d) => new Date(d.time)}
      xIsDate
      series={[
        {
          key: "ohlc",
          label,
          type: "candlestick",
          open: (d) => d.open,
          high: (d) => d.high,
          low: (d) => d.low,
          close: (d) => d.close,
        },
      ]}
      xTickFormat={xTickFormat}
      leftTickFormat={yTickFormat}
      tooltipTitle={tooltipTitle}
      tooltipValueFormat={tooltipValueFormat}
    />
  );
}
