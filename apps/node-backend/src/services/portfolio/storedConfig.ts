/**
 * Read a stored `custom_config` (JSON column) as an object of unknown values.
 *
 * Stage writes an object, but older rows may hold a JSON string, and a string
 * that is not valid JSON, or JSON that is not an object, carries no keys.
 * Readers pick the few keys they use and validate each one themselves.
 */
export function storedConfigObject(raw: unknown): Record<string, unknown> {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}
