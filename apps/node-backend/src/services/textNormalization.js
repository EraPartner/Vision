/**
 * Text Normalization Service
 * Mirrors: apps/backend/services/text_normalization_service.py
 */

const RECIPIENT_PREFIXES = [
  'Payment from ', 'Payment to ', 'From ', 'To ',
  'Transfer from ', 'Transfer to ', 'Sent to ', 'Received from ',
];

const KBC_RECIPIENT_PREFIXES = [
  'IBAN: ', 'Virement: ', 'Virement automatique: ',
  'Domiciliation: ', 'Creditrente ',
];

const KBC_TRANSACTION_TYPES = [
  'GELDOPNEMING', 'OVERSCHRIJVING', 'DOMICILIËRING', 'DOMICILIERING',
  'AANKOOP', 'TERUGBETALING', 'STORTING', 'AFHALING', 'BETALING',
  'RETRO-SEPA', 'SEPA', 'EUROPESE', 'INTERNATIONALE', 'CREDITRENTE',
];

const KBC_SEPARATORS = [' VIA ', ' NAAR ', ' VAN ', ' MET ', ' DOOR ', ' OP ', ' OM '];

export function cleanRecipientName(recipient) {
  if (!recipient) return recipient;
  let cleaned = recipient.trim();
  for (const prefix of RECIPIENT_PREFIXES) {
    if (cleaned.toLowerCase().startsWith(prefix.toLowerCase())) {
      cleaned = cleaned.slice(prefix.length).trim();
      break;
    }
  }
  return cleaned;
}

export function cleanKbcRecipientName(recipient) {
  if (!recipient) return recipient;
  recipient = recipient.trim();
  const upper = recipient.toUpperCase();

  for (const type of KBC_TRANSACTION_TYPES) {
    if (upper.startsWith(type)) {
      return type.charAt(0) + type.slice(1).toLowerCase();
    }
  }

  for (const sep of KBC_SEPARATORS) {
    if (upper.includes(sep)) {
      const first = recipient.split(new RegExp(sep, 'i'))[0].trim();
      return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
    }
  }

  const firstWord = recipient.split(/\s+/)[0] || recipient;
  if (firstWord.length > 3) {
    return firstWord.charAt(0).toUpperCase() + firstWord.slice(1).toLowerCase();
  }

  const words = recipient.split(/\s+/).slice(0, 3);
  if (words.length) {
    const phrase = words.join(' ');
    return phrase.charAt(0).toUpperCase() + phrase.slice(1).toLowerCase();
  }
  return recipient;
}

export function normalizeToUppercase(name) {
  if (!name) return name;
  if (typeof name !== 'string') throw new Error(`Name must be a string, got ${typeof name}`);
  return name.trim().toUpperCase();
}

/**
 * Normalize a name for uniqueness matching by sorting all non-initial tokens.
 * Mirrors Python's normalize_name_for_matching() exactly.
 *
 * This creates a canonical form that:
 * - Filters out single-letter alphabetic tokens (initials like "F", "J")
 * - Keeps all other tokens including numbers (e.g., "STORE 1" vs "STORE 2")
 * - Sorts all remaining tokens alphabetically for consistent ordering
 * - Removes punctuation
 *
 * Examples:
 * - "John Smith" → "JOHN SMITH"
 * - "Smith John" → "JOHN SMITH" (sorted)
 * - "John F Doe" → "DOE JOHN" (F filtered out as initial)
 * - "John F Kennedy" → "JOHN KENNEDY" (F filtered)
 * - "Test Recipient 1" → "1 RECIPIENT TEST" (1 kept, sorted)
 *
 * @param {string} name - The recipient name to normalize for matching
 * @returns {string} The normalized name with all substantial tokens sorted alphabetically (uppercase)
 */
export function normalizeForMatching(name) {
  if (!name) return name;

  // Normalize to uppercase and strip
  let normalized = name.trim().toUpperCase();

  // Remove common punctuation (periods, commas)
  normalized = normalized.replace(/\./g, ' ').replace(/,/g, ' ');

  // Split into tokens and filter empty strings
  const tokens = normalized.split(/\s+/).filter(Boolean);

  if (!tokens.length) return '';

  // Single word name - just return it
  if (tokens.length === 1) return tokens[0];

  // Filter out single-LETTER tokens (initials like "F", "J")
  // Keep single-digit tokens as they're meaningful (e.g., "STORE 1" vs "STORE 2")
  // Keep any multi-character tokens
  const substantial = tokens.filter(t => t.length > 1 || !/^[A-Z]$/.test(t));

  // If we have no substantial tokens (all were initials), return sorted originals
  if (!substantial.length) return tokens.sort().join(' ');

  // Sort all substantial tokens alphabetically for consistent ordering
  return substantial.sort().join(' ');
}

export function formatAmountString(amountStr) {
  if (!amountStr) return null;
  amountStr = amountStr.trim();
  const commaPos = amountStr.lastIndexOf(',');
  const dotPos = amountStr.lastIndexOf('.');
  if (commaPos > dotPos) {
    amountStr = amountStr.replace(/\./g, '').replace(',', '.');
  } else {
    amountStr = amountStr.replace(/,/g, '');
  }
  const val = parseFloat(amountStr);
  return isNaN(val) ? null : val;
}

export function extractCurrencyCode(currencyStr) {
  if (!currencyStr) return null;
  const parts = currencyStr.split(/\s+/);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (/^[A-Za-z]{3}$/.test(parts[i])) return parts[i].toUpperCase();
  }
  if (/^[A-Za-z]{3}$/.test(currencyStr)) return currencyStr.toUpperCase();
  return null;
}
