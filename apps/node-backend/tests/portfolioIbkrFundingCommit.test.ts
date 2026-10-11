import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { mockLogger } from "./helpers/mockLogger.ts";
import { loose, partial } from "./helpers/partial.ts";
import { mockTxConnection } from "./helpers/repoMocks.ts";
import { syntheticIbkrCashCorrection } from "./helpers/ibkrCashReconciliation.ts";
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

import * as connection from "../src/database/connection.ts";
import rawRecipientRepository from "../src/repositories/recipientRepository.ts";
import rawSettingsRepository from "../src/repositories/settingsRepository.ts";
import rawCategoryRepository from "../src/repositories/categoryRepository.ts";
import { readReconciliationSources as rawReadReconciliationSources } from "../src/repositories/portfolioImportReconciliationRepository.ts";
import {
  readIbkrCashCorrectionContext as rawReadIbkrCashCorrectionContext,
  proveIbkrCashCorrections,
} from "../src/services/portfolioIbkrCashReconciliation.ts";
import { commitBatch } from "../src/services/portfolioImportPipeline/commit.ts";

type SqlSpy = Mock<
  (sql: string, params?: readonly unknown[]) => Promise<{ rows: unknown[] }>
>;
// mockTxConnection adds the `poolQuery` sink, which the real module lacks.
const { poolQuery, query } = connection as unknown as {
  poolQuery: SqlSpy;
  query: SqlSpy;
};
const recipientRepository = vi.mocked(rawRecipientRepository);
const settingsRepository = vi.mocked(rawSettingsRepository);
const categoryRepository = vi.mocked(rawCategoryRepository);
const readReconciliationSources = vi.mocked(rawReadReconciliationSources);
const readIbkrCashCorrectionContext = vi.mocked(
  rawReadIbkrCashCorrectionContext,
);

type Fixture = ReturnType<typeof syntheticIbkrCashCorrection>;
type WireRow = Record<string, unknown>;
// The synthetic rows are wire-shaped (numeric ids, string dates), and the
// cases splice receipts and after-images into the context as the DB would
// return them.
type Source = Omit<Fixture, "context"> & {
  context: {
    ledger: WireRow[];
    sources: WireRow[];
    batches: WireRow[];
    receipts: WireRow[];
  };
};
type StagedRow = WireRow & { id: number; batch_id: number; raw_data: string };

let source: Source;
let selected: StagedRow;
let format: string;
let fingerprintDuplicate: boolean;
let marks: { id: unknown; status: unknown }[];
const prove = () =>
  proveIbkrCashCorrections(
    loose([source.native]),
    loose(source.nativeBatches),
    loose(source.context),
  );
function projection(row: WireRow) {
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
  // The commit read as pg returns it: BIGINT id as text, JSON details and
  // the LEFT JOIN investment columns NULL for a cash row.
  return {
    ...Object.fromEntries(keys.map((key) => [key, row[key]])),
    id: String(row.id),
    asset_transfer_details: row.asset_transfer_details ?? null,
    asset_adjustment_details: row.asset_adjustment_details ?? null,
    asset_class: null,
    investment_currency: null,
  };
}
function dispatch(sql: string, params?: readonly unknown[]) {
  if (/SELECT b\.account_id, b\.is_brokerage/.test(sql))
    return {
      rows: [
        {
          // BIGINT id as pg returns it.
          id: String(selected.batch_id),
          rows_total: 1,
          status: "committing",
          adapter_name: "portfolio_generic",
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
    marks.push({ id: params![0], status: params![1] });
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
  recipientRepository.createOrGet.mockResolvedValue(
    partial({ recipient: { id: 3 } }),
  );
  recipientRepository.getOrCreateSystemId.mockResolvedValue(3);
  settingsRepository.get.mockResolvedValue(undefined);
  categoryRepository.getActiveByIds.mockResolvedValue([]);
  readReconciliationSources.mockImplementation(async () =>
    loose([{ ...selected }]),
  );
  readIbkrCashCorrectionContext.mockImplementation(async () =>
    loose(source.context),
  );
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
    expect(marks).toEqual([{ id: String(selected.id), status: "duplicate" }]);
    expect(inserts()).toEqual([]);
  });

  it("resolves a repeated original source through its intact corrected after-image before ordinary dedup", async () => {
    const action = prove().actions[0]!;
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
    expect(marks).toEqual([{ id: String(selected.id), status: "duplicate" }]);
    expect(inserts()).toEqual([]);
  });

  it("fails closed when an aliased corrected cash after-image has changed", async () => {
    const action = prove().actions[0]!;
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
    const action = prove().actions[0]!;
    source.context.ledger[0] = action.after.snapshot;
    source.context.receipts.push({
      id: 90,
      transaction_id: 40,
      before_data: action.before,
      after_data: action.after,
    });
    readReconciliationSources.mockResolvedValue(
      loose([{ ...selected, raw_data: `${selected.raw_data} ` }]),
    );
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
    expect(inserts()[0]![1]!.slice(0, 3)).toEqual(["2026-01-01", 100, "USD"]);
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
