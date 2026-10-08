import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { buildPortfolioImportReconciliationPlan as buildPlan } from "../src/services/portfolioImportReconciliationService.ts";
import type {
  HistoryImage,
  ReconciliationPlanInput,
} from "../src/services/portfolioImportReconciliationService.ts";
import type { ReconciliationSourceRow } from "../src/repositories/portfolioImportReconciliationRepository.ts";
import {
  verifiedPortfolioPerformanceBasisReference,
  portfolioPerformanceReferenceIdentifiesLegacy,
} from "../src/services/portfolioPerformanceReferenceEvidence.ts";
import {
  retainedEvent,
  retainedReference,
  retainedEvidenceRow,
} from "./fixtures/retainedPortfolioEvidence.ts";
import type { RetainedEvent } from "./fixtures/retainedPortfolioEvidence.ts";
import { loose } from "./helpers/partial.ts";

/** Every staged row in this suite carries its literal record. */
type SourceRow = ReconciliationSourceRow & { raw_data: string };

// The synthetic rows are wire-shaped: numeric BIGINT ids, string dates, and
// partial batch, history and repair-context rows.
const buildPortfolioImportReconciliationPlan = (
  input: Record<string, unknown>,
) => buildPlan(loose<ReconciliationPlanInput>(input));

const source = (over: Record<string, unknown> = {}) =>
  loose<SourceRow>({
    id: 1,
    batch_id: 1,
    row_index: 0,
    status: "matched",
    route: "portfolio",
    investment_id: 1,
    account_id: 7,
    asset_class: "crypto",
    type: "gift",
    type_raw: "Gift",
    tx_date: "2025-01-01",
    units: "1",
    amount: "0",
    price_per_unit: null,
    fees: "0",
    taxes: "0",
    currency: "USD",
    raw_data: "literal primary CSV record",
    symbol_raw: "ETH",
    note: "Asset transfer in; original cost basis unavailable",
    source_transaction_id: "primary:1",
    source_record_hash: "a".repeat(64),
    dedup_fingerprint: "b".repeat(64),
    dedup_fingerprint_version: 1,
    custom_config: { format: "kinesis_transaction_history" },
    asset_transfer_details: { direction: "in", basisStatus: "unresolved" },
    ...over,
  });
const legacy = (over: Record<string, unknown> = {}) =>
  loose<HistoryImage>({
    id: 40,
    investment_id: 1,
    type: "gift",
    date: "2025-01-01",
    units: "1",
    amount: "200",
    price_per_unit: "200",
    fees: "0",
    taxes: "0",
    currency: "EUR",
    account_id: null,
    import_batch_id: null,
    source_record_hash: null,
    dedup_fingerprint: null,
    dedup_fingerprint_version: null,
    note: "Keep this note",
    ...over,
  });
// `facts` may deliberately blank a column (fx_rate_to_eur: undefined).
const retain = (
  row: SourceRow,
  event: RetainedEvent,
  facts: Record<string, unknown> = {},
) =>
  loose<SourceRow>(
    retainedEvidenceRow(
      row,
      retainedReference([event]),
      event,
      row.type === "gift" ? "recorded_native" : "primary_execution",
      facts,
    ),
  );
const review = (row: SourceRow, current: HistoryImage, policy?: string) =>
  buildPortfolioImportReconciliationPlan({
    rows: [row],
    history: [current],
    batches: [{ id: 1, account_id: 7, status: "awaiting_review" }],
    adoptPolicy: policy,
  });

