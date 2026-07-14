/**
 * Category interchange-string helpers shared by the Vision backend and frontend.
 *
 * The backend stores a category as two separate columns, `general` and `detail`.
 * When a category travels over the API (and inside a few UI helpers) it is carried
 * as a single joined string in the form `GENERAL:DETAIL`. This module is the one
 * source of truth for building and splitting that interchange string so the two
 * apps can no longer hand-mirror divergent parsing (the frontend previously
 * re-implemented it as a local closure — see RecipientsPage).
 *
 * Semantics (mirrors the frontend closure):
 *   - The separator is a single ':' with no surrounding spaces.
 *   - `general` and `detail` are trimmed.
 *   - A missing / empty `detail` collapses to just the general part (no trailing
 *     separator): format('FOOD', '') === 'FOOD'.
 *   - Only the FIRST ':' separates general from detail; the detail text itself may
 *     contain colons, which are preserved: parse('FOOD:A:B') → detail 'A:B'.
 *
 * Pure — no I/O.
 */

/**
 * Join a general/detail pair into the `GENERAL:DETAIL` interchange string.
 * A missing or empty (after trim) detail yields just the general part.
 *
 * @param {string|null|undefined} general
 * @param {string|null|undefined} detail
 * @returns {string}
 */
export function formatCategoryName(general, detail) {
  const g = String(general ?? '').trim();
  const d = String(detail ?? '').trim();
  return d ? `${g}:${d}` : g;
}

/**
 * Split a `GENERAL:DETAIL` interchange string into its parts. Splits on the
 * first ':' only, so a detail containing colons is preserved. A string with no
 * ':' returns an empty detail.
 *
 * @param {string|null|undefined} str
 * @returns {{ general: string, detail: string }}
 */
export function parseCategoryName(str) {
  const s = String(str ?? '');
  const idx = s.indexOf(':');
  if (idx === -1) return { general: s.trim(), detail: '' };
  return {
    general: s.slice(0, idx).trim(),
    detail: s.slice(idx + 1).trim(),
  };
}
