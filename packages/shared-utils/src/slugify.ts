/**
 * Normalize a string into a URL-safe slug.
 *
 * Rules: lowercase, trim, whitespace → hyphen, strip non-alphanumeric-except-dash,
 * collapse consecutive hyphens, strip leading/trailing hyphens.
 *
 * Unicode characters are dropped (known v1 limitation; transliteration in v2).
 * Examples:
 *   'Rome 2020'  → 'rome-2020'
 *   '  --weird-- ' → 'weird'
 *   'Café' → 'caf'
 */
export function slugify(input: string): string {
  return String(input)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
