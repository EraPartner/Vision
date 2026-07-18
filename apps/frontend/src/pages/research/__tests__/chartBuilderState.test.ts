// @vitest-environment jsdom
/**
 * Persisted Chart Builder state restore (ZOD-11).
 *
 * Pins the pre-zod contract for well-formed blobs — the result must equal the
 * old `{ ...DEFAULT_STATE, ...JSON.parse(raw) }` merge exactly, unknown keys
 * included — and the new per-field fallback for malformed blobs.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_STATE, STORAGE_KEY, loadState, type BuilderState } from '../chartBuilderState';

function store(value: unknown) {
    localStorage.setItem(STORAGE_KEY, typeof value === 'string' ? value : JSON.stringify(value));
}

afterEach(() => {
    localStorage.clear();
});

describe('loadState', () => {
    it('returns DEFAULT_STATE when nothing is stored', () => {
        expect(loadState()).toEqual(DEFAULT_STATE);
    });

    it('restores a well-formed full blob exactly as the old defaults merge did', () => {
        const blob: BuilderState = {
            range: '5y',
            logLeft: true,
            rebase: false,
            series: [
                { id: 's1', symbol: 'AAPL', field: 'price', type: 'line', axis: 'left', provider: '' },
                {
                    id: 's2',
                    symbol: 'CPIAUCSL',
                    field: 'price',
                    type: 'area',
                    axis: 'right',
                    provider: 'fred',
                    macro: { provider: 'fred', seriesId: 'CPIAUCSL', title: 'CPI' },
                },
            ],
            indicators: [{ id: 'i1', type: 'sma', period: 50, seriesId: 's1' }],
            oscillator: 'rsi',
            oscillatorSeriesId: 's1',
        };
        store(blob);
        expect(loadState()).toEqual({ ...DEFAULT_STATE, ...blob });
    });

    it('restores a partial blob merged over defaults (old behavior)', () => {
        store({ range: '3mo', logLeft: true });
        expect(loadState()).toEqual({ ...DEFAULT_STATE, range: '3mo', logLeft: true });
    });

    it('preserves unknown keys from the stored blob (loose merge)', () => {
        store({ range: '1d', futureFlag: true });
        expect(loadState()).toEqual({ ...DEFAULT_STATE, range: '1d', futureFlag: true });
    });

    it('falls back per-field: a malformed field takes its default, valid fields survive', () => {
        store({ range: 'bogus', logLeft: 'yes', oscillator: 'macd', oscillatorSeriesId: 42 });
        expect(loadState()).toEqual({ ...DEFAULT_STATE, oscillator: 'macd' });
    });

    it('drops a series array containing malformed entries back to the default', () => {
        store({
            range: '1y',
            series: [{ id: 's1', symbol: 'AAPL' }],
        });
        expect(loadState()).toEqual(DEFAULT_STATE);
    });

    it('falls back to DEFAULT_STATE when the blob is not an object', () => {
        store([1, 2, 3]);
        expect(loadState()).toEqual(DEFAULT_STATE);
        store('"just a string"');
        expect(loadState()).toEqual(DEFAULT_STATE);
    });

    it('falls back to DEFAULT_STATE when the blob is not valid JSON', () => {
        store('{not json');
        expect(loadState()).toEqual(DEFAULT_STATE);
    });
});
