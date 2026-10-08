/** Native Client Portal Transaction Status & History funding workbook. */
import { createHash } from "node:crypto";
import { readIbkrFundingWorkbook } from "../../lib/portfolioUpload.ts";
import type { FundingWorkbookCell } from "../../lib/portfolioUpload.ts";
import { toDecimal } from "../../lib/money.ts";
import { ValidationError } from "../../middleware/errorHandler.ts";
import type { IbkrFundingEvidence } from "../../repositories/portfolioImportCashRepository.ts";
import type { ParsedPortfolioRows } from "./portfolioGenericAdapter.ts";

type FundingSheet = "Deposit" | "Withdrawal";
const COLUMNS: Record<FundingSheet, string[]> = {
  Deposit: [
    "Request Date",
    "Reference Number",
    "Method",
    "Account ID",
    "Account Title",
    "Delivering Institution",
    "From Account Number",
    "Routing Number",
    "Date Received",
    "Date Available for Trading",
    "Date Available for Withdrawal - Original Bank",
    "Date Available for Withdrawal - Other Bank",
    "Amount",
    "Status",
  ],
  Withdrawal: [
    "Request Date",
    "Reference Number",
    "Method",
    "Account ID",
    "Account Title",
    "Receiving Institution",
    "Date Processed",
    "Amount",
    "Status",
  ],
};

interface IbkrFundingSheetDescriptor {
  sheet: FundingSheet;
  header_row: 1;
  source_columns: string[];
  records: {
    row_number: number;
    record_hash: string;
    source_id: string;
    source_account_identity: string;
  }[];
}
/** Retained batch context that later authenticates each staged funding row. */
export interface IbkrFundingSourceContext {
  version: 1;
  source_file_hash: string;
  source_format: "xls" | "xlsx";
  source_account_identities: string[];
  sheets: IbkrFundingSheetDescriptor[];
  record_hashes: string[];
}
/** The literal workbook row persisted as `raw_data`. */
interface IbkrFundingEnvelope {
  schema: "ibkr_funding_workbook_row";
  version: 1;
  source_file_hash: string;
  source_format: "xls" | "xlsx";
  sheet: string;
  header_row: 1;
  row_number: number;
  columns: string[];
  cells: FundingWorkbookCell[];
}
type FundingRecordEvidence = Omit<
  IbkrFundingEvidence,
  "rawData" | "recordHash" | "sourceFileHash" | "sourceFormat"
>;

const hash = (raw: string): string =>
  createHash("sha256").update(raw, "utf8").digest("hex");
const validHash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const equal = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);
const isFundingSheet = (sheet: unknown): sheet is FundingSheet =>
  typeof sheet === "string" && Object.hasOwn(COLUMNS, sheet);
const FUNDING_CURRENCIES = new Set(Intl.supportedValuesOf("currency"));
// An explicitly typed binding so each call narrows like a `throw`.
const fail: (message: string) => never = (message) => {
  throw new ValidationError(`IBKR funding history ${message}`);
};

function text(cell: FundingWorkbookCell | undefined, required = false): string {
  if (cell == null) {
    if (required) fail("is missing a required literal value");
    return "";
  }
  if (cell.type !== "text" || typeof cell.value !== "string")
    fail("requires literal text cells for its native export fields");
  const value = cell.value;
  if (
    value.length > 10000 ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 && ![9, 10, 13].includes(code);
    })
  )
    fail("contains an unsupported literal value");
  if (required && (!value || value.trim() !== value))
    fail("contains a blank or altered required value");
  return value;
}

function date(value: string | undefined): string {
  if (value === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return fail("requires an ISO calendar date");
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  )
    fail("contains an invalid calendar date");
  return value;
}

function nativeAmount(value: string | undefined): {
  currency: string;
  amount: string;
} {
  const match =
    /^([A-Z]{3}) ((?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)\.\d{2})$/.exec(
      value ?? "",
    );
  if (!match || !FUNDING_CURRENCIES.has(match[1]!))
    return fail("requires an explicit native currency and unambiguous amount");
  const amount = toDecimal(match[2]!.replaceAll(",", ""));
  if (
    !amount.gt(0) ||
    !Number.isFinite(amount.toNumber()) ||
    amount.gt("999999999999")
  )
    fail("contains an unsupported funding amount");
  return { currency: match[1]!, amount: amount.toFixed(2) };
}

