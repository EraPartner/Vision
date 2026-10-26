/**
 * IBKR Client Portal "Transaction Status & History" funding workbook (.xls or
 * .xlsx). Each completed deposit or withdrawal becomes one brokerage cash row
 * in its own currency, identified by the account and IBKR reference number.
 * The Transaction History CSV reports the same movements only in the
 * statement base currency; the reconciliation plan pairs the two (ADR-236
 * amendment) so that neither import double counts the other.
 */
import { readIbkrFundingWorkbook } from "../../lib/portfolioUpload.ts";
import type { FundingWorkbookCell } from "../../lib/portfolioUpload.ts";
import { toDecimal } from "../../lib/money.ts";
import { ValidationError } from "../../middleware/errorHandler.ts";
import { asCurrencyCode } from "@vision/types/brands";
import type { CurrencyCode } from "@vision/types/brands";
import type { ParsedPortfolioRows } from "./portfolioGenericAdapter.ts";
import { requiredValue } from "../requiredValue.ts";

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
/** Statuses of a movement that reached the account. */
const COMPLETED_STATUS =
  /^(?:available|sent|completed?|processed|received|credited|disbursed)$/i;
/** Statuses of a request that never moved money. */
const OPEN_STATUS =
  /^(?:pending|processing|requested|rejected|cancell?ed|failed|returned|reversed|expired|on hold)$/i;

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

/** One funding movement as the workbook states it. */
export interface IbkrFundingFacts {
  type: "deposit" | "withdrawal";
  /** request date, the staged transaction date */
  date: string;
  /** date received (deposit) or processed (withdrawal); request date if blank */
  completedDate: string;
  currency: CurrencyCode;
  /** positive magnitude in the movement's own currency */
  amount: string;
  sourceAccount: string;
  sourceId: string;
  method: string;
  status: string;
  institution: string | undefined;
}

const equal = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);
const isFundingSheet = (sheet: unknown): sheet is FundingSheet =>
  typeof sheet === "string" && Object.hasOwn(COLUMNS, sheet);
const FUNDING_CURRENCIES = new Set(Intl.supportedValuesOf("currency"));
// An explicitly typed binding so each call narrows like a `throw`.
const fail: (message: string) => never = (message) => {
  throw new ValidationError(`IBKR funding history ${message}`);
};

function text(cell: FundingWorkbookCell | undefined): string {
  if (cell == null) return "";
  if (cell.type === "number") return cell.value;
  if (cell.type !== "text" || typeof cell.value !== "string")
    fail("requires text cells for its export fields");
  const value = cell.value;
  if (value.length > 10000 || hasUnsupportedControlCharacter(value))
    fail("contains an unsupported literal value");
  return value.trim();
}

/** Any control character other than tab, line feed or carriage return. */
function hasUnsupportedControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 && ![9, 10, 13].includes(code)) return true;
  }
  return false;
}

function date(value: string | undefined): string {
  if (value === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return fail("requires ISO calendar dates (YYYY-MM-DD)");
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  )
    fail("contains an invalid calendar date");
  return value;
}

function nativeAmount(value: string | undefined): {
  currency: CurrencyCode;
  amount: string;
} {
  const match =
    /^([A-Z]{3}) ((?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d{1,8})?)$/.exec(
      value ?? "",
    );
  const [, currency, digits] = match ?? [];
  if (
    currency === undefined ||
    digits === undefined ||
    !FUNDING_CURRENCIES.has(currency)
  )
    return fail("requires an amount with its currency, such as USD 1,000.00");
  const amount = toDecimal(digits.replaceAll(",", ""));
  if (!amount.gt(0) || amount.gt("999999999999"))
    fail("contains an unsupported funding amount");
  return { currency: asCurrencyCode(currency), amount: amount.toFixed() };
}

/**
 * Read one envelope's movement, or undefined for a request that never moved
 * money (pending, rejected, cancelled).
 */
