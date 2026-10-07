import { Decimal, toDecimal } from "../lib/money.ts";
import { createHash } from "node:crypto";
import { parsedDateToYmd } from "../lib/importDates.ts";
import { parseKinesisSourceRecordForBasisPolicy } from "./portfolioImportPipeline/kinesisTransactionHistoryAdapter.js";
import {
  parseAmountField,
  parseCsvText,
  parseDateWithFormat,
} from "./importPipeline/adapters/_shared.js";
import {
  getNexoProSpotReconciliationEvidence,
  nexoProSourceMoneyMatches,
} from "./portfolioImportPipeline/nexoProTransactionHistoryAdapter.js";

const same = (left, right, places = 4) =>
  left != null &&
  right != null &&
  toDecimal(left)
    .toDecimalPlaces(places)
    .eq(toDecimal(right).toDecimalPlaces(places));

const KINESIS_COLUMNS = [
  "DateTime",
  "HIN",
  "Currency_Code",
  "Transaction_Type",
  "Transaction_ID",
  "Order_ID",
  "Currency_Pair",
  "Amount",
  "Trade_Price",
  "Total",
  "Fee",
  "Fee_Currency",
  "Trade_Value",
  "Trade_Value_Currency",
  "Starting_Balance",
  "Starting_Balance_Currency",
  "Closing_Balance",
  "Closing_Balance_Currency",
];
const KINESIS_FIAT = new Set(["AUD", "CAD", "CHF", "EUR", "GBP", "SGD", "USD"]);

/** Bind reviewed source facts and instrument resolution, excluding commit progress. */
export function portfolioReferenceStagingBinding(rows) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        rows.map((row) => ({
          id: row.id,
          batchId: row.batch_id,
          investmentId: row.investment_id,
          rawData: row.raw_data,
          sourceId: row.source_transaction_id,
          sourceHash: row.source_record_hash,
          fingerprint: row.dedup_fingerprint,
          fingerprintVersion: row.dedup_fingerprint_version,
          type: row.type,
          route: row.route,
          date: row.tx_date,
          units: row.units,
          amount: row.amount,
          price: row.price_per_unit,
          fees: row.fees,
          taxes: row.taxes,
          currency: row.currency,
          fx: row.fx_rate_to_eur,
          transfer: row.asset_transfer_details,
          adjustment: row.asset_adjustment_details
            ? {
                ...row.asset_adjustment_details,
                eligibleSourceRecordHashes: undefined,
              }
            : row.asset_adjustment_details,
        })),
      ),
      "utf8",
    )
    .digest("hex");
}

/** Preserve the recorded native valuation; only a literal consistent FX quote can supply EUR FX. */
export function recordedPortfolioPerformanceBasis(event) {
  const gross = event.units.filter((unit) => unit.type === "GROSS_VALUE");
  if (gross.length > 1) return undefined;
  const unit = gross[0];
  const native = unit?.forex ||
    unit?.amount || { amount: event.amount, currency: event.currency };
  if (!native || !/^[A-Z]{3}$/.test(native.currency)) return undefined;
  let fxRateToEur;
  if (native.currency === "EUR") fxRateToEur = undefined;
  else if (
    unit?.forex &&
    unit.amount?.currency === "EUR" &&
    unit.exchangeRate
  ) {
    const rate = toDecimal(unit.exchangeRate);
    if (
      same(
        toDecimal(native.amount).times(rate).toFixed(),
        unit.amount.amount,
        2,
      )
    )
      fxRateToEur = rate.toFixed();
    else if (
      same(toDecimal(native.amount).div(rate).toFixed(), unit.amount.amount, 2)
    )
      fxRateToEur = toDecimal(1).div(rate).toFixed();
    else return undefined;
  }
  return { amount: native.amount, currency: native.currency, fxRateToEur };
}

