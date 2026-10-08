/** Literal IBKR proof. Missing original statement context never becomes guessed evidence. */
import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import { Decimal, toDecimal } from "../lib/money.ts";

/**
 * @typedef {object} IbkrSourceContext
 * @property {1} version
 * @property {string} source_file_hash
 * @property {string[]} source_columns
 * @property {string} base_currency
 * @property {string} header_record
 * @property {string} summary_base_currency_record
 * @property {string[]} record_hashes
 */

const hash = (raw) => createHash("sha256").update(raw, "utf8").digest("hex");
const clean = (value) =>
  String(value ?? "").trim() === "-" ? "" : String(value ?? "").trim();
const same = (left, right, places) =>
  left != null &&
  right != null &&
  toDecimal(left)
    .toDecimalPlaces(places)
    .eq(toDecimal(right).toDecimalPlaces(places));
const stored = (literal, value, places) =>
  value != null &&
  [Decimal.ROUND_HALF_EVEN, Decimal.ROUND_HALF_UP].some((rounding) =>
    toDecimal(literal).toDecimalPlaces(places, rounding).eq(toDecimal(value)),
  );
const zero = (value) => value == null || toDecimal(value).eq(0);

function literalNumber(value, optional = false) {
  const text = clean(value);
  if (!text) return optional ? toDecimal(0) : undefined;
  // IBKR's maintained numeric dialect permits a comma decimal separator.
  if (!/^[+-]?\d+(?:[.,]\d+)?$/.test(text)) return undefined;
  return toDecimal(text.replace(",", "."));
}

function csvRecord(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 100000)
    return undefined;
  const rows = parse(raw, { skip_empty_lines: true });
  return rows.length === 1 ? rows[0] : undefined;
}

/** @param {any} row */
export function getIbkrPrimaryReconciliationEvidence(row) {
  try {
    const config =
      typeof row.custom_config === "string"
        ? JSON.parse(row.custom_config)
        : row.custom_config;
    const context = config?.ibkr_source_context;
    if (
      config?.format !== "ibkr_transaction_history" ||
      context?.version !== 1 ||
      !/^[a-f0-9]{64}$/.test(context.source_file_hash || "") ||
      !Array.isArray(context.source_columns) ||
      !Array.isArray(context.record_hashes)
    )
      return undefined;
    const header = csvRecord(context.header_record);
    const summary = csvRecord(context.summary_base_currency_record);
    if (
      header?.[0] !== "Transaction History" ||
      header[1] !== "Header" ||
      summary?.[0] !== "Summary" ||
      summary[1] !== "Data" ||
      clean(summary[2]) !== "Base Currency" ||
      clean(summary[3]) !== context.base_currency ||
      !/^[A-Z]{3}$/.test(context.base_currency) ||
      JSON.stringify(header.slice(2).map(clean)) !==
        JSON.stringify(context.source_columns) ||
      new Set(context.source_columns).size !== context.source_columns.length
    )
      return undefined;
    let raw = row.raw_data;
    if (typeof raw !== "string") return undefined;
    if (raw.startsWith("{")) raw = JSON.parse(raw).primaryRawData;
    if (
      typeof raw !== "string" ||
      hash(raw) !== row.source_record_hash ||
      !context.record_hashes.includes(hash(raw))
    )
      return undefined;
    const values = csvRecord(raw);
    if (
      values?.[0] !== "Transaction History" ||
      values[1] !== "Data" ||
      values.length !== context.source_columns.length + 2
    )
      return undefined;
    const record = Object.fromEntries(
      context.source_columns.map((key, i) => [key, clean(values[i + 2])]),
    );
    const type = {
      Buy: "buy",
      Sell: "sell",
      Dividend: "dividend",
      "Foreign Tax Withholding": "tax",
    }[record["Transaction Type"]];
    if (
      !type ||
      row.type !== type ||
      row.type_raw !== (type === "tax" ? "tax" : record["Transaction Type"]) ||
      row.route !== "portfolio" ||
      record.Date !== row.tx_date ||
      !/^\d{4}-\d{2}-\d{2}$/.test(record.Date) ||
      record.Symbol !== row.symbol_raw ||
      !record.Symbol ||
      !record.Account ||
      record.Account !== row.source_account_identity
    )
      return undefined;
    const gross = literalNumber(record["Gross Amount"]);
    const net = literalNumber(record["Net Amount"]);
    const fx = literalNumber(record["Exchange Rate"]);
    const commission = literalNumber(record.Commission, true);
    const transactionFees = literalNumber(record["Transaction Fees"], true);
    if (
      !gross ||
      !net ||
      !fx?.gt(0) ||
      !commission ||
      !transactionFees ||
      !zero(row.taxes)
    )
      return undefined;
    const baseFees = commission.abs().plus(transactionFees.abs());
    const trade = type === "buy" || type === "sell";
    if (trade) {
      const units = literalNumber(record.Quantity)?.abs();
      const price = literalNumber(record.Price)?.abs();
      if (
        !units?.gt(0) ||
        !price?.gt(0) ||
        !/^[A-Z]{3}$/.test(record["Price Currency"]) ||
        context.base_currency !== "EUR" ||
        row.currency !== record["Price Currency"] ||
        !same(units, row.units, 8) ||
        !same(price, row.price_per_unit, 6) ||
        !stored(baseFees.div(fx), row.fees ?? 0, 4) ||
        !same(fx, row.fx_rate_to_eur, 10) ||
        (type === "buy"
          ? !gross.lt(0) || !net.lt(0)
          : !gross.gt(0) || !net.gt(0))
      )
        return undefined;
      const amount = units.times(price);
      if (
        (row.amount != null && !stored(amount, row.amount, 4)) ||
        !same(amount.times(fx), gross.abs(), 4) ||
        !same(
          type === "buy"
            ? gross.abs().plus(baseFees)
            : gross.abs().minus(baseFees),
          net.abs(),
          2,
        )
      )
        return undefined;
      return {
        type,
        date: record.Date,
        currency: row.currency,
        baseCurrency: context.base_currency,
        units: units.toFixed(),
        price: price.toFixed(),
        amount: amount.toFixed(),
        fees: baseFees.div(fx).toFixed(),
        fxRateToEur: fx.toFixed(),
        gross: gross.abs().toFixed(),
        net: net.abs().toFixed(),
        sourceAccount: record.Account,
      };
    }
    if (
      row.currency !== context.base_currency ||
      record["Price Currency"] ||
      !baseFees.eq(0) ||
      !zero(row.fees) ||
      !zero(row.fx_rate_to_eur) ||
      row.units != null ||
      row.price_per_unit != null ||
      !stored(gross.abs(), row.amount, 4) ||
      !same(gross.abs(), net.abs(), 2) ||
      (type === "dividend"
        ? !gross.gt(0) || !net.gt(0)
        : !gross.lt(0) || !net.lt(0))
    )
      return undefined;
    return {
      type,
      date: record.Date,
      currency: context.base_currency,
      baseCurrency: context.base_currency,
      amount: gross.abs().toFixed(),
      gross: gross.abs().toFixed(),
      net: net.abs().toFixed(),
      sourceAccount: record.Account,
    };
  } catch {
    return undefined;
  }
}

