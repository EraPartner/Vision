/** Portfolio-only CSV/XLSX upload boundary. Bank-statement uploads stay CSV-only. */

import fs from "node:fs/promises";
import os from "node:os";
import crypto from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import multer from "multer";
import readExcelFile from "read-excel-file/node";
import { ValidationError } from "../middleware/errorHandler.ts";
import { csvUploadErrorTranslator } from "./csvUpload.ts";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_WORKBOOK_BYTES = 100 * 1024 * 1024;
const MAX_WORKBOOK_ENTRIES = 1000;
const MAX_WORKBOOK_CELLS = 500000;
const FILE_TYPE_ERROR = "File must be a CSV or XLSX workbook";

export type WorkbookNumber = { type: 'number', raw: string };
export type WorkbookCell = string|boolean|Date|WorkbookNumber|null;
export type PortfolioWorkbookSheet = { sheet: string, data: WorkbookCell[][], sourceFileHash: string };

export interface UploadedFileInfo {
  originalname?: string;
  mimetype?: string;
}

export function isLikelyPortfolioFile(file: UploadedFileInfo | undefined) {
  const name = file?.originalname?.toLowerCase() || "";
  const mime = file?.mimetype?.toLowerCase() || "";
  const commonMime = mime === "" || mime === "application/octet-stream";
  return (
    (name.endsWith(".csv") &&
      (commonMime ||
        mime.includes("csv") ||
        mime === "text/plain" ||
        mime === "application/vnd.ms-excel")) ||
    (name.endsWith(".xlsx") &&
      (commonMime ||
        mime ===
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))
  );
}

export const portfolioUpload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (
    _req: unknown,
    file: UploadedFileInfo,
    callback: (error: Error | null, acceptFile?: boolean) => void,
  ) => {
    if (!isLikelyPortfolioFile(file)) callback(new Error(FILE_TYPE_ERROR));
    else callback(null, true);
  },
});

export function portfolioUploadErrorTranslator(
  error: unknown,
  req: unknown,
  res: unknown,
  next: (error?: unknown) => void,
) {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    error.message === FILE_TYPE_ERROR
  )
    return next(new ValidationError(FILE_TYPE_ERROR));
  return csvUploadErrorTranslator(error, req, res, next);
}

/**
 * Multer's temporary names have no extension. Inspect bytes rather than paths.
 */
export async function detectPortfolioFileFormat(
  filePath: string | URL,
): Promise<"csv" | "xlsx"> {
  const file = await fs.open(filePath, "r");
  try {
    const signature = Buffer.alloc(8);
    await file.read(signature, 0, 8, 0);
    if (signature.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])))
      return "xlsx";
    if (
      signature.equals(
        Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      )
    ) {
      throw new ValidationError(
        "Legacy XLS workbooks are not supported. Export an XLSX workbook.",
      );
    }
    return "csv";
  } finally {
    await file.close();
  }
}

/**
 * Bound ZIP inflation before the parser decompresses XML. XLSX imports do not
 * extract files, execute macros, evaluate formulas, or follow external links.
 */
