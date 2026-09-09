/** Versioned, provider-neutral identity for budgeting and portfolio imports. */

import crypto from "node:crypto";
import { parsedDateToYmd } from "../lib/importDates.js";

export const IMPORT_FINGERPRINT_VERSION = 1;

/** @param {unknown} value @returns {string} */
export function normalizeIdentityText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toUpperCase();
}

/** @param {unknown} value @returns {string} */
export function normalizeIdentityDecimal(value) {
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

/** @param {unknown} rawData @returns {string|null} */
export function computeSourceRecordHash(rawData) {
  if (rawData === null || rawData === undefined) return null;
  return crypto
    .createHash("sha256")
    .update(String(rawData), "utf8")
    .digest("hex");
}

/** @param {unknown[]} values @returns {string} */
function canonicalTuple(values) {
  return JSON.stringify(values.map((value) => value ?? null));
}

/**
 * @param {Record<string, any>} row
 * @param {string} _adapterName retained for adapter-call compatibility; not identity input
 * @returns {{ base: string, sourceId: string }}
 */
export function budgetingIdentityBase(row, _adapterName) {
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

/**
 * @param {Record<string, any>} row
 * @param {{ adapterName?: string, accountIdentity: string }} context
 * @returns {{ base: string, sourceId: string }}
 */
export function portfolioIdentityBase(row, { accountIdentity }) {
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
 *
 * @param {Record<string, any>[]} rows
 * @param {(row: Record<string, any>) => {base: string, sourceId: string}} baseFor
 * @returns {Array<{sourceRecordHash: string|null, fingerprint: string, version: number, occurrence: number}>}
 */
export function assignImportIdentities(rows, baseFor) {
  const occurrenceByBase = new Map();
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
