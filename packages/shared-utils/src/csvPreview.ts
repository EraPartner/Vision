/** Exact CSV preview semantics shared between web and read-only native probe. */
export interface CsvPreviewOptions {
  delimiter: string;
  record_delimiter: string[];
  relax_column_count: boolean;
  relax_quotes: boolean;
  skip_empty_lines: boolean;
  trim: boolean;
  from_line: number;
}
export type CsvPreviewParser = (
  text: string,
  options: CsvPreviewOptions,
) => string[][];
const MAX_PREVIEW_ROWS = 5;

export interface CsvPreview {
  headers: string[];
  rows: string[][];
}

/**
 * Parse the peeked text into records. Because only the first PEEK_BYTES of
 * the file are read, the text can end mid-record — even inside an open
 * quote, which csv-parse rejects (CSV_QUOTE_NOT_CLOSED) despite
 * relax_quotes. Retry once with a closing quote appended: the truncated
 * record then parses as if the quote closed at the cut, and the column-count
 * check below drops it when it lost columns (matching the previous
 * hand-rolled parser's behavior).
 */
function parseRecords(
  text: string,
  sep: string,
  skipRows: number,
  parse: CsvPreviewParser,
): string[][] {
  const options = {
    delimiter: sep,
    record_delimiter: ["\r\n", "\n", "\r"],
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: true,
    trim: true,
    from_line: skipRows + 1,
  };
  try {
    return parse(text, options);
  } catch (err) {
    if ((err as { code?: string }).code !== "CSV_QUOTE_NOT_CLOSED") throw err;
    return parse(`${text}"`, options);
  }
}

/**
 * Parse raw text into a CsvPreview (headers + up to MAX_PREVIEW_ROWS rows).
 * Blank records are skipped; fields are trimmed (also inside quotes) and
 * records with a different field count than the header are skipped.
 */
export function parseCsvText(
  text: string,
  sep: string,
  skipRows: number,
  parse: CsvPreviewParser,
): CsvPreview {
  const records = parseRecords(
    text.replace(/^\uFEFF/, ""),
    sep,
    skipRows,
    parse,
  );
  const [headerRecord, ...rest] = records;
  if (headerRecord === undefined) {
    return { headers: [], rows: [] };
  }

  const headers = headerRecord.map((field) => field.trim());

  const rows: string[][] = [];
  for (const record of rest) {
    if (rows.length >= MAX_PREVIEW_ROWS) break;
    if (record.length !== headers.length) continue;
    rows.push(record.map((field) => field.trim()));
  }

  return { headers, rows };
}

export function decodePreviewBytes(
  buffer: ArrayBuffer | Uint8Array,
  encoding: string,
  partial: boolean,
): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const normalized = encoding.trim().toLowerCase();
  const latin1 = () =>
    Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  if (["latin1", "latin-1", "iso-8859-1"].includes(normalized)) return latin1();
  if (normalized === "windows-1252")
    return new TextDecoder("windows-1252").decode(bytes);
  if (normalized && normalized !== "utf-8" && normalized !== "utf8")
    throw new Error("Unsupported CSV encoding");
  // A preview slice can end inside a valid UTF-8 character. Keep that tail
  // pending so it does not incorrectly trigger the importer's Latin-1 fallback.
  const text = new TextDecoder("utf-8").decode(bytes, { stream: partial });
  return text.includes("\uFFFD") ? latin1() : text;
}
