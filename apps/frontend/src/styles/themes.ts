/**
 * Theme variant palettes.
 *
 * Each variant provides a full `light` and `dark` palette. Values are HSL
 * components (e.g. `"260 89% 63%"`) so Tailwind's `hsl(var(--token))` wiring
 * composes opacity correctly. Keys match CSS custom property names in
 * `tokens.css` without the leading `--`.
 *
 * The `default` variant mirrors `tokens.css` so switching away and back is
 * lossless.
 */

export type ThemeMode = 'light' | 'dark'

export type ThemeVariant =
  | 'default'
  | 'dracula'
  | 'solarized'
  | 'nord'
  | 'high-contrast'

export const THEME_VARIANTS: ThemeVariant[] = [
  'default',
  'dracula',
  'solarized',
  'nord',
  'high-contrast'
]

export function isThemeVariant(value: unknown): value is ThemeVariant {
  return (
    typeof value === 'string' &&
    (THEME_VARIANTS as string[]).includes(value)
  )
}

export type ThemeTokens = {
  background: string
  foreground: string
  card: string
  'card-foreground': string
  popover: string
  'popover-foreground': string
  muted: string
  'muted-foreground': string
  secondary: string
  'secondary-foreground': string
  border: string
  input: string
  primary: string
  'primary-foreground': string
  accent: string
  'accent-foreground': string
  ring: string
  destructive: string
  'destructive-foreground': string
  success: string
  warning: string
  expense: string
  'chart-1': string
  'chart-2': string
  'chart-3': string
  'chart-4': string
  'chart-5': string
  'chart-6': string
  'chart-7': string
  'chart-8': string
  'sidebar-background': string
  'sidebar-foreground': string
  'sidebar-primary': string
  'sidebar-primary-foreground': string
  'sidebar-accent': string
  'sidebar-accent-foreground': string
  'sidebar-border': string
  'sidebar-ring': string
  'glass-surface': string
  'glass-surface-soft': string
  'glass-surface-deep': string
  'glass-border': string
  'glass-highlight': string
  'glass-shadow': string
  'glass-tint': string
}

export type TokenKey = keyof ThemeTokens

export type ThemePalette = {
  light: ThemeTokens
  dark: ThemeTokens
}

/* ------------------------------------------------------------------
 * default — emerald + champagne gold on warm ivory / obsidian.
 * Mirrors tokens.css verbatim.
 * ------------------------------------------------------------------ */
const defaultLight: ThemeTokens = {
  background: '42 30% 97%',
  foreground: '200 18% 10%',
  card: '0 0% 100%',
  'card-foreground': '200 18% 10%',
  popover: '0 0% 100%',
  'popover-foreground': '200 18% 10%',
  muted: '42 18% 93%',
  'muted-foreground': '200 10% 36%',
  secondary: '42 18% 93%',
  'secondary-foreground': '200 18% 10%',
  border: '42 15% 87%',
  input: '42 15% 87%',
  primary: '158 62% 32%',
  'primary-foreground': '42 30% 97%',
  accent: '38 58% 52%',
  'accent-foreground': '200 18% 10%',
  ring: '158 62% 32%',
  destructive: '358 74% 48%',
  'destructive-foreground': '0 0% 100%',
  success: '152 58% 38%',
  warning: '38 80% 50%',
  expense: '358 74% 44%',
  'chart-1': '158 62% 38%',
  'chart-2': '38 62% 54%',
  'chart-3': '204 68% 48%',
  'chart-4': '268 52% 58%',
  'chart-5': '14 76% 54%',
  'chart-6': '182 48% 40%',
  'chart-7': '340 58% 54%',
  'chart-8': '48 72% 48%',
  'sidebar-background': '42 24% 96%',
  'sidebar-foreground': '200 14% 22%',
  'sidebar-primary': '158 62% 32%',
  'sidebar-primary-foreground': '42 30% 97%',
  'sidebar-accent': '42 18% 90%',
  'sidebar-accent-foreground': '200 18% 10%',
  'sidebar-border': '42 15% 85%',
  'sidebar-ring': '158 62% 32%',
  'glass-surface': '42 30% 99%',
  'glass-surface-soft': '42 26% 98%',
  'glass-surface-deep': '0 0% 100%',
  'glass-border': '200 18% 22%',
  'glass-highlight': '42 60% 98%',
  'glass-shadow': '200 40% 10%',
  'glass-tint': '158 40% 40%'
}

