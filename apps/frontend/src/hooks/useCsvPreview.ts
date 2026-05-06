/**
 * useCsvPreview — client-side CSV header detection + row preview.
 *
 * Reads the first PEEK_BYTES bytes of the file, parses headers and up to
 * MAX_PREVIEW_ROWS data rows using the given separator. Supports
 * double-quote escaping.
 */

import { useEffect, useState } from "react";

const PEEK_BYTES = 16_384; // 16 KB — enough for headers + several rows
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
 * Parse a single CSV line into fields, respecting double-quoted values.
 */
function parseCsvLine(line: string, sep: string): string[] {
  const result: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          // Escaped double-quote
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === sep) {
        result.push(field.trim());
        field = "";
      } else {
        field += ch;
      }
    }
  }

  result.push(field.trim());
  return result;
}

/**
 * Split raw CSV text into logical records, respecting quoted fields that may
 * contain embedded newlines. Returns one string per record.
 */
function splitCsvRecords(text: string): string[] {
  const records: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          current += '""';
          i++;
        } else {
          inQuotes = false;
          current += ch;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        current += ch;
      } else if (ch === '\r' && text[i + 1] === '\n') {
        records.push(current);
        current = "";
        i++;
      } else if (ch === '\n' || ch === '\r') {
        records.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }

  if (current.length > 0) records.push(current);
  return records;
}

/**
 * Parse raw text into a CsvPreview (headers + up to MAX_PREVIEW_ROWS rows).
 * Records that are blank or produce a different number of fields than the
 * header are skipped.
 */
function parseCsvText(text: string, sep: string): CsvPreview {
  const records = splitCsvRecords(text);

  const headerIdx = records.findIndex((r) => r.trim().length > 0);
  if (headerIdx === -1) {
    return { headers: [], rows: [] };
  }

  const headers = parseCsvLine(records[headerIdx], sep);
  const colCount = headers.length;

  const rows: string[][] = [];
  for (let i = headerIdx + 1; i < records.length && rows.length < MAX_PREVIEW_ROWS; i++) {
    const record = records[i].trim();
    if (!record) continue;
    const fields = parseCsvLine(records[i], sep);
    if (fields.length === colCount) {
      rows.push(fields);
    }
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
