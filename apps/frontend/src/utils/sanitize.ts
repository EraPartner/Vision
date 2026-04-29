/**
 * Security utilities for input sanitization and XSS prevention.
 */

/**
 * Escape HTML special characters to prevent XSS when rendering user content.
 */
export function escapeHtml(str: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return str.replace(/[&<>"']/g, (c) => map[c] || c);
}

/**
 * Strip HTML tags from a string.
 *
 * Iterates until the output stops shrinking so that nested-tag bypasses such as
 * `<<a>script>` cannot survive the first pass. Each iteration removes at least
 * one character or terminates, so this is bounded.
 */
export function stripHtml(str: string): string {
  const tagRe = /<[^>]*>/g;
  let prev = str;
  // codeql[js/incomplete-sanitization]: iterative loop reruns until stable, closing the nested-tag bypass (e.g. `<<a>script>`).
  let next = prev.replace(tagRe, "");
  while (next !== prev) {
    prev = next;
    next = prev.replace(tagRe, "");
  }
  return next;
}

/**
 * Sanitize a filename to prevent directory traversal and special characters.
 */
export function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/^\./, "_")
    .slice(0, 255);
}

/**
 * Validate and sanitize a string input: trim, limit length, strip HTML.
 */
export function sanitizeInput(input: string, maxLength: number = 1000): string {
  return stripHtml(input.trim()).slice(0, maxLength);
}

/**
 * Validate that a string looks like a safe URL (http/https only).
 */
export function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * Sanitize numeric input – returns NaN for non-numeric strings.
 */
export function sanitizeNumber(value: string | number): number {
  const num = typeof value === "number" ? value : parseFloat(value);
  if (!Number.isFinite(num)) return NaN;
  return num;
}
