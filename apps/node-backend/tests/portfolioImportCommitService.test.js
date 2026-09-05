import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockConnection } from "./helpers/repoMocks.js";

const mocks = vi.hoisted(() => ({
  withTransaction: vi.fn(async (fn) => fn()),
  lockBatchForUpdate: vi.fn(),
  setBatchAccount: vi.fn(),
  getAccount: vi.fn(),
  commitPortfolioImport: vi.fn(),
}));

vi.mock("../src/database/connection.js", () =>
  mockConnection({
    withTransaction: mocks.withTransaction,
  }),
);
vi.mock("../src/repositories/portfolioImportBatchRepository.js", () => ({
  lockBatchForUpdate: mocks.lockBatchForUpdate,
  setBatchAccount: mocks.setBatchAccount,
}));
vi.mock("../src/services/accountService.js", () => ({
  default: { get: mocks.getAccount },
}));
vi.mock("../src/services/portfolioImportPipeline/index.js", () => ({
  commitPortfolioImport: mocks.commitPortfolioImport,
}));

import { commitReviewedPortfolioImport } from "../src/services/portfolioImportCommitService.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lockBatchForUpdate.mockResolvedValue({
    status: "complete_with_errors",
  });
  mocks.getAccount.mockResolvedValue({ id: 77 });
  mocks.commitPortfolioImport.mockResolvedValue({
    imported: 1,
    duplicates: 0,
    errors: 0,
  });
});

describe("commitReviewedPortfolioImport", () => {
  it("locks the batch before setting and reading its commit account", async () => {
    await commitReviewedPortfolioImport({ batchId: 5, accountId: 77 });

    expect(mocks.withTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.lockBatchForUpdate).toHaveBeenCalledWith(5);
    expect(mocks.getAccount).toHaveBeenCalledWith(77);
    expect(mocks.setBatchAccount).toHaveBeenCalledWith(5, 77);
    expect(mocks.commitPortfolioImport).toHaveBeenCalledWith({ batchId: 5 });
    expect(mocks.lockBatchForUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setBatchAccount.mock.invocationCallOrder[0],
    );
    expect(mocks.setBatchAccount.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.commitPortfolioImport.mock.invocationCallOrder[0],
    );
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
});
