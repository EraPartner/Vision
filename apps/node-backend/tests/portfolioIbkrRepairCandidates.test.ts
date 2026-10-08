import { describe, expect, it } from "vitest";
import { narrowImportedIbkrRepairCandidates } from "../src/services/portfolioIbkrRepairCandidates.ts";
import type {
  RepairCandidate,
  RepairItem,
} from "../src/services/portfolioIbkrRepairCandidates.ts";
import { partial } from "./helpers/partial.ts";

type Item = Omit<RepairItem, "row" | "candidates"> & {
  row: RepairItem["row"] & { id: number };
  candidates: RepairCandidate[];
};

const legacy = (over = {}) => ({
  id: 40,
  investment_id: 1,
  type: "buy",
  date: "2026-01-01",
  currency: "USD",
  units: "5",
  amount: "500",
  price_per_unit: "100",
  account_id: null,
  import_batch_id: null,
  dedup_fingerprint: null,
  ...over,
});
const item = (id: number, price = "100", over = {}): Item => {
  const fingerprint = (id === 1 ? "a" : "b").repeat(64);
  return {
    row: {
      id,
      route: "portfolio",
      type: "buy",
      tx_date: "2026-01-01",
      investment_id: 1,
      currency: "USD",
      custom_config: { format: "ibkr_transaction_history" },
      dedup_fingerprint: fingerprint,
      dedup_fingerprint_version: 1,
    },
    source: {
      type: "buy",
      date: "2026-01-01",
      currency: "USD",
      units: "5",
      price_per_unit: price,
      amount: String(Number(price) * 5),
      fees: "0",
      taxes: "0",
    },
    candidates: [legacy()],
    // The imported copy carries only the provenance fields the narrowing reads.
    imported: partial<RepairCandidate>({
      id: 100 + id,
      import_batch_id: 3,
      investment_id: 1,
      currency: "USD",
      dedup_fingerprint: fingerprint,
      dedup_fingerprint_version: 1,
    }),
    ...over,
  };
};

describe("contested imported IBKR repair identities", () => {
  it("retains one exact price/principal match and settles the distinct existing fill as duplicate", () => {
    const first = item(1);
    const second = item(2, "120");
    const result = narrowImportedIbkrRepairCandidates([first, second]);
    expect(result.prepared).toEqual([first]);
    expect(result.settledDuplicates).toEqual([{ ...second, candidates: [] }]);
    expect(result.settledDuplicates[0].imported!.id).toBe(102);
    expect(second.candidates).toHaveLength(1);
  });
  it("keeps two legitimate identical fills ambiguous", () => {
    const items = [item(1), item(2)];
    expect(narrowImportedIbkrRepairCandidates(items)).toEqual({
      prepared: items,
      settledDuplicates: [],
    });
  });
  it("keeps a third different fill blocked when two exact claims exist", () => {
    const items = [item(1), item(2), item(3, "120")];
    expect(narrowImportedIbkrRepairCandidates(items).prepared).toEqual(items);
  });
  it.each([
    ["nearby date", { date: "2026-01-02" }],
    ["other currency", { currency: "EUR" }],
    ["missing amount", { amount: null }],
    ["missing price", { price_per_unit: null }],
    ["unproven principal", { amount: "610" }],
    ["unknown fees", { fees: null }],
    ["nonfinite amount", { amount: "Infinity" }],
  ])("fails closed for %s", (_label, changes) => {
    const first = item(1);
    const second = item(2, "120");
    second.source = { ...second.source, ...changes };
    expect(
      narrowImportedIbkrRepairCandidates([first, second]).prepared,
    ).toEqual([first, second]);
  });
  it("keeps a possible gross/net explanation ambiguous", () => {
    const first = item(1);
    const second = item(2, "96");
    second.source.fees = "20";
    expect(
      narrowImportedIbkrRepairCandidates([first, second]).prepared,
    ).toEqual([first, second]);
  });
  it.each(["unimported", "other provider", "changed source identity"])(
    "does not narrow %s rows",
    (kind) => {
      const first = item(1);
      const second = item(2, "120");
      if (kind === "unimported") second.imported = undefined;
      if (kind === "other provider")
        second.row.custom_config.format = "saxo_transaction_history";
      if (kind === "changed source identity")
        second.imported!.dedup_fingerprint = "c".repeat(64);
      expect(
        narrowImportedIbkrRepairCandidates([first, second]).prepared,
      ).toEqual([first, second]);
    },
  );
  it("removes only the proven conflicting candidate and retains other valid candidates", () => {
    const first = item(1);
    const second = item(2, "120");
    second.candidates.push(
      legacy({ id: 41, amount: "600", price_per_unit: "120" }),
    );
    const result = narrowImportedIbkrRepairCandidates([first, second]);
    expect(result.prepared[1].candidates.map((r) => r.id)).toEqual([41]);
    expect(result.settledDuplicates).toEqual([]);
  });
  it("compares financial fields at stored precision", () => {
    const first = item(1);
    first.source.units = "5.000000001";
    first.source.price_per_unit = "100.0000001";
    first.source.amount = "500.0000001";
    expect(
      narrowImportedIbkrRepairCandidates([first, item(2, "120")])
        .settledDuplicates,
    ).toHaveLength(1);
  });
});