export function portfolioPerformanceTradeFacts(
  event,
  targetCurrency = undefined,
) {
  const basis = recordedPortfolioPerformanceBasis(event);
  if (
    !basis ||
    !["BUY", "SELL"].includes(event.type) ||
    !toDecimal(event.shares).gt(0)
  )
    return undefined;
  const gross = event.units.find((unit) => unit.type === "GROSS_VALUE");
  const currency = targetCurrency || basis.currency;
  const convert = (money) => {
    if (!money) return undefined;
    if (money.currency === currency) return toDecimal(money.amount);
    if (!basis.fxRateToEur) return undefined;
    if (money.currency === basis.currency && currency === "EUR")
      return toDecimal(money.amount).times(basis.fxRateToEur);
    if (money.currency === "EUR" && currency === basis.currency)
      return toDecimal(money.amount).div(basis.fxRateToEur);
    return undefined;
  };
  const grossAmount = gross
    ? convert(
        gross.forex?.currency === currency
          ? gross.forex
          : gross.amount?.currency === currency
            ? gross.amount
            : gross.forex || gross.amount,
      )
    : currency === event.currency
      ? toDecimal(event.amount)
      : undefined;
  if (grossAmount === undefined) return undefined;
  const charges = { FEE: toDecimal(0), TAX: toDecimal(0) };
  for (const unit of event.units)
    if (unit.type in charges) {
      const amount = convert(
        unit.forex?.currency === currency
          ? unit.forex
          : unit.amount?.currency === currency
            ? unit.amount
            : unit.forex || unit.amount,
      );
      if (amount === undefined) return undefined;
      charges[unit.type] = charges[unit.type].plus(amount);
    }
  const hasGross = event.units.some((unit) => unit.type === "GROSS_VALUE");
  const principal = hasGross
    ? grossAmount
    : event.type === "BUY"
      ? toDecimal(event.amount).minus(charges.FEE).minus(charges.TAX)
      : toDecimal(event.amount).plus(charges.FEE).plus(charges.TAX);
  if (!principal.gt(0)) return undefined;
  return {
    ...basis,
    currency,
    fxRateToEur: currency === "EUR" ? undefined : basis.fxRateToEur,
    amount: principal.toFixed(),
    fees: charges.FEE.toFixed(),
    taxes: charges.TAX.toFixed(),
    units: event.shares,
    price: principal.div(event.shares).toFixed(),
  };
}

/** Secondary proof must agree with the unchanged primary asset, units and day. */
function readVerifiedPortfolioPerformanceBasisReference(row) {
  let envelope;
  try {
    envelope = JSON.parse(row.raw_data);
  } catch {
    return undefined;
  }
  const proof = envelope?.__portfolioPerformanceReference;
  if (
    typeof envelope?.primaryRawData !== "string" ||
    !proof ||
    !/^[a-f0-9]{64}$/.test(proof.sourceHash || "") ||
    !proof.transactionId ||
    !proof.securityId ||
    Number(proof.investmentId) !== Number(row.investment_id) ||
    !proof.literal ||
    proof.literal.transactionId !== proof.transactionId ||
    proof.literal.securityId !== proof.securityId
  )
    return undefined;
  const literal = proof.literal;
  if (
    typeof literal.date !== "string" ||
    !/^\d+$/.test(literal.amountMinor || "") ||
    !Array.isArray(literal.units) ||
    literal.type !== "DELIVERY_INBOUND" ||
    literal.date.slice(0, 10) !== row.tx_date ||
    !/^\d+$/.test(literal.sharesMinor || "") ||
    !same(
      toDecimal(literal.sharesMinor).div("100000000").toFixed(),
      row.units,
      8,
    )
  )
    return undefined;
  const basis = recordedPortfolioPerformanceBasis({
    type: literal.type,
    amount: toDecimal(literal.amountMinor).div(100).toFixed(),
    currency: literal.currency,
    units: literal.units,
  });
  if (!basis) return undefined;
  if (proof.basisPolicy === "zero") {
    if (
      !["EUR", "USD"].includes(basis.currency) ||
      !toDecimal(basis.amount).lte("0.01") ||
      row.asset_adjustment_details?.kind !== "yield_acquisition" ||
      row.asset_adjustment_details?.basisPolicy !== "zero" ||
      !same(row.amount, "0") ||
      row.type !== "gift"
    )
      return undefined;
    return { ...proof, amount: "0", currency: row.currency, meaningful: false };
  }
  if (
    proof.basisPolicy !== "recorded_native" ||
    !toDecimal(basis.amount).gt("0.01") ||
    !same(row.amount, basis.amount) ||
    row.currency !== basis.currency ||
    (basis.fxRateToEur != null &&
      !same(row.fx_rate_to_eur, basis.fxRateToEur, 10))
  )
    return undefined;
  return { ...proof, ...basis, meaningful: true };
}

