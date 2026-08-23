/**
 * Currency utility functions
 */

/**
 * Canonical list of currencies offered in currency dropdowns (account
 * creation/editing and the default-currency setting). Order matters: subset
 * consumers slice a prefix of it (e.g. the report export dialog takes the
 * first 12), so add new currencies with that in mind.
 */
export const SUPPORTED_CURRENCIES = [
    'EUR', 'USD', 'GBP', 'CHF', 'JPY', 'CAD', 'AUD', 'SEK', 'NOK', 'DKK',
    'PLN', 'CZK', 'HUF', 'RON', 'BGN', 'HRK', 'TRY', 'SAR', 'AED', 'INR',
    'BRL', 'MXN', 'ZAR', 'SGD', 'HKD', 'NZD', 'KRW', 'THB', 'MYR', 'PHP',
];

/**
 * Currencies an investment can be denominated in (shared by the add/edit
 * investment forms). Deliberately not a subset of SUPPORTED_CURRENCIES: it
 * includes BTC.
 */
export const INVESTMENT_CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'SAR', 'BTC'];

type CurrencyFormatDefaults = {
  defaultCurrency: string;
  locale: string;
  fractionDigits: number;
};

const currencyFormatDefaults: CurrencyFormatDefaults = {
  defaultCurrency: 'EUR',
  locale: 'en-US',
  fractionDigits: 2,
};

/**
 * Map a numberFormat setting value (from AppSettings) to a BCP 47 locale string
 * suitable for use with Intl.NumberFormat.
 *
 * numberFormat values:  'eu' | 'us' | 'ch' | 'in'
 */
/**
 * Parse a user-entered numeric string into a Number, handling both
 * comma-as-decimal (EU) and period-as-decimal (US) regardless of
 * what `Number()` would do alone. Returns NaN if unparseable.
 *
 * Heuristic: if both "," and "." are present, the rightmost wins as decimal.
 * If only "," and the segment after it is not 3 digits, treat as decimal.
 */
export function parseLocaleNumber(input: string | number | null | undefined): number {
  if (typeof input === 'number') return input;
  if (input == null) return NaN;
  let s = String(input).trim();
  if (!s) return NaN;
  s = s.replace(/\s/g, '').replace(/[$€£¥]/g, '');
  let negative = false;
  if (s.startsWith('(') && s.endsWith(')')) { negative = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { negative = !negative; s = s.slice(1); }
  else if (s.startsWith('+')) { s = s.slice(1); }
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    const tail = s.length - lastComma - 1;
    if (tail === 3) s = s.replace(/,/g, '');
    else s = s.replace(',', '.');
  } else if (lastDot >= 0 && s.indexOf('.') !== lastDot) {
    // Only dots, more than one of them → EU thousands grouping (e.g.
    // "1.234.567"). A single dot is left untouched as the decimal point.
    s = s.replace(/\./g, '');
  }
  const n = parseFloat(s);
  if (isNaN(n)) return NaN;
  return negative ? -n : n;
}

export function numberFormatToLocale(numberFormat: string): string {
  switch (numberFormat) {
    case 'eu': return 'de-DE';   // 1.234,56 — European
    case 'us': return 'en-US';   // 1,234.56 — US / UK
    case 'ch': return 'de-CH';   // 1'234.56 — Swiss
    case 'in': return 'en-IN';   // 1,23,456.78 — Indian
    default:   return 'en-US';
  }
}

export function configureCurrencyFormatDefaults(
  updates: Partial<CurrencyFormatDefaults>
): void {
  if (updates.defaultCurrency) {
    currencyFormatDefaults.defaultCurrency = updates.defaultCurrency;
  }
  if (updates.locale) {
    currencyFormatDefaults.locale = updates.locale;
  }
  if (updates.fractionDigits !== undefined) {
    currencyFormatDefaults.fractionDigits = Math.max(0, Math.min(6, updates.fractionDigits));
  }
}