function assertBoundedWorkbook(bytes: Buffer) {
  if (bytes.length > MAX_UPLOAD_BYTES)
    throw new ValidationError("File size exceeds maximum of 50MB");
  let end = -1;
  for (
    let offset = bytes.length - 22;
    offset >= Math.max(0, bytes.length - 65557);
    offset--
  ) {
    if (
      bytes.readUInt32LE(offset) === 0x06054b50 &&
      offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length
    ) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new ValidationError("Invalid XLSX workbook archive");
  const entryCount = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryOffset = bytes.readUInt32LE(end + 16);
  if (
    bytes.readUInt16LE(end + 4) !== 0 ||
    bytes.readUInt16LE(end + 6) !== 0 ||
    entryCount !== bytes.readUInt16LE(end + 8) ||
    entryCount > MAX_WORKBOOK_ENTRIES ||
    directoryOffset + directorySize !== end
  ) {
    throw new ValidationError("Unsupported XLSX archive layout or size");
  }
  let offset = directoryOffset;
  let expanded = 0;
  const names = new Set<string>();
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50)
      throw new ValidationError("Invalid XLSX archive directory");
    const length =
      46 +
      bytes.readUInt16LE(offset + 28) +
      bytes.readUInt16LE(offset + 30) +
      bytes.readUInt16LE(offset + 32);
    const uncompressed = bytes.readUInt32LE(offset + 24);
    const compressed = bytes.readUInt32LE(offset + 20);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const method = bytes.readUInt16LE(offset + 10);
    const name = bytes
      .subarray(offset + 46, offset + 46 + bytes.readUInt16LE(offset + 28))
      .toString("utf8");
    expanded += uncompressed;
    if (
      offset + length > end ||
      expanded > MAX_WORKBOOK_BYTES ||
      uncompressed === 0xffffffff ||
      bytes.readUInt16LE(offset + 8) & 1 ||
      names.has(name)
    ) {
      throw new ValidationError(
        "XLSX workbook exceeds safe limits or contains unsupported entries",
      );
    }
    names.add(name);
    if (
      localOffset + 30 > directoryOffset ||
      bytes.readUInt32LE(localOffset) !== 0x04034b50 ||
      bytes.readUInt16LE(localOffset + 6) & 1 ||
      ![0, 8].includes(method) ||
      bytes.readUInt16LE(localOffset + 8) !== method
    ) {
      throw new ValidationError("Unsupported XLSX archive entry");
    }
    const dataOffset =
      localOffset +
      30 +
      bytes.readUInt16LE(localOffset + 26) +
      bytes.readUInt16LE(localOffset + 28);
    if (dataOffset + compressed > directoryOffset)
      throw new ValidationError("Invalid XLSX archive entry bounds");
    try {
      const payload = bytes.subarray(dataOffset, dataOffset + compressed);
      const inflated =
        method === 0
          ? payload
          : inflateRawSync(payload, {
              maxOutputLength: Math.max(1, uncompressed),
            });
      if (inflated.length !== uncompressed)
        throw new Error("Inconsistent size");
    } catch {
      throw new ValidationError(
        "XLSX archive entry does not match its declared size",
      );
    }
    offset += length;
  }
  if (
    offset !== end ||
    !names.has("xl/workbook.xml") ||
    !names.has("[Content_Types].xml")
  ) {
    throw new ValidationError("Uploaded archive is not an XLSX workbook");
  }
}

/**
 * Read typed dates and retain numeric XML text without converting identifiers
 * through a JavaScript number. The source byte hash and tagged cells give each
 * retained row deterministic workbook provenance.
 */
export async function readPortfolioWorkbook(
  filePath: string | URL,
): Promise<PortfolioWorkbookSheet[]> {
  const bytes = await fs.readFile(filePath);
  assertBoundedWorkbook(bytes);
  let sheets;
  try {
    sheets = await readExcelFile(bytes, {
      trim: false,
      parseNumber: (raw): WorkbookNumber => ({ type: "number", raw }),
    });
  } catch {
    throw new ValidationError("XLSX workbook could not be read safely");
  }
  const sourceFileHash = crypto
    .createHash("sha256")
    .update(bytes)
    .digest("hex");
  const cellCount = sheets.reduce(
    (cellTotal, sheet) =>
      cellTotal + sheet.data.reduce((count, row) => count + row.length, 0),
    0,
  );
  if (cellCount > MAX_WORKBOOK_CELLS)
    throw new ValidationError("XLSX workbook contains too many cells");
  // read-excel-file types date cells as `typeof Date`; at runtime they are
  // Date instances, which is what WorkbookCell declares.
  return sheets.map((sheet) => ({
    ...sheet,
    sourceFileHash,
  })) as PortfolioWorkbookSheet[];
}

/**
 * Reject unsupported workbook formats before a batch or staging rows are made.
 * Run the format adapter read-only so missing or ambiguous details cannot make
 * a batch first. The dynamic import avoids a static reader/adapter cycle.
 */
export async function assertPortfolioUploadSupported(
  filePath: string | URL,
  config: { format?: string },
) {
  if ((await detectPortfolioFileFormat(filePath)) !== "xlsx") return;
  if (config.format !== "saxo_transaction_history")
    throw new ValidationError(
      "XLSX portfolio imports require a supported Saxo transaction-history workbook",
    );
  const { parseSaxoTransactionHistory } =
    await import("../services/portfolioImportPipeline/saxoTransactionHistoryAdapter.ts");
  await parseSaxoTransactionHistory(
    filePath instanceof URL ? fileURLToPath(filePath) : filePath,
  );
}
