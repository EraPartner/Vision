/**
 * Resolve a compatibility parameter with deterministic body-first precedence.
 * Presence matters: an explicit false or empty body value must not silently
 * fall back to a conflicting query value.
 *
 * @param {Record<string, unknown> | undefined} body
 * @param {Record<string, unknown> | undefined} query
 * @param {string} key
 * @returns {unknown}
 */
export function bodyFirstParam(body, query, key) {
  if (body && Object.prototype.hasOwnProperty.call(body, key)) {
    return body[key];
  }
  return query?.[key];
}

/**
 * Parse a boolean query parameter with one accepted spelling set.
 *
 * Express normally supplies strings, while listener-free handler tests and
 * internal callers sometimes supply primitive values. Absent, empty, or
 * unrecognised values use the caller-owned default. This preserves each
 * endpoint's documented default without letting individual routers invent a
 * different true/false vocabulary.
 *
 * @param {unknown} raw
 * @param {boolean} [defaultValue]
 * @returns {boolean}
 */
export function parseBooleanQueryParam(raw, defaultValue = false) {
  if (raw == null || raw === "") return defaultValue;
  if (raw === true || raw === 1) return true;
  if (raw === false || raw === 0) return false;

  const normalized = String(raw).trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return defaultValue;
}
