/** Read-only statement detection and preview. No batches or financial records are created. */
import fs from "node:fs/promises";
import { parse } from "csv-parse/sync";
import readExcelFile from "read-excel-file/node";
import {
  detectPortfolioImportRecords,
  type DetectedPortfolioImport,
} from "@vision/shared-utils/portfolio-import-detection";
import {
  decodePreviewBytes,
  parseCsvText,
  type CsvPreview,
} from "@vision/shared-utils/csv-preview";
import {
  detectSeparator,
  PEEK_BYTES,
} from "@vision/shared-utils/csv-separator";
import { assertBoundedWorkbook } from "../lib/portfolioUpload.ts";
import { ValidationError } from "../middleware/errorHandler.ts";

export interface PortfolioProbeOptions {
  separator?: string | undefined;
  encoding: "utf-8" | "latin1" | "windows-1252";
  skipRows: number;
}
export interface PortfolioImportProbe {
  detected: DetectedPortfolioImport | null;
  detectionError: "parse_error" | null;
  preview: CsvPreview | null;
  previewError: "parse_error" | null;
  separator: string;
}

async function detect(
  bytes: Buffer,
  filename: string,
): Promise<DetectedPortfolioImport | undefined> {
  const name = filename.toLowerCase();
  if (name.endsWith(".xlsx")) {
    const xlsx = bytes
      .subarray(0, 4)
      .equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    if (!xlsx) return undefined;
    assertBoundedWorkbook(bytes);
    const sheets = await readExcelFile(bytes, { parseNumber: (raw) => raw });
    const matches = sheets
      .map((sheet) => detectPortfolioImportRecords(sheet.data))
      .filter((match) => match !== undefined);
    return matches.length === 1 && matches[0]?.source === "saxo"
      ? matches[0]
      : undefined;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder("windows-1252").decode(bytes);
  }
  // Detection includes every identity; a preview prefix cannot select a destination account.
  return detectPortfolioImportRecords(
    parse(text, {
      bom: true,
      relax_column_count: true,
      skip_empty_lines: true,
    }),
  );
}

export async function probePortfolioImport(
  filePath: string,
  filename: string,
  options: PortfolioProbeOptions,
): Promise<PortfolioImportProbe> {
  // Size check and read through one handle, so the file read is the file measured.
  const file = await fs.open(filePath, "r");
  let bytes: Buffer;
  try {
    if ((await file.stat()).size > 50 * 1024 * 1024)
      throw new ValidationError("File size exceeds maximum of 50MB");
    bytes = await file.readFile();
  } finally {
    await file.close();
  }
  let detected: DetectedPortfolioImport | null = null;
  let detectionError: "parse_error" | null = null;
  try {
    detected = (await detect(bytes, filename)) ?? null;
  } catch {
    detectionError = "parse_error";
  }
  let preview: CsvPreview | null = null;
  let previewError: "parse_error" | null = null;
  let separator = options.separator ?? ",";
  try {
    const prefix = bytes.subarray(0, PEEK_BYTES);
    const text = decodePreviewBytes(
      prefix,
      options.encoding,
      bytes.length > prefix.length,
    );
    // Header chips use the browser's UTF-8 readAsText sniff independent of the pinned encoding.
    if (options.separator === undefined) {
      const sniffed = new TextDecoder("utf-8").decode(prefix);
      separator = detectSeparator(
        sniffed.split(/\r\n|\r|\n/).find((line) => line.trim().length > 0) ??
          "",
      );
    }
    preview = parseCsvText(
      text,
      separator,
      options.skipRows,
      (input, config) => parse(input, config),
    );
  } catch {
    previewError = "parse_error";
  }
  return { detected, detectionError, preview, previewError, separator };
}
