/**
 * Return `url` only if it is a safe `http(s)` link, otherwise `undefined`.
 *
 * React does NOT neutralize dangerous URL schemes (`javascript:`, `data:`,
 * `vbscript:`) in an `href`, so any link built from external or user-supplied
 * data — news-feed items, GitHub release-API responses, user-entered link
 * fields — must be scheme-checked before it reaches the DOM. A click on a
 * `javascript:` href executes in the app origin (which holds financial data).
 *
 * Rendering `href={undefined}` yields an inert anchor, which is the safe
 * fallback for anything that isn't a plain web URL.
 */
export function safeHref(url: string | null | undefined): string | undefined {
  if (typeof url !== 'string') return undefined;
  return /^https?:\/\//i.test(url.trim()) ? url : undefined;
}
