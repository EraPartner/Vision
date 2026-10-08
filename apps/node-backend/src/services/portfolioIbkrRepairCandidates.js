/** Narrow only contested, already imported IBKR trade copies. */
import { toDecimal } from "../lib/money.ts";

/** @typedef {import('@vision/shared-utils/money').DecimalInput} DecimalInput */
/** @typedef {import('decimal.js').default} Decimal */
/**
 * @typedef {{ row: any, source: any, candidates: any[], imported?: any }} RepairItem
 */

const PLACES = { units: 8, amount: 4, price_per_unit: 6 };
const id = (/** @type {unknown} */ value) =>
  Number.isSafeInteger(Number(value)) && Number(value) > 0;

/**
 * @param {DecimalInput} value
 * @returns {Decimal | undefined}
 */
function number(value) {
  if (value == null || String(value).trim() === "") return undefined;
  try {
    const result = toDecimal(value);
    return result.isFinite() && result.gt(0) ? result : undefined;
  } catch {
    return undefined;
  }
}

/** @param {RepairItem} item */
function eligible(item) {
  let config = item.row.custom_config;
  try {
    if (typeof config === "string") config = JSON.parse(config);
  } catch {
    return false;
  }
  return (
    config?.format === "ibkr_transaction_history" &&
    item.imported &&
    id(item.imported.id) &&
    id(item.imported.import_batch_id) &&
    item.row.route === "portfolio" &&
    ["buy", "sell"].includes(item.source.type) &&
    item.row.type === item.source.type &&
    item.row.tx_date === item.source.date &&
    item.row.currency === item.source.currency &&
    item.imported.currency === item.source.currency &&
    Number(item.imported.investment_id) === Number(item.row.investment_id) &&
    item.row.dedup_fingerprint &&
    item.row.dedup_fingerprint === item.imported.dedup_fingerprint &&
    item.row.dedup_fingerprint_version ===
      item.imported.dedup_fingerprint_version
  );
}

/**
 * @param {RepairItem} item
 * @param {any} candidate
 * @returns {"exact" | "different" | undefined}
 */
function comparison(item, candidate) {
  const source = item.source;
  if (
    !eligible(item) ||
    !id(candidate.id) ||
    candidate.account_id != null ||
    candidate.import_batch_id != null ||
    candidate.dedup_fingerprint != null ||
    Number(candidate.investment_id) !== Number(item.row.investment_id) ||
    candidate.type !== source.type ||
    candidate.date !== source.date ||
    !/^\d{4}-\d{2}-\d{2}$/.test(source.date) ||
    candidate.currency !== source.currency ||
    !/^[A-Z]{3}$/.test(source.currency)
  )
    return undefined;
  /** @type {Record<string, [Decimal, Decimal]>} */
  const values = {};
  for (const [field, places] of Object.entries(PLACES)) {
    const left = number(source[field]);
    const right = number(candidate[field]);
    if (!left || !right) return undefined;
    values[field] = [
      left.toDecimalPlaces(places),
      right.toDecimalPlaces(places),
    ];
  }
  if (
    !values.units[0].eq(values.units[1]) ||
    !values.units[0]
      .times(values.price_per_unit[0])
      .toDecimalPlaces(4)
      .eq(values.amount[0]) ||
    !values.units[1]
      .times(values.price_per_unit[1])
      .toDecimalPlaces(4)
      .eq(values.amount[1])
  )
    return undefined;
  if (
    values.amount[0].eq(values.amount[1]) &&
    values.price_per_unit[0].eq(values.price_per_unit[1])
  )
    return "exact";
  if (
    values.amount[0].eq(values.amount[1]) ||
    values.price_per_unit[0].eq(values.price_per_unit[1])
  )
    return undefined;
  // A gross/net explanation remains ambiguous even with a different displayed price.
  for (const sign of [-1, 1]) {
    if (source.fees == null || source.taxes == null) return undefined;
    try {
      const charges = toDecimal(source.fees).plus(source.taxes);
      if (!charges.isFinite() || charges.lt(0)) return undefined;
      if (
        values.amount[0]
          .plus(charges.times(sign))
          .toDecimalPlaces(4)
          .eq(values.amount[1])
      )
        return undefined;
    } catch {
      return undefined;
    }
  }
  return "different";
}

/**
 * Caller has already validated each imported copy's source and provenance.
 * Settled items must emit duplicate against imported.id, never an insert.
 * @template {{ row: any, source: any, candidates: any[], imported?: any }} T
 * @param {T[]} items
 * @returns {{ prepared: T[], settledDuplicates: T[] }}
 */
export function narrowImportedIbkrRepairCandidates(items) {
  const claims = new Map();
  for (const item of items) {
    for (const candidate of item.candidates) {
      if (comparison(item, candidate) !== "exact") continue;
      const key = Number(candidate.id);
      claims.set(key, [...(claims.get(key) || []), item]);
    }
  }
  const prepared = [];
  const settledDuplicates = [];
  for (const item of items) {
    const candidates = item.candidates.filter((candidate) => {
      const winners = claims.get(Number(candidate.id));
      return !(
        winners?.length === 1 &&
        winners[0] !== item &&
        comparison(item, candidate) === "different"
      );
    });
    if (candidates.length === item.candidates.length) prepared.push(item);
    else if (!candidates.length)
      settledDuplicates.push({ ...item, candidates });
    else prepared.push({ ...item, candidates });
  }
  return { prepared, settledDuplicates };
}
