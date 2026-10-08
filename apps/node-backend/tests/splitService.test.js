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
        recipientExistsInTransaction: vi.fn(),
      },
    };
  });

vi.mock("../src/database/connection.ts", () =>
  mockConnection({
    withTransaction: mockWithTransaction,
  }),
);

vi.mock("../src/repositories/splitRepository.ts", () => ({
  default: mockRepository,
  ...mockPrimitives,
}));
vi.mock("../src/repositories/auditChainRepository.ts", () => ({
  appendAuditEvent: vi.fn(),
}));

import { appendAuditEvent } from "../src/repositories/auditChainRepository.ts";

import {
  addPayment,
  createBulkSplitsAtomic,
  createSplitAtomic,
  deleteSplit,
  settleSplit,
} from "../src/services/splitService.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockRepository.writeAudit.mockResolvedValue({
    id: "42",
    payload_text: '{"test":true}',
    occurred_at: "2026-09-20T00:00:00.123456Z",
  });
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
    expect(appendAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "split",
        event: "create",
        auditRowId: "42",
        splitId: "9",
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
    expect(appendAuditEvent).not.toHaveBeenCalled();
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


describe("splitService.createBulkSplitsAtomic", () => {
  beforeEach(() => {
    mockPrimitives.recipientExistsInTransaction.mockResolvedValue(true);
    mockPrimitives.insertSplitInTransaction.mockImplementation(
      async (_client, input) => ({ id: input.transaction_id * 10, ...input }),
    );
  });

  it("writes one preset split per unsplit transaction, locking ids in ascending order", async () => {
    const totals = {
      1: { transaction_total: 10.01, current_split_total: 0 },
      2: { transaction_total: 40, current_split_total: 0 },
      5: { transaction_total: 7.5, current_split_total: 0 },
    };
    mockPrimitives.lockAndGetTotals.mockImplementation(
      async (_client, id) => totals[id] ?? null,
    );

    const result = await createBulkSplitsAtomic({
      transaction_ids: [5, 1, 2, 1],
      recipient_id: 3,
      mode: "equal",
      actor: "tor",
    });

    // Deduplicated and sorted: a second overlapping bulk call takes the same
    // row locks in the same order, so the two cannot deadlock.
    expect(
      mockPrimitives.lockAndGetTotals.mock.calls.map(([, id]) => id),
    ).toEqual([1, 2, 5]);
    // Half of each, banker's rounding to cents (10.01 / 2 = 5.005 -> 5.00).
    expect(
      mockPrimitives.insertSplitInTransaction.mock.calls.map(
        ([, input]) => [input.transaction_id, input.amount],
      ),
    ).toEqual([
      [1, 5],
      [2, 20],
      [5, 3.75],
    ]);
    expect(result).toMatchObject({
      requested: 4,
      split: 3,
      skipped_already_split: 0,
      skipped_zero_amount: 0,
      skipped_missing: 0,
    });
    expect(result.items).toHaveLength(3);
    expect(mockRepository.writeAudit).toHaveBeenCalledTimes(3);
    expect(mockRepository.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        split_id: 10,
        action: "create",
        actor: "tor",
        client: mockClient,
        payload: expect.objectContaining({ bulk: true, mode: "equal" }),
      }),
    );
  });

  it("full mode gives the other person the whole amount", async () => {
    mockPrimitives.lockAndGetTotals.mockResolvedValue({
      transaction_total: 12.34,
      current_split_total: 0,
    });

    await createBulkSplitsAtomic({
      transaction_ids: [1],
      recipient_id: 3,
      mode: "full",
    });

    expect(mockPrimitives.insertSplitInTransaction).toHaveBeenCalledWith(
      mockClient,
      expect.objectContaining({ transaction_id: 1, amount: 12.34 }),
    );
  });

  it("skips and counts already-split, zero-amount and missing transactions", async () => {
    const totals = {
      1: { transaction_total: 30, current_split_total: 15 },
      2: { transaction_total: 0, current_split_total: 0 },
      3: { transaction_total: 9, current_split_total: 0 },
    };
    mockPrimitives.lockAndGetTotals.mockImplementation(
      async (_client, id) => totals[id] ?? null,
    );

    const result = await createBulkSplitsAtomic({
      transaction_ids: [1, 2, 3, 4],
      recipient_id: 3,
      mode: "full",
    });

    expect(result).toMatchObject({
      requested: 4,
      split: 1,
      skipped_already_split: 1,
      skipped_zero_amount: 1,
      skipped_missing: 1,
    });
    expect(mockPrimitives.insertSplitInTransaction).toHaveBeenCalledTimes(1);
    expect(mockPrimitives.insertSplitInTransaction).toHaveBeenCalledWith(
      mockClient,
      expect.objectContaining({ transaction_id: 3, amount: 9 }),
    );
  });

  it("rejects an unknown recipient before locking or writing anything", async () => {
    mockPrimitives.recipientExistsInTransaction.mockResolvedValue(false);

    await expect(
      createBulkSplitsAtomic({
        transaction_ids: [1],
        recipient_id: 999,
        mode: "equal",
      }),
    ).rejects.toThrow(/Recipient not found/);
    expect(mockPrimitives.lockAndGetTotals).not.toHaveBeenCalled();
    expect(mockPrimitives.insertSplitInTransaction).not.toHaveBeenCalled();
    expect(mockRepository.writeAudit).not.toHaveBeenCalled();
  });
});
