/** Bounded unit coverage only; secondary yield values never replace source money. */
import { parse } from "csv-parse/sync";
import { toDecimal } from "../lib/money.ts";
import { parseAmountField } from "./importPipeline/adapters/_shared.js";
import { __computeSourceRecordHash } from "./importIdentity.js";

const DAY = 86400000;
const FIAT = new Set(["AUD", "CAD", "CHF", "EUR", "GBP", "JPY", "USD"]);
const format = (row) => row.custom_config?.format || row.adapter_name;
const same = (left, right, places) =>
  left != null &&
  right != null &&
  toDecimal(left)
    .toDecimalPlaces(places)
    .eq(toDecimal(right).toDecimalPlaces(places));
const distance = (left, right) =>
  Math.abs(Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`)) /
  DAY;

function literalInterest(row) {
  try {
    if (
      format(row) !== "nexo_transaction_history" ||
      row.status !== "matched" ||
      row.route !== "portfolio" ||
      row.type !== "gift" ||
      row.type_raw !== "Gift" ||
      !Number.isInteger(Number(row.account_id)) ||
      Number(row.account_id) <= 0 ||
      !Number.isInteger(Number(row.investment_id)) ||
      Number(row.investment_id) <= 0 ||
      row.source_record_hash !== __computeSourceRecordHash(row.raw_data)
    )
      return undefined;
    const records = parse(row.raw_data, { skip_empty_lines: false });
    if (records.length !== 1 || records[0].length !== 11) return undefined;
    const [
      id,
      type,
      inputAsset,
      input,
      asset,
      output,
      usd,
      fee,
      ,
      details,
      time,
    ] = records[0].map((cell) => String(cell).trim());
    const amount = parseAmountField(usd);
    const units = parseAmountField(output);
    const feeAmount = fee === "-" || fee === "" ? 0 : parseAmountField(fee);
    const date = time.slice(0, 10);
    const timestamp = Date.parse(`${time.replace(" ", "T")}Z`);
    if (
      !id ||
      type !== "Interest" ||
      !/^approved\b/i.test(details) ||
      !/^[A-Z0-9]{2,10}$/.test(asset) ||
      FIAT.has(asset) ||
      (asset.endsWith("X") && FIAT.has(asset.slice(0, -1))) ||
      inputAsset !== asset ||
      !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(time) ||
      !Number.isFinite(timestamp) ||
      new Date(timestamp).toISOString().slice(0, 10) !== date ||
      !Number.isFinite(amount) ||
      amount <= 0 ||
      !Number.isFinite(units) ||
      units <= 0 ||
      !same(parseAmountField(input), units, 8) ||
      feeAmount !== 0 ||
      row.source_transaction_id !== `${id}:units` ||
      row.tx_date !== date ||
      row.symbol_raw !== asset ||
      row.currency !== "USD" ||
      !same(row.units, units, 8) ||
      !same(row.amount, amount, 4) ||
      !same(row.price_per_unit, toDecimal(amount).div(units), 6) ||
      !toDecimal(row.fees || 0).eq(0) ||
      !toDecimal(row.taxes || 0).eq(0) ||
      row.fx_rate_to_eur != null ||
      row.asset_transfer_details != null ||
      row.asset_adjustment_details != null
    )
      return undefined;
    return { sourceId: id, asset, date, amount, units, rawData: row.raw_data };
  } catch {
    return undefined;
  }
}

function pairedIncome(row, acquisition, proof) {
  try {
    return (
      format(row) === "nexo_transaction_history" &&
      row.status === "matched" &&
      row.route === "portfolio" &&
      row.type === "interest" &&
      row.type_raw === "Interest" &&
      row.source_transaction_id === `${proof.sourceId}:income` &&
      row.raw_data === proof.rawData &&
      row.source_record_hash === __computeSourceRecordHash(row.raw_data) &&
      Number(row.account_id) === Number(acquisition.account_id) &&
      Number(row.investment_id) === Number(acquisition.investment_id) &&
      row.symbol_raw === proof.asset &&
      row.tx_date === proof.date &&
      row.currency === "USD" &&
      same(row.amount, proof.amount, 4) &&
      row.units == null &&
      row.price_per_unit == null &&
      toDecimal(row.fees || 0).eq(0) &&
      toDecimal(row.taxes || 0).eq(0) &&
      row.fx_rate_to_eur == null &&
      row.asset_transfer_details == null &&
      row.asset_adjustment_details == null
    );
  } catch {
    return false;
  }
}

function literalDelivery(event) {
  try {
    const literal = event.literal;
    return (
      event.type === "DELIVERY_INBOUND" &&
      literal?.type === event.type &&
      literal.transactionId === event.id &&
      literal.securityId === event.securityId &&
      literal.date.slice(0, 10) === event.date &&
      /^\d+$/.test(literal.sharesMinor) &&
      toDecimal(literal.sharesMinor).div("100000000").eq(event.shares) &&
      toDecimal(event.shares).gt(0)
    );
  } catch {
    return false;
  }
}

/**
 * Returns { groups, blockers }. Each group covers one PP unit receipt with all
 * literal paired source yields in one whole one/two-day window. The caller
 * supplies its proven PP account and investment mappings; no names are guessed.
 * Rows remain unchanged, including their distinct source dates and USD values.
 */
export function findNexoReferenceYieldGroups({
  reference,
  rows,
  alreadyCovered = new Set(),
  history = [],
  accountMappings = new Map(),
  securityInvestments = new Map(),
}) {
  /** @type {any[]} */
  const blockers = [];
  /** @type {any[]} */
  const pairs = [];
  const candidates = [];
  const add = (reason, event, extra = {}) =>
    blockers.push({
      reason,
      referenceTransactionId: event?.id,
      ...extra,
    });
  for (const acquisition of rows) {
    if (
      format(acquisition) !== "nexo_transaction_history" ||
      acquisition.type !== "gift" ||
      !String(acquisition.source_transaction_id || "").endsWith(":units")
    )
      continue;
    const proof = literalInterest(acquisition);
    const incomes = proof
      ? rows.filter((row) => pairedIncome(row, acquisition, proof))
      : [];
    const duplicates = proof
      ? rows.filter(
          (row) =>
            row.source_transaction_id === acquisition.source_transaction_id &&
            Number(row.account_id) === Number(acquisition.account_id),
        )
      : [];
    if (!proof || incomes.length !== 1 || duplicates.length !== 1) {
      add("reference_unproven_yield_source", undefined, {
        rowId: acquisition.id,
        rowOrdinal: acquisition.row_index + 1,
        batchId: Number(acquisition.batch_id),
      });
      continue;
    }
    pairs.push({ acquisition, income: incomes[0], proof });
  }
  for (const event of reference.events) {
    if (alreadyCovered.has(event.id) || !literalDelivery(event)) continue;
    const accountId = accountMappings.get(event.portfolioId);
    const investment = securityInvestments.get(event.securityId);
    if (accountId == null || !investment) continue;
    const eligible = pairs.filter(
      ({ acquisition }) =>
        Number(acquisition.account_id) === Number(accountId) &&
        Number(acquisition.investment_id) === Number(investment.id),
    );
    // Each window includes every source receipt on its days. Never search
    // arbitrary subsets that happen to equal a secondary quantity.
    const windows = [
      eligible.filter(({ proof }) => proof.date === event.date),
      eligible.filter(
        ({ proof }) =>
          distance(proof.date, event.date) <= 1 && proof.date <= event.date,
      ),
      eligible.filter(
        ({ proof }) =>
          distance(proof.date, event.date) <= 1 && proof.date >= event.date,
      ),
    ];
    const seen = new Set();
    for (const window of windows) {
      if (
        window.length < 2 ||
        new Set(window.map(({ proof }) => proof.asset)).size !== 1 ||
        new Set(window.map(({ proof }) => proof.sourceId)).size !==
          window.length
      )
        continue;
      const units = window.reduce(
        (sum, { acquisition }) => sum.plus(acquisition.units),
        toDecimal(0),
      );
      if (!units.eq(event.shares)) continue;
      const key = window
        .map(({ acquisition }) => String(acquisition.id))
        .sort()
        .join(":");
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        event,
        acquisitionRows: window.map(({ acquisition }) => acquisition),
        incomeRows: window.map(({ income }) => income),
      });
    }
  }
  const groups = [];
  for (const group of candidates) {
    const independentlyCovered = group.acquisitionRows.some((row) =>
      reference.events.some(
        (event) =>
          alreadyCovered.has(event.id) &&
          literalDelivery(event) &&
          Number(accountMappings.get(event.portfolioId)) ===
            Number(row.account_id) &&
          Number(securityInvestments.get(event.securityId)?.id) ===
            Number(row.investment_id) &&
          event.date === row.tx_date &&
          toDecimal(event.shares).eq(row.units),
      ),
    );
    const overlaps = candidates.filter(
      (other) =>
        other.event.id === group.event.id ||
        other.acquisitionRows.some((row) =>
          group.acquisitionRows.some((member) => member.id === row.id),
        ),
    );
    if (independentlyCovered || overlaps.length !== 1) {
      if (
        !blockers.some(
          (item) =>
            item.reason === "reference_ambiguous_yield_group" &&
            item.referenceTransactionId === group.event.id,
        )
      )
        add("reference_ambiguous_yield_group", group.event);
      continue;
    }
    const legacy = history.filter((current) => {
      try {
        if (
          current.type !== "gift" ||
          Number(current.investment_id) !==
            Number(group.acquisitionRows[0].investment_id) ||
          (current.account_id != null &&
            Number(current.account_id) !==
              Number(group.acquisitionRows[0].account_id)) ||
          distance(current.date, group.event.date) > 7 ||
          !toDecimal(current.units).gt(0)
        )
          return false;
        // A possible aggregate blocks insertion; this is deliberately not an
        // adoption tolerance or permission to rewrite historical quantities.
        return toDecimal(current.units)
          .minus(group.event.shares)
          .abs()
          .lte(toDecimal(group.event.shares).times("0.01"));
      } catch {
        return false;
      }
    });
    if (legacy.length) {
      for (const current of legacy)
        add("reference_existing_aggregate_yield_history", group.event, {
          transactionId: current.id,
          rowIds: group.acquisitionRows.map((row) => row.id),
        });
      continue;
    }
    groups.push(group);
  }
  return { groups, blockers };
}