const defaultDark: ThemeTokens = {
  background: '200 20% 7%',
  foreground: '42 25% 96%',
  card: '200 18% 11%',
  'card-foreground': '42 25% 96%',
  popover: '200 20% 9%',
  'popover-foreground': '42 25% 96%',
  muted: '200 14% 14%',
  'muted-foreground': '42 12% 68%',
  secondary: '200 14% 14%',
  'secondary-foreground': '42 25% 96%',
  border: '200 14% 20%',
  input: '200 14% 18%',
  primary: '158 64% 52%',
  'primary-foreground': '200 20% 6%',
  accent: '42 72% 66%',
  'accent-foreground': '200 20% 6%',
  ring: '158 64% 52%',
  destructive: '358 82% 62%',
  'destructive-foreground': '200 20% 6%',
  success: '152 62% 54%',
  warning: '38 88% 62%',
  expense: '358 92% 68%',
  'chart-1': '158 64% 58%',
  'chart-2': '42 78% 68%',
  'chart-3': '204 78% 62%',
  'chart-4': '268 68% 72%',
  'chart-5': '14 82% 64%',
  'chart-6': '182 58% 54%',
  'chart-7': '340 68% 66%',
  'chart-8': '48 82% 60%',
  'sidebar-background': '200 22% 6%',
  'sidebar-foreground': '42 18% 82%',
  'sidebar-primary': '158 64% 52%',
  'sidebar-primary-foreground': '200 20% 6%',
  'sidebar-accent': '200 18% 12%',
  'sidebar-accent-foreground': '42 25% 96%',
  'sidebar-border': '200 14% 16%',
  'sidebar-ring': '158 64% 52%',
  'glass-surface': '200 22% 12%',
  'glass-surface-soft': '200 20% 14%',
  'glass-surface-deep': '200 24% 9%',
  'glass-border': '42 30% 88%',
  'glass-highlight': '42 40% 94%',
  'glass-shadow': '0 0% 0%',
  'glass-tint': '158 50% 45%'
}

/* ------------------------------------------------------------------
 * dracula — purple/pink/cyan on deep indigo.
 * Light variant = soft lavender paper with dracula accents.
 * ------------------------------------------------------------------ */
const draculaDark: ThemeTokens = {
  background: '231 15% 18%',
  foreground: '60 30% 96%',
  card: '232 14% 22%',
  'card-foreground': '60 30% 96%',
  popover: '231 15% 20%',
  'popover-foreground': '60 30% 96%',
  muted: '232 14% 26%',
  'muted-foreground': '230 14% 70%',
  secondary: '232 14% 26%',
  'secondary-foreground': '60 30% 96%',
  border: '232 14% 30%',
  input: '232 14% 28%',
  primary: '265 89% 78%',
  'primary-foreground': '231 15% 14%',
  accent: '326 100% 74%',
  'accent-foreground': '231 15% 14%',
  ring: '265 89% 78%',
  destructive: '0 100% 67%',
  'destructive-foreground': '231 15% 14%',
  success: '135 94% 65%',
  warning: '65 92% 76%',
  expense: '0 100% 67%',
  'chart-1': '265 89% 78%',
  'chart-2': '326 100% 74%',
  'chart-3': '191 97% 77%',
  'chart-4': '135 94% 65%',
  'chart-5': '31 100% 71%',
  'chart-6': '65 92% 76%',
  'chart-7': '210 70% 70%',
  'chart-8': '0 100% 67%',
  'sidebar-background': '231 15% 14%',
  'sidebar-foreground': '60 30% 90%',
  'sidebar-primary': '265 89% 78%',
  'sidebar-primary-foreground': '231 15% 14%',
  'sidebar-accent': '232 14% 22%',
  'sidebar-accent-foreground': '60 30% 96%',
  'sidebar-border': '232 14% 24%',
  'sidebar-ring': '265 89% 78%',
  'glass-surface': '232 14% 24%',
  'glass-surface-soft': '232 14% 26%',
  'glass-surface-deep': '231 15% 16%',
  'glass-border': '60 30% 90%',
  'glass-highlight': '265 89% 90%',
  'glass-shadow': '231 30% 4%',
  'glass-tint': '265 70% 55%'
}

