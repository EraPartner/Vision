import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockConnection } from "./helpers/repoMocks.js";

const { mockClient, mockWithTransaction, mockRepository, mockPrimitives } =
  vi.hoisted(() => {
    const client = { query: vi.fn() };
    return {
      mockClient: client,
      mockWithTransaction: vi.fn(async (fn) => fn(client)),
      mockRepository: {
        writeAudit: vi.fn(),
        settleSplit: vi.fn(),
        settleAllByRecipient: vi.fn(),
        deleteSplit: vi.fn(),
        getSplitById: vi.fn(),
        getOwedSummaryRows: vi.fn(),
        getOwedByRecipientRows: vi.fn(),
      },
      mockPrimitives: {
        formatSplit: vi.fn((row) => row),
        getPaidAmountInTransaction: vi.fn(),
        insertPaymentInTransaction: vi.fn(),
        insertSplitInTransaction: vi.fn(),
        insertSplitsBatchInTransaction: vi.fn(),
        lockAndGetTotals: vi.fn(),
        lockSplitForPayment: vi.fn(),
        markSettledIfCovered: vi.fn(),
      },
    };
  });

vi.mock("../src/database/connection.js", () =>
  mockConnection({
    withTransaction: mockWithTransaction,
  }),
);

vi.mock("../src/repositories/splitRepository.js", () => ({
  default: mockRepository,
  ...mockPrimitives,
}));

import {
  addPayment,
  createSplitAtomic,
  deleteSplit,
  settleSplit,
} from "../src/services/splitService.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("splitService transaction orchestration", () => {
  it("creates and audits a split with the same transaction client", async () => {
    mockPrimitives.lockAndGetTotals.mockResolvedValue({
      transaction_total: 50,
      current_split_total: 0,
    });
    mockPrimitives.insertSplitInTransaction.mockResolvedValue({
      id: 9,
      recipient_id: 2,
      amount: 20,
      note: null,
    });

    await createSplitAtomic({
      transaction_id: 1,
      recipient_id: 2,
      amount: "20",
      actor: "test",
    });

    expect(mockPrimitives.insertSplitInTransaction).toHaveBeenCalledWith(
      mockClient,
      expect.objectContaining({ amount: 20 }),
    );
    expect(mockRepository.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        split_id: 9,
        action: "create",
        actor: "test",
        client: mockClient,
      }),
    );
  });

  it("rejects an overpayment before insert or audit", async () => {
    mockPrimitives.lockSplitForPayment.mockResolvedValue({
      id: 7,
      amount: "30.0000",
      is_settled: false,
    });
    mockPrimitives.getPaidAmountInTransaction.mockResolvedValue("25.0000");

    await expect(addPayment({ split_id: 7, amount: 6 })).rejects.toThrow(
      /exceed split outstanding balance/,
    );
    expect(mockPrimitives.insertPaymentInTransaction).not.toHaveBeenCalled();
    expect(mockRepository.writeAudit).not.toHaveBeenCalled();
  });

  it("settles and audits with the same transaction client", async () => {
    mockRepository.settleSplit.mockResolvedValue({ id: 7 });

    await expect(settleSplit(7, "test")).resolves.toEqual({ id: 7 });
    expect(mockRepository.settleSplit).toHaveBeenCalledWith(7, mockClient);
    expect(mockRepository.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        split_id: 7,
        action: "settle",
        actor: "test",
        client: mockClient,
      }),
    );
  });

  it("deletes from a captured snapshot and audits in one transaction", async () => {
    mockRepository.getSplitById.mockResolvedValue({
      id: 7,
      transaction_id: 3,
      recipient_id: 2,
      amount: 12,
    });
    mockRepository.deleteSplit.mockResolvedValue(true);

    await expect(deleteSplit(7, "test")).resolves.toBe(true);
    expect(mockRepository.getSplitById).toHaveBeenCalledWith(7, mockClient);
    expect(mockRepository.deleteSplit).toHaveBeenCalledWith(7, mockClient);
    expect(mockRepository.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        split_id: null,
        action: "delete",
        actor: "test",
        client: mockClient,
        payload: expect.objectContaining({ transaction_id: 3 }),
      }),
    );
  });
});
