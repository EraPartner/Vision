/**
 * CSV delimiter sniffing shared by the import header preview and column mappers.
 */

export const PEEK_BYTES = 16_384;
export const CANDIDATE_SEPARATORS = [",", ";", "\t", "|"];

// Human-friendly label for a separator char (tab is otherwise invisible).
export const SEPARATOR_LABELS: Record<string, string> = {
  ",": ",",
  ";": ";",
  "\t": "⇥",
  "|": "|",
};

/**
 * Pick the most likely delimiter from a header line: the candidate that splits
 * it into the most columns. Ties keep the earlier candidate (comma first).
 */
export function detectSeparator(headerLine: string): string {
  let best = ",";
  let bestCount = 1;
  for (const sep of CANDIDATE_SEPARATORS) {
    const count = headerLine.split(sep).length;
    if (count > bestCount) {
      best = sep;
      bestCount = count;
    }
  }
  return best;
}
