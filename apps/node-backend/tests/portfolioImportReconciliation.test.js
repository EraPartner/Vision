import { describe, expect, it } from "vitest";
import { buildPortfolioImportReconciliationPlan } from "../src/services/portfolioImportReconciliationService.js";

const legacy = (over = {}) => ({
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
  note: "Manual research note",
  import_batch_id: null,
  source_record_hash: null,
  dedup_fingerprint: null,
  dedup_fingerprint_version: null,
  ...over,
});
const source = (over = {}) => ({
  id: 10,
  batch_id: 1,
  row_index: 0,
  status: "matched",
  route: "portfolio",
  type: "buy",
  tx_date: "2026-01-01",
  investment_id: 1,
  asset_class: "stock",
  account_id: 7,
  amount: "500.0000",
  units: "5.00000000",
  price_per_unit: "100.000000",
  fees: "0.0000",
  taxes: "0.0000",
  currency: "EUR",
  fx_rate_to_eur: null,
  dedup_fingerprint: "a".repeat(64),
  dedup_fingerprint_version: 1,
  source_record_hash: "b".repeat(64),
  custom_config: { format: "saxo_transaction_history" },
  ...over,
});
const plan = (rows, history, adoptPolicy, batchPolicies = []) =>
  buildPortfolioImportReconciliationPlan({
    rows,
    history,
    batches: [...new Set(rows.map((row) => row.batch_id))].map((id) => ({
      id,
      account_id: 7,
      status: "awaiting_review",
    })),
    adoptPolicy,
    batchPolicies,
  });

