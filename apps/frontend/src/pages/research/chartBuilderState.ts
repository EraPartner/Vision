/**
 * Chart Builder persisted state (ZOD-11).
 *
 * Types and defaults for ChartBuilderPage live here so the current v2 layout
 * library can import them without a component dependency.
 */

import type { MacroProvider, ResearchRange } from "@/types/research";

export type SeriesType = "line" | "area" | "candlestick" | "bar";
export type Field = "price" | "volume";

export interface BuilderSeries {
    id: string;
    symbol: string;
    field: Field;
    type: SeriesType;
    axis: "left" | "right";
    provider: string;
    /** Set when this is a macroeconomic series (ADR-082); provider-pinned, fetched via getMacroSeries. */
    macro?: { provider: MacroProvider; seriesId: string; title: string };
}

export type IndicatorType = "sma" | "ema" | "bollinger";
export interface BuilderIndicator {
    id: string;
    type: IndicatorType;
    period: number;
    seriesId: string;
}
export type Oscillator = "none" | "rsi" | "macd";

export interface BuilderState {
    range: ResearchRange;
    logLeft: boolean;
    rebase: boolean;
    series: BuilderSeries[];
    indicators: BuilderIndicator[];
    oscillator: Oscillator;
    oscillatorSeriesId: string | null;
}

export const DEFAULT_STATE: BuilderState = {
    range: "1y",
    logLeft: false,
    rebase: false,
    series: [],
    indicators: [],
    oscillator: "none",
    oscillatorSeriesId: null,
};
