import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockConnection } from "./helpers/repoMocks.js";

const mocks = vi.hoisted(() => ({
  withTransaction: vi.fn(async (fn) => fn()),
  lockBatchForUpdate: vi.fn(),
  setBatchAccount: vi.fn(),
  getAccount: vi.fn(),
  commitPortfolioImport: vi.fn(),
  assertPortfolioImportReadiness: vi.fn(),
}));

vi.mock("../src/database/connection.ts", () =>
  mockConnection({
    withTransaction: mocks.withTransaction,
  }),
);
vi.mock("../src/repositories/portfolioImportBatchRepository.ts", () => ({
  lockBatchForUpdate: mocks.lockBatchForUpdate,
  setBatchAccount: mocks.setBatchAccount,
}));
vi.mock("../src/services/accountService.ts", () => ({
  default: { get: mocks.getAccount },
}));
vi.mock("../src/services/portfolioImportPipeline/index.ts", () => ({
  commitPortfolioImport: mocks.commitPortfolioImport,
}));
vi.mock("../src/services/portfolioImportReadinessService.ts", () => ({
  assertPortfolioImportReadiness: mocks.assertPortfolioImportReadiness,
  isMaintainedPortfolioImport: () => false,
}));

import { commitReviewedPortfolioImport } from "../src/services/portfolioImportCommitService.ts";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lockBatchForUpdate.mockResolvedValue({
    status: "complete_with_errors",
  });
  mocks.getAccount.mockResolvedValue({
    id: 77,
    type: "brokerage",
    is_active: true,
  });
  mocks.commitPortfolioImport.mockResolvedValue({
    imported: 1,
    duplicates: 0,
    errors: 0,
  });
  mocks.assertPortfolioImportReadiness.mockResolvedValue(undefined);
});

describe("commitReviewedPortfolioImport", () => {
  it("locks the batch before setting and reading its commit account", async () => {
    await commitReviewedPortfolioImport({ batchId: 5, accountId: 77 });

    expect(mocks.withTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.lockBatchForUpdate).toHaveBeenCalledWith(5);
    expect(mocks.getAccount).toHaveBeenCalledWith(77);
    expect(mocks.setBatchAccount).toHaveBeenCalledWith(5, 77);
    expect(mocks.commitPortfolioImport).toHaveBeenCalledWith({ batchId: 5 });
    expect(mocks.assertPortfolioImportReadiness).toHaveBeenCalledWith({
      batchId: 5,
      batch: { status: "complete_with_errors" },
      accountId: 77,
    });
    expect(mocks.lockBatchForUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setBatchAccount.mock.invocationCallOrder[0],
    );
    expect(mocks.setBatchAccount.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.assertPortfolioImportReadiness.mock.invocationCallOrder[0],
    );
    expect(
      mocks.assertPortfolioImportReadiness.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.commitPortfolioImport.mock.invocationCallOrder[0]);
  });

  it("stops before canonical commit when readiness fails", async () => {
    mocks.assertPortfolioImportReadiness.mockRejectedValueOnce(
      new Error("Import needs reconciliation"),
    );

    await expect(commitReviewedPortfolioImport({ batchId: 5 })).rejects.toThrow(
      "Import needs reconciliation",
    );
    expect(mocks.commitPortfolioImport).not.toHaveBeenCalled();
  });

  it("does not rewrite the stored account when no account is supplied", async () => {
    await commitReviewedPortfolioImport({ batchId: 5 });

    expect(mocks.getAccount).not.toHaveBeenCalled();
    expect(mocks.setBatchAccount).not.toHaveBeenCalled();
    expect(mocks.commitPortfolioImport).toHaveBeenCalledWith({ batchId: 5 });
  });

  it("rejects a non-reviewable batch before commit", async () => {
    mocks.lockBatchForUpdate.mockResolvedValue({ status: "complete" });

    await expect(
      commitReviewedPortfolioImport({ batchId: 5, accountId: 77 }),
    ).rejects.toThrow("not in a reviewable state");

    expect(mocks.setBatchAccount).not.toHaveBeenCalled();
    expect(mocks.commitPortfolioImport).not.toHaveBeenCalled();
  });

  it("rejects inactive and non-portfolio replacement accounts", async () => {
    for (const account of [
      { id: 77, type: "checking", is_active: true },
      { id: 77, type: "wallet", is_active: false },
    ]) {
      mocks.getAccount.mockResolvedValueOnce(account);
      await expect(
        commitReviewedPortfolioImport({ batchId: 5, accountId: 77 }),
      ).rejects.toThrow("active portfolio account");
      expect(mocks.setBatchAccount).not.toHaveBeenCalled();
      expect(mocks.commitPortfolioImport).not.toHaveBeenCalled();
    }
  });
});
