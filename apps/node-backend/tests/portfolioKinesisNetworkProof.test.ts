import { describe, it, expect } from "vitest";
import { networkReceipt, networkSource } from "./helpers/kinesisNetwork.ts";
import type { NetworkSourceRow } from "./helpers/kinesisNetwork.ts";
import { loose } from "./helpers/partial.ts";
import {
  verifyKinesisNetworkReceipt,
  verifiedKinesisNetworkRow as rawVerifiedRow,
  proveKinesisNetworkBindings as rawProveBindings,
} from "../src/services/portfolioKinesisNetworkProof.ts";
import {
  assignImportIdentities,
  portfolioIdentityBase,
} from "../src/services/importIdentity.ts";

type BindingArgs = Parameters<typeof rawProveBindings>;
// The synthetic rows are wire-shaped (numeric BIGINT ids, string dates).
const verifiedKinesisNetworkRow = (row: object) =>
  rawVerifiedRow(loose<Parameters<typeof rawVerifiedRow>[0]>(row));
const proveKinesisNetworkBindings = (
  rows: object[],
  batches: object[],
  history: object[],
  context?: object,
) =>
  rawProveBindings(
    loose<BindingArgs[0]>(rows),
    loose<BindingArgs[1]>(batches),
    loose<BindingArgs[2]>(history),
    loose<BindingArgs[3]>(context),
  );
/** A staged network row a test may tamper with. */
type TamperableRow = Omit<NetworkSourceRow, "fx_rate_to_eur"> & {
  fx_rate_to_eur: string | null;
};

describe("literal native wallet supplemental evidence", () => {
  it.each(["asset_fee", "asset_transfer_witness"])(
    "validates the exact %s operation without inventing a fee",
    async (kind) => {
      const source = await networkSource({ kind });
      expect(verifiedKinesisNetworkRow(source.rows[0]!)).toMatchObject({
        kind,
        proof: { feeUnits: "0.0001500", principal: "0.0300000" },
      });
      expect(
        proveKinesisNetworkBindings(source.rows, source.batches, []).blockers,
      ).toEqual([]);
    },
  );
  it.each([
    "precision",
    "balance",
    "missing_empty",
    "missing_operation",
    "payer",
    "operation_type",
    "negative_header",
  ])("rejects %s evidence", (kind) => {
    const receipt = networkReceipt({ kind: "asset_fee" });
    if (kind === "precision")
      (receipt.operation as { amount: string }).amount = "0.03000004";
    if (kind === "balance")
      receipt.sourceAccount.balances[0]!.balance = "0.9698501";
    if (kind === "missing_empty") receipt.sourceHistoryPages.splice(1, 1);
    if (kind === "missing_operation") receipt.sourceHistoryPages.pop();
    if (kind === "payer") receipt.transaction.fee_account = "UNPROVED-PAYER";
    if (kind === "operation_type") receipt.operation.type = "unsupported";
    if (kind === "negative_header")
      receipt.sourceAccount.balances[0]!.balance = "-0.9698500";
    expect(() => verifyKinesisNetworkReceipt(receipt, "asset_fee")).toThrow();
  });
  it.each(["currency", "fx", "identity", "raw", "units", "account"])(
    "rejects fresh mapped %s tampering",
    async (kind) => {
      const source = await networkSource({ kind: "asset_fee" }),
        row: TamperableRow = source.rows[0]!;
      if (kind === "currency") {
        row.currency = "USD";
        row.dedup_fingerprint = assignImportIdentities([row], (item) =>
          portfolioIdentityBase(item, { accountIdentity: "UNASSIGNED" }),
        )[0]!.fingerprint;
      }
      if (kind === "fx") row.fx_rate_to_eur = "1";
      if (kind === "identity") row.dedup_fingerprint = "c".repeat(64);
      if (kind === "raw") row.raw_data += " ";
      if (kind === "units") row.units = "0.00015";
      if (kind === "account") row.source_account_identity = "UNPROVED-SENDER";
      if (kind === "units") row.units = "0.00016";
      expect(verifiedKinesisNetworkRow(row)).toBeUndefined();
      expect(
        proveKinesisNetworkBindings(source.rows, source.batches, []).blockers,
      ).toHaveLength(1);
    },
  );
});