describe("retained literal JSON proof and reviewed reconciliation", () => {
  it("validates retained native basis and permits reviewed currency transcription correction without inventing FX", () => {
    const original = source();
    const after = retain(
      original,
      retainedEvent({ amount: "200", currency: "USD" }),
      {
        amount: "200",
        price_per_unit: "200",
        currency: "USD",
        fx_rate_to_eur: undefined,
        asset_transfer_details: {
          direction: "in",
          basisStatus: "recorded_reference",
        },
      },
    );
    expect(JSON.parse(after.raw_data).primaryRawData).toBe(original.raw_data);
    expect(verifiedPortfolioPerformanceBasisReference(after)).toMatchObject({
      meaningful: true,
      currency: "USD",
      amount: "200",
    });
    expect(review(after, legacy()).plan.blockers[0].reason).toBe(
      "source_policy_required",
    );
    const adopted = review(after, legacy(), "prefer_source");
    expect(adopted.plan.ready).toBe(true);
    expect(adopted.adoptions[0].after).toMatchObject({
      id: 40,
      currency: "USD",
      amount: "200",
      fx_rate_to_eur: null,
      note: "Keep this note",
    });
    expect(
      review(after, legacy({ amount: "201" }), "prefer_source").plan.blockers[0]
        .reason,
    ).toBe("unproven_currency_conversion");
  });
  it("requires a consistent retained native GROSS_VALUE and literal FX", () => {
    const event = retainedEvent({
      amount: "180",
      units: [
        {
          type: "GROSS_VALUE",
          amount: { currency: "EUR", amount: "180" },
          forex: { currency: "USD", amount: "200" },
          exchangeRate: "0.9",
        },
      ],
    });
    const row = retain(source(), event, {
      amount: "200",
      price_per_unit: "200",
      currency: "USD",
      fx_rate_to_eur: "0.9",
    });
    expect(verifiedPortfolioPerformanceBasisReference(row)).toMatchObject({
      amount: "200",
      currency: "USD",
      fxRateToEur: "0.9",
    });
    const envelope = JSON.parse(row.raw_data);
    envelope.__portfolioPerformanceReference.literal.units[0].exchangeRate =
      "0.7";
    expect(
      verifiedPortfolioPerformanceBasisReference({
        ...row,
        raw_data: JSON.stringify(envelope),
      }),
    ).toBeUndefined();
  });

  it("adopts literal confirmed zero-basis yield currency without inventing a rate, while unproven/positive legacy values block", () => {
    const columns = [
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
    const raw =
      "2025-01-01 00:00:00,SYNTHETIC,ETH,Holder's_Distribution,YIELD-SYNTHETIC,,,1,,1,0,ETH,20,USD,0,ETH,1,ETH";
    const row = source({
      amount: "0",
      price_per_unit: "0",
      note: "Holder's Distribution units",
      asset_transfer_details: undefined,
      asset_adjustment_details: {
        kind: "yield_acquisition",
        basisPolicy: "zero",
      },
      source_transaction_id: "YIELD-SYNTHETIC:units",
      raw_data: raw,
      source_record_hash: createHash("sha256").update(raw).digest("hex"),
      custom_config: {
        format: "kinesis_transaction_history",
        yield_basis_policy: "zero",
        source_columns: columns,
      },
    });
    const zero = legacy({ amount: "0", price_per_unit: "0" });
    expect(review(row, zero, "prefer_source").plan.ready).toBe(true);
    expect(review(row, zero, "prefer_source").adoptions[0].after).toMatchObject(
      { currency: "USD", amount: "0", fx_rate_to_eur: null },
    );
    expect(
      review(
        {
          ...row,
          custom_config: { ...row.custom_config, source_columns: undefined },
        },
        zero,
        "prefer_source",
      ).plan.ready,
    ).toBe(false);
    expect(
      review(
        row,
        legacy({ amount: "10", price_per_unit: "10" }),
        "prefer_source",
      ).plan.ready,
    ).toBe(false);
  });
  it("retains literal primary Pro execution authority while retained literal evidence uniquely identifies legacy currency transcription", () => {
    const pro = source({
      type: "sell",
      type_raw: "Sell",
      currency: "USD",
      units: "1",
      amount: "100",
      price_per_unit: "100",
      fees: "1",
      note: undefined,
      asset_transfer_details: undefined,
      custom_config: { format: "nexo_pro_spot_history" },
      source_transaction_id: "nexo-pro:spot:order:PP-PRO-SELL",
      raw_data:
        "201,2025-01-01 12:00:00,ETH/USD,sell,market,999,100,,1,1,1,USD,completed,PP-PRO-SELL",
    });
    const old = legacy({ type: "sell", amount: "90", price_per_unit: "90" });
    const enriched = retain(pro, retainedEvent({ type: "SELL", amount: "90" }));
    expect(portfolioPerformanceReferenceIdentifiesLegacy(enriched, old)).toBe(
      true,
    );
    const corrected = review(enriched, old, "prefer_source");
    expect(corrected.plan.ready).toBe(true);
    expect(corrected.adoptions[0].after).toMatchObject({
      currency: "USD",
      amount: "100",
      fees: "1",
      fx_rate_to_eur: null,
    });
    expect(
      review(enriched, legacy({ ...old, amount: "91" }), "prefer_source").plan
        .ready,
    ).toBe(false);
    const raw =
      "order-7,2025-01-01 12:00:00,BTC/USD,sell,market,executed,0.5,0.5,100,100,50,1,USD,49";
    // Use the maintained adapter header order; unsupported invented records remain rejected.
    const rejected = source({
      type: "sell",
      raw_data: JSON.stringify({
        primaryRawData: raw,
        __portfolioPerformanceReference: {
          basisPolicy: "primary_execution",
          sourceHash: "c".repeat(64),
          transactionId: "fake",
          securityId: "security-eth",
          literal: {
            transactionId: "fake",
            securityId: "security-eth",
            type: "SELL",
            date: "2025-01-01",
            currency: "EUR",
            amountMinor: "5000",
            sharesMinor: "50000000",
            units: [],
          },
        },
      }),
    });
    expect(
      portfolioPerformanceReferenceIdentifiesLegacy(
        rejected,
        legacy({ type: "sell" }),
      ),
    ).toBe(false);
    expect(
      verifiedPortfolioPerformanceBasisReference(
        source({
          raw_data:
            '{"__portfolioPerformanceReference":{"literal":{"amountMinor":{}}}}',
        }),
      ),
    ).toBeUndefined();
  });
  it("binds retained rounded cash and a cash-consistent price to a unique shifted Pro sale", () => {
    const pro = source({
      type: "sell",
      type_raw: "Sell",
      tx_date: "2025-01-14",
      currency: "EUR",
      units: "10",
      amount: "20.02",
      price_per_unit: "2.002",
      fees: "0.04",
      note: undefined,
      asset_transfer_details: undefined,
      custom_config: { format: "nexo_pro_spot_history" },
      source_transaction_id: "nexo-pro:spot:order:PP-ROUNDED-SELL",
      raw_data:
        "202,2025-01-14 12:00:00,ETH/EUR,sell,market,2.002,2.002,,10,10,0.04,EUR,completed,PP-ROUNDED-SELL",
    });
    const old = legacy({
      type: "sell",
      units: "10",
      amount: "20.0231",
      price_per_unit: "2.00231",
      fees: "0.03",
    });
    const enriched = retain(
      pro,
      retainedEvent({
        type: "SELL",
        shares: "10",
        amount: "19.99",
        units: [{ type: "FEE", amount: { currency: "EUR", amount: "0.03" } }],
      }),
    );
    expect(review(enriched, old, "prefer_source").plan).toMatchObject({
      ready: true,
      summary: { adopt: 1, insert: 0 },
    });
    expect(
      portfolioPerformanceReferenceIdentifiesLegacy(enriched, {
        ...old,
        amount: "20.03",
        price_per_unit: "2.003",
      }),
    ).toBe(false);
    expect(
      portfolioPerformanceReferenceIdentifiesLegacy(enriched, {
        ...old,
        price_per_unit: "3",
      }),
    ).toBe(false);
    const ambiguous = buildPortfolioImportReconciliationPlan({
      rows: [enriched],
      history: [old, { ...old, id: 41 }],
      batches: [{ id: 1, account_id: 7, status: "awaiting_review" }],
      adoptPolicy: "prefer_source",
    });
    expect(ambiguous.plan).toMatchObject({
      ready: false,
      summary: { insert: 0 },
    });
    expect(ambiguous.plan.blockers[0].reason).toBe("ambiguous_history");
    expect(review(pro, old, "prefer_source").plan).toMatchObject({
      ready: false,
      summary: { insert: 0 },
    });
  });

  it("retains the literal Pro base-fee reference proof after PostgreSQL half rounding", () => {
    const pro = source({
      type: "buy",
      type_raw: "Buy",
      currency: "EUR",
      units: "9.999925",
      amount: "19.9999",
      price_per_unit: "2",
      fees: "0.0002",
      note: undefined,
      asset_transfer_details: undefined,
      custom_config: { format: "nexo_pro_spot_history" },
      source_transaction_id: "nexo-pro:spot:order:PP-HALF-BUY",
      raw_data:
        "203,2025-01-01 12:00:00,ETH/EUR,buy,limit,2,2,,10,10,0.000075,ETH,completed,PP-HALF-BUY",
    });
    const old = legacy({
      type: "buy",
      units: "10",
      amount: "20",
      price_per_unit: "2",
    });
    const enriched = retain(
      pro,
      retainedEvent({ type: "BUY", shares: "10", amount: "20" }),
    );
    expect(review(enriched, old, "prefer_source").plan).toMatchObject({
      ready: true,
      summary: { adopt: 1, insert: 0 },
    });
  });

  it("persists reference blockers and binds the complete reviewed scope even for an empty batch", () => {
    const result = buildPortfolioImportReconciliationPlan({
      rows: [],
      history: [],
      batches: [
        {
          id: 1,
          account_id: 7,
          status: "awaiting_review",
          custom_config: {
            portfolio_performance_reference: {
              effectiveBatchIds: [1, 2],
              routing: [{ batchId: 1, accountId: 7 }],
            },
            reference_blockers: [
              {
                reason: "reference_unmatched_event",
                referenceTransactionId: "old-aggregate",
              },
            ],
          },
        },
      ],
    });
    expect(result.plan.ready).toBe(false);
    expect(result.plan.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          batchId: 1,
          reason: "reference_scope_changed",
          candidateTransactionIds: [],
        }),
        expect.objectContaining({
          batchId: 1,
          reason: "reference_unmatched_event",
          referenceTransactionId: "old-aggregate",
        }),
      ]),
    );
  });
  it("separates portfolio and cash ID namespaces when proving an existing duplicate repair", () => {
    const staged = source({
      type: "buy",
      type_raw: "Buy",
      amount: "100",
      price_per_unit: "100",
      currency: "EUR",
      note: undefined,
      asset_transfer_details: undefined,
      custom_config: { format: "ibkr_transaction_history" },
    });
    const manual = legacy({
      type: "buy",
      amount: "100",
      price_per_unit: "100",
    });
    const imported = legacy({
      ...manual,
      id: 50,
      account_id: 7,
      import_batch_id: 8,
      note: null,
      source_record_hash: staged.source_record_hash,
      dedup_fingerprint: staged.dedup_fingerprint,
      dedup_fingerprint_version: 1,
    });
    const provenance = {
      id: 20,
      batch_id: 8,
      route: "portfolio",
      status: "committed",
      committed_txn_id: 50,
      dedup_fingerprint: staged.dedup_fingerprint,
      note: null,
    };
    const result = buildPortfolioImportReconciliationPlan({
      rows: [staged],
      history: [manual, imported],
      batches: [{ id: 1, account_id: 7, status: "awaiting_review" }],
      adoptPolicy: "preserve_existing",
      repairContext: {
        transactions: [manual, imported],
        batches: [{ id: 8, status: "complete", rows_imported: 1 }],
        staging: [provenance, { ...provenance, id: 21, route: "cash" }],
        knownTransactionIds: [],
      },
    });
    expect(result.plan).toMatchObject({
      ready: true,
      summary: { repair_duplicate: 1 },
    });
  });
});
