export function neutralizeCsvFormula(value: string): string;
export function quoteCsvValue(value: string): string;
export function escapeCsvValue(
  value: unknown,
  options?: { treatNumericStringsAsSafe?: boolean },
): string;
