import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockLogger } from "./helpers/mockLogger.js";
import { mockTxConnection } from "./helpers/repoMocks.js";
import { syntheticIbkrCashCorrection } from "./helpers/ibkrCashReconciliation.js";
const { client } = vi.hoisted(() => ({ client: { query: vi.fn() } }));
vi.mock("../src/config/logger.ts", () => ({ logger: mockLogger() }));
vi.mock("../src/database/connection.ts", () => mockTxConnection(client));
vi.mock("../src/repositories/recipientRepository.ts", () => ({
  default: { createOrGet: vi.fn(), getOrCreateSystemId: vi.fn() },
}));
vi.mock("../src/repositories/settingsRepository.ts", () => ({
  default: { get: vi.fn() },
}));
vi.mock("../src/repositories/categoryRepository.ts", () => ({
  default: { getActiveByIds: vi.fn() },
}));
vi.mock("../src/services/portfolio/portfolioTransactionService.ts", () => ({
  default: { create: vi.fn() },
}));
vi.mock(
  "../src/repositories/portfolioImportReconciliationRepository.ts",
  async (importOriginal) => ({
    ...(await importOriginal()),
    readReconciliationSources: vi.fn(),
  }),
);
vi.mock(
  "../src/services/portfolioIbkrCashReconciliation.ts",
  async (importOriginal) => ({
    ...(await importOriginal()),
    readIbkrCashCorrectionContext: vi.fn(),
  }),
);

import { poolQuery, query } from "../src/database/connection.ts";
import recipientRepository from "../src/repositories/recipientRepository.ts";
import settingsRepository from "../src/repositories/settingsRepository.ts";
import categoryRepository from "../src/repositories/categoryRepository.ts";
import { readReconciliationSources } from "../src/repositories/portfolioImportReconciliationRepository.ts";
import {
  readIbkrCashCorrectionContext,
  proveIbkrCashCorrections,
} from "../src/services/portfolioIbkrCashReconciliation.ts";
import { commitBatch } from "../src/services/portfolioImportPipeline/commit.ts";

let source;
let selected;
let format;
let fingerprintDuplicate;
let marks;
function projection(row) {
  const keys = [
    "id",
    "status",
    "tx_date",
    "type",
    "route",
    "type_raw",
    "units",
    "price_per_unit",
    "amount",
    "fees",
    "taxes",
    "currency",
    "fx_rate_to_eur",
    "note",
    "source_record_hash",
    "source_transaction_id",
    "dedup_fingerprint",
    "dedup_fingerprint_version",
    "dedup_occurrence",
    "investment_id",
  ];
  return Object.fromEntries(keys.map((key) => [key, row[key]]));
}
function dispatch(sql, params) {
  if (/SELECT b\.account_id, b\.is_brokerage/.test(sql))
    return {
      rows: [
        {
          id: selected.batch_id,
          account_id: 7,
          is_brokerage: true,
          account_institution: "IBKR",
          account_name: "Synthetic IBKR",
          custom_config: selected.custom_config,
        },
      ],
    };
  if (/FROM portfolio_import_staging_rows isr/.test(sql))
    return { rows: [projection(selected)] };
  if (
    /WHERE dedup_fingerprint_version = \$1 AND dedup_fingerprint = \$2/.test(
      sql,
    )
  )
    return { rows: fingerprintDuplicate ? [{ "?column?": 1 }] : [] };
  if (/SELECT COUNT\(\*\)::int AS n FROM transactions/.test(sql))
    return { rows: [{ n: 0 }] };
  if (/INSERT INTO transactions/.test(sql)) return { rows: [{ id: 999 }] };
  if (/SET status = \$2, error_message/.test(sql))
    marks.push({ id: params[0], status: params[1] });
  return { rows: [] };
}
beforeEach(() => {
  vi.clearAllMocks();
  source = syntheticIbkrCashCorrection();
  selected = { ...source.original, status: "matched", committed_txn_id: null };
  format = "ibkr_transaction_history";
  fingerprintDuplicate = false;
  marks = [];
  poolQuery.mockImplementation((sql, params) =>
    Promise.resolve(dispatch(sql, params)),
  );
  client.query.mockImplementation((sql, params) =>
    Promise.resolve(dispatch(sql, params)),
  );
  recipientRepository.createOrGet.mockResolvedValue({ recipient: { id: 3 } });
  recipientRepository.getOrCreateSystemId.mockResolvedValue(3);
  settingsRepository.get.mockResolvedValue(undefined);
  categoryRepository.getActiveByIds.mockResolvedValue([]);
  readReconciliationSources.mockImplementation(async () => [{ ...selected }]);
  readIbkrCashCorrectionContext.mockImplementation(async () => source.context);
});
const inserts = () =>
  query.mock.calls.filter(([sql]) => /INSERT INTO transactions/.test(sql));

