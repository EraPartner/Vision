/**
 * IBAN validation utilities.
 * Mirrors: apps/backend/services/iban.py
 *
 * Public API:
 * - normalizeIban(iban) -> string
 * - isValidIban(iban) -> boolean
 */

/**
 * Normalize an IBAN by removing spaces and converting to uppercase.
 * @param {string} iban
 * @returns {string}
 */
export function normalizeIban(iban) {
  if (!iban || typeof iban !== 'string') return '';
  return iban.replace(/\s+/g, '').toUpperCase();
}

/**
 * Validate an IBAN using the mod-97 checksum algorithm.
 * @param {string} iban
 * @returns {boolean}
 */
export function isValidIban(iban) {
  if (!iban || typeof iban !== 'string') return false;

  const s = normalizeIban(iban);
  if (s.length < 4) return false;

  // Rearrange: move first 4 chars to end
  const rearranged = s.slice(4) + s.slice(0, 4);

  // Convert letters to numbers (A=10, B=11, ..., Z=35)
  let numStr = '';
  for (const ch of rearranged) {
    if (ch >= '0' && ch <= '9') {
      numStr += ch;
    } else if (ch >= 'A' && ch <= 'Z') {
      numStr += (ch.charCodeAt(0) - 'A'.charCodeAt(0) + 10).toString();
    } else {
      return false; // Invalid character
    }
  }

  // Compute mod 97 in chunks to avoid BigInt for most cases
  let remainder = 0;
  const chunkSize = 9;
  for (let i = 0; i < numStr.length; i += chunkSize) {
    const piece = numStr.slice(i, i + chunkSize);
    remainder = parseInt(remainder.toString() + piece, 10) % 97;
  }

  return remainder === 1;
}
