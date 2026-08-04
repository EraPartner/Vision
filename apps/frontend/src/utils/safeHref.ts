/**
 * Return `url` only if it is a safe `http(s)` link, otherwise `undefined`.
 *
 * React does NOT neutralize dangerous URL schemes (`javascript:`, `data:`,
 * `vbscript:`) in an `href`, so any link built from external or user-supplied
 * data — news-feed items, GitHub release-API responses, user-entered link
 * fields — must be scheme-checked before it reaches the DOM. A click on a
 * `javascript:` href executes in the app origin (which holds financial data).
 *
 * Protocol-relative URLs (`//cdn.example.com/article`) are accepted and
 * resolved against `https:`. They are ordinary web links and common in RSS and
 * news payloads; the previous `^https?:\/\//` test rejected them, which turned
 * legitimate articles into dead cards.
 *
 * The check parses rather than pattern-matches, so the scheme decision is made
 * by the same URL grammar the browser uses. That also closes an obfuscation gap
 * a prefix regex has: the parser strips embedded tabs and newlines, so
 * `java\nscript:…` is recognized as `javascript:` and rejected.
 *
 * Rendering `href={undefined}` yields an inert anchor, which is the safe
 * fallback for anything that isn't a plain web URL.
 */
export function safeHref(url: string | null | undefined): string | undefined {
  if (typeof url !== 'string') return undefined;
  const trimmed = url.trim();
  if (!trimmed) return undefined;

  const candidate = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    // Relative paths and malformed input land here — same rejection as before.
    return undefined;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  return candidate;
}
