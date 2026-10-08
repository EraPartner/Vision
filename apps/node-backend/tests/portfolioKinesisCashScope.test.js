import { describe, it, expect } from "vitest";
import { buildPortfolioImportReconciliationPlan } from "../src/services/portfolioImportReconciliationService.ts";
import {
  proveKinesisCashSources,
  cashFeeFingerprint,
} from "../src/services/portfolioKinesisCashScope.ts";
import { cashSource } from "./helpers/kinesisCashScope.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const plan = (source, extra = {}) =>
  buildPortfolioImportReconciliationPlan({
    ...source,
    adoptPolicy: "preserve_existing",
    reconciliationScope: "record_cash_only",
    cashFundingPolicy: "own_account_transfer",
    ...extra,
  }).plan;
describe("complete source-owned Kinesis cash", () => {
  it("selects only complete native chains and preserves unrelated source events", async () => {
    const source = await cashSource();
    const before = structuredClone(source);
    const result = plan(source);
    expect(result).toMatchObject({
      ready: true,
      summary: {
        cash: 6,
        insert: 0,
        adopt: 0,
        repair_duplicate: 0,
        record_income: 0,
      },
      pending: 3,
      complete: false,
    });
    expect(
      result.actions.every(
        (action) =>
          action.cashProof.memberCount === 6 &&
          action.cashValues.transferSource === "brokerage" &&
          action.cashValues.transferPeerId === null,
      ),
    ).toBe(true);
    expect(
      result.actions.filter((action) => action.cashValues.isTransfer),
    ).toHaveLength(4);
    expect(
      result.actions.filter((action) => !action.cashValues.isTransfer),
    ).toHaveLength(2);
    expect(result.actions.map((action) => action.cashValues.amount)).toEqual([
      "100.0000",
      "-60.0000",
      "-10.0000",
      "-29.0000",
      "20.0000",
      "-20.0000",
    ]);
    expect(
      result.actions.filter((action) => action.cashFeeValues),
    ).toHaveLength(1);
    expect(
      result.actions.find((action) => action.cashFeeValues).cashFeeValues,
    ).toMatchObject({ amount: "-1.0000", isTransfer: false });
    expect(source).toEqual(before);
  });
  it.each([
    "missing_capture",
    "filtered",
    "missing_cash",
    "raw_tamper",
    "amount",
    "fees",
    "taxes",
    "currency",
    "units",
    "price",
    "fx",
    "instrument",
    "route",
    "fingerprint",
    "account",
    "same_source_twice",
  ])("rejects %s without partial cash selection", async (kind) => {
    const source = await cashSource();
    const row = source.rows.find((item) => item.route === "cash");
    if (kind === "missing_capture")
      delete source.batches[0].custom_config.kinesis_source_context;
    if (kind === "filtered")
      source.batches[0].custom_config.included_symbols = ["KAU"];
    if (kind === "missing_cash")
      source.rows.splice(source.rows.indexOf(row), 1);
    if (kind === "raw_tamper") row.raw_data += " ";
    if (kind === "amount") row.amount = "999";
    if (kind === "fees") row.fees = "1";
    if (kind === "taxes") row.taxes = "1";
    if (kind === "currency") row.currency = "USD";
    if (kind === "units") row.units = "1";
    if (kind === "price") row.price_per_unit = "1";
    if (kind === "fx") row.fx_rate_to_eur = "1";
    if (kind === "instrument") row.investment_id = 8;
    if (kind === "route") row.route = "portfolio";
    if (kind === "fingerprint") row.dedup_fingerprint = "f".repeat(64);
    if (kind === "account") row.account_id = 8;
    if (kind === "same_source_twice") {
      const second = await cashSource({ batchId: 3, rowStart: 100 });
      source.rows.push(...second.rows);
      source.batches.push(...second.batches);
    }
    expect(plan(source)).toMatchObject({ ready: false });
    expect(plan(source).summary.cash).toBe(0);
  });
  it("requires explicit preserve policy and source-bound funding confirmation", async () => {
    const source = await cashSource();
    expect(() => plan(source, { adoptPolicy: "prefer_source" })).toThrow(
      /preserve_existing/,
    );
    expect(() => plan(source, { cashFundingPolicy: undefined })).toThrow(
      /funding/,
    );
  });
  it.each([
    "opening_balance",
    "chain_gap",
    "fee_total",
    "fee_currency",
    "cent_residual",
  ])(
    "rejects authentic but incomplete or unallocatable literal cash: %s",
    async (kind) => {
      const lines = (
        await fs.readFile(
          new URL(
            "./fixtures/portfolio/kinesis-closed-cash.csv",
            import.meta.url,
          ),
          "utf8",
        )
      )
        .trim()
        .split("\n")
        .map((line) => line.split(","));
      const withdrawal = lines.find((line) => line[4] === "C-OUT-EUR");
      if (kind === "opening_balance")
        for (const line of lines.slice(1).filter((row) => row[2] === "EUR")) {
          line[14] = String(Number(line[14]) + 1);
          line[16] = String(Number(line[16]) + 1);
        }
      if (kind === "chain_gap") {
        lines[3][14] = "101";
        lines[3][16] = "41";
      }
      if (kind === "fee_total") withdrawal[7] = "28";
      if (kind === "fee_currency") withdrawal[11] = "USD";
      if (kind === "cent_residual") {
        withdrawal[7] = "28.995";
        withdrawal[10] = "1.005";
      }
      const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), "vision-cash-literal-"),
      );
      try {
        const sourcePath = path.join(directory, "synthetic.csv");
        await fs.writeFile(
          sourcePath,
          lines.map((line) => line.join(",")).join("\n") + "\n",
        );
        expect(plan(await cashSource({ sourcePath }))).toMatchObject({
          ready: false,
          summary: { cash: 0 },
          selectedRowIds: [],
        });
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
  );
  it("defers every cash member when a historical quote is unavailable and binds rate changes", async () => {
    const source = await cashSource();
    const first = plan(source);
    source.historicalFxContext[0].rate = null;
    expect(plan(source)).toMatchObject({
      ready: true,
      summary: { cash: 0 },
      selectedRowIds: [],
      pending: 9,
    });
    source.historicalFxContext[0].rate = "0.9";
    expect(plan(source).planFingerprint).not.toBe(first.planFingerprint);
  });
  it("rejects existing cash resemblance without an owned immutable image", async () => {
    const source = await cashSource();
    const row = source.rows[0];
    source.cashContext.ledger.push({
      id: 500,
      date: row.tx_date,
      currency: row.currency,
      amount: row.amount,
      account_id: row.account_id,
      is_active: true,
    });
    expect(plan(source)).toMatchObject({ ready: false, summary: { cash: 0 } });
  });
  it.each(["opening", "other_currency", "ordinary"])(
    "rejects unrelated active account cash: %s",
    async (kind) => {
      const source = await cashSource();
      source.cashContext.ledger.push({
        id: 900,
        date: "2020-01-01",
        amount: "0.0100",
        currency: kind === "other_currency" ? "GBP" : "EUR",
        account_id: source.batches[0].account_id,
        is_active: true,
        transfer_source: kind === "opening" ? "opening" : null,
      });
      expect(plan(source)).toMatchObject({
        ready: false,
        summary: { cash: 0 },
        selectedRowIds: [],
        blockers: expect.arrayContaining([
          expect.objectContaining({ reason: "cash_account_not_empty" }),
        ]),
      });
      source.cashContext.ledger[0].is_active = false;
      expect(plan(source)).toMatchObject({ ready: true, summary: { cash: 6 } });
    },
  );
  it("rejects an unproved statement reading even at zero and binds the complete reading context", async () => {
    const source = await cashSource();
    const first = plan(source);
    source.cashContext.statementBalances = [
      {
        account_id: source.batches[0].account_id,
        currency: "EUR",
        balance: "0.0000",
        balance_date: "2020-01-01",
      },
    ];
    expect(plan(source)).toMatchObject({
      ready: false,
      summary: { cash: 0 },
      selectedRowIds: [],
    });
    expect(plan(source).planFingerprint).not.toBe(first.planFingerprint);
  });
  it("repeats only unchanged same-file owned cash and rejects a changed transfer flag", async () => {
    const source = await cashSource();
    const prior = await cashSource({ batchId: 1, rowStart: 100 });
    const proof = proveKinesisCashSources(
      prior.rows,
      prior.batches,
      "own_account_transfer",
    );
    const ledger = proof.groups[0].members.flatMap((member, index) => {
      const after = {
        id: 500 + index,
        amount: member.values.amount,
        date: member.values.date,
        currency: member.values.currency,
        account_id: member.values.accountId,
        is_active: true,
        is_transfer: member.values.isTransfer,
        transfer_source: "brokerage",
        transfer_peer_id: null,
        source_record_hash: member.row.source_record_hash,
        dedup_fingerprint: member.row.dedup_fingerprint,
        dedup_fingerprint_version: 1,
      };
      const feeAfter = member.feeValues
        ? {
            ...after,
            id: 600 + index,
            amount: member.feeValues.amount,
            is_transfer: false,
            dedup_fingerprint: cashFeeFingerprint(member.row),
          }
        : undefined;
      member.row.status = "committed";
      member.row.committed_txn_id = after.id;
      member.row.raw_data = JSON.stringify({
        primaryRawData: member.row.raw_data,
        portfolioCashReceipt: {
          version: 1,
          after,
          values: member.values,
          proof: member.proof,
          ...(feeAfter ? { feeAfter, feeValues: member.feeValues } : {}),
        },
      });
      return feeAfter ? [after, feeAfter] : [after];
    });
    source.cashContext = {
      ledger,
      sources: prior.rows,
      batches: prior.batches,
    };
    expect(plan(source)).toMatchObject({
      ready: true,
      summary: { cash: 0, duplicate: 6 },
    });
    const ownedRow = prior.rows.find((row) => row.committed_txn_id);
    ownedRow.committed_txn_id += 1;
    expect(plan(source)).toMatchObject({
      ready: false,
      summary: { duplicate: 0 },
    });
    ownedRow.committed_txn_id -= 1;
    ownedRow.status = "duplicate";
    expect(plan(source)).toMatchObject({
      ready: false,
      summary: { duplicate: 0 },
    });
    ownedRow.status = "committed";
    source.cashContext.ledger[0].is_transfer = false;
    expect(plan(source)).toMatchObject({
      ready: false,
      summary: { cash: 0, duplicate: 0 },
    });
  });
});
