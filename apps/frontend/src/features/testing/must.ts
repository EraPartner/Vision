/**
 * Narrow a value a test has already arranged to exist (a query result, an
 * array element) without a non-null assertion. Throws with a readable message
 * instead of a later "cannot read properties of undefined".
 */
export function must<T>(value: T | null | undefined, label = "value"): T {
    if (value === null || value === undefined) {
        throw new Error(`Expected ${label} to be present`);
    }
    return value;
}