export function portfolioPrimaryRawData(rawData) {
  try {
    const envelope = JSON.parse(rawData);
    if (typeof envelope?.primaryRawData === "string")
      return envelope.primaryRawData;
  } catch {
    /* Ordinary CSV source. */
  }
  return rawData;
}

/** An explicit zero policy applies only to a maintained, literal yield source. */
export function verifiedPortfolioZeroYieldSource(row) {
  try {
    if (
      row.custom_config?.format !== "kinesis_transaction_history" ||
      row.custom_config?.yield_basis_policy !== "zero" ||
      row.type !== "gift" ||
      row.asset_adjustment_details?.kind !== "yield_acquisition" ||
      row.asset_adjustment_details?.basisPolicy !== "zero" ||
      !same(row.amount, 0) ||
      !same(row.fees || 0, 0) ||
      !same(row.taxes || 0, 0)
    )
      return false;
    const raw = portfolioPrimaryRawData(row.raw_data);
    if (
      createHash("sha256").update(raw, "utf8").digest("hex") !==
      row.source_record_hash
    )
      return false;
    const parsed = parseKinesisSourceRecordForBasisPolicy(raw, {
      sourceColumns: row.custom_config.source_columns,
      yield_basis_policy: "zero",
    });
    const matches = parsed?.filter(
      (item) => item.sourceId === row.source_transaction_id,
    );
    if (matches?.length !== 1) return false;
    const item = matches[0];
    return (
      item.typeRaw === "Gift" &&
      item.assetAdjustment?.kind === "yield_acquisition" &&
      item.assetAdjustment?.basisPolicy === "zero" &&
      item.currency === row.currency &&
      item.symbolRaw === row.symbol_raw &&
      parsedDateToYmd(item.date) === row.tx_date &&
      same(item.units, row.units, 8) &&
      same(item.amount, 0) &&
      same(item.fees || 0, 0) &&
      same(item.taxes || 0, 0)
    );
  } catch {
    return false;
  }
}

export function zeroYieldIdentifiesLegacy(row, current) {
  return (
    verifiedPortfolioZeroYieldSource(row) &&
    current.type === "gift" &&
    current.date === row.tx_date &&
    same(current.units, row.units, 8) &&
    same(current.amount || 0, 0) &&
    same(current.fees || 0, 0) &&
    same(current.taxes || 0, 0) &&
    (current.price_per_unit == null || same(current.price_per_unit, 0))
  );
}

