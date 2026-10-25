/**
 * Builds a type guard for a string-literal union from a `Record` keyed by every
 * member. The record makes the list exhaustive at compile time, so adding a
 * member to the union fails to compile until the guard lists it too.
 */
export const enumGuard =
    <T extends string>(members: Record<T, true>) =>
    (value: string): value is T =>
        Object.hasOwn(members, value);
