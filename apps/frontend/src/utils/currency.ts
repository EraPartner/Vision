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

/**
 * Format amount with currency symbol (simpler version)
 * @param amount The amount to format
 * @param currencyCode ISO 4217 currency code
 * @returns Formatted string with currency symbol
 */
export function formatAmountWithSymbol(
  amount: number,
  currencyCode: string = 'EUR'
): string {
  const symbol = getCurrencySymbol(currencyCode);
  const formattedAmount = Math.abs(amount).toFixed(2);
  
  // For currencies that typically show symbol after the amount
  const symbolAfter = ['SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF'];
  
  if (symbolAfter.includes(currencyCode.toUpperCase())) {
    return `${formattedAmount} ${symbol}`;
  }
  
  return `${symbol}${formattedAmount}`;
}