/** Exact PP legacy facts identify a transcription; the primary execution supplies new facts. */
function readPortfolioPerformanceReferenceIdentifiesLegacy(row, current) {
  let envelope;
  try {
    envelope = JSON.parse(row.raw_data);
  } catch {
    return false;
  }
  const reference = envelope?.__portfolioPerformanceReference;
  const literal = reference?.literal;
  if (
    reference?.basisPolicy !== "primary_execution" ||
    !literal ||
    reference.transactionId !== literal.transactionId ||
    reference.securityId !== literal.securityId ||
    Number(reference.investmentId) !== Number(row.investment_id) ||
    !/^[a-f0-9]{64}$/.test(reference.sourceHash || "") ||
    !["BUY", "SELL"].includes(literal.type) ||
    !/^\d+$/.test(literal.sharesMinor || "") ||
    !/^\d+$/.test(literal.amountMinor || "") ||
    !Array.isArray(literal.units) ||
    typeof literal.date !== "string"
  )
    return false;
  const proof = getNexoProSpotReconciliationEvidence(envelope.primaryRawData);
  if (
    !proof ||
    proof.side !== row.type ||
    proof.currency !== row.currency ||
    proof.symbol !== row.symbol_raw ||
    row.source_transaction_id !==
      `nexo-pro:spot:order:${proof.sourceOrderId}` ||
    proof.sourceTimestamp.slice(0, 10) !== row.tx_date ||
    !same(proof.netUnits, row.units, 8) ||
    !nexoProSourceMoneyMatches(proof.amount, row.amount) ||
    !same(proof.unitPrice, row.price_per_unit, 6) ||
    !nexoProSourceMoneyMatches(proof.quoteFee, row.fees) ||
    !same(row.taxes || 0, 0)
  )
    return false;
  const event = {
    type: literal.type,
    date: literal.date.slice(0, 10),
    shares: toDecimal(literal.sharesMinor).div("100000000").toFixed(),
    amount: toDecimal(literal.amountMinor).div(100).toFixed(),
    currency: literal.currency,
    units: literal.units,
  };
  const facts = portfolioPerformanceTradeFacts(event);
  const dayDifference =
    Math.abs(Date.parse(row.tx_date) - Date.parse(event.date)) / 86400000;
  const primaryCash =
    proof.side === "buy"
      ? toDecimal(proof.amount).plus(proof.quoteFee)
      : toDecimal(proof.amount).minus(proof.quoteFee);
  const cashProof =
    (facts &&
      [proof.amount, proof.grossQuoteAmount, primaryCash.toFixed()].some(
        (value) => same(value, facts.amount, 2),
      )) ||
    (row.currency === event.currency &&
      same(primaryCash.toFixed(), event.amount, 2));
  if (
    !facts ||
    dayDifference > 31 ||
    !(
      same(proof.netUnits, event.shares, 8) ||
      same(proof.grossUnits, event.shares, 8)
    ) ||
    (row.currency !== facts.currency ? dayDifference > 7 : !cashProof) ||
    current.type !== event.type.toLowerCase() ||
    current.date !== event.date ||
    current.currency !== facts.currency ||
    !same(current.units, event.shares, 8) ||
    !same(current.fees || 0, facts.fees) ||
    !same(current.taxes || 0, facts.taxes) ||
    !(
      same(current.amount, facts.amount, 2) ||
      same(current.amount, event.amount, 2)
    )
  )
    return false;
  return (
    same(current.price_per_unit, facts.price, 6) ||
    // PP records cash in cents; its derived unit price may retain more digits.
    // Bind that price to the same literal cash instead of guessing an execution.
    same(
      toDecimal(current.price_per_unit).times(current.units).toFixed(),
      current.amount,
      2,
    )
  );
}

export function verifiedPortfolioPerformanceBasisReference(row) {
  try {
    return readVerifiedPortfolioPerformanceBasisReference(row);
  } catch {
    return undefined;
  }
}
export function portfolioPerformanceReferenceIdentifiesLegacy(row, current) {
  try {
    return readPortfolioPerformanceReferenceIdentifiesLegacy(row, current);
  } catch {
    return false;
  }
}

/** Literal placeholder identity is separate from a claim of converted economic equivalence. */
export function portfolioPerformanceBasisIdentifiesLegacy(row, current) {
  try {
    const proof = verifiedPortfolioPerformanceBasisReference(row);
    if (
      !proof ||
      current.type !== "gift" ||
      current.date !== proof.literal.date.slice(0, 10) ||
      !same(current.units, row.units, 8)
    )
      return false;
    const event = {
      type: proof.literal.type,
      amount: toDecimal(proof.literal.amountMinor).div(100).toFixed(),
      currency: proof.literal.currency,
      units: proof.literal.units,
    };
    const basis = recordedPortfolioPerformanceBasis(event);
    if (!basis || !same(current.fees || 0, 0) || !same(current.taxes || 0, 0))
      return false;
    if (proof.basisPolicy === "zero")
      return (
        same(current.amount, 0) ||
        (current.currency === basis.currency &&
          same(current.amount, basis.amount))
      );
    // An exact numeric transcription into the wrong currency can be corrected
    // to the literal native valuation. This does not invent an exchange rate.
    return (
      same(current.amount, 0) ||
      ((current.currency === basis.currency || current.currency === "EUR") &&
        same(current.amount, basis.amount))
    );
  } catch {
    return false;
  }
}

