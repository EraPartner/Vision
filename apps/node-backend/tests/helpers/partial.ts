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
 * Both are identity functions at runtime.
 */
export type DeepPartial<T> = T extends (...args: never[]) => unknown
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