export function getCurrencyFormatDefaults(): CurrencyFormatDefaults {
  return { ...currencyFormatDefaults };
}

/**
 * Get currency symbol from ISO currency code
 * @param currencyCode ISO 4217 currency code (e.g., 'EUR', 'USD', 'GBP')
 * @returns Currency symbol (e.g., '€', '$', '£')
 */
export function getCurrencySymbol(currencyCode: string = 'EUR'): string {
  const symbols: Record<string, string> = {
    EUR: '€',
    USD: '$',
    GBP: '£',
    JPY: '¥',
    CHF: 'CHF',
    CAD: 'CA$',
    AUD: 'A$',
    CNY: '¥',
    INR: '₹',
    BRL: 'R$',
    RUB: '₽',
    KRW: '₩',
    MXN: 'MX$',
    SEK: 'kr',
    NOK: 'kr',
    DKK: 'kr',
    PLN: 'zł',
    CZK: 'Kč',
    HUF: 'Ft',
  };

  return symbols[currencyCode.toUpperCase()] || currencyCode;
}

/**
 * Format amount with currency using Intl.NumberFormat
 * @param amount The amount to format
 * @param currencyCode ISO 4217 currency code
 * @param locale Optional locale override.
 * @param fractionDigits Optional fraction digits override.
 * @returns Formatted currency string
 */
export function formatCurrency(
  amount: number,
  currencyCode?: string,
  locale?: string,
  fractionDigits?: number,
  /** Render an explicit locale-correct sign (+/−) for non-zero amounts. */
  signed?: boolean
): string {
  const effectiveCurrency = currencyCode || currencyFormatDefaults.defaultCurrency;
  const effectiveLocale = locale || currencyFormatDefaults.locale;
  const effectiveFractionDigits = fractionDigits ?? currencyFormatDefaults.fractionDigits;

  // Mirrors the Money.tsx / useCurrencyPartsFormatter guard: a malformed
  // currency code or out-of-range fraction digits makes the Intl.NumberFormat
  // constructor throw RangeError. Those siblings degrade to a bare `${val}`
  // number; this string path must degrade to the byte-identical text, or the
  // same bad input renders on one surface and crashes the page from the other
  // (e.g. the forecast odometer degrades while the chart axis beside it throws
  // into the error boundary).
  try {
    return new Intl.NumberFormat(effectiveLocale, {
      style: 'currency',
      currency: effectiveCurrency,
      minimumFractionDigits: effectiveFractionDigits,
      maximumFractionDigits: effectiveFractionDigits,
      signDisplay: signed ? 'exceptZero' : 'auto',
    }).format(amount);
  } catch {
    return `${amount}`;
  }
}

export interface PercentFormatOptions {
  /**
   * Fraction digits. Defaults to 1 — the house standard for gain/loss deltas.
   * Non-delta readouts (tax rates, allocation shares) pass their own.
   */
  digits?: number;
  /**
   * Minimum fraction digits, when a site wants "up to N" rather than a fixed N
   * (e.g. the rebalance weight column shows "7.5%" but "60%", not "60.0%").
   * Defaults to `digits`, i.e. a fixed count.
   */
  minDigits?: number;
  /** Render an explicit sign for non-zero values. See the sign note below. */
  signed?: boolean;
  /** Locale override; defaults to the configured app number-format locale. */
  locale?: string;
}

