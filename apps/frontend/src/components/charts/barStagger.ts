const STAGGER_STEP_S = 0.015;
const STAGGER_WAVE_MAX_S = 1.2;

/**
 * Entrance delay for bar `index` of `count`. Each bar trails the previous by
 * 15ms, but the whole wave is capped at 1.2s: identical to `index * 0.015`
 * up to 80 bars, compressed proportionally beyond that.
 */
export function barStaggerDelay(index: number, count: number): number {
    if (count <= 1) return 0;
    return (index / count) * Math.min(count * STAGGER_STEP_S, STAGGER_WAVE_MAX_S);
}
