import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { parsePortfolioPerformanceXml } from "../src/services/portfolioPerformanceXmlParser.js";
import { planPortfolioImportReference } from "../src/services/portfolioImportReferenceService.js";
import { buildPortfolioImportReconciliationPlan } from "../src/services/portfolioImportReconciliationService.js";
import {
  verifiedPortfolioPerformanceBasisReference,
  portfolioPerformanceReferenceIdentifiesLegacy,
} from "../src/services/portfolioPerformanceReferenceEvidence.js";
import {
  portfolioPerformanceXml,
  ppEvent,
} from "./fixtures/portfolioPerformanceSynthetic.js";

const investments = [
  {
    id: 1,
    symbol: "ETH-EUR",
    name: "Synthetic Ether holding",
    asset_class: "crypto",
    currency: "EUR",
    price_provider: "yahoo",
    price_provider_id: "ETH-EUR",
  },
];
const source = (over = {}) => ({
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
const legacy = (over = {}) => ({
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
const reference = (events, portfolios) =>
  parsePortfolioPerformanceXml(portfolioPerformanceXml({ events, portfolios }));
const review = (row, current, policy) =>
  buildPortfolioImportReconciliationPlan({
    rows: [row],
    history: [current],
    batches: [{ id: 1, account_id: 7, status: "awaiting_review" }],
    adoptPolicy: policy,
  });

describe("literal secondary reference enrichment", () => {
  it("enriches meaningful native deposit basis and permits reviewed currency transcription correction without inventing FX", () => {
    const ref = reference([ppEvent({ amount: "200", currency: "USD" })]);
    const original = source();
    const plan = planPortfolioImportReference({
      reference: ref,
      rows: [original],
      investments,
      history: [legacy()],
    });
    expect(plan.blockers).toEqual([]);
    const after = plan.corrections[0].after;
    expect(after).toMatchObject({
      amount: "200",
      currency: "USD",
      fx_rate_to_eur: undefined,
    });
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
  it("uses only consistent literal native GROSS_VALUE and FX", () => {
    const event = ppEvent({
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
    const planned = planPortfolioImportReference({
      reference: reference([event]),
      rows: [source()],
      investments,
    });
    expect(planned.corrections[0].after).toMatchObject({
      amount: "200",
      currency: "USD",
      fx_rate_to_eur: "0.9",
    });
    expect(
      planPortfolioImportReference({
        reference: reference([
          { ...event, units: [{ ...event.units[0], exchangeRate: "0.7" }] },
        ]),
        rows: [source()],
        investments,
      }).blockers[0].reason,
    ).toBe("reference_unproven_basis");
  });
  it("clears explicit zero yield placeholders while retaining primary income and meaningful deposits", () => {
    const yieldRow = source({
      note: "Holder's Distribution units",
      asset_adjustment_details: {
        kind: "yield_acquisition",
        basisPolicy: "zero",
      },
      asset_transfer_details: undefined,
    });
    const plan = planPortfolioImportReference({
      reference: reference([ppEvent()]),
      rows: [yieldRow],
      investments,
      history: [legacy({ amount: "0.01", price_per_unit: "0.01" })],
    });
    expect(plan.blockers).toEqual([]);
    expect(plan.corrections[0].after).toMatchObject({
      amount: "0",
      price_per_unit: null,
      asset_adjustment_details: {
        kind: "yield_acquisition",
        basisPolicy: "zero",
      },
    });
    expect(
      review(
        plan.corrections[0].after,
        legacy({ amount: "0.01", price_per_unit: "0.01" }),
        "prefer_source",
      ).plan.ready,
    ).toBe(true);
    const ordinary = planPortfolioImportReference({
      reference: reference([ppEvent()]),
      rows: [source()],
      investments,
    });
    expect(ordinary.blockers[0].reason).toBe("reference_unproven_basis");
    const meaningful = planPortfolioImportReference({
      reference: reference([ppEvent({ amount: "200", currency: "USD" })]),
      rows: [source()],
      investments,
    });
    expect(
      review(
        meaningful.corrections[0].after,
        legacy({ amount: "0", price_per_unit: "0" }),
        "prefer_source",
      ).plan.ready,
    ).toBe(true);
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
  it("blocks ambiguous sources and aggregates instead of appending beside old history", () => {
    const events = [
      ppEvent({ id: "matched", shares: "1" }),
      ppEvent({ id: "aggregate", shares: "2", date: "2025-01-02" }),
    ];
    const plan = planPortfolioImportReference({
      reference: reference(events),
      rows: [source({ asset_transfer_details: undefined })],
      investments,
      history: [
        legacy({
          date: "2025-01-02",
          units: "2",
          amount: "0.01",
          price_per_unit: "0.005",
        }),
      ],
    });
    expect(plan.blockers.map((item) => item.reason)).toContain(
      "reference_unmatched_event",
    );
    expect(plan.blockers.map((item) => item.reason)).toContain(
      "reference_uncovered_legacy_history",
    );
    expect(plan.coverage).toMatchObject({
      unmatchedMappedReferenceEvents: 1,
      unmatchedLegacyRows: 1,
    });
    const duplicate = planPortfolioImportReference({
      reference: reference([ppEvent(), ppEvent({ id: "another" })]),
      rows: [source()],
      investments,
    });
    expect(duplicate.blockers[0].reason).toBe("reference_ambiguous_match");
  });
  it("derives account mapping from exact paired primary custody transfers and shared reference account UUIDs", () => {
    const portfolios = [
      { id: "portfolio-one", accountId: "source-cash" },
      { id: "portfolio-two", accountId: "destination-cash" },
      { id: "portfolio-alias", accountId: "destination-cash" },
    ];
    const events = [
      ppEvent({ id: "out", type: "TRANSFER_OUT", pairId: "in" }),
      ppEvent({
        id: "in",
        type: "TRANSFER_IN",
        pairId: "out",
        portfolioId: "portfolio-two",
      }),
      ppEvent({
        id: "sale",
        type: "SELL",
        portfolioId: "portfolio-alias",
        date: "2025-01-03",
        shares: "0.5",
        amount: "100",
      }),
    ];
    const row = source({
      type: null,
      type_raw: "AssetTransfer",
      route: "asset_transfer",
      asset_transfer_details: {
        direction: "out",
        basisStatus: "carried",
        feeUnits: "0",
        receivedUnits: "1",
      },
      custom_config: {
        format: "nexo_transaction_history",
        transfer_destination_account_id: 8,
      },
    });
    const plan = planPortfolioImportReference({
      reference: reference(events, portfolios),
      rows: [row],
      investments,
    });
    expect(plan.blockers).toEqual([]);
    expect(plan.accountMappings).toContainEqual({
      portfolioId: "portfolio-alias",
      accountId: 8,
    });
    expect(plan.supplemental[0]).toMatchObject({
      accountId: 8,
      row: { type: "sell", amount: "100", units: "0.5" },
    });
  });
  it("stages external fees only from a unique paired withdrawal/return difference, never outbound valuation", () => {
    const events = [
      ppEvent({ id: "out", type: "TRANSFER_OUT", pairId: "in", shares: "1" }),
      ppEvent({
        id: "in",
        type: "TRANSFER_IN",
        pairId: "out",
        portfolioId: "portfolio-two",
        shares: "1",
      }),
      ppEvent({
        id: "return-out",
        type: "TRANSFER_OUT",
        pairId: "return-in",
        portfolioId: "portfolio-two",
        shares: "0.9",
      }),
      ppEvent({
        id: "return-in",
        type: "TRANSFER_IN",
        pairId: "return-out",
        shares: "0.9",
      }),
      ppEvent({
        id: "fee",
        type: "DELIVERY_OUTBOUND",
        portfolioId: "portfolio-two",
        shares: "0.1",
        amount: "999",
      }),
    ];
    const outbound = source({
      route: "asset_transfer",
      type: null,
      asset_transfer_details: { direction: "out" },
      custom_config: {
        format: "nexo_transaction_history",
        transfer_destination_account_id: 8,
      },
    });
    const inbound = source({
      id: 2,
      row_index: 1,
      units: "0.9",
      custom_config: {
        format: "nexo_transaction_history",
        transfer_origin_account_id: 8,
      },
    });
    const plan = planPortfolioImportReference({
      reference: reference(events),
      rows: [outbound, inbound],
      investments,
    });
    expect(plan.blockers).toEqual([]);
    expect(plan.supplemental[0]).toMatchObject({
      accountId: 8,
      row: {
        amount: "0",
        units: "0.1",
        asset_adjustment_details: { kind: "asset_fee", basisPolicy: "carried" },
      },
    });
    const bad = planPortfolioImportReference({
      reference: reference(
        events.map((item) =>
          item.id === "fee" ? { ...item, shares: "0.2" } : item,
        ),
      ),
      rows: [outbound, inbound],
      investments,
    });
    expect(bad.blockers[0].reason).toBe("reference_unproven_transfer_fee");
  });
  it("keeps older selected-asset custody dependencies in scope without importing unrelated shared-wallet assets", () => {
    const portfolios = [
      { id: "portfolio-one", accountId: "broker" },
      { id: "portfolio-two", accountId: "wallet" },
      { id: "portfolio-metal", accountId: "wallet" },
    ];
    const events = [
      ppEvent({ id: "out", type: "TRANSFER_OUT", pairId: "in" }),
      ppEvent({
        id: "in",
        type: "TRANSFER_IN",
        pairId: "out",
        portfolioId: "portfolio-two",
      }),
      ppEvent({
        id: "older-dependency",
        date: "2020-01-01",
        portfolioId: "portfolio-two",
      }),
      ppEvent({
        id: "unrelated-metal",
        securityId: "security-metal",
        portfolioId: "portfolio-metal",
      }),
    ];
    const ref = parsePortfolioPerformanceXml(
      portfolioPerformanceXml({
        events,
        portfolios,
        securities: [
          {
            id: "security-eth",
            ticker: "ETH",
            name: "Synthetic Ether",
            currency: "EUR",
          },
          {
            id: "security-metal",
            ticker: "METAL",
            name: "Synthetic metal",
            currency: "USD",
          },
        ],
      }),
    );
    const row = source({
      type: null,
      route: "asset_transfer",
      type_raw: "AssetTransfer",
      asset_transfer_details: {
        direction: "out",
        feeUnits: "0",
        receivedUnits: "1",
      },
      custom_config: {
        format: "nexo_transaction_history",
        transfer_destination_account_id: 8,
      },
    });
    const plan = planPortfolioImportReference({
      reference: ref,
      rows: [row],
      investments: [
        ...investments,
        {
          id: 2,
          symbol: "METAL",
          name: "Synthetic metal",
          asset_class: "precious_metal",
          currency: "USD",
        },
      ],
    });
    expect(plan.blockers).toEqual([
      expect.objectContaining({
        reason: "reference_unmatched_event",
        referenceTransactionId: "older-dependency",
      }),
    ]);
    expect(plan.coverage).toMatchObject({
      unmatchedMappedReferenceEvents: 1,
      outsideSelectedReferenceEvents: 1,
    });
    expect(plan.supplemental).toEqual([]);
  });

  it("proves a dated isolated custody loss and blocks intervening same-asset events", () => {
    const events = [
      ppEvent({
        id: "out",
        type: "TRANSFER_OUT",
        pairId: "in",
        shares: "1",
        date: "2023-01-01",
      }),
      ppEvent({
        id: "in",
        type: "TRANSFER_IN",
        pairId: "out",
        portfolioId: "portfolio-two",
        shares: "1",
        date: "2023-01-01",
      }),
      ppEvent({
        id: "back-out",
        type: "TRANSFER_OUT",
        pairId: "back-in",
        portfolioId: "portfolio-two",
        shares: "0.9",
        date: "2024-01-01",
      }),
      ppEvent({
        id: "back-in",
        type: "TRANSFER_IN",
        pairId: "back-out",
        shares: "0.9",
        date: "2024-01-01",
      }),
      ppEvent({
        id: "loss",
        type: "DELIVERY_OUTBOUND",
        portfolioId: "portfolio-two",
        shares: "0.1",
        date: "2024-01-01",
        amount: "500",
      }),
    ];
    const rows = [
      source({
        type: null,
        route: "asset_transfer",
        tx_date: "2023-01-01",
        asset_transfer_details: {
          direction: "out",
          feeUnits: "0",
          receivedUnits: "1",
        },
        custom_config: {
          format: "nexo_transaction_history",
          transfer_destination_account_id: 8,
        },
      }),
      source({
        id: 2,
        row_index: 1,
        units: "0.9",
        tx_date: "2024-01-01",
        custom_config: {
          format: "nexo_transaction_history",
          transfer_origin_account_id: 8,
        },
      }),
    ];
    const good = planPortfolioImportReference({
      reference: reference(events),
      rows,
      investments,
    });
    expect(good.blockers).toEqual([]);
    expect(good.supplemental).toHaveLength(1);
    expect(good.supplemental[0].row).toMatchObject({
      units: "0.1",
      amount: "0",
      tx_date: "2024-01-01",
      asset_adjustment_details: { kind: "asset_fee", basisPolicy: "carried" },
    });
    const bad = planPortfolioImportReference({
      reference: reference([
        ...events,
        ppEvent({
          id: "unexplained-middle",
          portfolioId: "portfolio-two",
          date: "2023-06-01",
          shares: "0.1",
        }),
      ]),
      rows,
      investments,
    });
    expect(bad.blockers.map((item) => item.reason)).toContain(
      "reference_unproven_transfer_fee",
    );
  });

  it("retains literal primary Pro execution authority while PP uniquely identifies legacy currency transcription", () => {
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
    const planned = planPortfolioImportReference({
      reference: reference([ppEvent({ type: "SELL", amount: "90" })]),
      rows: [pro],
      investments,
      history: [old],
    });
    expect(planned.blockers).toEqual([]);
    const executionScope = planPortfolioImportReference({
      reference: reference([
        ppEvent({ type: "SELL", amount: "90" }),
        ppEvent({ id: "wallet-only", type: "DELIVERY_INBOUND", shares: "2" }),
      ]),
      rows: [pro],
      investments,
      history: [old],
    });
    expect(executionScope.blockers).toEqual([]);
    expect(executionScope.coverage).toMatchObject({
      matchedReferenceEvents: 1,
      unmatchedMappedReferenceEvents: 0,
      outsideSelectedReferenceEvents: 1,
    });
    const missingExecution = planPortfolioImportReference({
      reference: reference([
        ppEvent({ type: "SELL", amount: "90" }),
        ppEvent({ id: "missing-trade", type: "BUY", shares: "2" }),
      ]),
      rows: [pro],
      investments,
      history: [old],
    });
    expect(missingExecution.blockers.map((item) => item.reason)).toContain(
      "reference_unmatched_event",
    );
    const enriched = planned.corrections[0].after;
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
    const fundingDateSale = {
      ...pro,
      tx_date: "2025-01-14",
      currency: "EUR",
      raw_data: pro.raw_data
        .replace("2025-01-01", "2025-01-14")
        .replace("ETH/USD", "ETH/EUR")
        .replace(",1,USD,completed,", ",1,EUR,completed,"),
    };
    const ppNet = legacy({ type: "sell", amount: "99", price_per_unit: "99" });
    const shifted = planPortfolioImportReference({
      reference: reference([ppEvent({ type: "SELL", amount: "99" })]),
      rows: [fundingDateSale],
      investments,
      history: [ppNet],
    });
    expect(shifted.blockers).toEqual([]);
    expect(
      review(shifted.corrections[0].after, ppNet, "prefer_source").plan,
    ).toMatchObject({ ready: true, summary: { adopt: 1, insert: 0 } });
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
  it("binds rounded PP cash and a cash-consistent price to a unique shifted Pro sale", () => {
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
    const planned = planPortfolioImportReference({
      reference: reference([
        ppEvent({
          type: "SELL",
          shares: "10",
          amount: "19.99",
          units: [{ type: "FEE", amount: { currency: "EUR", amount: "0.03" } }],
        }),
      ]),
      rows: [pro],
      investments,
      history: [old],
    });
    expect(planned.blockers).toEqual([]);
    const enriched = planned.corrections[0].after;
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
    const planned = planPortfolioImportReference({
      reference: reference([
        ppEvent({ type: "BUY", shares: "10", amount: "20" }),
      ]),
      rows: [pro],
      investments,
      history: [old],
    });
    expect(planned.blockers).toEqual([]);
    expect(
      review(planned.corrections[0].after, old, "prefer_source").plan,
    ).toMatchObject({
      ready: true,
      summary: { adopt: 1, insert: 0 },
    });
  });

  it("covers delayed base-fee unit removals without charging net Pro buys a second time", () => {
    const pro = source({
      type: "buy",
      type_raw: "Buy",
      currency: "EUR",
      units: "9.99",
      amount: "19.98",
      price_per_unit: "2",
      fees: "0.02",
      note: undefined,
      asset_transfer_details: undefined,
      custom_config: { format: "nexo_pro_spot_history" },
      source_transaction_id: "nexo-pro:spot:order:PP-BASE-FEE",
      raw_data:
        "203,2025-01-01 12:00:00,ETH/EUR,buy,limit,2,2,,10,10,0.01,ETH,completed,PP-BASE-FEE",
    });
    const events = [
      ppEvent({ type: "BUY", shares: "10", amount: "20" }),
      ppEvent({
        id: "fee-one",
        type: "DELIVERY_OUTBOUND",
        date: "2025-01-02",
        shares: "0.00499999",
        amount: "0.01",
      }),
      ppEvent({
        id: "fee-two",
        type: "DELIVERY_OUTBOUND",
        date: "2025-01-03",
        shares: "0.005",
        amount: "0.01",
      }),
    ];
    // The wallet row keeps custody coverage enabled in this mixed review.
    const wallet = source({
      id: 2,
      row_index: 1,
      route: "cash",
      type: "deposit",
      investment_id: null,
      custom_config: { format: "nexo_transaction_history" },
    });
    const plan = planPortfolioImportReference({
      reference: reference(events),
      rows: [pro, wallet],
      investments,
    });
    expect(plan.blockers).toEqual([]);
    expect(plan.supplemental).toEqual([]);
    expect(plan.matchedReferenceRows).toBe(3);
    const after = plan.corrections.find((item) => item.row.id === pro.id).after;
    expect(after).toMatchObject({
      units: "9.99",
      amount: "19.98",
      fees: "0.02",
      tx_date: "2025-01-01",
    });
    expect(
      JSON.parse(after.raw_data).__portfolioPerformanceReference.evidence
        .baseFeeCoverage,
    ).toMatchObject({
      sourceFeeUnits: "0.01",
      recordedFeeUnits: "0.00999999",
      roundingDifferenceUnits: "0.00000001",
    });
    const wrong = planPortfolioImportReference({
      reference: reference(
        events.map((item) =>
          item.id === "fee-two" ? { ...item, shares: "0.00499997" } : item,
        ),
      ),
      rows: [pro, wallet],
      investments,
    });
    expect(
      wrong.blockers.filter(
        (item) => item.reason === "reference_unmatched_event",
      ),
    ).toHaveLength(2);
    const premature = planPortfolioImportReference({
      reference: reference(
        events.map((item) =>
          item.id === "fee-two" ? { ...item, date: "2024-01-01" } : item,
        ),
      ),
      rows: [pro, wallet],
      investments,
    });
    expect(premature.blockers.map((item) => item.reason)).toContain(
      "reference_unmatched_event",
    );
  });

  it("covers the alternate PP net transfer plus fee only with one exact same-day decomposition", () => {
    const rows = [
      source({
        type: null,
        route: "asset_transfer",
        type_raw: "AssetTransfer",
        units: "1.1",
        asset_transfer_details: {
          direction: "out",
          basisStatus: "carried",
          feeUnits: "0.1",
          receivedUnits: "1",
        },
        custom_config: {
          format: "kinesis_transaction_history",
          transfer_destination_account_id: 8,
        },
      }),
      source({
        id: 2,
        row_index: 1,
        tx_date: "2025-01-02",
        note: "Holder's Distribution units",
        asset_transfer_details: undefined,
        asset_adjustment_details: {
          kind: "yield_acquisition",
          basisPolicy: "zero",
        },
      }),
    ];
    const events = [
      ppEvent({
        id: "custody-out",
        type: "TRANSFER_OUT",
        pairId: "custody-in",
      }),
      ppEvent({
        id: "custody-in",
        type: "TRANSFER_IN",
        pairId: "custody-out",
        portfolioId: "portfolio-two",
      }),
      ppEvent({ id: "custody-fee", type: "DELIVERY_OUTBOUND", shares: "0.1" }),
      ppEvent({ id: "binding-yield", date: "2025-01-02" }),
    ];
    const covered = planPortfolioImportReference({
      reference: reference(events),
      rows,
      investments,
    });
    expect(covered.blockers).toEqual([]);
    expect(covered.coverage.matchedReferenceEvents).toBe(4);
    expect(covered.supplemental).toEqual([]);
    const ambiguous = planPortfolioImportReference({
      reference: reference([
        ...events,
        ppEvent({
          id: "fee-duplicate",
          type: "DELIVERY_OUTBOUND",
          shares: "0.1",
        }),
      ]),
      rows,
      investments,
    });
    expect(ambiguous.blockers.map((x) => x.reason)).toContain(
      "reference_unmatched_event",
    );
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
