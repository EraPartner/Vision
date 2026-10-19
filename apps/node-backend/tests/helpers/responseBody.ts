/**
 * Readers for parsed supertest response bodies, which are typed `unknown`.
 *
 * Each reader walks a key path with plain JavaScript property-access
 * semantics, so a test reads `bodyAt(res, "error", "code")` where it used to
 * write `res.body.error.code`, and nothing about the assertion changes:
 *   - a missing final key reads as `undefined`;
 *   - reading through `null` or `undefined` throws a `TypeError`, as `.` does;
 *   - primitives are boxed, so `bodyAt(res, "error", "message", "length")`
 *     still reads a string's length.
 */

export type BodyKey = string | number;

function read(root: unknown, keys: readonly BodyKey[]): unknown {
  let node = root;
  keys.forEach((key, index) => {
    if (node === null || node === undefined) {
      const path = keys.slice(0, index).join(".") || "(root)";
      throw new TypeError(
        `Cannot read '${String(key)}' of ${String(node)} at ${path}`,
      );
    }
    node = Reflect.get(Object(node), key);
  });
  return node;
}

function asList(value: unknown, keys: readonly BodyKey[]): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`Expected an array at ${keys.join(".") || "(root)"}`);
  }
  return value;
}

/** `value.<keys>` — the same walk on any value (an array item, a saved body). */
export function valueAt(value: unknown, ...keys: BodyKey[]): unknown {
  return read(value, keys);
}

/** `res.body.<keys>`. */
export function bodyAt(res: { body: unknown }, ...keys: BodyKey[]): unknown {
  return read(res.body, keys);
}

/** `value.<keys>`, which must be an array (as calling an array method requires). */
export function listAt(value: unknown, ...keys: BodyKey[]): unknown[] {
  return asList(read(value, keys), keys);
}