/**
 * Format a percentage with the app's number-format locale, so a percent uses
 * the same decimal separator as the money beside it (the `eu` setting renders
 * "1.234,56 €" for money, so its percentages must read "12,5%", not "12.5%").
 *
 * VALUE SCALE — the input is in PERCENT UNITS: `12.5` renders "12,5%". That
 * matches how every call site already holds its value, so the sweep never has
 * to rescale a value and risk a factor-of-100 money-adjacent bug. Call sites
 * that hold a fraction (0.125) pass `value * 100` at the boundary, exactly as
 * they already did before their `toFixed`.
 *
 * WHY `decimal` + a literal "%" RATHER THAN `style: 'percent'` — the app locale
 * here is a number-format proxy, not the user's language: `numberFormatToLocale`
 * maps the `eu` setting to `de-DE` purely to get "1.234,56" grouping, and the
 * app's actual languages are en/nl. `style: 'percent'` would import de-DE's
 * German typography along with the separator and render "12,5 %" with a
 * non-breaking space, which is wrong for both en and nl and would reflow the
 * tight delta chips. This is the same trap ForecastInnerRolling already
 * documents for month names ("numberFormatToLocale maps 'eu' -> 'de-DE', which
 * would yield German months"), so percent formatting avoids it the same way:
 * take the locale's number shape, not its unit typography. Keeping the value in
 * percent units also removes the /100 float boundary entirely.
 *
 * SIGN — `signed` maps to `signDisplay: 'exceptZero'`, the same convention
 * `formatCurrency` and `useCurrencyPartsFormatter` use for money. A gain/loss
 * percent and the amount beside it therefore agree about what a zero looks
 * like (both unsigned). This inherits the known `exceptZero` pitfall — a loss
 * small enough to round to zero prints "0,0%" and loses its minus — but it
 * inherits it *identically* to the money it sits next to, which is the point of
 * sharing the convention. Do not switch a single site to 'always'/'auto'
 * without moving its money sibling too.
 */
export function formatPercent(value: number, options: PercentFormatOptions = {}): string {
  const { digits = 1, minDigits, signed = false, locale } = options;
  const effectiveLocale = locale || currencyFormatDefaults.locale;

  // Same degradation contract as formatCurrency: out-of-range fraction digits
  // make the Intl.NumberFormat constructor throw RangeError, and a percent
  // readout must never take a card into the error boundary.
  try {
    return `${new Intl.NumberFormat(effectiveLocale, {
      minimumFractionDigits: minDigits ?? digits,
      maximumFractionDigits: digits,
      signDisplay: signed ? 'exceptZero' : 'auto',
    }).format(value)}%`;
  } catch {
    return `${value}%`;
  }
}

export interface CompactFormatResult {
  display: string;
  full: string;
  isCompact: boolean;
  /** formatToParts of `display` — feed to `<RollingNumber parts>` for the Money treatment. */
  parts: Intl.NumberFormatPart[];
}

const COMPACT_LENGTH_THRESHOLD = 9;

export function formatCurrencyCompact(
  amount: number,
  currencyCode?: string,
  locale?: string,
  fractionDigits?: number
): CompactFormatResult {
  const effectiveCurrency = currencyCode || currencyFormatDefaults.defaultCurrency;
  const effectiveLocale = locale || currencyFormatDefaults.locale;
  const effectiveFractionDigits = fractionDigits ?? currencyFormatDefaults.fractionDigits;

  const fullParts = new Intl.NumberFormat(effectiveLocale, {
    style: 'currency',
    currency: effectiveCurrency,
    minimumFractionDigits: effectiveFractionDigits,
    maximumFractionDigits: effectiveFractionDigits,
  }).formatToParts(amount);
  const full = fullParts.map((p) => p.value).join('');
  if (full.length <= COMPACT_LENGTH_THRESHOLD) {
    return { display: full, full, isCompact: false, parts: fullParts };
  }

  const compactParts = new Intl.NumberFormat(effectiveLocale, {
    style: 'currency',
    currency: effectiveCurrency,
    notation: 'compact',
    maximumFractionDigits: 1,
  }).formatToParts(amount);
  const compact = compactParts.map((p) => p.value).join('');
  const hasCompactNotation = compactParts.some((p) => p.type === 'compact');

  if (!hasCompactNotation || compact.length >= full.length) {
    return { display: full, full, isCompact: false, parts: fullParts };
  }

  return { display: compact, full, isCompact: true, parts: compactParts };
}
