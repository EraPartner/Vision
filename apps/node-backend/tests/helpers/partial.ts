/**
 * Typed casts for test fixtures.
 *
 * `partial<T>()` takes a fixture that sets only the fields a test reads and
 * returns it as `T`. The argument is still checked against `DeepPartial<T>`,
 * so a misspelt or wrongly typed field fails the type check. `loose<T>()` is
 * for fixtures that deliberately do not match `T` (wire-shaped values such as
 * string dates or numeric ids where a row type says otherwise); prefer
 * `partial` and leave a short comment wherever `loose` is needed.
 *
 * Fixtures are where test data enters, so `partial` accepts a branded id or
 * currency code (`@vision/types/brands`) as its plain number or string.
 *
 * Both are identity functions at runtime.
 */
import type { z } from "zod";

/** A branded id or currency code widened to its base type. */
type Unbranded<T> = T extends number ? number : T extends string ? string : T;

export type DeepPartial<T> = T extends z.$brand<string>
  ? Unbranded<T>
  : T extends (...args: never[]) => unknown
    ? T
    : T extends readonly (infer U)[]
      ? readonly DeepPartial<U>[]
      : T extends object
        ? { [K in keyof T]?: DeepPartial<T[K]> }
        : T;

export function partial<T>(value: NoInfer<DeepPartial<T>>): T {
  return value as T;
}

export function loose<T>(value: unknown): T {
  return value as T;
}
