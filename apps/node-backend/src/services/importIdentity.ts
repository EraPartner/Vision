/** Versioned, provider-neutral identity for budgeting and portfolio imports. */

import crypto from "node:crypto";
import { parsedDateToYmd } from "../lib/importDates.ts";

const IMPORT_FINGERPRINT_VERSION = 1;

export interface ImportIdentityBase {
  base: string;
  sourceId: string;
}

export interface ImportIdentity {
  sourceRecordHash: string | null;
  fingerprint: string;
  version: number;
  occurrence: number;
}

/** The staging-row fields that feed a budgeting identity. */
export interface BudgetingIdentityRow {
  source_id?: unknown;
  bank_account?: unknown;
  currency?: unknown;
  tx_date?: unknown;
  amount?: unknown;
  recipient_account?: unknown;
  recipient_raw?: unknown;
  memo?: unknown;
}

/** The staging-row fields that feed a portfolio identity. */
export interface PortfolioIdentityRow {
  source_transaction_id?: unknown;
  route?: unknown;
  source_account_identity?: unknown;
  currency?: unknown;
  tx_date?: unknown;
  type?: unknown;
  symbol_raw?: unknown;
  name_raw?: unknown;
  units?: unknown;
  price_per_unit?: unknown;
  amount?: unknown;
  fees?: unknown;
  taxes?: unknown;
  note?: unknown;
}

export function normalizeIdentityText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toUpperCase();
}

export function normalizeIdentityDecimal(value: unknown): string {
  const source = String(value ?? "").trim();
  if (!source) return "";
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(source);
  if (!match) return source;
  const sign = match[1] === "-" ? "-" : "";
  const integer = (match[2] || "").replace(/^0+/, "") || "0";
  const fraction = (match[3] || "").replace(/0+$/, "");
  if (integer === "0" && !fraction) return "0";
  return `${sign}${integer}${fraction ? `.${fraction}` : ""}`;
}

function computeSourceRecordHash(rawData: unknown): string | null {
  if (rawData === null || rawData === undefined) return null;
  return crypto
    .createHash("sha256")
    .update(String(rawData), "utf8")
    .digest("hex");
}

function canonicalTuple(values: unknown[]): string {
  return JSON.stringify(values.map((value) => value ?? null));
}

/**
 * @param _adapterName retained for adapter-call compatibility; not identity input
 */
export function budgetingIdentityBase(
  row: BudgetingIdentityRow,
  _adapterName?: string | null,
): ImportIdentityBase {
  const sourceId = normalizeIdentityText(row.source_id);
  const prefix = [
    "vision-import",
    IMPORT_FINGERPRINT_VERSION,
    "budgeting",
    normalizeIdentityText(row.bank_account),
    normalizeIdentityText(row.currency) || "EUR",
  ];
  if (sourceId) {
    return {
      base: canonicalTuple([...prefix, "source-id", sourceId]),
      sourceId,
    };
  }
  return {
    base: canonicalTuple([
      ...prefix,
      "fields",
      parsedDateToYmd(row.tx_date) || "",
      normalizeIdentityDecimal(row.amount),
      normalizeIdentityText(row.recipient_account),
      normalizeIdentityText(row.recipient_raw),
      normalizeIdentityText(row.memo),
    ]),
    sourceId: "",
  };
}

export function portfolioIdentityBase(
  row: PortfolioIdentityRow,
  { accountIdentity }: { adapterName?: string; accountIdentity: string },
): ImportIdentityBase {
  const sourceId = normalizeIdentityText(row.source_transaction_id);
  const prefix = [
    "vision-import",
    IMPORT_FINGERPRINT_VERSION,
    "portfolio",
    normalizeIdentityText(row.route) || "PORTFOLIO",
    normalizeIdentityText(row.source_account_identity) ||
      normalizeIdentityText(accountIdentity),
    normalizeIdentityText(row.currency) || "EUR",
  ];
  if (sourceId) {
    return {
      base: canonicalTuple([...prefix, "source-id", sourceId]),
      sourceId,
    };
  }
  return {
    base: canonicalTuple([
      ...prefix,
      "fields",
      parsedDateToYmd(row.tx_date) || "",
      normalizeIdentityText(row.type),
      normalizeIdentityText(row.symbol_raw),
      normalizeIdentityText(row.name_raw),
      normalizeIdentityDecimal(row.units),
      normalizeIdentityDecimal(row.price_per_unit),
      normalizeIdentityDecimal(row.amount),
      normalizeIdentityDecimal(row.fees),
      normalizeIdentityDecimal(row.taxes),
      normalizeIdentityText(row.note),
    ]),
    sourceId: "",
  };
}

/**
 * Assign an order-independent set of occurrence fingerprints. Rows sharing an
 * immutable source id intentionally share one fingerprint. Rows without one
 * receive the stable set of ordinals 1..n for their canonical field identity.
 */
export function assignImportIdentities<R extends { raw_data?: unknown }>(
  rows: R[],
  baseFor: (row: R) => ImportIdentityBase,
): ImportIdentity[] {
  const occurrenceByBase = new Map<string, number>();
  return rows.map((row) => {
    const { base, sourceId } = baseFor(row);
    const occurrence = sourceId ? 1 : (occurrenceByBase.get(base) ?? 0) + 1;
    if (!sourceId) occurrenceByBase.set(base, occurrence);
    const fingerprint = crypto
      .createHash("sha256")
      .update(canonicalTuple([base, "occurrence", occurrence]), "utf8")
      .digest("hex");
    return {
      sourceRecordHash: computeSourceRecordHash(row.raw_data),
      fingerprint,
      version: IMPORT_FINGERPRINT_VERSION,
      occurrence,
    };
  });
}

export {
  computeSourceRecordHash as __computeSourceRecordHash,
  IMPORT_FINGERPRINT_VERSION as __IMPORT_FINGERPRINT_VERSION,
};
