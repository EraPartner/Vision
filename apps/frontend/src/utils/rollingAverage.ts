/**
 * Rolling average utilities.
 *
 * computeRollingAverage: sliding window mean over an array of numbers.
 * Returns null for the first (window - 1) indices where there is not yet
 * enough data to fill the window.
 */

/**
 * Compute a simple rolling (moving) average.
 *
 * @param values  Input series.
 * @param window  Number of periods to average (must be >= 1).
 * @returns       Array of same length; first (window - 1) entries are null.
 */
export function computeRollingAverage(
    values: ReadonlyArray<number>,
    window: number,
): Array<number | null> {
    if (window <= 1) return values.map((v) => v);

    return values.map((_, i) => {
        if (i < window - 1) return null;
        let sum = 0;
        for (let j = i - window + 1; j <= i; j++) sum += values[j];
        return sum / window;
    });
}
