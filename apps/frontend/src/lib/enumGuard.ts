/**
 * Builds a type guard for a string-literal union from a `Record` keyed by every
 * member. The record makes the list exhaustive at compile time, so adding a
 * member to the union fails to compile until the guard lists it too.
 */
export const enumGuard =
    <T extends string>(members: Record<T, true>) =>
    (value: string): value is T =>
        Object.hasOwn(members, value);

/**
 * Builds a type guard from a runtime list of members (the same list a Select
 * renders its items from), without a cast.
 */
export const listGuard =
    <T extends string | number>(members: readonly T[]) =>
    (value: unknown): value is T =>
        members.some((member) => member === value);

/**
 * Adapts a typed handler to a Radix `onValueChange`, which reports a plain
 * string: a value outside the guard is ignored instead of cast through.
 */
export const onGuarded =
    <T extends string>(
        guard: (value: string) => value is T,
        handler: (value: T) => void,
    ) =>
    (value: string): void => {
        if (guard(value)) handler(value);
    };
