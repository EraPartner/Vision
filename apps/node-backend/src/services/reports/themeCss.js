/**
 * Convert frontend theme tokens (HSL component strings) to CSS custom properties.
 *
 * Tokens are received as HSL components (e.g. "158 62% 32%") so templates can
 * compose them with `hsl(var(--primary) / 0.1)` for alpha variants, exactly
 * matching the app's Tailwind CSS convention.
 *
 * @param {import('./index.js').ThemeTokens} tokens
 * @returns {string} - `<style>` block content (`:root { ... }`)
 */
export function buildThemeCss(tokens) {
  const { mode, ...colorTokens } = tokens;

  const vars = Object.entries(colorTokens)
    .map(([key, value]) => `  ${tokenToCssVar(key)}: ${value};`)
    .join('\n');

  // Default values used when a token is missing — matches app default theme light mode.
  const defaults = [
    '--primary: 158 62% 32%',
    '--accent: 38 58% 52%',
    '--success: 152 58% 38%',
    '--expense: 358 74% 48%',
    '--surface: 0 0% 100%',
    '--text: 220 26% 14%',
    '--muted: 220 13% 46%',
    '--border: 220 13% 91%',
    '--chart-1: 158 62% 32%',
    '--chart-2: 38 58% 52%',
    '--chart-3: 200 72% 48%',
    '--chart-4: 270 62% 52%',
    '--chart-5: 358 74% 48%',
    '--chart-6: 32 84% 52%',
    '--chart-7: 152 58% 38%',
    '--chart-8: 220 52% 48%',
  ]
    .map((d) => `  ${d};`)
    .join('\n');

  return `:root {\n  /* defaults */\n${defaults}\n\n  /* resolved theme */\n${vars}\n}`;
}

/**
 * Map camelCase token key → CSS custom property name.
 *
 * chart1..chart8  →  --chart-1..--chart-8
 * primary         →  --primary
 * muted           →  --muted
 */
function tokenToCssVar(key) {
  // chart1..chart8 → --chart-1..--chart-8
  const chartMatch = key.match(/^chart(\d)$/);
  if (chartMatch) return `--chart-${chartMatch[1]}`;

  // camelCase → kebab-case → --prefix
  const kebab = key.replace(/([A-Z])/g, '-$1').toLowerCase();
  return `--${kebab}`;
}
