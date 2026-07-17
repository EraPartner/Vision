/**
 * useCsvPreview — client-side CSV header detection + row preview.
 *
 * Reads the first PEEK_BYTES bytes of the file, parses headers and up to
 * MAX_PREVIEW_ROWS data rows using the given separator via csv-parse's
 * browser build — the same parser the backend importers use, so the preview
 * and the real import agree on quoting/newline edge cases.
 */

import { useEffect, useState } from "react";
import { parse } from "csv-parse/browser/esm/sync";
import { PEEK_BYTES } from "@/features/imports/csvSeparator";

const MAX_PREVIEW_ROWS = 5;

export interface CsvPreview {
  headers: string[];
  rows: string[][];
}

interface State {
  preview: CsvPreview | null;
  isLoading: boolean;
  error: string | null;
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
function parseRecords(text: string, sep: string): string[][] {
  const options = {
    delimiter: sep,
    record_delimiter: ["\r\n", "\n", "\r"],
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: true,
    trim: true,
  };
  try {
    return parse(text, options) as string[][];
  } catch (err) {
    if ((err as { code?: string }).code !== "CSV_QUOTE_NOT_CLOSED") throw err;
    return parse(`${text}"`, options) as string[][];
  }
}

/**
 * Parse raw text into a CsvPreview (headers + up to MAX_PREVIEW_ROWS rows).
 * Blank records are skipped; fields are trimmed (also inside quotes) and
 * records with a different field count than the header are skipped.
 */
function parseCsvText(text: string, sep: string): CsvPreview {
  const records = parseRecords(text, sep);
  if (records.length === 0) {
    return { headers: [], rows: [] };
  }

  const [headerRecord, ...rest] = records;
  const headers = headerRecord.map((field) => field.trim());

  const rows: string[][] = [];
  for (const record of rest) {
    if (rows.length >= MAX_PREVIEW_ROWS) break;
    if (record.length !== headers.length) continue;
    rows.push(record.map((field) => field.trim()));
  }

  return { headers, rows };
}

export function useCsvPreview(file: File | null, separator: string): State {
  const [state, setState] = useState<State>({
    preview: null,
    isLoading: false,
    error: null,
  });

  useEffect(() => {
    if (!file) {
      setState({ preview: null, isLoading: false, error: null });
      return;
    }

    let cancelled = false;
    setState({ preview: null, isLoading: true, error: null });

    const slice = file.slice(0, PEEK_BYTES);
    const reader = new FileReader();

    reader.onload = () => {
      if (cancelled) return;
      try {
        const text = reader.result as string;
        const preview = parseCsvText(text, separator);
        setState({ preview, isLoading: false, error: null });
      } catch {
        setState({ preview: null, isLoading: false, error: "parse_error" });
      }
    };

    reader.onerror = () => {
      if (!cancelled) {
        setState({ preview: null, isLoading: false, error: "read_error" });
      }
    };

    reader.readAsText(slice);

    return () => {
      cancelled = true;
      reader.abort();
    };
  }, [file, separator]);

  return state;
}
