import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recipientExists: vi.fn(),
  upsertSubscription: vi.fn(),
  upsertOutlier: vi.fn(),
  detectCategoryOutliers: vi.fn(),
}));

vi.mock("../src/repositories/insightDismissalRepository.js", () => ({
  default: {
    recipientExists: mocks.recipientExists,
    upsertSubscription: mocks.upsertSubscription,
    upsertOutlier: mocks.upsertOutlier,
  },
}));

vi.mock("../src/services/categoryOutlierService.js", () => ({
  detectCategoryOutliers: mocks.detectCategoryOutliers,
}));

import { dismissInsight } from "../src/services/insightDismissalService.js";
import { NotFoundError } from "../src/middleware/errorHandler.js";

describe("insightDismissalService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.recipientExists.mockResolvedValue(true);
  });

  it("idempotently delegates subscription dismissals", async () => {
    mocks.upsertSubscription.mockResolvedValue({ id: 1 });
    await expect(
      dismissInsight({ kind: "subscription_new", recipient_id: 8 }),
    ).resolves.toEqual({ id: 1 });
    expect(mocks.upsertSubscription).toHaveBeenCalledWith(
      "subscription_new",
      8,
    );
  });

  it("rejects a subscription recipient that no longer exists", async () => {
    mocks.recipientExists.mockResolvedValue(false);

    await expect(
      dismissInsight({ kind: "subscription_new", recipient_id: 8 }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(mocks.upsertSubscription).not.toHaveBeenCalled();
  });

  it("stores the current server-derived outlier deviation", async () => {
    mocks.detectCategoryOutliers.mockResolvedValue([
      { categoryId: 4, monthKey: "2026-09", deviation: 4.25 },
    ]);
    mocks.upsertOutlier.mockResolvedValue({ id: 2 });

    await dismissInsight({
      kind: "category_outlier",
      category_id: 4,
      month_key: "2026-09",
    });

    expect(mocks.upsertOutlier).toHaveBeenCalledWith(4, "2026-09", 4.25);
  });

  it("rejects a category finding that is no longer active", async () => {
    mocks.detectCategoryOutliers.mockResolvedValue([]);
    await expect(
      dismissInsight({
        kind: "category_outlier",
        category_id: 4,
        month_key: "2026-09",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(mocks.upsertOutlier).not.toHaveBeenCalled();
  });
});
