import { describe, expect, it } from "vitest";
import { buildPortfolioImportReconciliationPlan } from "../src/services/portfolioImportReconciliationService.ts";
import type { ReconciliationPlanInput } from "../src/services/portfolioImportReconciliationService.ts";
import { loose } from "./helpers/partial.ts";

import { syntheticIbkrPlannerSource } from "./helpers/ibkrReconciliation.ts";

const manual = (overrides = {}) => ({
  id: 40,
  investment_id: 1,
  type: "buy",
  date: "2026-01-01",
  amount: "500.0000",
  units: "5.00000000",
  price_per_unit: "100.000000",
  fees: "0.0000",
  taxes: "0.0000",
  currency: "EUR",
  fx_rate_to_eur: null,
  account_id: null,
  note: "Keep this manual note",
  is_recurring: false,
  recurrence_interval: null,
  recurrence_end_date: null,
  import_batch_id: null,
  source_record_hash: null,
  dedup_fingerprint: null,
  dedup_fingerprint_version: null,
  dividend_amount_convention: "unknown",
  ...overrides,
});
type Source = ReturnType<typeof syntheticIbkrPlannerSource>;
type Manual = ReturnType<typeof manual>;

function imported(source: Source, id = 41) {
  return manual({
    id,
    type: source.type,
    date: source.tx_date,
    amount: source.amount,
    units: source.units,
    price_per_unit: source.price_per_unit,
    fees: source.fees,
    taxes: source.taxes,
    currency: source.currency,
    fx_rate_to_eur: source.fx_rate_to_eur,
    account_id: 7,
    note: source.note,
    import_batch_id: "1",
    source_record_hash: source.source_record_hash,
    dedup_fingerprint: source.dedup_fingerprint,
    dedup_fingerprint_version: 1,
  });
}
function build(rows: Source[], history: Manual[], importedRows: Manual[] = []) {
  // Batch and repair-context rows carry only the fields the planner reads.
  return buildPortfolioImportReconciliationPlan(
    loose<ReconciliationPlanInput>({
      rows,
      history,
      batches: [{ id: 2, account_id: 7, status: "awaiting_review" }],
      adoptPolicy: "prefer_source",
      repairContext: {
        transactions: [],
        knownTransactionIds: [],
        batches: importedRows.length
          ? [{ id: 1, status: "complete", rows_imported: importedRows.length }]
          : [],
        staging: importedRows.map((copy, index) => ({
          id: index + 100,
          batch_id: 1,
          route: "portfolio",
          committed_txn_id: copy.id,
          status: "committed",
          dedup_fingerprint: copy.dedup_fingerprint,
          note: copy.note,
        })),
      },
    }),
  );
}