describe("portfolio history adoption plan", () => {
  it.each(["dividend", "interest"])(
    "proves gross-to-net %s using withholding subtraction and known FX",
    (type) => {
      const income = source({
        type,
        amount: "100",
        units: null,
        price_per_unit: null,
        taxes: "15",
      });
      const net = legacy({
        type,
        amount: "85",
        units: null,
        price_per_unit: null,
        dividend_amount_convention: type === "dividend" ? "net" : "unknown",
      });
      expect(plan([income], [net], "prefer_source").plan.ready).toBe(true);
      expect(
        plan([income], [{ ...net, amount: "115" }], "prefer_source").plan
          .blockers[0].reason,
      ).toBe("unproven_economics");
      const foreign = { ...income, currency: "USD", fx_rate_to_eur: "0.8" };
      expect(
        plan([foreign], [{ ...net, amount: "68" }], "prefer_source").plan.ready,
      ).toBe(true);
      expect(
        plan(
          [{ ...foreign, fx_rate_to_eur: null }],
          [{ ...net, amount: "68" }],
          "prefer_source",
        ).plan.blockers[0].reason,
      ).toBe("unproven_currency_conversion");
    },
  );
  it("binds sorted per-batch preservation and source overrides with global fallback", () => {
    const rows = [
      source({ currency: "USD", amount: "600", price_per_unit: "120" }),
      source({
        id: 11,
        batch_id: 2,
        investment_id: 2,
        fees: "2",
        tx_date: "2026-01-03",
        dedup_fingerprint: "c".repeat(64),
      }),
    ];
    const existing = [legacy(), legacy({ id: 41, investment_id: 2 })];
    const overrides = [
      { batchId: 2, adoptPolicy: "prefer_source" },
      { batchId: 1, adoptPolicy: "preserve_existing" },
    ];
    const result = plan(rows, existing, undefined, overrides);
    expect(result.plan).toMatchObject({
      ready: true,
      batchPolicies: [overrides[1], overrides[0]],
    });
    expect(result.adoptions.map((item) => item.policy)).toEqual([
      "preserve_existing",
      "prefer_source",
    ]);
    expect(result.adoptions[0].after).toMatchObject({
      currency: "EUR",
      amount: "500.0000",
    });
    expect(result.adoptions[1].after).toMatchObject({
      fees: "2",
      date: "2026-01-03",
    });
    expect(result.plan.planFingerprint).toBe(
      plan(rows, existing, undefined, overrides.toReversed()).plan
        .planFingerprint,
    );
    expect(
      plan(rows, existing, "prefer_source", [overrides[1]]).plan.ready,
    ).toBe(true);
    expect(plan(rows, existing).plan.planFingerprint).not.toBe(
      result.plan.planFingerprint,
    );
    expect(() =>
      plan(rows, existing, undefined, [
        { batchId: 3, adoptPolicy: "preserve_existing" },
      ]),
    ).toThrow("batch_policies");
    expect(() =>
      plan(rows, existing, undefined, [overrides[0], overrides[0]]),
    ).toThrow("batch_policies");
    const duplicate = { ...rows[0], id: 12, batch_id: 2 };
    expect(
      plan([rows[0], duplicate], [existing[0]], undefined, overrides).plan
        .blockers[0].reason,
    ).toBe("source_policy_conflict");
  });
  it("requires same-account Pro history before accepting Wallet internal annotations", () => {
    const movement = source({
      route: "account_internal",
      type: null,
      investment_id: null,
      asset_transfer_details: { direction: "internal" },
      custom_config: { format: "nexo_transaction_history" },
    });
    expect(plan([movement], []).plan.blockers[0].reason).toBe(
      "missing_companion_pro_history",
    );
    const pro = source({
      id: 11,
      batch_id: 2,
      custom_config: { format: "nexo_pro_spot_history" },
    });
    expect(plan([movement, pro], []).plan).toMatchObject({
      ready: true,
      summary: { internal_annotation: 1, insert: 1 },
    });
    expect(
      plan([{ ...movement, account_id: 9 }, pro], []).plan.blockers[0].reason,
    ).toBe("missing_companion_pro_history");
  });
  it("uses literal Nexo Pro base-fee proof for gross-to-net unit corrections", () => {
    const pro = source({
      symbol_raw: "SYN",
      units: "9.97",
      amount: "19.94",
      fees: "0.06",
      price_per_unit: "2",
      source_transaction_id: "nexo-pro:spot:order:PRO-SYNTHETIC-ORDER",
      custom_config: { format: "nexo_pro_spot_history" },
      raw_data:
        "201,2026-01-01 23:59:59.123,SYN/EUR,buy,limit,999,2,,100,10,0.03,SYN,completed,PRO-SYNTHETIC-ORDER",
    });
    const old = legacy({ units: "10", amount: "20", price_per_unit: "2" });
    expect(plan([pro], [old]).plan.summary.insert).toBe(0);
    const corrected = plan([pro], [old], "prefer_source");
    expect(corrected.plan.ready).toBe(true);
    expect(corrected.adoptions[0].after).toMatchObject({
      units: "9.97",
      amount: "19.94",
      fees: "0.06",
    });
    const unproven = {
      ...pro,
      raw_data: pro.raw_data.replace(",999,2,", ",999,3,"),
    };
    expect(plan([unproven], [old]).plan.summary.insert).toBe(0);
    expect(
      plan([unproven], [old], "prefer_source").plan.blockers[0].reason,
    ).toBe("unproven_units");
  });

  it.each(["19.9998", "19.9999"])(
    "reconciles a literal base-fee execution after amount rounding to %s",
    (amount) => {
      const pro = source({
        symbol_raw: "SYN",
        units: "9.999925",
        amount,
        fees: "0.0002",
        price_per_unit: "2",
        source_transaction_id: "nexo-pro:spot:order:PRO-HALF-DECIMAL",
        custom_config: { format: "nexo_pro_spot_history" },
        raw_data:
          "203,2026-01-01 12:00:00,SYN/EUR,buy,limit,2,2,,10,10,0.000075,SYN,completed,PRO-HALF-DECIMAL",
      });
      const old = legacy({ units: "10", amount: "20", price_per_unit: "2" });
      expect(plan([pro], [old], "prefer_source").plan).toMatchObject({
        ready: true,
        summary: { adopt: 1, insert: 0 },
      });
      expect(
        plan([{ ...pro, amount: "19.9997" }], [old], "prefer_source").plan
          .summary.adopt,
      ).toBe(0);
    },
  );

  it("corrects a 13-day Nexo Pro funding-date sale only with literal matching price and cash evidence", () => {
    const pro = source({
      type: "sell",
      symbol_raw: "SYN",
      tx_date: "2026-01-14",
      units: "10",
      amount: "20",
      fees: "0.1",
      price_per_unit: "2",
      source_transaction_id: "nexo-pro:spot:order:PRO-SYNTHETIC-SALE",
      custom_config: { format: "nexo_pro_spot_history" },
      raw_data:
        "202,2026-01-14 12:00:00,SYN/EUR,sell,market,20,2,,10,10,0.1,EUR,completed,PRO-SYNTHETIC-SALE",
    });
    const old = legacy({
      type: "sell",
      units: "10",
      amount: "19.9",
      price_per_unit: "2",
    });
    const corrected = plan([pro], [old], "prefer_source");
    expect(corrected.plan).toMatchObject({
      ready: true,
      summary: { adopt: 1, insert: 0 },
    });
    expect(corrected.plan.actions[0].corrections).toContain("date");
    expect(corrected.adoptions[0].after.date).toBe("2026-01-14");
    expect(
      plan([pro], [old, { ...old, id: 41 }], "prefer_source").plan.blockers[0]
        .reason,
    ).toBe("ambiguous_history");
    expect(
      plan([pro], [{ ...old, amount: "18" }], "prefer_source").plan.summary
        .adopt,
    ).toBe(0);
    expect(
      plan([pro], [{ ...old, amount: "18" }], "preserve_existing").plan,
    ).toMatchObject({ ready: false, summary: { insert: 0 } });
    expect(
      plan([pro], [{ ...old, price_per_unit: "3" }], "prefer_source").plan
        .summary.adopt,
    ).toBe(0);
    expect(
      plan([{ ...pro, tx_date: "2026-02-02" }], [old], "prefer_source").plan
        .summary.adopt,
    ).toBe(0);
    expect(
      plan(
        [{ ...pro, custom_config: { format: "saxo_transaction_history" } }],
        [old],
        "prefer_source",
      ).plan.summary.adopt,
    ).toBe(0);
  });

  it("dedups dated custody source identities before projecting another movement", () => {
    const outgoing = source({
      route: "asset_transfer",
      type: null,
      asset_transfer_details: {
        direction: "out",
        basisStatus: "carried",
        feeUnits: "0",
      },
      custom_config: { transfer_destination_account_id: 8 },
    });
    const duplicate = { ...outgoing, id: 11, batch_id: 2 };
    const preview = plan([outgoing, duplicate], []).plan;
    expect(preview).toMatchObject({
      ready: true,
      summary: { transfer: 1, duplicate_source: 1 },
    });
    expect(preview.actions[0].transfer).toMatchObject({
      sourceAccountId: 7,
      destinationAccountId: 8,
      units: "5.00000000",
      receivedUnits: "5",
    });
    const existing = {
      id: 42,
      type: "asset_transfer",
      investment_id: 1,
      source_account_id: 7,
      destination_account_id: 8,
      date: "2026-01-01",
      units: "5",
      fee_units: "0",
      dedup_fingerprint: outgoing.dedup_fingerprint,
      dedup_fingerprint_version: 1,
    };
    expect(plan([outgoing], [existing]).plan.summary.duplicate).toBe(1);
    expect(
      plan(
        [
          {
            ...outgoing,
            custom_config: { transfer_destination_account_id: 9 },
          },
        ],
        [existing],
      ).plan.blockers[0].reason,
    ).toBe("source_identity_conflict");
  });
  it("adopts exact legacy evidence without changing financial values or notes", () => {
    const result = plan([source()], [legacy()]);
    expect(result.plan.ready).toBe(true);
    expect(result.plan.actions[0]).toMatchObject({
      action: "adopt",
      policy: "exact",
      existingTransactionId: 40,
    });
    expect(result.adoptions[0].after).toMatchObject({
      amount: "500.0000",
      date: "2026-01-01",
      note: "Manual research note",
      account_id: 7,
      import_batch_id: null,
    });
  });

  it("requires explicit policy for dates and fees within the seven-day candidate window", () => {
    const result = plan(
      [source({ tx_date: "2026-01-07", fees: "2.0000" })],
      [legacy()],
    );
    expect(result.plan.ready).toBe(false);
    expect(result.plan.actions[0]).toMatchObject({
      action: "policy_required",
      corrections: expect.arrayContaining(["date", "fees"]),
    });
  });

  it("never adds a same-units cross-currency candidate without a policy", () => {
    const result = plan(
      [source({ currency: "USD", amount: "600", price_per_unit: "120" })],
      [legacy()],
    );
    expect(result.plan.summary.insert).toBe(0);
    expect(result.plan.blockers[0].reason).toBe("source_policy_required");
    expect(
      plan(
        [source({ currency: "USD", amount: "600", price_per_unit: "120" })],
        [legacy()],
        "prefer_source",
      ).plan.blockers[0].reason,
    ).toBe("unproven_currency_conversion");
  });

  it("preserves known acquisition basis on a transfer placeholder only by explicit policy", () => {
    const incoming = source({
      type: "gift",
      amount: "0",
      price_per_unit: null,
      note: "Kinesis asset transfer in; original cost basis unavailable",
    });
    expect(plan([incoming], [legacy()]).plan.blockers[0].reason).toBe(
      "missing_original_basis",
    );
    const adopted = plan([incoming], [legacy()], "preserve_existing");
    expect(adopted.plan.ready).toBe(true);
    expect(adopted.adoptions[0].after).toMatchObject({
      type: "buy",
      amount: "500.0000",
      units: "5.00000000",
    });
    expect(plan([incoming], [], "preserve_existing").plan.ready).toBe(false);
  });

  it("requires global one-to-one uniqueness across different files and accounts", () => {
    const rows = [
      source(),
      source({
        id: 20,
        batch_id: 2,
        account_id: 9,
        dedup_fingerprint: "c".repeat(64),
      }),
    ];
    const result = plan(rows, [legacy()], "preserve_existing");
    expect(result.plan.ready).toBe(false);
    expect(
      result.plan.blockers.every(
        (blocker) => blocker.reason === "ambiguous_history",
      ),
    ).toBe(true);
    expect(result.adoptions).toHaveLength(0);
  });

  it("dedups repeated immutable source identities before allocating legacy rows", () => {
    const result = plan(
      [source(), source({ id: 20, batch_id: 2 })],
      [legacy()],
    );
    expect(result.plan.ready).toBe(true);
    expect(result.plan.summary.adopt).toBe(1);
    expect(result.plan.summary.duplicate_source).toBe(1);
  });

  it("blocks existing assigned or stamped transactions instead of treating them as new", () => {
    expect(
      plan([source()], [legacy({ account_id: 9 })], "preserve_existing").plan
        .blockers[0].reason,
    ).toBe("existing_assigned_or_imported_history");
    expect(
      plan([source()], [legacy({ import_batch_id: "8" })], "preserve_existing")
        .plan.blockers[0].reason,
    ).toBe("existing_assigned_or_imported_history");
  });

  it("recognizes a canonical immutable fingerprint as a no-op first", () => {
    const result = plan(
      [source()],
      [
        legacy({
          account_id: 7,
          dedup_fingerprint: "a".repeat(64),
          dedup_fingerprint_version: 1,
        }),
      ],
    );
    expect(result.plan.ready).toBe(true);
    expect(result.plan.summary.duplicate).toBe(1);
    expect(result.adoptions).toHaveLength(0);
  });

  it("binds account selection, source records, existing notes and policy into its plan fingerprint", () => {
    const initial = plan([source()], [legacy()]).plan.planFingerprint;
    expect(
      plan([source({ account_id: 9 })], [legacy()]).plan.planFingerprint,
    ).not.toBe(initial);
    expect(
      plan([source()], [legacy({ note: "Changed" })]).plan.planFingerprint,
    ).not.toBe(initial);
    expect(
      plan([source()], [legacy()], "preserve_existing").plan.planFingerprint,
    ).not.toBe(initial);
  });
});
