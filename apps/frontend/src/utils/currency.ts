/**
 * Currency utility functions
 */

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
  fractionDigits?: number
): string {
  const effectiveCurrency = currencyCode || currencyFormatDefaults.defaultCurrency;
  const effectiveLocale = locale || currencyFormatDefaults.locale;
  const effectiveFractionDigits = fractionDigits ?? currencyFormatDefaults.fractionDigits;

  return new Intl.NumberFormat(effectiveLocale, {
    style: 'currency',
    currency: effectiveCurrency,
    minimumFractionDigits: effectiveFractionDigits,
    maximumFractionDigits: effectiveFractionDigits,
  }).format(amount);
}

export interface CompactFormatResult {
  display: string;
  full: string;
  isCompact: boolean;
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

  const full = formatCurrency(amount, effectiveCurrency, effectiveLocale, effectiveFractionDigits);
  if (full.length <= COMPACT_LENGTH_THRESHOLD) {
    return { display: full, full, isCompact: false };
  }

  const compact = new Intl.NumberFormat(effectiveLocale, {
    style: 'currency',
    currency: effectiveCurrency,
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(amount);

  if (compact.length >= full.length) {
    return { display: full, full, isCompact: false };
  }

  return { display: compact, full, isCompact: true };
}

