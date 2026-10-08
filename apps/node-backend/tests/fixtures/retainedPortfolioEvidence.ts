import { createHash } from "node:crypto";
import { toDecimal } from "../../src/lib/money.ts";
import { portfolioReferenceStagingBinding } from "../../src/services/portfolioPerformanceReferenceEvidence.ts";

const minor = (value, factor) => toDecimal(value).times(factor).toFixed(0);

/** Synthetic stored JSON witnesses. No document parsing, matching or upload path. */
export function retainedEvent(over = {}) {
  const event = {
    id: "reference-one",
    portfolioId: "portfolio-one",
    referenceAccountId: "account-one",
    securityId: "security-eth",
    type: "DELIVERY_INBOUND",
    date: "2025-01-01",
    shares: "1",
    amount: "0.01",
    currency: "EUR",
    units: [],
    ...over,
  };
  event.units = event.units.map((unit) => ({
    ...unit,
    amount: { ...unit.amount, minor: minor(unit.amount.amount, 100) },
    ...(unit.forex
      ? { forex: { ...unit.forex, minor: minor(unit.forex.amount, 100) } }
      : {}),
  }));
  event.literal = {
    transactionId: event.id,
    date: `${event.date}T00:00`,
    type: event.type,
    currency: event.currency,
    amountMinor: minor(event.amount, 100),
    sharesMinor: minor(event.shares, "100000000"),
    securityId: event.securityId,
    units: event.units,
    ...over.literal,
  };
  return event;
}

export function retainedReference(events) {
  return {
    sourceHash: createHash("sha256")
      .update(JSON.stringify({ syntheticStoredEvidence: events }))
      .digest("hex"),
    events,
  };
}

/** Explicitly attach one already-retained witness to a synthetic source row. */
export function retainedEvidenceRow(
  row,
  reference,
  event,
  basisPolicy = "recorded_native",
  facts = {},
) {
  return {
    ...row,
    ...facts,
    raw_data: JSON.stringify({
      primaryRawData: row.raw_data,
      __portfolioPerformanceReference: {
        sourceHash: reference.sourceHash,
        transactionId: event.id,
        securityId: event.securityId,
        portfolioId: event.portfolioId,
        investmentId: row.investment_id,
        accountId: Number(row.account_id),
        literal: event.literal,
        basisPolicy,
      },
    }),
  };
}

export function retainedReferenceConfiguration(rows, scope, reference) {
  const batchIds = [...new Set(rows.map((row) => Number(row.batch_id)))];
  const routing = batchIds.map((batchId) => ({
    batchId,
    accountId: Number(
      rows.find((row) => Number(row.batch_id) === batchId).account_id,
    ),
    originAccountId: null,
    destinationAccountId: null,
  }));
  return {
    sourceHash: reference.sourceHash,
    reconciliationScope: scope,
    originalBatchIds: batchIds,
    effectiveBatchIds: batchIds,
    routing,
    originalRouting: routing,
    stagingBinding: portfolioReferenceStagingBinding(rows),
    originalStagingBinding: portfolioReferenceStagingBinding(rows),
  };
}