const draculaLight: ThemeTokens = {
  background: '60 30% 98%',
  foreground: '231 15% 18%',
  card: '0 0% 100%',
  'card-foreground': '231 15% 18%',
  popover: '0 0% 100%',
  'popover-foreground': '231 15% 18%',
  muted: '250 20% 94%',
  'muted-foreground': '231 15% 38%',
  secondary: '250 20% 94%',
  'secondary-foreground': '231 15% 18%',
  border: '250 18% 86%',
  input: '250 18% 86%',
  primary: '265 70% 50%',
  'primary-foreground': '60 30% 98%',
  accent: '326 80% 48%',
  'accent-foreground': '60 30% 98%',
  ring: '265 70% 50%',
  destructive: '0 74% 48%',
  'destructive-foreground': '0 0% 100%',
  success: '135 60% 36%',
  warning: '31 90% 46%',
  expense: '0 74% 48%',
  'chart-1': '265 70% 50%',
  'chart-2': '326 80% 48%',
  'chart-3': '191 80% 42%',
  'chart-4': '135 60% 36%',
  'chart-5': '31 90% 46%',
  'chart-6': '48 84% 42%',
  'chart-7': '210 70% 48%',
  'chart-8': '0 74% 48%',
  'sidebar-background': '250 28% 96%',
  'sidebar-foreground': '231 15% 26%',
  'sidebar-primary': '265 70% 50%',
  'sidebar-primary-foreground': '60 30% 98%',
  'sidebar-accent': '250 20% 91%',
  'sidebar-accent-foreground': '231 15% 18%',
  'sidebar-border': '250 18% 84%',
  'sidebar-ring': '265 70% 50%',
  'glass-surface': '60 30% 99%',
  'glass-surface-soft': '250 26% 97%',
  'glass-surface-deep': '0 0% 100%',
  'glass-border': '231 15% 22%',
  'glass-highlight': '265 80% 96%',
  'glass-shadow': '231 30% 10%',
  'glass-tint': '265 60% 55%'
}

/* ------------------------------------------------------------------
 * solarized — Ethan Schoonover's palette. Famous for light-mode readability.
 * ------------------------------------------------------------------ */
const solarizedLight: ThemeTokens = {
  background: '44 87% 94%',
  foreground: '194 14% 40%',
  card: '46 42% 88%',
  'card-foreground': '194 14% 40%',
  popover: '46 42% 88%',
  'popover-foreground': '194 14% 40%',
  muted: '44 60% 90%',
  'muted-foreground': '180 7% 60%',
  secondary: '44 60% 90%',
  'secondary-foreground': '194 14% 40%',
  border: '44 40% 82%',
  input: '44 40% 82%',
  primary: '205 82% 41%',
  'primary-foreground': '44 87% 94%',
  accent: '175 59% 40%',
  'accent-foreground': '44 87% 94%',
  ring: '205 82% 41%',
  destructive: '1 79% 52%',
  'destructive-foreground': '44 87% 94%',
  success: '68 100% 30%',
  warning: '45 100% 35%',
  expense: '1 79% 52%',
  'chart-1': '205 82% 41%',
  'chart-2': '175 59% 40%',
  'chart-3': '68 100% 30%',
  'chart-4': '237 45% 57%',
  'chart-5': '331 64% 52%',
  'chart-6': '18 89% 44%',
  'chart-7': '45 100% 35%',
  'chart-8': '1 79% 52%',
  'sidebar-background': '46 42% 88%',
  'sidebar-foreground': '194 14% 40%',
  'sidebar-primary': '205 82% 41%',
  'sidebar-primary-foreground': '44 87% 94%',
  'sidebar-accent': '44 60% 90%',
  'sidebar-accent-foreground': '194 14% 40%',
  'sidebar-border': '44 40% 80%',
  'sidebar-ring': '205 82% 41%',
  'glass-surface': '44 87% 96%',
  'glass-surface-soft': '46 60% 92%',
  'glass-surface-deep': '46 42% 88%',
  'glass-border': '194 25% 20%',
  'glass-highlight': '44 90% 97%',
  'glass-shadow': '194 40% 15%',
  'glass-tint': '205 60% 45%'
}

