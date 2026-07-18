/**
 * Chart Builder persisted state (ZOD-11).
 *
 * Types, defaults, and the localStorage load path for ChartBuilderPage live
 * here (a non-component module) so the zod schema can be exported for tests
 * without tripping react-refresh/only-export-components.
 *
 * Restore semantics: per-field fallback. A well-formed stored blob loads
 * exactly as the old `{ ...DEFAULT_STATE, ...JSON.parse(raw) }` merge did
 * (unknown keys included — loose objects); a malformed field falls back to
 * its default instead of poisoning the merge, and a blob that is not an
 * object at all falls back to `DEFAULT_STATE` wholesale.
 */

import { z } from 'zod';
import type { MacroProvider, ResearchRange } from '@/types/research';

export type SeriesType = 'line' | 'area' | 'candlestick' | 'bar';
export type Field = 'price' | 'volume';

export interface BuilderSeries {
    id: string;
    symbol: string;
    field: Field;
    type: SeriesType;
    axis: 'left' | 'right';
    provider: string;
    /** Set when this is a macroeconomic series (ADR-082); provider-pinned, fetched via getMacroSeries. */
    macro?: { provider: MacroProvider; seriesId: string; title: string };
}

export type IndicatorType = 'sma' | 'ema' | 'bollinger';
export interface BuilderIndicator {
    id: string;
    type: IndicatorType;
    period: number;
    seriesId: string;
}
export type Oscillator = 'none' | 'rsi' | 'macd';

export interface BuilderState {
    range: ResearchRange;
    logLeft: boolean;
    rebase: boolean;
    series: BuilderSeries[];
    indicators: BuilderIndicator[];
    oscillator: Oscillator;
    oscillatorSeriesId: string | null;
}

export const STORAGE_KEY = 'research.chartBuilder.v1';

export const DEFAULT_STATE: BuilderState = {
    range: '1y',
    logLeft: false,
    rebase: false,
    series: [],
    indicators: [],
    oscillator: 'none',
    oscillatorSeriesId: null,
};

const seriesSchema = z.looseObject({
    id: z.string(),
    symbol: z.string(),
    field: z.enum(['price', 'volume'] as const satisfies readonly Field[]),
    type: z.enum(['line', 'area', 'candlestick', 'bar'] as const satisfies readonly SeriesType[]),
    axis: z.enum(['left', 'right']),
    provider: z.string(),
    macro: z
        .looseObject({
            provider: z.enum(['fred', 'eurostat', 'dbnomics'] as const satisfies readonly MacroProvider[]),
            seriesId: z.string(),
            title: z.string(),
        })
        .optional(),
});

const indicatorSchema = z.looseObject({
    id: z.string(),
    type: z.enum(['sma', 'ema', 'bollinger'] as const satisfies readonly IndicatorType[]),
    period: z.number(),
    seriesId: z.string(),
});

export const storedBuilderStateSchema = z.looseObject({
    range: z
        .enum(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', 'max'] as const satisfies readonly ResearchRange[])
        .catch(DEFAULT_STATE.range),
    logLeft: z.boolean().catch(DEFAULT_STATE.logLeft),
    rebase: z.boolean().catch(DEFAULT_STATE.rebase),
    series: z.array(seriesSchema).catch(() => []),
    indicators: z.array(indicatorSchema).catch(() => []),
    oscillator: z
        .enum(['none', 'rsi', 'macd'] as const satisfies readonly Oscillator[])
        .catch(DEFAULT_STATE.oscillator),
    oscillatorSeriesId: z.string().nullable().catch(DEFAULT_STATE.oscillatorSeriesId),
});

/**
 * Load the persisted builder state. Malformed JSON, a non-object blob, or
 * localStorage failures fall back to `DEFAULT_STATE`, exactly as before.
 */
export function loadState(): BuilderState {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = storedBuilderStateSchema.safeParse(JSON.parse(raw));
            if (parsed.success) return parsed.data as BuilderState;
        }
    } catch { /* ignore */ }
    return DEFAULT_STATE;
}
