/**
 * Normalize a raw CSV transaction-type string to a canonical portfolio_txn_type.
 *
 * Resolution order: explicit user mapping → built-in aliases → the raw value if
 * it is already canonical. A present-but-unrecognized value is an ERROR, not a
 * silent fallback to the default: mislabeling a sell as a buy corrupts cost
 * basis, so unknown types route the row to review where the user maps them.
 * The default type is used only when there is no type value at all (e.g. the
 * CSV has no type column).
 */

import { VALID_PORTFOLIO_TXN_TYPES } from '../../lib/portfolioTxnTypes.js';

// Lowercased raw → canonical. Covers common English/Dutch/German brokerage labels.
/** @type {Record<string, string>} */
export const BUILTIN_TYPE_ALIASES = {
  buy: 'buy', purchase: 'buy', bought: 'buy', koop: 'buy', aankoop: 'buy', kauf: 'buy',
  sell: 'sell', sale: 'sell', sold: 'sell', verkoop: 'sell', verkauf: 'sell',
  dividend: 'dividend', div: 'dividend', distribution: 'dividend', dividenden: 'dividend',
  fee: 'fee', fees: 'fee', commission: 'fee', kosten: 'fee',
  tax: 'tax', taxes: 'tax', withholding: 'tax', belasting: 'tax',
  interest: 'interest', rente: 'interest',
  gift: 'gift',
  split: 'split',
};

/**
 * @param {unknown} raw
 * @param {{ typeMapping?: Record<string,string>, defaultType?: string }} [opts]
 * @returns {{ type?: string, error?: string }}
 */
export function normalizeType(raw, { typeMapping = {}, defaultType } = {}) {
  const trimmed = String(raw ?? '').trim();

  if (!trimmed) {
    if (defaultType && VALID_PORTFOLIO_TXN_TYPES.has(defaultType)) return { type: defaultType };
    return { error: 'missing transaction type' };
  }

  const lower = trimmed.toLowerCase();

  // User mapping wins. Match the raw value verbatim first, then case-insensitively.
  const mapped = typeMapping[trimmed] ?? typeMapping[lower];
  if (mapped) {
    if (!VALID_PORTFOLIO_TXN_TYPES.has(mapped)) {
      return { error: `mapped type "${mapped}" is not a valid portfolio transaction type` };
    }
    return { type: mapped };
  }

  const alias = BUILTIN_TYPE_ALIASES[lower];
  if (alias) return { type: alias };

  if (VALID_PORTFOLIO_TXN_TYPES.has(lower)) return { type: lower };

  return { error: `unknown transaction type "${trimmed}"` };
}