/** A proximity guard can block an extra insertion; it cannot authorize adoption. */
export function plausibleRoundedKinesisDepositLegacy(row, current) {
  try {
    if (
      row.custom_config?.format !== "kinesis_transaction_history" ||
      row.route !== "portfolio" ||
      row.type !== "gift" ||
      row.type_raw !== "Gift" ||
      row.asset_transfer_details?.direction !== "in" ||
      current.type !== "gift" ||
      current.date !== row.tx_date ||
      Number(current.investment_id) !== Number(row.investment_id)
    )
      return false;
    const primaryUnits = toDecimal(row.units);
    const legacyUnits = toDecimal(current.units);
    const precision = legacyUnits.decimalPlaces();
    const difference = primaryUnits.minus(legacyUnits).abs();
    return (
      primaryUnits.gt(0) &&
      legacyUnits.gt(0) &&
      precision >= 6 &&
      precision < 8 &&
      difference.gt(0) &&
      difference.lte("0.0000005") &&
      difference.lte(primaryUnits.times("0.0001")) &&
      [Decimal.ROUND_HALF_EVEN, Decimal.ROUND_HALF_UP].some((rounding) =>
        primaryUnits.toDecimalPlaces(precision, rounding).eq(legacyUnits),
      )
    );
  } catch {
    return false;
  }
}

function literalKinesisAssetRecord(row) {
  if (
    row.custom_config?.format !== "kinesis_transaction_history" ||
    !Number.isInteger(Number(row.account_id)) ||
    Number(row.account_id) <= 0
  )
    return undefined;
  const raw = portfolioPrimaryRawData(row.raw_data);
  if (
    createHash("sha256").update(raw, "utf8").digest("hex") !==
    row.source_record_hash
  )
    return undefined;
  const columns = row.custom_config.source_columns;
  if (
    !Array.isArray(columns) ||
    columns.length !== KINESIS_COLUMNS.length ||
    new Set(columns).size !== columns.length ||
    !KINESIS_COLUMNS.every((column) => columns.includes(column))
  )
    return undefined;
  const records = parseCsvText(raw, {
    columns,
    skip_empty_lines: true,
    relax_column_count: false,
  });
  if (records.length !== 1) return undefined;
  const record = records[0];
  const clean = (value) => String(value ?? "").trim();
  const symbol = clean(record.Currency_Code).toUpperCase();
  const amount = parseAmountField(record.Amount);
  const start = parseAmountField(record.Starting_Balance);
  const close = parseAmountField(record.Closing_Balance);
  const fee = clean(record.Fee) ? parseAmountField(record.Fee) : 0;
  const sourceDate = parseDateWithFormat(
    clean(record.DateTime).replace(/\s+UTC$/i, ""),
    "%Y-%m-%d %H:%M:%S",
  );
  if (
    !clean(record.Transaction_ID) ||
    row.source_transaction_id !== clean(record.Transaction_ID) ||
    !clean(record.HIN) ||
    row.source_account_identity !== clean(record.HIN) ||
    KINESIS_FIAT.has(symbol) ||
    !/^[A-Z0-9]{2,10}$/.test(symbol) ||
    row.symbol_raw !== symbol ||
    clean(record.Starting_Balance_Currency).toUpperCase() !== symbol ||
    clean(record.Closing_Balance_Currency).toUpperCase() !== symbol ||
    parsedDateToYmd(sourceDate) !== row.tx_date ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    !Number.isFinite(start) ||
    !Number.isFinite(close) ||
    !Number.isFinite(fee) ||
    fee < 0
  )
    return undefined;
  return {
    type: clean(record.Transaction_Type),
    symbol,
    amount: toDecimal(amount),
    delta: toDecimal(close).minus(start),
    fee: toDecimal(fee),
    feeCurrency: clean(record.Fee_Currency).toUpperCase(),
  };
}

