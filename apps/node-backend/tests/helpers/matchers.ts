/**
 * Typed wrappers over vitest's asymmetric matchers.
 *
 * `expect.any(...)`, `expect.objectContaining(...)` and friends return `any`,
 * which makes every use inside an expected object an unsafe assignment. These
 * wrappers return the type the matcher stands in for, so the surrounding
 * expectation stays type-checked. They are identity wrappers at runtime.
 */
import { expect } from "vitest";

import type { DeepPartial } from "./partial.ts";

/** The value type `expect.any(ctor)` stands in for. */
type InstanceOf<C> = C extends StringConstructor
  ? string
  : C extends NumberConstructor
    ? number
    : C extends BooleanConstructor
      ? boolean
      : C extends BigIntConstructor
        ? bigint
        : C extends abstract new (...args: never[]) => infer I
          ? I
          : never;

/** `expect.any(ctor)` typed as an instance of `ctor` (`string` for `String`). */
export function anyInstance<C extends abstract new (...args: never[]) => unknown>(
  ctor: C,
): InstanceOf<C> {
  return expect.any(ctor) as InstanceOf<C>;
}

/** A partial expectation; a property may also be given as `undefined`. */
type Expected<T> = {
  [K in keyof DeepPartial<T>]: DeepPartial<T>[K] | undefined;
};

/** `expect.objectContaining(expected)` typed as the object it matches. */
export function objectContaining<T extends object>(
  expected: Expected<T>,
): T {
  return expect.objectContaining<unknown>(expected) as T;
}

/** `expect.arrayContaining(expected)` typed as the array it matches. */
export function arrayContaining<T>(expected: T[]): T[] {
  return expect.arrayContaining<unknown>(expected) as T[];
}

/** `expect.stringMatching(pattern)` typed as a string. */
export function stringMatching(pattern: string | RegExp): string {
  return expect.stringMatching(pattern) as string;
}

/** `expect.stringContaining(fragment)` typed as a string. */
export function stringContaining(fragment: string): string {
  return expect.stringContaining(fragment) as string;
}

/** `expect.closeTo(value, digits)` typed as a number. */
export function closeTo(value: number, digits?: number): number {
  return expect.closeTo(value, digits) as number;
}

/** `expect.anything()` typed as whatever the expectation needs. */
export function anything(): never {
  return expect.anything() as never;
}
