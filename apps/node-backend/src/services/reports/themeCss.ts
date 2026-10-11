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

import { REPORT_THEME_DEFAULTS } from "@vision/types/reportThemeDefaults";
import type { ThemeTokens } from "./index.ts";

/**
 * HSL component triple, e.g. "158 62% 32%" — hue (0-360, optional decimal),
 * saturation%, lightness%. The only shape a theme token may take.
 */
export const HSL_COMPONENT_RE =
  /^\d{1,3}(?:\.\d+)?\s+\d{1,3}(?:\.\d+)?%\s+\d{1,3}(?:\.\d+)?%$/;

/** @returns `<style>` block content (`:root { ... }`) */
export function buildThemeCss(tokens: ThemeTokens): string {
  const { mode, ...colorTokens } = tokens;

  // Skip tokens whose value is missing/blank OR not a valid HSL-component
  // triple so they don't (a) override the mode-aware defaults with invalid CSS
  // like `--text: undefined;`, or (b) inject arbitrary CSS into the rendered
  // `:root {}` block (see HSL_COMPONENT_RE above). Rejected tokens fall through
  // to the defaults below.
  const vars = Object.entries(colorTokens)
    .map(([key, value]): [string, string] => [
      key,
      typeof value === "string" ? value.trim() : "",
    ])
    .filter(([, value]) => HSL_COMPONENT_RE.test(value))
    .map(([key, value]) => `  ${tokenToCssVar(key)}: ${value};`)
    .join("\n");

  const palette = REPORT_THEME_DEFAULTS[mode === "dark" ? "dark" : "light"];
  const defaults = Object.entries(palette)
    .map(([name, value]) => `  ${tokenToCssVar(name)}: ${value};`)
    .join("\n");

  return `:root {\n  /* defaults (${mode === "dark" ? "dark" : "light"} mode) */\n${defaults}\n\n  /* resolved theme */\n${vars}\n}`;
}

/**
 * Map camelCase token key → CSS custom property name.
 *
 * chart1..chart8  →  --chart-1..--chart-8
 * primary         →  --primary
 * muted           →  --muted
 */
function tokenToCssVar(key: string): string {
  // chart1..chart8 → --chart-1..--chart-8
  const chartMatch = key.match(/^chart(\d)$/);
  if (chartMatch) return `--chart-${chartMatch[1]}`;

  // camelCase → kebab-case → --prefix
  const kebab = key.replace(/([A-Z])/g, "-$1").toLowerCase();
  return `--${kebab}`;
}
