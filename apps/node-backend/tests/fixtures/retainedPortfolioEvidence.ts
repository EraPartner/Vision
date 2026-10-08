import { createHash } from "node:crypto";
import { toDecimal } from "../../src/lib/money.ts";
import { portfolioReferenceStagingBinding } from "../../src/services/portfolioPerformanceReferenceEvidence.ts";
import type {
  PortfolioPerformanceLiteral,
  PortfolioPerformanceMoney,
} from "../../src/services/portfolioPerformanceReferenceEvidence.ts";
import type { ReconciliationSourceRow } from "../../src/repositories/portfolioImportReconciliationRepository.ts";
import type { DecimalInput } from "../../src/lib/money.ts";

const minor = (value: DecimalInput, factor: number | string) =>
  toDecimal(value).times(factor).toFixed(0);

/** A Portfolio Performance unit as a test writes it (major-unit amounts). */
export interface RetainedUnitInput {
  type: string;
  amount: PortfolioPerformanceMoney;
  forex?: PortfolioPerformanceMoney;
  exchangeRate?: string;
}

/** A retained unit: each money value also carries its minor-unit integer string. */
export interface RetainedUnit {
  type: string;
  amount: PortfolioPerformanceMoney & { minor: string };
  forex?: PortfolioPerformanceMoney & { minor: string };
  exchangeRate?: string;
}

/** One retained Portfolio Performance transaction plus the literal it was bound to. */
export interface RetainedEvent {
  id: string;
  portfolioId: string;
  referenceAccountId: string;
  securityId: string;
  type: string;
  date: string;
  shares: string;
  amount: string;
  currency: string;
  units: RetainedUnit[];
  literal: PortfolioPerformanceLiteral & Record<string, unknown>;
}

export type RetainedEventOverrides = Partial<
  Omit<RetainedEvent, "units" | "literal">
> & {
  units?: RetainedUnitInput[];
  /** Extra or replacement fields for the derived literal. */
  literal?: Record<string, unknown>;
};

export interface RetainedReference {
  sourceHash: string;
  events: RetainedEvent[];
}

/** The staged-row columns `retainedEvidenceRow` and `retainedReferenceConfiguration` read. */
export interface RetainedSourceRow {
  raw_data: string | null;
  investment_id: number | null;
  account_id: number | string | null;
  batch_id: number | string;
}

/** Synthetic stored JSON witnesses. No document parsing, matching or upload path. */
export function retainedEvent(
  over: RetainedEventOverrides = {},
): RetainedEvent {
  const base = {
    id: "reference-one",
    portfolioId: "portfolio-one",
    referenceAccountId: "account-one",
    securityId: "security-eth",
    type: "DELIVERY_INBOUND",
    date: "2025-01-01",
    shares: "1",
    amount: "0.01",
    currency: "EUR",
    units: [] as RetainedUnitInput[],
    ...over,
  };
  // Built in place, as the stored witness is: units gain minor amounts, then
  // the literal is derived from the finished event.
  const event = base as Omit<typeof base, "units"> & {
    units: RetainedUnitInput[] | RetainedUnit[];
    literal?: RetainedEvent["literal"];
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
  return event as RetainedEvent;
}

export function retainedReference(events: RetainedEvent[]): RetainedReference {
  return {
    sourceHash: createHash("sha256")
      .update(JSON.stringify({ syntheticStoredEvidence: events }))
      .digest("hex"),
    events,
  };
}

/** Explicitly attach one already-retained witness to a synthetic source row. */
export function retainedEvidenceRow<
  R extends RetainedSourceRow,
  F extends Record<string, unknown> = Record<never, never>,
>(
  row: R,
  reference: Pick<RetainedReference, "sourceHash">,
  event: RetainedEvent,
  basisPolicy = "recorded_native",
  facts: F = {} as F,
): Omit<R, keyof F | "raw_data"> & F & { raw_data: string } {
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

export function retainedReferenceConfiguration(
  rows: RetainedSourceRow[],
  scope: string,
  reference: Pick<RetainedReference, "sourceHash">,
) {
  const batchIds = [...new Set(rows.map((row) => Number(row.batch_id)))];
  const routing = batchIds.map((batchId) => ({
    batchId,
    accountId: Number(
      rows.find((row) => Number(row.batch_id) === batchId)!.account_id,
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
    // Synthetic rows carry only the columns the binding digest reads.
    stagingBinding: portfolioReferenceStagingBinding(
      rows as unknown as ReconciliationSourceRow[],
    ),
    originalStagingBinding: portfolioReferenceStagingBinding(
      rows as unknown as ReconciliationSourceRow[],
    ),
  };
}