/** Literal negative asset balance must equal received units plus its same-asset fee. */
export function verifiedKinesisWithdrawal(row) {
  try {
    if (
      row.route !== "asset_transfer" ||
      row.asset_transfer_details?.direction !== "out" ||
      row.asset_transfer_details?.basisStatus !== "carried"
    )
      return undefined;
    const literal = literalKinesisAssetRecord(row);
    if (
      !literal ||
      literal.type !== "Withdrawal" ||
      !literal.delta.lt(0) ||
      (literal.fee.gt(0) && literal.feeCurrency !== literal.symbol) ||
      !literal.delta.negated().eq(row.units) ||
      !literal.amount.plus(literal.fee).eq(row.units) ||
      !literal.amount.eq(row.asset_transfer_details.receivedUnits) ||
      !literal.fee.eq(row.asset_transfer_details.feeUnits)
    )
      return undefined;
    return {
      receivedUnits: literal.amount.toFixed(),
      feeUnits: literal.fee.toFixed(),
      grossUnits: literal.delta.negated().toFixed(),
    };
  } catch {
    return undefined;
  }
}

/** Only literal deposit quantity plus exact meaningful PP basis can correct rounding. */
export function portfolioPerformanceRoundedDepositIdentifiesLegacy(
  row,
  current,
) {
  try {
    if (
      !plausibleRoundedKinesisDepositLegacy(row, current) ||
      current.account_id != null ||
      current.import_batch_id != null ||
      current.source_record_hash != null ||
      current.dedup_fingerprint != null ||
      row.asset_transfer_details?.basisStatus !== "recorded_reference" ||
      row.asset_adjustment_details != null ||
      !Number.isInteger(Number(row.account_id)) ||
      Number(row.account_id) <= 0 ||
      !same(row.fees || 0, 0) ||
      !same(row.taxes || 0, 0) ||
      !same(current.fees || 0, 0) ||
      !same(current.taxes || 0, 0)
    )
      return false;
    const proof = verifiedPortfolioPerformanceBasisReference(row);
    if (
      !proof?.meaningful ||
      proof.basisPolicy !== "recorded_native" ||
      Number(proof.accountId) !== Number(row.account_id) ||
      !toDecimal(proof.literal.sharesMinor).div("100000000").eq(row.units) ||
      !same(toDecimal(proof.amount).div(row.units), row.price_per_unit, 6) ||
      (proof.fxRateToEur == null && row.fx_rate_to_eur != null)
    )
      return false;
    const literal = literalKinesisAssetRecord(row);
    if (
      !literal ||
      literal.type !== "Deposit" ||
      !literal.delta.eq(literal.amount) ||
      !same(literal.amount, row.units, 8) ||
      !literal.fee.eq(0)
    )
      return false;
    const zero = same(current.amount, 0);
    if (zero)
      return (
        current.price_per_unit == null || same(current.price_per_unit, 0, 6)
      );
    return (
      (current.currency === proof.currency || current.currency === "EUR") &&
      same(current.amount, proof.amount) &&
      (current.price_per_unit == null ||
        same(
          toDecimal(current.price_per_unit).times(current.units),
          current.amount,
        ))
    );
  } catch {
    return false;
  }
}

export function verifiedPortfolioPerformanceCustodyAnnotation(row) {
  try {
    const proof = JSON.parse(row.raw_data)?.__portfolioPerformanceReference;
    return (
      proof?.basisPolicy === "paired_custody" &&
      /^[a-f0-9]{64}$/.test(proof.sourceHash || "") &&
      proof.transactionId === proof.literal?.transactionId &&
      proof.securityId === proof.literal?.securityId &&
      proof.literal?.type === "TRANSFER_IN" &&
      proof.literal.date.slice(0, 10) === row.tx_date &&
      same(
        toDecimal(proof.literal.sharesMinor).div("100000000").toFixed(),
        row.units,
        8,
      ) &&
      !!proof.literal.fromTransactionId &&
      !!proof.literal.toTransactionId &&
      row.asset_transfer_details?.direction === "internal" &&
      row.custom_config?.transfer_origin_account_id != null
    );
  } catch {
    return false;
  }
}