describe("IBKR native funding commit protection", () => {
  it("blocks a new funding insert from the base-currency Transaction History CSV", async () => {
    await expect(
      commitBatch({ batchId: selected.batch_id }),
    ).rejects.toMatchObject({
      details: { reason: "ibkr_native_funding_required" },
    });
    expect(inserts()).toEqual([]);
    expect(marks).toEqual([]);
  });

  it("allows an existing exact original fingerprint to remain a duplicate", async () => {
    fingerprintDuplicate = true;
    await expect(
      commitBatch({ batchId: selected.batch_id }),
    ).resolves.toMatchObject({ imported: 0, duplicates: 1, errors: 0 });
    expect(marks).toEqual([{ id: selected.id, status: "duplicate" }]);
    expect(inserts()).toEqual([]);
  });

  it("resolves a repeated original source through its intact corrected after-image before ordinary dedup", async () => {
    const action = proveIbkrCashCorrections(
      [source.native],
      source.nativeBatches,
      source.context,
    ).actions[0];
    source.context.ledger[0] = {
      ...action.after.snapshot,
      category_id: 58,
      is_transfer: true,
      transfer_peer_id: 50,
    };
    source.context.receipts.push({
      id: 90,
      transaction_id: 40,
      before_data: action.before,
      after_data: action.after,
    });
    await expect(
      commitBatch({ batchId: selected.batch_id }),
    ).resolves.toMatchObject({ imported: 0, duplicates: 1, errors: 0 });
    expect(readReconciliationSources).toHaveBeenCalledWith([selected.batch_id]);
    expect(readIbkrCashCorrectionContext).toHaveBeenCalledTimes(1);
    expect(
      query.mock.calls.some(([sql]) =>
        /WHERE dedup_fingerprint_version/.test(sql),
      ),
    ).toBe(false);
    expect(marks).toEqual([{ id: selected.id, status: "duplicate" }]);
    expect(inserts()).toEqual([]);
  });

  it("fails closed when an aliased corrected cash after-image has changed", async () => {
    const action = proveIbkrCashCorrections(
      [source.native],
      source.nativeBatches,
      source.context,
    ).actions[0];
    source.context.ledger[0] = { ...action.after.snapshot, amount: "101.0000" };
    source.context.receipts.push({
      id: 90,
      transaction_id: 40,
      before_data: action.before,
      after_data: action.after,
    });
    await expect(
      commitBatch({ batchId: selected.batch_id }),
    ).rejects.toMatchObject({ details: { reason: "cash_receipt_changed" } });
    expect(inserts()).toEqual([]);
    expect(marks).toEqual([]);
  });

  it("does not alias an altered retained source record", async () => {
    const action = proveIbkrCashCorrections(
      [source.native],
      source.nativeBatches,
      source.context,
    ).actions[0];
    source.context.ledger[0] = action.after.snapshot;
    source.context.receipts.push({
      id: 90,
      transaction_id: 40,
      before_data: action.before,
      after_data: action.after,
    });
    readReconciliationSources.mockResolvedValue([
      { ...selected, raw_data: `${selected.raw_data} ` },
    ]);
    await expect(
      commitBatch({ batchId: selected.batch_id }),
    ).rejects.toMatchObject({
      details: { reason: "ibkr_native_funding_required" },
    });
    expect(inserts()).toEqual([]);
  });

  it("requires intact literal native proof for future standalone funding ledger inserts", async () => {
    format = "ibkr_funding_history";
    selected = {
      ...source.native,
      custom_config: { ...source.native.custom_config, format },
    };
    await expect(
      commitBatch({ batchId: selected.batch_id }),
    ).resolves.toMatchObject({ imported: 1, duplicates: 0, errors: 0 });
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0][1].slice(0, 3)).toEqual(["2026-01-01", 100, "USD"]);
  });

  it("rejects native proof tampering even if an ordinary fingerprint exists", async () => {
    selected = { ...source.native, raw_data: `${source.native.raw_data} ` };
    fingerprintDuplicate = true;
    await expect(
      commitBatch({ batchId: selected.batch_id }),
    ).rejects.toMatchObject({
      details: { reason: "ibkr_native_funding_required" },
    });
    expect(inserts()).toEqual([]);
    expect(marks).toEqual([]);
  });
});