describe("bounded IBKR planner integration", () => {
  it("uses primary currency-label identity only for a proven imported-copy repair", () => {
    const row = syntheticIbkrPlannerSource();
    const copy = imported(row);
    const result = build([row], [manual(), copy], [copy]);
    expect(result.plan).toMatchObject({
      ready: true,
      summary: { repair_duplicate: 1, insert: 0 },
    });
    expect(result.adoptions[0]!.after).toMatchObject({
      id: 40,
      note: "Keep this manual note",
      type: "buy",
      amount: "500",
      currency: "USD",
      fx_rate_to_eur: "0.8",
      fees: "2",
    });
    expect(build([row], [manual()]).plan.ready).toBe(false);
  });
  it("allows an exact-date failed sale with authenticated native economics and retains the Nexo date boundary", () => {
    const row = syntheticIbkrPlannerSource({
      type: "sell",
      literal: {
        "Transaction Type": "Sell",
        "Gross Amount": "400",
        "Net Amount": "398.4",
      },
    });
    const current = manual({ type: "sell" });
    expect(build([row], [current]).plan).toMatchObject({
      ready: true,
      summary: { adopt: 1, insert: 0 },
    });
    current.date = "2026-01-02";
    expect(build([row], [current]).plan.ready).toBe(false);
    current.date = "2026-01-20";
    expect(build([row], [current]).plan.summary.adopt).toBe(0);
  });
  it.each(["context", "hash", "date", "price", "fees"])(
    "blocks mismatched %s primary evidence",
    (kind) => {
      const row = syntheticIbkrPlannerSource();
      const copy = imported(row);
      if (kind === "context")
        delete (row.custom_config as Partial<Source["custom_config"]>)
          .ibkr_source_context;
      if (kind === "hash") row.source_record_hash = "f".repeat(64);
      if (kind === "date")
        row.custom_config.ibkr_source_context.record_hashes = [];
      if (kind === "price")
        row.raw_data = row.raw_data.replace(",100,USD,", ",101,USD,");
      if (kind === "fees")
        row.custom_config.ibkr_source_context.summary_base_currency_record =
          "Summary,Data,Base Currency,USD";
      expect(build([row], [manual(), copy], [copy]).plan.ready).toBe(false);
    },
  );
  it("narrows contested exact trade identities and settles the other existing copy as a duplicate, never an insert", () => {
    const exact = syntheticIbkrPlannerSource({
      currency: "EUR",
      fx_rate_to_eur: "1.0000000000",
      literal: {
        "Price Currency": "EUR",
        "Gross Amount": "-500",
        Commission: "-2",
        "Net Amount": "-502",
        "Exchange Rate": "1",
      },
    });
    const other = syntheticIbkrPlannerSource({
      id: 11,
      row_index: 1,
      amount: "505.0000",
      price_per_unit: "101.000000",
      currency: "EUR",
      fx_rate_to_eur: "1.0000000000",
      literal: {
        Price: "101",
        "Price Currency": "EUR",
        "Gross Amount": "-505",
        Commission: "-2",
        "Net Amount": "-507",
        "Exchange Rate": "1",
      },
    });
    const copies = [imported(exact, 41), imported(other, 42)];
    const result = build([exact, other], [manual(), ...copies], copies);
    expect(result.plan).toMatchObject({
      ready: true,
      summary: { repair_duplicate: 1, duplicate: 1, insert: 0 },
    });
    expect(
      result.plan.actions.find((action) => action.rowId === 11),
    ).toMatchObject({ action: "duplicate", existingTransactionId: 42 });
    expect(result.adoptions[0]!.before.id).toBe(40);
  });
  it("keeps gross/net candidates ambiguous instead of expanding repair eligibility", () => {
    const exact = syntheticIbkrPlannerSource({
      currency: "EUR",
      fx_rate_to_eur: "1.0000000000",
      literal: {
        "Price Currency": "EUR",
        "Gross Amount": "-500",
        Commission: "-2",
        "Net Amount": "-502",
        "Exchange Rate": "1",
      },
    });
    const net = syntheticIbkrPlannerSource({
      id: 11,
      row_index: 1,
      amount: "502.0000",
      price_per_unit: "100.400000",
      currency: "EUR",
      fx_rate_to_eur: "1.0000000000",
      literal: {
        Price: "100.4",
        "Price Currency": "EUR",
        "Gross Amount": "-502",
        Commission: "-2",
        "Net Amount": "-504",
        "Exchange Rate": "1",
      },
    });
    const copies = [imported(exact, 41), imported(net, 42)];
    expect(
      build([exact, net], [manual(), ...copies], copies).plan,
    ).toMatchObject({
      ready: false,
      summary: { repair_duplicate: 0, insert: 0 },
    });
  });

  it("repairs a copied dividend label and removes inline withholding only with the proved separate tax", () => {
    const income = syntheticIbkrPlannerSource({
      type: "dividend",
      amount: "3.3333",
      units: null,
      price_per_unit: null,
      fees: "0",
      currency: "EUR",
      fx_rate_to_eur: null,
      literal: {
        "Transaction Type": "Dividend",
        Quantity: "-",
        Price: "-",
        "Price Currency": "-",
        "Gross Amount": "3.3333333",
        Commission: "0",
        "Net Amount": "3.3333333",
      },
    });
    const tax = syntheticIbkrPlannerSource({
      id: 11,
      row_index: 1,
      type: "tax",
      type_raw: "tax",
      amount: "0.3333",
      units: null,
      price_per_unit: null,
      fees: "0",
      currency: "EUR",
      fx_rate_to_eur: null,
      literal: {
        "Transaction Type": "Foreign Tax Withholding",
        Quantity: "-",
        Price: "-",
        "Price Currency": "-",
        "Gross Amount": "-0.3333333",
        Commission: "0",
        "Net Amount": "-0.3333333",
      },
    });
    const current = manual({
      type: "dividend",
      amount: "3.33",
      units: null,
      price_per_unit: null,
      taxes: "0.33",
      currency: "USD",
    });
    const copies = [imported(income, 41), imported(tax, 42)];
    const result = build([income, tax], [current, ...copies], copies);
    expect(result.plan).toMatchObject({
      ready: true,
      summary: { repair_duplicate: 1, duplicate: 1, insert: 0 },
    });
    expect(result.adoptions[0]!.after).toMatchObject({
      id: 40,
      amount: "3.3333",
      taxes: "0",
      currency: "EUR",
      fx_rate_to_eur: null,
      dividend_amount_convention: "gross",
    });
    expect(build([income], [current, ...copies], copies).plan.ready).toBe(
      false,
    );
    const foreignTax = structuredClone(tax);
    foreignTax.source_account_identity = "OTHER-SYNTHETIC-ACCOUNT";
    expect(
      build([income, foreignTax], [current, ...copies], copies).plan.ready,
    ).toBe(false);
    const ambiguousTax = { ...tax, id: 12, dedup_fingerprint: "c".repeat(64) };
    expect(
      build([income, tax, ambiguousTax], [current, ...copies], copies).plan
        .ready,
    ).toBe(false);
  });
});
