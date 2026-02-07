/**
 * Currency utility functions
 */

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
 * @param locale The locale to use for formatting (defaults to 'en-US')
 * @returns Formatted currency string
 */
export function formatCurrency(
  amount: number,
  currencyCode: string = 'EUR',
  locale: string = 'en-US'
): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currencyCode,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
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
