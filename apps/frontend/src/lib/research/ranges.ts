import type { ResearchRange } from '@/types/research';

export interface ChartRangeOption {
    label: string;
    range: ResearchRange;
    /** Candle sampling interval for chart fetches; range-only consumers ignore it. */
    interval: string;
}

/**
 * The 1M-5Y range ladder shared by the research compare/chart-builder pages
 * and the watchlist chart dialog.
 */
export const RESEARCH_RANGES: ChartRangeOption[] = [
    { label: '1M', range: '1mo', interval: '1d' },
    { label: '3M', range: '3mo', interval: '1d' },
    { label: '6M', range: '6mo', interval: '1d' },
    { label: '1Y', range: '1y', interval: '1wk' },
    { label: '5Y', range: '5y', interval: '1mo' },
];

/**
 * The full ladder for the market lookup chart: intraday 1D/5D plus MAX around
 * the shared 1M-5Y core.
 */
export const LOOKUP_RANGES: ChartRangeOption[] = [
    { label: '1D', range: '1d', interval: '5m' },
    { label: '5D', range: '5d', interval: '15m' },
    ...RESEARCH_RANGES,
    { label: 'MAX', range: 'max', interval: '1mo' },
];
