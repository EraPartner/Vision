import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getImportReadinessProblems: vi.fn(),
  getManualPortfolioOverlaps: vi.fn(),
  lockImportReadinessHistory: vi.fn(),
}));
vi.mock("../src/repositories/portfolioImportBatchRepository.ts", () => mocks);

import {
  assertPortfolioImportReadiness,
  isMaintainedPortfolioImport,
} from "../src/services/portfolioImportReadinessService.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getImportReadinessProblems.mockResolvedValue([]);
  mocks.getManualPortfolioOverlaps.mockResolvedValue([]);
});

describe("maintained portfolio import readiness", () => {
  it.each(["ibkr", "kinesis", "nexo", "saxo"])(
    "recognizes %s adapter names and saved specialized parser configurations",
    (source) => {
      expect(isMaintainedPortfolioImport({ adapter_name: source })).toBe(true);
      expect(
        isMaintainedPortfolioImport({
          adapter_name: "custom",
          custom_config: { format: `${source}_transaction_history` },
        }),
      ).toBe(true);
      expect(
        isMaintainedPortfolioImport({
          adapter_name: "custom",
          custom_config: JSON.stringify({
            format: `${source}_transaction_history`,
          }),
        }),
      ).toBe(true);
    },
  );

  it("retains generic partial imports without readiness queries", async () => {
    await assertPortfolioImportReadiness({
      batchId: 5,
      batch: { adapter_name: "generic", custom_config: "invalid JSON" },
    });
    expect(mocks.getImportReadinessProblems).not.toHaveBeenCalled();
    expect(mocks.lockImportReadinessHistory).not.toHaveBeenCalled();
  });

  it("returns only counts and one-based source ordinals for incomplete rows", async () => {
    mocks.getImportReadinessProblems.mockResolvedValue([
      { row_index: 0 },
      { row_index: 4 },
    ]);
    await expect(
      assertPortfolioImportReadiness({
        batchId: 5,
        batch: { adapter_name: "nexo", account_id: 77 },
      }),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        reason: "incomplete_source",
        count: 2,
        row_ordinals: [1, 5],
      },
    });
    expect(mocks.lockImportReadinessHistory).not.toHaveBeenCalled();
    expect(mocks.getManualPortfolioOverlaps).not.toHaveBeenCalled();
  });

  it("serializes the overlap read and uses the reviewed replacement account", async () => {
    await assertPortfolioImportReadiness({
      batchId: 5,
      batch: { adapter_name: "saxo", account_id: 77 },
      accountId: 88,
    });
    expect(mocks.getImportReadinessProblems).toHaveBeenCalledWith(5, 88);
    expect(mocks.lockImportReadinessHistory).toHaveBeenCalledWith(88);
    expect(mocks.getManualPortfolioOverlaps).toHaveBeenCalledWith(5, 88);
    expect(
      mocks.lockImportReadinessHistory.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.getManualPortfolioOverlaps.mock.invocationCallOrder[0],
    );
  });

  it("rejects history overlaps with a non-sensitive diagnostic", async () => {
    mocks.getManualPortfolioOverlaps.mockResolvedValue([{ row_index: 8 }]);
    await expect(
      assertPortfolioImportReadiness({
        batchId: 5,
        batch: { adapter_name: "kinesis" },
      }),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        reason: "existing_history_overlap",
        count: 1,
        row_ordinals: [9],
      },
    });
  });
});
