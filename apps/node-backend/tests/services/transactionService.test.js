import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  isManualDuplicate: vi.fn(),
  recordManualRawTransaction: vi.fn(),
  autoLinkTransactions: vi.fn(),
  resolveRecipientIdByName: vi.fn(),
  resolveCategoryIdByName: vi.fn(),
  scheduleReconcile: vi.fn(),
  getTransferSuggestions: vi.fn(),
  markTransfer: vi.fn(),
  unmarkTransfer: vi.fn(),
}));

vi.mock("../../src/repositories/transactionRepository.js", () => ({
  default: { create: mocks.create, update: mocks.update },
}));
vi.mock("../../src/services/recipientService.js", () => ({
  resolveRecipientIdByName: mocks.resolveRecipientIdByName,
}));
vi.mock("../../src/services/categoryService.js", () => ({
  resolveCategoryIdByName: mocks.resolveCategoryIdByName,
}));
vi.mock("../../src/services/transferReconciliationService.js", () => ({
  scheduleReconcile: mocks.scheduleReconcile,
  getTransferSuggestions: mocks.getTransferSuggestions,
  markTransfer: mocks.markTransfer,
  unmarkTransfer: mocks.unmarkTransfer,
}));
vi.mock("../../src/services/deduplication.js", () => ({
  isManualDuplicate: mocks.isManualDuplicate,
  recordManualRawTransaction: mocks.recordManualRawTransaction,
}));
vi.mock("../../src/services/plannedMatchService.js", () => ({
  autoLinkTransactions: mocks.autoLinkTransactions,
}));
vi.mock("../../src/services/attachmentRecordService.js", () => ({
  attachmentRepository: { listPathsByTransactionIds: vi.fn() },
}));
vi.mock("../../src/services/attachmentCleanup.js", () => ({
  removeAttachmentFilesBestEffort: vi.fn(),
}));
vi.mock("../../src/config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

const { default: transactionService } =
  await import("../../src/services/transactionService.js");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("transactionService route orchestration", () => {
  it("blocks a matching manual transaction by default", async () => {
    mocks.isManualDuplicate.mockResolvedValue({
      isDuplicate: true,
      existingTransactionId: 42,
    });

    await expect(
      transactionService.createManualTransaction({
        transaction_date: "2026-09-03",
        bank_account: "Main",
        recipient_id: 7,
        amount: -12.5,
      }),
    ).rejects.toThrow("Duplicate transaction detected");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("creates a matching manual transaction only after explicit confirmation", async () => {
    mocks.isManualDuplicate.mockResolvedValue({
      isDuplicate: true,
      existingTransactionId: 42,
    });
    mocks.create.mockResolvedValue({ id: 43 });
    mocks.autoLinkTransactions.mockResolvedValue({
      autoLinkedCount: 0,
      links: [],
    });

    await expect(
      transactionService.createManualTransaction({
        transaction_date: "2026-09-03",
        bank_account: "Main",
        recipient_id: 7,
        amount: -12.5,
        allow_duplicate: true,
      }),
    ).resolves.toMatchObject({ transaction: { id: 43 } });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.recordManualRawTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: 43 }),
    );
  });

  it("resolves PATCH names, strips convenience fields, updates, and reconciles", async () => {
    mocks.resolveRecipientIdByName.mockResolvedValue(11);
    mocks.resolveCategoryIdByName.mockResolvedValue(22);
    mocks.update.mockResolvedValue({ id: 7 });

    await expect(
      transactionService.update(7, {
        recipient_name: "Shop",
        category_name: "FOOD:GROCERIES",
        memo: "weekly",
      }),
    ).resolves.toEqual({ id: 7 });

    expect(mocks.resolveRecipientIdByName).toHaveBeenCalledWith("Shop");
    expect(mocks.resolveCategoryIdByName).toHaveBeenCalledWith(
      "FOOD:GROCERIES",
    );
    expect(mocks.update).toHaveBeenCalledWith(7, {
      recipient_id: 11,
      category_id: 22,
      memo: "weekly",
    });
    expect(mocks.scheduleReconcile).toHaveBeenCalledTimes(1);
  });

  it("preserves explicit nullable ids without name lookups", async () => {
    mocks.update.mockResolvedValue({ id: 7 });

    await transactionService.update(7, {
      recipient_id: null,
      category_id: 9,
    });

    expect(mocks.resolveRecipientIdByName).not.toHaveBeenCalled();
    expect(mocks.resolveCategoryIdByName).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith(7, {
      recipient_id: null,
      category_id: 9,
    });
  });

  it("does not reconcile when the transaction was not found", async () => {
    mocks.update.mockResolvedValue(null);

    await expect(
      transactionService.update(99, { memo: "missing" }),
    ).resolves.toBeNull();

    expect(mocks.scheduleReconcile).not.toHaveBeenCalled();
  });

  it("owns transfer marking side effects", async () => {
    await transactionService.markTransfer(1, 2);
    await transactionService.unmarkTransfer(1);

    expect(mocks.markTransfer).toHaveBeenCalledWith(1, 2);
    expect(mocks.unmarkTransfer).toHaveBeenCalledWith(1);
    expect(mocks.scheduleReconcile).toHaveBeenCalledTimes(2);
  });
});
