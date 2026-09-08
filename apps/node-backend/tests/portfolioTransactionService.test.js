import { beforeEach, describe, expect, it, vi } from "vitest";

const reads = vi.hoisted(() => ({
  getAssetClassByInvestmentId: vi.fn(),
  getById: vi.fn(),
  getUnitEventIdsForImportBatch: vi.fn(),
}));
const writes = vi.hoisted(() => ({
  hardDelete: vi.fn(),
  insert: vi.fn(),
  updateFields: vi.fn(),
}));

vi.mock("../src/repositories/portfolioTxRepo.reads.js", () => reads);
vi.mock("../src/repositories/portfolioTxRepo.writes.js", () => writes);

import { update } from "../src/services/portfolio/portfolioTransactionService.js";

describe("portfolioTransactionService recurrence compatibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reads.getById.mockResolvedValue({
      id: 7,
      investment_id: 2,
      asset_class: "stock",
      type: "dividend",
      date: "2026-09-01",
      amount: 10,
      fees: 0,
      taxes: 0,
      dividend_amount_convention: "unknown",
      currency: "EUR",
      is_recurring: true,
      recurrence_interval: "monthly",
      recurrence_end_date: null,
      account_id: null,
    });
    writes.updateFields.mockImplementation(async (_id, fields) => ({
      id: 7,
      ...fields,
    }));
  });

  it("normalizes legacy direct-service updates before persistence", async () => {
    await update(7, { recurrence_interval: "bi-weekly" });

    expect(writes.updateFields).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ recurrence_interval: "biweekly" }),
      expect.any(Object),
    );
  });
});
