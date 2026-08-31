import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  resolveRecipientIdByName: vi.fn(),
  resolveCategoryIdByName: vi.fn(),
  scheduleReconcile: vi.fn(),
  getTransferSuggestions: vi.fn(),
  markTransfer: vi.fn(),
  unmarkTransfer: vi.fn(),
}));

vi.mock("../../src/repositories/transactionRepository.js", () => ({
  default: { update: mocks.update },
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
  isManualDuplicate: vi.fn(),
  recordManualRawTransaction: vi.fn(),
}));
vi.mock("../../src/services/plannedMatchService.js", () => ({
  autoLinkTransactions: vi.fn(),
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