const solarizedDark: ThemeTokens = {
  background: '192 100% 11%',
  foreground: '44 26% 74%',
  card: '192 87% 9%',
  'card-foreground': '44 26% 74%',
  popover: '192 87% 9%',
  'popover-foreground': '44 26% 74%',
  muted: '192 81% 14%',
  'muted-foreground': '186 8% 55%',
  secondary: '192 81% 14%',
  'secondary-foreground': '44 26% 74%',
  border: '192 70% 18%',
  input: '192 70% 18%',
  primary: '205 82% 55%',
  'primary-foreground': '192 100% 11%',
  accent: '175 59% 50%',
  'accent-foreground': '192 100% 11%',
  ring: '205 82% 55%',
  destructive: '1 71% 62%',
  'destructive-foreground': '192 100% 11%',
  success: '68 100% 45%',
  warning: '45 100% 50%',
  expense: '1 71% 62%',
  'chart-1': '205 82% 55%',
  'chart-2': '175 59% 50%',
  'chart-3': '68 100% 45%',
  'chart-4': '237 45% 67%',
  'chart-5': '331 64% 62%',
  'chart-6': '18 89% 54%',
  'chart-7': '45 100% 50%',
  'chart-8': '1 71% 62%',
  'sidebar-background': '192 100% 9%',
  'sidebar-foreground': '44 26% 70%',
  'sidebar-primary': '205 82% 55%',
  'sidebar-primary-foreground': '192 100% 11%',
  'sidebar-accent': '192 81% 14%',
  'sidebar-accent-foreground': '44 26% 74%',
  'sidebar-border': '192 70% 16%',
  'sidebar-ring': '205 82% 55%',
  'glass-surface': '192 81% 14%',
  'glass-surface-soft': '192 70% 16%',
  'glass-surface-deep': '192 100% 9%',
  'glass-border': '44 30% 80%',
  'glass-highlight': '44 40% 90%',
  'glass-shadow': '192 100% 4%',
  'glass-tint': '205 60% 45%'
}

/* ------------------------------------------------------------------
 * nord — arctic, bluish pastel palette by Arctic Ice Studio.
 * ------------------------------------------------------------------ */
const nordDark: ThemeTokens = {
  background: '220 16% 22%',
  foreground: '218 27% 94%',
  card: '222 16% 26%',
  'card-foreground': '218 27% 94%',
  popover: '222 16% 24%',
  'popover-foreground': '218 27% 94%',
  muted: '220 17% 30%',
  'muted-foreground': '218 20% 76%',
  secondary: '220 17% 30%',
  'secondary-foreground': '218 27% 94%',
  border: '220 16% 36%',
  input: '220 16% 32%',
  primary: '210 34% 63%',
  'primary-foreground': '220 16% 22%',
  accent: '179 25% 65%',
  'accent-foreground': '220 16% 22%',
  ring: '210 34% 63%',
  destructive: '354 42% 56%',
  'destructive-foreground': '218 27% 94%',
  success: '92 28% 65%',
  warning: '40 71% 73%',
  expense: '354 42% 56%',
  'chart-1': '210 34% 63%',
  'chart-2': '179 25% 65%',
  'chart-3': '92 28% 65%',
  'chart-4': '311 20% 63%',
  'chart-5': '14 51% 63%',
  'chart-6': '193 43% 67%',
  'chart-7': '40 71% 73%',
  'chart-8': '354 42% 56%',
  'sidebar-background': '220 16% 18%',
  'sidebar-foreground': '218 27% 88%',
  'sidebar-primary': '210 34% 63%',
  'sidebar-primary-foreground': '220 16% 22%',
  'sidebar-accent': '222 16% 26%',
  'sidebar-accent-foreground': '218 27% 94%',
  'sidebar-border': '220 16% 30%',
  'sidebar-ring': '210 34% 63%',
  'glass-surface': '222 16% 28%',
  'glass-surface-soft': '220 17% 32%',
  'glass-surface-deep': '220 16% 20%',
  'glass-border': '218 27% 90%',
  'glass-highlight': '218 27% 94%',
  'glass-shadow': '220 30% 6%',
  'glass-tint': '210 34% 50%'
}