function recordEvidence(envelope: IbkrFundingEnvelope): FundingRecordEvidence {
  const sheet = envelope?.sheet;
  if (!isFundingSheet(sheet) || !equal(envelope.columns, COLUMNS[sheet]))
    return fail("has an unsupported or changed header layout");
  if (
    !Array.isArray(envelope.cells) ||
    envelope.cells.length !== envelope.columns.length
  )
    fail("contains an incomplete literal row");
  const record: Record<string, string> = Object.fromEntries(
    envelope.columns.map((key, index) => [key, text(envelope.cells[index])]),
  );
  for (const key of [
    "Request Date",
    "Reference Number",
    "Method",
    "Account ID",
    "Account Title",
    "Amount",
    "Status",
  ])
    if (!record[key] || record[key]!.trim() !== record[key])
      fail("is missing an unaltered required field");
  if (
    !/^[A-Z][A-Z0-9-]{2,49}$/.test(record["Account ID"]!) ||
    !/^[A-Za-z0-9-]{1,100}$/.test(record["Reference Number"]!)
  )
    fail("contains an unsupported account or reference identity");
  if (record.Method !== "Wire") fail("contains an unsupported funding method");
  if (record.Status !== (sheet === "Deposit" ? "Available" : "Sent"))
    fail("contains a funding movement whose completed status is not proved");
  const requestedDate = date(record["Request Date"]);
  const completedDate = date(
    record[sheet === "Deposit" ? "Date Received" : "Date Processed"],
  );
  if (completedDate < requestedDate)
    fail("contains inconsistent request and completion dates");
  return {
    type: sheet === "Deposit" ? "deposit" : "withdrawal",
    direction: sheet === "Deposit" ? "in" : "out",
    date: requestedDate,
    completedDate,
    ...nativeAmount(record.Amount),
    sourceAccount: record["Account ID"]!,
    sourceId: record["Reference Number"]!,
    reference: record["Reference Number"]!,
    accountTitle: record["Account Title"]!,
    institution:
      record[
        sheet === "Deposit" ? "Delivering Institution" : "Receiving Institution"
      ] || undefined,
    method: record.Method!,
    status: record.Status!,
  };
}

export async function parseIbkrFundingHistory(
  filePath: string,
): Promise<
  ParsedPortfolioRows & { ibkrFundingSourceContext: IbkrFundingSourceContext }
> {
  const sheets = await readIbkrFundingWorkbook(filePath);
  const first = sheets[0] ?? fail("contains no funding sheets");
  const rows: ParsedPortfolioRows = [];
  const identities = new Set<string>();
  const references = new Set<string>();
  const titles = new Map<string, string>();
  const context: IbkrFundingSourceContext = {
    version: 1,
    source_file_hash: first.sourceFileHash,
    source_format: first.sourceFormat,
    source_account_identities: [],
    sheets: [],
    record_hashes: [],
  };
  for (const source of sheets) {
    const columns = (source.data[0] ?? []).map((cell) => text(cell, true));
    const sheet = source.sheet;
    if (!isFundingSheet(sheet) || !equal(columns, COLUMNS[sheet]))
      return fail(
        "requires the original Deposit or Withdrawal sheet with its complete header",
      );
    const descriptor: IbkrFundingSheetDescriptor = {
      sheet,
      header_row: 1,
      source_columns: columns,
      records: [],
    };
    context.sheets.push(descriptor);
    for (let index = 1; index < source.data.length; index++) {
      const cells = source.data[index]!;
      if (
        cells.every(
          (cell) => cell == null || (cell.type === "text" && cell.value === ""),
        )
      )
        continue;
      const envelope: IbkrFundingEnvelope = {
        schema: "ibkr_funding_workbook_row",
        version: 1,
        source_file_hash: source.sourceFileHash,
        source_format: source.sourceFormat,
        sheet: source.sheet,
        header_row: 1,
        row_number: index + 1,
        columns,
        cells,
      };
      const proof = recordEvidence(envelope);
      const identity = `${proof.sourceAccount}\u0000${proof.sourceId}`;
      if (references.has(identity))
        fail("contains duplicate funding references");
      references.add(identity);
      identities.add(proof.sourceAccount);
      if (
        titles.has(proof.sourceAccount) &&
        titles.get(proof.sourceAccount) !== proof.accountTitle
      )
        fail("contains inconsistent account ownership labels");
      titles.set(proof.sourceAccount, proof.accountTitle);
      const rawData = JSON.stringify(envelope);
      if (Buffer.byteLength(rawData, "utf8") > 100000)
        fail("contains a literal row exceeding the retained proof limit");
      const recordHash = hash(rawData);
      context.record_hashes.push(recordHash);
      descriptor.records.push({
        row_number: index + 1,
        record_hash: recordHash,
        source_id: proof.sourceId,
        source_account_identity: proof.sourceAccount,
      });
      rows.push({
        date: new Date(`${proof.date}T00:00:00Z`),
        typeRaw: source.sheet,
        symbolRaw: "",
        nameRaw: "",
        units: null,
        pricePerUnit: null,
        amount: Number(proof.amount),
        fees: null,
        taxes: null,
        currency: proof.currency,
        fxRateToEur: null,
        note: `IBKR ${proof.type} (${proof.method}, ${proof.status})${proof.institution ? ` — ${proof.institution}` : ""}`,
        rawData,
        sourceAccountIdentity: proof.sourceAccount,
        sourceId: proof.sourceId,
      });
    }
  }
  if (!rows.length) fail("contains no completed funding movements");
  if (identities.size !== 1)
    fail("must contain one unambiguous broker account");
  context.source_account_identities = [...identities];
  rows.skipped = 0;
  rows.sourceColumns = [
    ...new Set(context.sheets.flatMap((sheet) => sheet.source_columns)),
  ];
  return Object.assign(rows, { ibkrFundingSourceContext: context });
}

