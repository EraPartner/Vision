/** Portfolio-only statement upload boundary. Bank-statement uploads stay CSV-only. */

import fs from "node:fs/promises";
import os from "node:os";
import crypto from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import multer from "multer";
import readExcelFile from "read-excel-file/node";
import * as XLSX from "xlsx";
import { ValidationError } from "../middleware/errorHandler.ts";
import { csvUploadErrorTranslator } from "./csvUpload.ts";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_WORKBOOK_BYTES = 100 * 1024 * 1024;
const MAX_WORKBOOK_ENTRIES = 1000;
const MAX_WORKBOOK_CELLS = 500000;
const FILE_TYPE_ERROR = "File must be a CSV, XLSX or supported XLS workbook";

export type WorkbookNumber = { type: "number"; raw: string };
export type WorkbookCell = string | boolean | Date | WorkbookNumber | null;
export type PortfolioWorkbookSheet = {
  sheet: string;
  data: WorkbookCell[][];
  sourceFileHash: string;
};
export type FundingWorkbookCell =
  | { type: "text"; value: string }
  | { type: "number"; value: string }
  | { type: "boolean"; value: boolean }
  | null;
export interface FundingWorkbookSheet {
  sheet: string;
  data: FundingWorkbookCell[][];
  sourceFileHash: string;
  sourceFormat: "xls" | "xlsx";
}

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
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")) ||
    (name.endsWith(".xls") &&
      (commonMime || mime === "application/vnd.ms-excel"))
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
): Promise<"csv" | "xls" | "xlsx"> {
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
      return "xls";
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
 * The native IBKR funding export is binary XLS. Read it separately so the
 * existing Saxo XML-number reader remains unchanged. Formulas, hidden sheets
 * and macro content cannot become primary financial evidence.
 */
export async function readIbkrFundingWorkbook(
  filePath: string | URL,
): Promise<FundingWorkbookSheet[]> {
  const format = await detectPortfolioFileFormat(filePath);
  if (format !== "xls" && format !== "xlsx")
    throw new ValidationError(
      "IBKR funding history requires an original XLS or XLSX workbook",
    );
  const bytes = await fs.readFile(filePath);
  if (bytes.length > MAX_UPLOAD_BYTES)
    throw new ValidationError("File size exceeds maximum of 50MB");
  if (format === "xlsx") assertBoundedWorkbook(bytes);
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(bytes, {
      type: "buffer",
      cellDates: false,
      cellFormula: true,
      cellText: false,
      bookVBA: true,
      WTF: true,
    });
  } catch {
    throw new ValidationError("IBKR funding workbook could not be read safely");
  }
  if (
    workbook.vbaraw ||
    workbook.SheetNames.length > 2 ||
    workbook.SheetNames.length === 0 ||
    new Set(workbook.SheetNames).size !== workbook.SheetNames.length ||
    workbook.Workbook?.Sheets?.some((sheet) => sheet.Hidden)
  )
    throw new ValidationError(
      "IBKR funding workbook contains unsupported sheets or macros",
    );
  const sourceFileHash = crypto
    .createHash("sha256")
    .update(bytes)
    .digest("hex");
  let cellCount = 0;
  return workbook.SheetNames.map((sheet) => {
    const source = workbook.Sheets[sheet];
    const reference = source["!ref"];
    if (
      !reference ||
      (source["!type"] && source["!type"] !== "sheet") ||
      source["!merges"]?.length
    )
      throw new ValidationError(
        "IBKR funding workbook contains an unsupported sheet layout",
      );
    const range = XLSX.utils.decode_range(reference);
    cellCount += (range.e.r + 1) * (range.e.c + 1);
    if (
      range.s.r !== 0 ||
      range.s.c !== 0 ||
      range.e.r < 0 ||
      range.e.c < 0 ||
      range.e.c > 99 ||
      cellCount > MAX_WORKBOOK_CELLS
    )
      throw new ValidationError(
        "IBKR funding workbook exceeds safe cell limits",
      );
    for (const [coordinate, cell] of Object.entries(source)) {
      if (coordinate.startsWith("!")) continue;
      const location = XLSX.utils.decode_cell(coordinate);
      if (
        !/^[A-Z]+[1-9]\d*$/.test(coordinate) ||
        location.r > range.e.r ||
        location.c > range.e.c ||
        cell.f != null ||
        cell.F != null
      )
        throw new ValidationError(
          "IBKR funding workbook contains formulas or cells outside its declared range",
        );
    }
    const data: FundingWorkbookCell[][] = [];
    for (let row = 0; row <= range.e.r; row++) {
      const values: FundingWorkbookCell[] = [];
      for (let column = 0; column <= range.e.c; column++) {
        const cell = source[XLSX.utils.encode_cell({ r: row, c: column })];
        if (cell?.f != null || cell?.F != null)
          throw new ValidationError(
            "IBKR funding workbook formulas are not supported",
          );
        if (!cell || cell.t === "z") values.push(null);
        else if (cell.t === "s")
          values.push({ type: "text", value: String(cell.v) });
        else if (cell.t === "n" && Number.isFinite(cell.v))
          values.push({ type: "number", value: String(cell.v) });
        else if (cell.t === "b")
          values.push({ type: "boolean", value: Boolean(cell.v) });
        else
          throw new ValidationError(
            "IBKR funding workbook contains an unsupported cell type",
          );
      }
      data.push(values);
    }
    return { sheet, data, sourceFileHash, sourceFormat: format };
  });
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
  const format = await detectPortfolioFileFormat(filePath);
  if (config.format === "ibkr_funding_history") {
    const { parseIbkrFundingHistory } =
      await import("../services/portfolioImportPipeline/ibkrFundingHistoryAdapter.ts");
    await parseIbkrFundingHistory(
      filePath instanceof URL ? fileURLToPath(filePath) : filePath,
    );
    return;
  }
  if (format === "csv") return;
  if (format !== "xlsx" || config.format !== "saxo_transaction_history")
    throw new ValidationError(
      "Portfolio workbooks require supported Saxo XLSX transaction history or IBKR XLS/XLSX funding history",
    );
  const { parseSaxoTransactionHistory } =
    await import("../services/portfolioImportPipeline/saxoTransactionHistoryAdapter.ts");
  await parseSaxoTransactionHistory(
    filePath instanceof URL ? fileURLToPath(filePath) : filePath,
  );
}
