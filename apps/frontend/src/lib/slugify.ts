/**
 * Mirrors apps/node-backend/src/lib/slugify.js.
 * Unicode characters are dropped (v1 limitation; transliteration in v2).
 */
export function slugify(input: string): string {
    return input
        .toLowerCase()
        .trim()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}
