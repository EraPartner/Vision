/**
 * Bank statement detection shared by the backend adapters and the budget
 * import card (ADR-268). Each signature reads the head of a decoded CSV file;
 * the backend adapters' `detect` delegate here, so the web card and the
 * importers cannot disagree about which format a file is.
 */

/** Built-in bank adapters, in registry (detection precedence) order. */
export const BANK_IMPORT_FORMATS = [
  "belfius",
  "revolut",
  "ing",
  "bnp",
  "kbc",
  "vision",
  "sabb",
  "wise",
] as const;
export type BankImportFormat = (typeof BANK_IMPORT_FORMATS)[number];

/** Bytes of a statement's head the detectors need; covers every signature. */
export const BANK_DETECTION_PEEK_BYTES = 65_536;

const BELFIUS_MIN_FIELDS = 12;

// Vision's own export column order (transactionExport.ts). Detection requires
// this exact ordered prefix: word-substring matching used to auto-route any
// unknown bank CSV whose header merely contained "date"/"amount"/"bank
// account"/"recipient" to this adapter. Columns after Currency (Balance,
// Category, Comment, Tags, Running Balance) may vary so older or extended
// exports still detect.
const VISION_EXPORT_HEADER_PREFIX = [
  "date",
  "bank account",
  "recipient",
  "memo",
  "amount",
  "currency",
];

function lines(sample: string): string[] {
  return sample.split(/\r\n|\r|\n/);
}

function firstLine(sample: string): string {
  return sample.split("\n")[0] || "";
}

const SIGNATURES: Record<BankImportFormat, (sample: string) => boolean> = {
  belfius: (sample) => {
    const head = lines(sample).slice(0, 15);
    return (
      head.some((line) => line.includes("Laatste saldo;")) ||
      head.some(
        (line) =>
          /^BE\d{2}/.test(line.trim()) &&
          line.split(";").length >= BELFIUS_MIN_FIELDS,
      )
    );
  },
  revolut: (sample) => {
    const lower = firstLine(sample).toLowerCase();
    return (
      lower.startsWith("type,") &&
      lower.includes("completed date") &&
      lower.includes("state")
    );
  },
  ing: (sample) =>
    lines(sample)
      .slice(0, 3)
      .some(
        (line) =>
          line.includes("Omzetnummer") && line.includes("Detail van de omzet"),
      ),
  bnp: (sample) =>
    lines(sample)
      .slice(0, 3)
      .some(
        (line) =>
          line.includes("Volgnummer") &&
          line.includes("Uitvoeringsdatum") &&
          line.includes("Valuta rekening"),
      ),
  kbc: (sample) => {
    const head = lines(sample).slice(0, 5);
    return (
      head.some((line) => line.startsWith("Rekeningnummer")) ||
      head.some((line) => line.includes("Vrije Mededeling"))
    );
  },
  vision: (sample) => {
    const cols = firstLine(sample)
      .trim()
      .toLowerCase()
      .split(",")
      .map((col) => col.trim());
    return VISION_EXPORT_HEADER_PREFIX.every((name, i) => cols[i] === name);
  },
  sabb: (sample) => {
    const lower = firstLine(sample).toLowerCase();
    return lower.includes("transaction date") && lower.includes("amount(sar)");
  },
  wise: (sample) => {
    const lower = firstLine(sample).toLowerCase();
    return (
      lower.includes("direction") &&
      lower.includes("target amount") &&
      lower.includes("source amount")
    );
  },
};

/** Whether `sample` (the decoded head of a file) looks like `format`'s export. */
export function matchesBankImportFormat(
  format: BankImportFormat,
  sample: string | null | undefined,
): boolean {
  if (!sample) return false;
  // Exporters such as Excel prepend a UTF-8 BOM; it is never part of a header.
  return SIGNATURES[format](sample.replace(/^﻿/, ""));
}

/**
 * Every built-in format whose signature matches, in registry order. Several
 * can match (an ING header also starts with KBC's "Rekeningnummer"); the
 * registry order is the precedence the importers have always used.
 */
export function detectBankImportFormats(
  sample: string | null | undefined,
): BankImportFormat[] {
  return BANK_IMPORT_FORMATS.filter((format) =>
    matchesBankImportFormat(format, sample),
  );
}

/** The column mapping of a saved custom parser, as the import card stores it. */
export interface SavedBankParserColumns {
  dateColumn: string;
  recipientColumn: string;
  amountColumn: string;
  memoColumn?: string | undefined;
}

/**
 * Whether a saved custom parser fits a file: every column it maps is present
 * in the header row read with that parser's own separator, encoding and
 * skipped rows. Headers are compared trimmed, as the column mapper shows them.
 */
export function matchesSavedBankParser(
  headers: readonly string[],
  columns: SavedBankParserColumns,
): boolean {
  const present = new Set(headers.map((header) => header.trim()));
  const mapped = [
    columns.dateColumn,
    columns.recipientColumn,
    columns.amountColumn,
    columns.memoColumn ?? "",
  ]
    .map((column) => column.trim())
    .filter(Boolean);
  return mapped.length >= 3 && mapped.every((column) => present.has(column));
}

export type BankImportDetection =
  | { kind: "detected"; source: string }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "none" };

/**
 * Decide the import source from what matched. Source keys are the card's
 * select values: an adapter name, or `saved:<id>` for a saved parser.
 *
 * - Built-in formats only: the first in registry order wins, exactly as the
 *   backend's `detectBank` resolves an overlap.
 * - One saved parser only: it wins.
 * - A built-in format and a saved parser, or several saved parsers: the file
 *   fits more than one setup the user owns, so nothing is guessed.
 */
export function resolveBankImportDetection(
  formats: readonly BankImportFormat[],
  savedSources: readonly string[],
): BankImportDetection {
  const [format] = formats;
  if (savedSources.length === 0)
    return format ? { kind: "detected", source: format } : { kind: "none" };
  if (!format && savedSources.length === 1)
    return { kind: "detected", source: savedSources[0] ?? "" };
  return {
    kind: "ambiguous",
    candidates: [...(format ? [format] : []), ...savedSources],
  };
}
