/**
 * Convert frontend theme tokens (HSL component strings) to CSS custom properties.
 *
 * Tokens are received as HSL components (e.g. "158 62% 32%") so templates can
 * compose them with `hsl(var(--primary) / 0.1)` for alpha variants, exactly
 * matching the app's Tailwind CSS convention.
 *
 * SECURITY: every token value is interpolated verbatim into a `:root { ... }`
 * block that Puppeteer renders. An unconstrained value would allow CSS
 * injection — e.g. closing the rule and adding `background: url(...)` to make
 * the backend issue an arbitrary outbound request (SSRF). `HSL_COMPONENT_RE`
 * pins the value to a hue/saturation%/lightness% triple; anything else is
 * dropped and falls through to the mode-aware defaults. The report route
 * validates with the same pattern, so this is defense-in-depth at the sink.
 */

/**
 * HSL component triple, e.g. "158 62% 32%" — hue (0-360, optional decimal),
 * saturation%, lightness%. The only shape a theme token may take.
 * @type {RegExp}
 */
export const HSL_COMPONENT_RE = /^\d{1,3}(?:\.\d+)?\s+\d{1,3}(?:\.\d+)?%\s+\d{1,3}(?:\.\d+)?%$/;

// Mode-aware fallback palettes. Used when the frontend either omits a token or
// sends `undefined` (which would otherwise serialise as `--text: undefined;`,
// an invalid declaration that silently falls through to the wrong color and
// produces dark-on-dark text in dark mode).
const LIGHT_DEFAULTS = {
  '--primary': '158 62% 32%',
  '--accent':  '38 58% 52%',
  '--success': '152 58% 38%',
  '--expense': '358 74% 48%',
  '--surface': '42 30% 97%',
  '--text':    '200 18% 10%',
  '--muted':   '200 10% 36%',
  '--border':  '42 15% 87%',
  '--chart-1': '158 62% 38%',
  '--chart-2': '38 62% 54%',
  '--chart-3': '204 68% 48%',
  '--chart-4': '268 52% 58%',
  '--chart-5': '14 76% 54%',
  '--chart-6': '182 48% 40%',
  '--chart-7': '340 58% 54%',
  '--chart-8': '48 72% 48%',
};

const DARK_DEFAULTS = {
  '--primary': '158 64% 52%',
  '--accent':  '42 72% 66%',
  '--success': '152 58% 50%',
  '--expense': '358 74% 60%',
  '--surface': '200 20% 7%',
  '--text':    '42 25% 96%',
  '--muted':   '42 12% 68%',
  '--border':  '200 14% 20%',
  '--chart-1': '158 64% 52%',
  '--chart-2': '42 72% 66%',
  '--chart-3': '204 68% 60%',
  '--chart-4': '268 60% 70%',
  '--chart-5': '14 76% 64%',
  '--chart-6': '182 50% 55%',
  '--chart-7': '340 62% 66%',
  '--chart-8': '48 76% 60%',
};

/**
 * @param {import('./index.js').ThemeTokens} tokens
 * @returns {string} - `<style>` block content (`:root { ... }`)
 */
export function buildThemeCss(tokens) {
  const { mode, ...colorTokens } = tokens;

  // Skip tokens whose value is missing/blank OR not a valid HSL-component
  // triple so they don't (a) override the mode-aware defaults with invalid CSS
  // like `--text: undefined;`, or (b) inject arbitrary CSS into the rendered
  // `:root {}` block (see HSL_COMPONENT_RE above). Rejected tokens fall through
  // to the defaults below.
  const vars = Object.entries(colorTokens)
    .map(([key, value]) => [key, typeof value === 'string' ? value.trim() : ''])
    .filter(([, value]) => HSL_COMPONENT_RE.test(value))
    .map(([key, value]) => `  ${tokenToCssVar(key)}: ${value};`)
    .join('\n');

  const palette = mode === 'dark' ? DARK_DEFAULTS : LIGHT_DEFAULTS;
  const defaults = Object.entries(palette)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');

  return `:root {\n  /* defaults (${mode === 'dark' ? 'dark' : 'light'} mode) */\n${defaults}\n\n  /* resolved theme */\n${vars}\n}`;
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