const nordLight: ThemeTokens = {
  background: '218 27% 94%',
  foreground: '220 16% 22%',
  card: '218 27% 98%',
  'card-foreground': '220 16% 22%',
  popover: '218 27% 98%',
  'popover-foreground': '220 16% 22%',
  muted: '218 27% 90%',
  'muted-foreground': '220 16% 36%',
  secondary: '218 27% 90%',
  'secondary-foreground': '220 16% 22%',
  border: '218 22% 82%',
  input: '218 22% 82%',
  primary: '213 32% 42%',
  'primary-foreground': '218 27% 94%',
  accent: '179 30% 36%',
  'accent-foreground': '218 27% 94%',
  ring: '213 32% 42%',
  destructive: '354 42% 46%',
  'destructive-foreground': '218 27% 94%',
  success: '92 38% 36%',
  warning: '40 71% 40%',
  expense: '354 42% 46%',
  'chart-1': '213 32% 42%',
  'chart-2': '179 30% 36%',
  'chart-3': '92 38% 36%',
  'chart-4': '311 30% 45%',
  'chart-5': '14 61% 46%',
  'chart-6': '193 53% 42%',
  'chart-7': '40 71% 42%',
  'chart-8': '354 42% 46%',
  'sidebar-background': '218 27% 92%',
  'sidebar-foreground': '220 16% 26%',
  'sidebar-primary': '213 32% 42%',
  'sidebar-primary-foreground': '218 27% 94%',
  'sidebar-accent': '218 27% 88%',
  'sidebar-accent-foreground': '220 16% 22%',
  'sidebar-border': '218 22% 80%',
  'sidebar-ring': '213 32% 42%',
  'glass-surface': '218 27% 96%',
  'glass-surface-soft': '218 27% 92%',
  'glass-surface-deep': '218 27% 98%',
  'glass-border': '220 16% 22%',
  'glass-highlight': '218 27% 98%',
  'glass-shadow': '220 30% 14%',
  'glass-tint': '213 32% 50%'
}

/* ------------------------------------------------------------------
 * high-contrast — WCAG AA+ palette. Pure black/white with saturated accents.
 * ------------------------------------------------------------------ */