function movement(envelope: IbkrFundingEnvelope): IbkrFundingFacts | undefined {
  const sheet = envelope.sheet;
  if (!isFundingSheet(sheet) || !equal(envelope.columns, COLUMNS[sheet]))
    return fail("has an unsupported or changed header layout");
  if (
    !Array.isArray(envelope.cells) ||
    envelope.cells.length > envelope.columns.length
  )
    fail("contains a row wider than its header");
  const record: Record<string, string> = Object.fromEntries(
    envelope.columns.map((key, index) => [key, text(envelope.cells[index])]),
  );
  for (const key of [
    "Request Date",
    "Reference Number",
    "Account ID",
    "Amount",
    "Status",
  ])
    if (!record[key]) fail(`is missing ${key} on row ${envelope.row_number}`);
  // The loop above rejected any missing or empty value of these keys.
  const accountId = requiredValue(record["Account ID"], "Account ID is present");
  const referenceNumber = requiredValue(
    record["Reference Number"],
    "Reference Number is present",
  );
  if (
    !/^[A-Z][A-Z0-9*-]{2,49}$/.test(accountId) ||
    !/^[A-Za-z0-9-]{1,100}$/.test(referenceNumber)
  )
    fail("contains an unsupported account or reference identity");
  const status = requiredValue(record.Status, "Status is present");
  if (OPEN_STATUS.test(status)) return undefined;
  if (!COMPLETED_STATUS.test(status))
    fail(`contains an unknown funding status "${status}"`);
  const requestedDate = date(record["Request Date"]);
  const completed =
    record[sheet === "Deposit" ? "Date Received" : "Date Processed"];
  const completedDate = completed ? date(completed) : requestedDate;
  if (completedDate < requestedDate)
    fail("contains inconsistent request and completion dates");
  return {
    type: sheet === "Deposit" ? "deposit" : "withdrawal",
    date: requestedDate,
    completedDate,
    ...nativeAmount(record.Amount),
    sourceAccount: accountId,
    sourceId: referenceNumber,
    method: record.Method || "funding",
    status,
    institution:
      record[
        sheet === "Deposit" ? "Delivering Institution" : "Receiving Institution"
      ] || undefined,
  };
}

/**
 * The movement retained in a staged funding row's `raw_data`, or undefined
 * when the value is not such an envelope.
 */
export function ibkrFundingFactsFromRawData(
  rawData: unknown,
): IbkrFundingFacts | undefined {
  try {
    if (typeof rawData !== "string" || rawData.length > 200000)
      return undefined;
    const parsed: unknown = JSON.parse(rawData);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("schema" in parsed) ||
      parsed.schema !== "ibkr_funding_workbook_row"
    )
      return undefined;
    // movement() re-checks the header layout and cells it reads.
    return movement(parsed as IbkrFundingEnvelope);
  } catch {
    return undefined;
  }
}

export async function parseIbkrFundingHistory(
  filePath: string,
): Promise<ParsedPortfolioRows> {
  const sheets = await readIbkrFundingWorkbook(filePath);
  if (sheets.length === 0) fail("contains no funding sheets");
  const rows: ParsedPortfolioRows = [];
  const identities = new Set<string>();
  const references = new Set<string>();
  let skipped = 0;
  for (const source of sheets) {
    const columns = (source.data[0] ?? []).map((cell) => text(cell));
    const sheet = source.sheet;
    if (!isFundingSheet(sheet) || !equal(columns, COLUMNS[sheet]))
      return fail(
        "requires the original Deposit or Withdrawal sheet with its complete header",
      );
    for (const [index, cells] of source.data.entries()) {
      if (index === 0) continue;
      if (
        cells.every(
          (cell) =>
            cell == null || (cell.type === "text" && cell.value.trim() === ""),
        )
      )
        continue;
      const envelope: IbkrFundingEnvelope = {
        schema: "ibkr_funding_workbook_row",
        version: 1,
        source_file_hash: source.sourceFileHash,
        source_format: source.sourceFormat,
        sheet,
        header_row: 1,
        row_number: index + 1,
        columns,
        cells,
      };
      const facts = movement(envelope);
      if (!facts) {
        skipped++;
        continue;
      }
      const identity = `${facts.sourceAccount}\u0000${facts.sourceId}`;
      if (references.has(identity))
        fail("contains duplicate funding references");
      references.add(identity);
      identities.add(facts.sourceAccount);
      const rawData = JSON.stringify(envelope);
      if (Buffer.byteLength(rawData, "utf8") > 100000)
        fail("contains a row exceeding the retained size limit");
      rows.push({
        date: new Date(`${facts.date}T00:00:00Z`),
        typeRaw: sheet,
        symbolRaw: "",
        nameRaw: "",
        units: null,
        pricePerUnit: null,
        amount: Number(facts.amount),
        fees: null,
        taxes: null,
        currency: facts.currency,
        fxRateToEur: null,
        note: `IBKR ${facts.type} (${facts.method}, ${facts.status})${facts.institution ? ` — ${facts.institution}` : ""}`,
        rawData,
        sourceAccountIdentity: facts.sourceAccount,
        sourceId: facts.sourceId,
      });
    }
  }
  if (rows.length === 0) fail("contains no completed funding movements");
  if (identities.size !== 1) fail("must contain one broker account");
  rows.skipped = skipped;
  rows.sourceColumns = [
    ...new Set(sheets.flatMap((sheet) => COLUMNS[sheet.sheet as FundingSheet])),
  ];
  return rows;
}
