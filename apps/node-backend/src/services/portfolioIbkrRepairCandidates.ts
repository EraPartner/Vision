/** Narrow only contested, already imported IBKR trade copies. */
import { toDecimal } from "../lib/money.ts";
import type { Decimal, DecimalInput } from "../lib/money.ts";
import type { ReconciliationSourceRow } from "../repositories/portfolioImportReconciliationRepository.ts";

export type { Decimal, DecimalInput };
/** A portfolio transaction image: a legacy candidate or the imported copy. */
export interface RepairCandidate {
  id: number | string;
  account_id?: number | null;
  import_batch_id?: number | string | null;
  dedup_fingerprint?: string | null;
  dedup_fingerprint_version?: number | null;
  investment_id: number | string;
  type: string;
  date: string;
  currency?: string | null;
  units?: DecimalInput;
  amount?: DecimalInput;
  price_per_unit?: DecimalInput;
}
export interface RepairItem {
  row: Pick<
    ReconciliationSourceRow,
    | "custom_config"
    | "route"
    | "type"
    | "tx_date"
    | "currency"
    | "investment_id"
    | "dedup_fingerprint"
    | "dedup_fingerprint_version"
  >;
  /** normalized planner values (see normalizedSource) */
  source: Record<string, string | null | undefined>;
  candidates: readonly RepairCandidate[];
  imported?: RepairCandidate;
}

const PLACES = { units: 8, amount: 4, price_per_unit: 6 };
const id = (value: unknown) =>
  Number.isSafeInteger(Number(value)) && Number(value) > 0;

function number(value: DecimalInput): Decimal | undefined {
  if (value == null || String(value).trim() === "") return undefined;
  try {
    const result = toDecimal(value);
    return result.isFinite() && result.gt(0) ? result : undefined;
  } catch {
    return undefined;
  }
}

function eligible(item: RepairItem) {
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
    ["buy", "sell"].includes(String(item.source.type)) &&
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

function comparison(
  item: RepairItem,
  candidate: RepairCandidate,
): "exact" | "different" | undefined {
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
    !/^\d{4}-\d{2}-\d{2}$/.test(String(source.date)) ||
    candidate.currency !== source.currency ||
    !/^[A-Z]{3}$/.test(String(source.currency))
  )
    return undefined;
  const values: Record<string, [Decimal, Decimal]> = {};
  for (const [field, places] of Object.entries(PLACES) as Array<
    [keyof typeof PLACES, number]
  >) {
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
 */
export function narrowImportedIbkrRepairCandidates<T extends RepairItem>(
  items: T[],
): { prepared: T[]; settledDuplicates: T[] } {
  const claims = new Map<number, T[]>();
  for (const item of items) {
    for (const candidate of item.candidates) {
      if (comparison(item, candidate) !== "exact") continue;
      const key = Number(candidate.id);
      claims.set(key, [...(claims.get(key) || []), item]);
    }
  }
  const prepared: T[] = [];
  const settledDuplicates: T[] = [];
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