const highContrastLight: ThemeTokens = {
  background: '0 0% 100%',
  foreground: '0 0% 0%',
  card: '0 0% 100%',
  'card-foreground': '0 0% 0%',
  popover: '0 0% 100%',
  'popover-foreground': '0 0% 0%',
  muted: '0 0% 94%',
  'muted-foreground': '0 0% 20%',
  secondary: '0 0% 94%',
  'secondary-foreground': '0 0% 0%',
  border: '0 0% 0%',
  input: '0 0% 0%',
  primary: '220 100% 30%',
  'primary-foreground': '0 0% 100%',
  accent: '280 100% 30%',
  'accent-foreground': '0 0% 100%',
  ring: '220 100% 30%',
  destructive: '0 100% 30%',
  'destructive-foreground': '0 0% 100%',
  success: '140 100% 22%',
  warning: '30 100% 30%',
  expense: '0 100% 30%',
  'chart-1': '220 100% 30%',
  'chart-2': '280 100% 30%',
  'chart-3': '140 100% 22%',
  'chart-4': '30 100% 30%',
  'chart-5': '0 100% 30%',
  'chart-6': '180 100% 24%',
  'chart-7': '330 100% 30%',
  'chart-8': '50 100% 24%',
  'sidebar-background': '0 0% 98%',
  'sidebar-foreground': '0 0% 0%',
  'sidebar-primary': '220 100% 30%',
  'sidebar-primary-foreground': '0 0% 100%',
  'sidebar-accent': '0 0% 90%',
  'sidebar-accent-foreground': '0 0% 0%',
  'sidebar-border': '0 0% 0%',
  'sidebar-ring': '220 100% 30%',
  'glass-surface': '0 0% 100%',
  'glass-surface-soft': '0 0% 98%',
  'glass-surface-deep': '0 0% 100%',
  'glass-border': '0 0% 0%',
  'glass-highlight': '0 0% 100%',
  'glass-shadow': '0 0% 0%',
  'glass-tint': '220 100% 40%'
}

const highContrastDark: ThemeTokens = {
  background: '0 0% 0%',
  foreground: '0 0% 100%',
  card: '0 0% 4%',
  'card-foreground': '0 0% 100%',
  popover: '0 0% 4%',
  'popover-foreground': '0 0% 100%',
  muted: '0 0% 10%',
  'muted-foreground': '0 0% 90%',
  secondary: '0 0% 10%',
  'secondary-foreground': '0 0% 100%',
  border: '0 0% 100%',
  input: '0 0% 100%',
  primary: '60 100% 70%',
  'primary-foreground': '0 0% 0%',
  accent: '180 100% 70%',
  'accent-foreground': '0 0% 0%',
  ring: '60 100% 70%',
  destructive: '0 100% 70%',
  'destructive-foreground': '0 0% 0%',
  success: '120 100% 70%',
  warning: '40 100% 70%',
  expense: '0 100% 70%',
  'chart-1': '60 100% 70%',
  'chart-2': '180 100% 70%',
  'chart-3': '120 100% 70%',
  'chart-4': '300 100% 75%',
  'chart-5': '20 100% 70%',
  'chart-6': '200 100% 70%',
  'chart-7': '330 100% 75%',
  'chart-8': '90 100% 65%',
  'sidebar-background': '0 0% 0%',
  'sidebar-foreground': '0 0% 100%',
  'sidebar-primary': '60 100% 70%',
  'sidebar-primary-foreground': '0 0% 0%',
  'sidebar-accent': '0 0% 8%',
  'sidebar-accent-foreground': '0 0% 100%',
  'sidebar-border': '0 0% 100%',
  'sidebar-ring': '60 100% 70%',
  'glass-surface': '0 0% 6%',
  'glass-surface-soft': '0 0% 10%',
  'glass-surface-deep': '0 0% 0%',
  'glass-border': '0 0% 100%',
  'glass-highlight': '0 0% 100%',
  'glass-shadow': '0 0% 0%',
  'glass-tint': '60 100% 50%'
}

export const themes: Record<ThemeVariant, ThemePalette> = {
  default: { light: defaultLight, dark: defaultDark },
  dracula: { light: draculaLight, dark: draculaDark },
  solarized: { light: solarizedLight, dark: solarizedDark },
  nord: { light: nordLight, dark: nordDark },
  'high-contrast': { light: highContrastLight, dark: highContrastDark }
}

export const TOKEN_KEYS: readonly TokenKey[] = Object.keys(
  defaultLight
) as TokenKey[]

/**
 * Apply a palette to `document.documentElement` by setting CSS custom
 * properties. Caller is responsible for setting the `.dark` class separately.
 */
export function applyThemePalette(
  variant: ThemeVariant,
  mode: ThemeMode,
  root: HTMLElement = document.documentElement
): void {
  const palette = themes[variant][mode]
  for (const key of TOKEN_KEYS) {
    root.style.setProperty(`--${key}`, palette[key])
  }
}