import { networkBindingFixture } from "./helpers/kinesisNetworkBinding.ts";
describe("unchanged original broker identity with native transfer witness", () => {
  it("binds the staged InternalMovement with NULL instrument through one literal matched peer", async () => {
    const source = await networkBindingFixture(),
      original = structuredClone(source.primary.rows[0]!),
      witness = source.witness.rows[0]!;
    witness.asset_transfer_details!.networkReceipt = reversed(
      witness.asset_transfer_details!.networkReceipt,
    );
    const originalWitness = structuredClone(witness);
    expect(witness).toMatchObject({
      type: null,
      type_raw: "InternalMovement",
      route: "account_internal",
      investment_id: null,
      resolved_investment_id: null,
      user_override_investment_id: null,
    });
    const result = proveKinesisNetworkBindings(source.rows, source.batches, []);
    expect(result.blockers).toEqual([]);
    expect(result.bindings).toHaveLength(1);
    expect(result.overrides.get(original.id)).toMatchObject({
      route: "asset_transfer",
      investment_id: original.resolved_investment_id,
      units: "0.03015000",
      dedup_fingerprint: original.dedup_fingerprint,
      source_record_hash: original.source_record_hash,
      raw_data: original.raw_data,
      asset_transfer_details: {
        direction: "in",
        feeUnits: "0.0001500",
        networkBinding: { originAccountId: 8, destinationAccountId: 7 },
      },
    });
    expect(source.primary.rows[0]).toEqual(original);
    expect(witness).toEqual(originalWitness);
  });
  it.each([
    "missing_instrument",
    "missing_resolved",
    "invalid_instrument",
    "override",
    "explicit_wrong_instrument",
    "asset",
    "date",
    "hash",
    "principal",
    "account",
    "type",
  ])("rejects an unproved %s peer or witness", async (kind) => {
    const source = await networkBindingFixture(),
      peer = source.primary.rows[0]!,
      witness = source.witness.rows[0]!;
    if (kind === "missing_instrument") peer.investment_id = null;
    if (kind === "missing_resolved") peer.resolved_investment_id = null;
    if (kind === "invalid_instrument") peer.investment_id = -1;
    if (kind === "override") {
      peer.user_override_investment_id = 2;
      peer.investment_id = 2;
    }
    if (kind === "explicit_wrong_instrument") witness.investment_id = 2;
    if (kind === "asset") witness.symbol_raw = "KAU";
    if (kind === "date") witness.tx_date = "2026-01-03";
    if (kind === "hash") witness.source_transaction_id = "d".repeat(64);
    if (kind === "principal") witness.units = "0.03000001";
    if (kind === "account") witness.account_id = peer.account_id;
    if (kind === "type") witness.type_raw = "asset_transfer_witness";
    const result = proveKinesisNetworkBindings(source.rows, source.batches, []);
    expect(result.blockers.length).toBeGreaterThan(0);
    expect(result.overrides.size).toBe(0);
    expect(result.bindings).toEqual([]);
  });
  it("rejects competing original peers across resolved instruments and broker accounts", async () => {
    const source = await networkBindingFixture(),
      peer = source.primary.rows[0],
      other = {
        ...peer,
        id: 502,
        batch_id: 5,
        account_id: 9,
        investment_id: 2,
        resolved_investment_id: 2,
      };
    const result = proveKinesisNetworkBindings(
      [...source.rows, other],
      [
        ...source.batches,
        { ...source.primary.batches[0], id: 5, account_id: 9 },
      ],
      [],
    );
    expect(result.blockers.map((blocker) => blocker.reason)).toEqual([
      "network_witness_ambiguous",
      "network_witness_ambiguous",
    ]);
    expect(result.overrides.size).toBe(0);
  });
  it("reproves a fresh original-only source from retained witness and canonical transfer", async () => {
    const source = await networkBindingFixture(),
      result = proveKinesisNetworkBindings(source.rows, source.batches, []),
      projected = result.overrides.get(source.primary.rows[0]!.id);
    const owner = { ...projected, status: "committed" },
      witness = { ...source.witness.rows[0], status: "duplicate" },
      current = {
        id: 400,
        type: "asset_transfer",
        staging_row_id: owner.id,
        import_batch_id: owner.batch_id,
        investment_id: 1,
        source_account_id: 8,
        destination_account_id: 7,
        date: owner.tx_date,
        units: owner.units,
        fee_units: owner.asset_transfer_details!.feeUnits,
        source_record_hash: owner.source_record_hash,
        dedup_fingerprint: owner.dedup_fingerprint,
        dedup_fingerprint_version: 1,
      };
    const fresh = { ...source.primary.rows[0], id: 501, batch_id: 5 },
      context = { sources: [owner, witness], batches: source.batches };
    expect(
      proveKinesisNetworkBindings(
        [fresh],
        [{ ...source.primary.batches[0], id: 5 }],
        [current],
        context,
      ).blockers,
    ).toEqual([]);
    witness.raw_data += " ";
    expect(
      proveKinesisNetworkBindings(
        [fresh],
        [{ ...source.primary.batches[0], id: 5 }],
        [current],
        context,
      ).blockers,
    ).toHaveLength(1);
  });
  it("does not reuse an aborted or unsettled witness", async () => {
    const source = await networkBindingFixture();
    const context = {
      sources: source.witness.rows,
      batches: source.witness.batches,
    };
    expect(
      proveKinesisNetworkBindings(
        source.primary.rows,
        source.primary.batches,
        [],
        context,
      ).blockers,
    ).toHaveLength(1);
  });
});

/** The same JSON value with every object's keys in reverse order. */
function reversed<T>(value: T): T {
  return (
    Array.isArray(value)
      ? value.map(reversed)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .reverse()
              .map(([key, item]) => [key, reversed(item)]),
          )
        : value
  ) as T;
}
it("treats JSONB key ordering as the same typed receipt", async () => {
  const source = await networkSource({ kind: "asset_fee" });
  source.rows[0]!.asset_adjustment_details!.networkReceipt = reversed(
    source.rows[0]!.asset_adjustment_details!.networkReceipt,
  );
  expect(verifiedKinesisNetworkRow(source.rows[0]!)).toBeDefined();
});