/** Primary identity corrects copied currency labels; it makes no FX equivalence claim.
 * @param {any} row
 * @param {any} source normalized planner values
 * @param {any} current unassigned legacy candidate
 * @param {any[]} rows selected primary source scope
 */
export function ibkrPrimaryEvidenceIdentifiesLegacy(
  row,
  source,
  current,
  rows,
) {
  try {
    const proof = getIbkrPrimaryReconciliationEvidence(row);
    if (
      !proof ||
      current.account_id != null ||
      current.import_batch_id != null ||
      current.dedup_fingerprint != null ||
      Number(current.investment_id) !== Number(row.investment_id) ||
      current.type !== proof.type ||
      current.date !== proof.date ||
      source.date !== proof.date ||
      source.type !== proof.type ||
      source.currency !== proof.currency ||
      !/^[A-Z]{3}$/.test(current.currency) ||
      !same(source.amount, proof.amount, 4) ||
      !zero(source.taxes)
    )
      return false;
    if (proof.type === "buy" || proof.type === "sell")
      return (
        current.currency === proof.baseCurrency &&
        current.currency !== proof.currency &&
        same(source.units, proof.units, 8) &&
        same(source.price_per_unit, proof.price, 6) &&
        same(source.fees, proof.fees, 4) &&
        same(source.fx_rate_to_eur, proof.fxRateToEur, 10) &&
        same(current.units, proof.units, 8) &&
        same(current.price_per_unit, proof.price, 6) &&
        same(current.amount, proof.amount, 4)
      );
    if (
      proof.type !== "dividend" ||
      current.currency === proof.currency ||
      !zero(current.fees) ||
      !zero(source.fees) ||
      !toDecimal(current.amount).eq(
        toDecimal(current.amount).toDecimalPlaces(2),
      ) ||
      !same(current.amount, proof.net, 2)
    )
      return false;
    const paired = rows.filter(
      (tax) =>
        tax.type === "tax" &&
        Number(tax.batch_id) === Number(row.batch_id) &&
        Number(tax.investment_id) === Number(row.investment_id) &&
        tax.tx_date === row.tx_date,
    );
    if (!paired.length) return zero(current.taxes);
    if (
      paired.length !== 1 ||
      !toDecimal(current.taxes ?? 0).eq(
        toDecimal(current.taxes ?? 0).toDecimalPlaces(2),
      )
    )
      return false;
    const withholding = getIbkrPrimaryReconciliationEvidence(paired[0]);
    return (
      !!withholding &&
      withholding.type === "tax" &&
      withholding.sourceAccount === proof.sourceAccount &&
      withholding.currency === proof.currency &&
      same(current.taxes, withholding.net, 2)
    );
  } catch {
    return false;
  }
}
