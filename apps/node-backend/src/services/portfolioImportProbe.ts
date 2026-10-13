/** Read-only statement detection and preview. No batches or financial records are created. */
import fs from "node:fs/promises";
import { parse } from "csv-parse/sync";
import readExcelFile from "read-excel-file/node";
import * as XLSX from "xlsx";
import {
  detectPortfolioImportRecords,
  detectIbkrFundingWorkbook,
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
  if (name.endsWith(".xls") || name.endsWith(".xlsx")) {
    const xls = bytes
      .subarray(0, 8)
      .equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    const xlsx = bytes
      .subarray(0, 4)
      .equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    if (!xls && !xlsx) return undefined;
    if (xlsx) assertBoundedWorkbook(bytes);
    const workbook = XLSX.read(bytes, {
      type: "buffer",
      cellDates: false,
      cellFormula: true,
      cellText: false,
      bookVBA: true,
      WTF: true,
    });
    const funding = detectIbkrFundingWorkbook(workbook, XLSX.utils);
    if (funding) return funding;
    if (
      xls ||
      workbook.SheetNames.some((sheet) =>
        ["Deposit", "Withdrawal"].includes(sheet),
      )
    )
      return undefined;
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
    }) as string[][],
  );
}

export async function probePortfolioImport(
  filePath: string,
  filename: string,
  options: PortfolioProbeOptions,
): Promise<PortfolioImportProbe> {
  const stat = await fs.stat(filePath);
  if (stat.size > 50 * 1024 * 1024)
    throw new ValidationError("File size exceeds maximum of 50MB");
  const bytes = await fs.readFile(filePath);
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
      (input, config) => parse(input, config) as string[][],
    );
  } catch {
    previewError = "parse_error";
  }
  return { detected, detectionError, preview, previewError, separator };
}
