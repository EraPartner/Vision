import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockConnection } from "./helpers/repoMocks.ts";
import { portfolioUnitEventDbRow } from "./helpers/portfolioPgRows.ts";
import { asAccountId } from "@vision/types/brands";

const mocks = vi.hoisted(() => ({
  getUnitEventsForInvestment: vi.fn(),
  getAssetAdjustmentsForBatch: vi.fn(),
  deleteAssetAdjustmentsForBatch: vi.fn(),
  getAssetTransfersForBatch: vi.fn(),
  deleteAssetTransfersForBatch: vi.fn(),
}));

vi.mock("../src/database/connection.ts", () =>
  mockConnection({
    // The LOCK TABLE statement; it returns no rows.
    query: () => Promise.resolve({ rows: [] }),
    withTransaction: (fn: () => unknown) => fn(),
  }),
);
vi.mock("../src/repositories/portfolioTxRepo.reads.ts", async (importOriginal) => ({
  ...(await importOriginal()),
  getUnitEventsForInvestment: mocks.getUnitEventsForInvestment,
}));
vi.mock(
  "../src/repositories/portfolioAssetAdjustmentRepository.ts",
  async (importOriginal) => ({
    ...(await importOriginal()),
    getAssetAdjustmentsForBatch: mocks.getAssetAdjustmentsForBatch,
    deleteAssetAdjustmentsForBatch: mocks.deleteAssetAdjustmentsForBatch,
  }),
);
vi.mock(
  "../src/repositories/portfolioAssetTransferRepository.ts",
  async (importOriginal) => ({
    ...(await importOriginal()),
    getAssetTransfersForBatch: mocks.getAssetTransfersForBatch,
    deleteAssetTransfersForBatch: mocks.deleteAssetTransfersForBatch,
  }),
);

import { rollbackPortfolioAssetAdjustmentsForBatch } from "../src/services/portfolio/portfolioAssetAdjustmentService.ts";
import { rollbackPortfolioAssetTransfersForBatch } from "../src/services/portfolio/portfolioAssetTransferService.ts";

const acct1 = asAccountId(1);
const acct2 = asAccountId(2);

// The unit-event history is a UNION of portfolio_transactions,
// portfolio_asset_transfers and portfolio_asset_adjustments, whose ids come
// from separate sequences. A rollback must match ids within one table only.
describe("custody rollback id matching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteAssetAdjustmentsForBatch.mockResolvedValue(1);
    mocks.deleteAssetTransfersForBatch.mockResolvedValue(1);
  });

  it("removing adjustment 5 keeps asset transfer 5 in the validated history", async () => {
    mocks.getAssetAdjustmentsForBatch.mockResolvedValue([
      { id: "5", investment_id: 1 },
    ]);
    mocks.getUnitEventsForInvestment.mockResolvedValue([
      portfolioUnitEventDbRow({
        id: "1",
        type: "buy",
        date: "2025-01-01",
        units: "10",
        amount: "100",
        account_id: acct1,
      }),
      portfolioUnitEventDbRow({
        id: "2",
        type: "buy",
        date: "2025-01-01",
        units: "8",
        amount: "80",
        account_id: acct2,
      }),
      portfolioUnitEventDbRow({
        id: "5",
        type: "asset_adjustment",
        date: "2025-01-10",
        units: "1",
        account_id: acct2,
        adjustment_kind: "asset_fee",
        basis_policy: "carried",
        adjustment_id: "5",
      }),
      portfolioUnitEventDbRow({
        id: "5",
        type: "asset_transfer",
        date: "2025-01-15",
        units: "5",
        source_account_id: acct2,
        destination_account_id: acct1,
        transfer_id: "5",
      }),
      portfolioUnitEventDbRow({
        id: "7",
        type: "asset_adjustment",
        date: "2025-02-01",
        units: "12",
        account_id: acct1,
        adjustment_kind: "asset_fee",
        basis_policy: "carried",
        adjustment_id: "7",
      }),
    ]);

    // Account 1 needs transfer 5's units to pay the 12-unit fee.
    await expect(rollbackPortfolioAssetAdjustmentsForBatch(9)).resolves.toBe(1);
  });

  it("omitting transaction 4 keeps asset adjustment 4 in the validated history", async () => {
    mocks.getAssetTransfersForBatch.mockResolvedValue([
      { id: "3", investment_id: 1 },
    ]);
    mocks.getUnitEventsForInvestment.mockResolvedValue([
      portfolioUnitEventDbRow({
        id: "1",
        type: "buy",
        date: "2025-01-01",
        units: "10",
        amount: "100",
        account_id: acct1,
      }),
      portfolioUnitEventDbRow({
        id: "2",
        type: "buy",
        date: "2025-01-01",
        units: "5",
        amount: "50",
        account_id: acct2,
      }),
      portfolioUnitEventDbRow({
        id: "3",
        type: "asset_transfer",
        date: "2025-01-15",
        units: "5",
        source_account_id: acct2,
        destination_account_id: acct1,
        transfer_id: "3",
      }),
      portfolioUnitEventDbRow({
        id: "4",
        type: "asset_adjustment",
        date: "2025-02-01",
        units: "12",
        account_id: acct1,
        adjustment_kind: "asset_fee",
        basis_policy: "carried",
        adjustment_id: "4",
      }),
    ]);

    // Without transfer 3, account 1 holds 10 units and cannot pay a 12-unit fee.
    await expect(
      rollbackPortfolioAssetTransfersForBatch(9, { omitTransactionIds: [4] }),
    ).rejects.toThrow("Asset fee exceeds source holdings");
    expect(mocks.deleteAssetTransfersForBatch).not.toHaveBeenCalled();
  });
});
