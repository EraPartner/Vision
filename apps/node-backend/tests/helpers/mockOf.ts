import { vi } from "vitest";
import type { MockedFunction } from "vitest";

type Procedure = (...args: never[]) => unknown;

/** Keys of `T` whose value is a function. */
type MethodKeys<T> = {
  [K in keyof T]: T[K] extends Procedure ? K : never;
}[keyof T];

/**
 * The spy behind a mocked method, for `expect(...)` and `.mockResolvedValue`.
 *
 * `vi.mocked(owner.method)` reads the method off its owner as an unbound
 * reference, which `@typescript-eslint/unbound-method` rejects. Looking the
 * method up by key keeps the reference typed but unbound, and checks at
 * runtime that the property really is a mock.
 */
export function mockOf<T extends object, K extends MethodKeys<T>>(
  owner: T,
  key: K,
): MockedFunction<Extract<T[K], Procedure>> {
  const member: unknown = owner[key];
  if (!vi.isMockFunction(member)) {
    throw new Error(`Expected ${String(key)} to be a mock function`);
  }
  return member as MockedFunction<Extract<T[K], Procedure>>;
}
