export interface ResearchPoint {
  time: number;
  close?: number | null | undefined;
  high?: number | null | undefined;
  low?: number | null | undefined;
  volume?: number | null | undefined;
}
export type ResearchRow = Record<string, number | null> & {
  time: number;
};
export interface ChartPresentationSeries {
  id: string;
  field: "price" | "volume";
  type: "line" | "area" | "candlestick" | "bar";
  points: ResearchPoint[];
}
export interface ChartPresentationIndicator {
  id: string;
  type: "sma" | "ema" | "bollinger";
  period: number;
  seriesId: string;
}