/** Validate retained source context and the literal workbook row against staging. */
export function getIbkrFundingPrimaryEvidence(
  // Staged rows from several readers reach here; every field is re-validated.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  row: any,
): IbkrFundingEvidence | undefined {
  try {
    const config =
      typeof row.custom_config === "string"
        ? JSON.parse(row.custom_config)
        : row.custom_config;
    const context: IbkrFundingSourceContext | undefined =
      config?.ibkr_funding_source_context;
    if (
      config?.format !== "ibkr_funding_history" ||
      context?.version !== 1 ||
      !validHash(context.source_file_hash) ||
      !["xls", "xlsx"].includes(context.source_format) ||
      !Array.isArray(context.source_account_identities) ||
      context.source_account_identities.length !== 1 ||
      !Array.isArray(context.sheets) ||
      !context.sheets.length ||
      context.sheets.length > 2 ||
      !Array.isArray(context.record_hashes) ||
      !context.record_hashes.length ||
      context.record_hashes.some((value) => !validHash(value)) ||
      new Set(context.record_hashes).size !== context.record_hashes.length
    )
      return undefined;
    const references = new Set<string>();
    const sheetNames = new Set<string>();
    const hashes: string[] = [];
    for (const sheet of context.sheets) {
      if (
        !isFundingSheet(sheet.sheet) ||
        sheetNames.has(sheet.sheet) ||
        sheet.header_row !== 1 ||
        !equal(sheet.source_columns, COLUMNS[sheet.sheet]) ||
        !Array.isArray(sheet.records)
      )
        return undefined;
      sheetNames.add(sheet.sheet);
      let previousRow = 1;
      for (const record of sheet.records) {
        if (
          !Number.isSafeInteger(record.row_number) ||
          record.row_number <= previousRow ||
          record.source_account_identity !==
            context.source_account_identities[0] ||
          typeof record.source_id !== "string" ||
          !record.source_id ||
          references.has(record.source_id) ||
          !validHash(record.record_hash)
        )
          return undefined;
        previousRow = record.row_number;
        references.add(record.source_id);
        hashes.push(record.record_hash);
      }
    }
    if (!equal(hashes, context.record_hashes)) return undefined;
    const rawData: unknown = row.raw_data;
    if (
      typeof rawData !== "string" ||
      Buffer.byteLength(rawData, "utf8") > 100000
    )
      return undefined;
    let literal: string = rawData;
    let envelope = JSON.parse(literal);
    if (typeof envelope.primaryRawData === "string") {
      literal = envelope.primaryRawData;
      envelope = JSON.parse(literal);
    }
    const recordHash = hash(literal);
    if (
      recordHash !== row.source_record_hash ||
      !context.record_hashes.includes(recordHash) ||
      envelope.schema !== "ibkr_funding_workbook_row" ||
      envelope.version !== 1 ||
      envelope.source_file_hash !== context.source_file_hash ||
      envelope.source_format !== context.source_format ||
      envelope.header_row !== 1 ||
      !Number.isSafeInteger(envelope.row_number) ||
      envelope.row_number < 2
    )
      return undefined;
    const descriptor = context.sheets.find(
      (sheet) => sheet.sheet === envelope.sheet,
    );
    const retained = descriptor?.records.find(
      (record) =>
        record.record_hash === recordHash &&
        record.row_number === envelope.row_number,
    );
    const proof = recordEvidence(envelope);
    if (
      !retained ||
      retained.source_id !== proof.sourceId ||
      retained.source_account_identity !== proof.sourceAccount ||
      row.route !== "cash" ||
      row.type != null ||
      row.type_raw !== envelope.sheet ||
      row.tx_date !== proof.date ||
      row.currency !== proof.currency ||
      row.source_account_identity !== proof.sourceAccount ||
      row.source_transaction_id !== proof.sourceId ||
      row.investment_id != null ||
      String(row.symbol_raw || "") ||
      String(row.name_raw || "") ||
      row.amount == null ||
      !toDecimal(row.amount).eq(proof.amount) ||
      [row.units, row.price_per_unit].some((value) => value != null) ||
      [row.fees, row.taxes].some(
        (value) => value != null && !toDecimal(value).eq(0),
      )
    )
      return undefined;
    return {
      ...proof,
      rawData: literal,
      recordHash,
      sourceFileHash: context.source_file_hash,
      sourceFormat: context.source_format,
    };
  } catch {
    return undefined;
  }
}

export default {
  name: "ibkr_funding_history",
  parseWithConfig: parseIbkrFundingHistory,
};
