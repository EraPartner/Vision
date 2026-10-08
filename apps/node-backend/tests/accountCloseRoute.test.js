import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/accountService.ts", () => ({
  default: {},
}));
vi.mock("../src/services/accountMergeService.ts", () => ({
  MAX_ACCOUNT_MERGE_SOURCES: 500,
  mergeAccounts: vi.fn(),
  previewMerge: vi.fn(),
}));
vi.mock("../src/services/openingBalanceService.ts", () => ({
  setOpeningBalance: vi.fn(),
}));
vi.mock("../src/services/reconcileService.ts", () => ({
  reconcileAccount: vi.fn(),
}));
vi.mock("../src/services/accountCloseService.ts", () => ({
  closeAccount: vi.fn(),
  previewAccountPortfolioLots: vi.fn(),
}));
vi.mock("../src/services/aggregationRefresh.ts", () => ({
  scheduleAggregationRefresh: vi.fn(),
}));
vi.mock("../src/services/info/cache.ts", () => ({
  invalidatePortfolioCaches: vi.fn(),
}));

import {
  closeAccount,
  previewAccountPortfolioLots,
} from "../src/services/accountCloseService.ts";
import { scheduleAggregationRefresh } from "../src/services/aggregationRefresh.ts";
import { invalidatePortfolioCaches } from "../src/services/info/cache.ts";

const { default: accountsRouter } = await import("../src/routes/accounts.ts");

function closeRouteHandler() {
  const layer = accountsRouter.stack.find(
    (entry) => entry.route?.path === "/:id/close" && entry.route.methods.post,
  );
  return layer.route.stack.at(-1).handle;
}

function closePortfolioPreviewRouteHandler() {
  const layer = accountsRouter.stack.find(
    (entry) =>
      entry.route?.path === "/:id/portfolio-lot-retag-preview" &&
      entry.route.methods.get,
  );
  return layer.route.stack.at(-1).handle;
}

describe("POST /:id/close listener-free route contract", () => {
  beforeEach(() => vi.clearAllMocks());

  it("forwards the explicit balance handling and refreshes derived data", async () => {
    closeAccount.mockResolvedValue({
      account_id: 7,
      balance_handling: "adjustment",
      adjustments: [],
    });
    const res = { ok: vi.fn() };

    await closeRouteHandler()(
      /** @type {any} */ ({
        params: { id: "7" },
        body: { balance_handling: "adjustment" },
      }),
      /** @type {any} */ (res),
    );

    expect(closeAccount).toHaveBeenCalledWith(7, {
      balance_handling: "adjustment",
    });
    expect(scheduleAggregationRefresh).toHaveBeenCalledOnce();
    expect(invalidatePortfolioCaches).toHaveBeenCalledOnce();
    expect(res.ok).toHaveBeenCalledWith(
      expect.objectContaining({ account_id: 7, links: [] }),
    );
  });
});

describe("GET /:id/portfolio-lot-retag-preview listener-free route contract", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the exact service preview without mutating derived caches", async () => {
    previewAccountPortfolioLots.mockResolvedValue({
      account_id: 7,
      eligible_count: 2,
      transaction_ids: [11, 12],
      limit: 500,
    });
    const res = { ok: vi.fn() };

    await closePortfolioPreviewRouteHandler()(
      /** @type {any} */ ({ params: { id: "7" } }),
      /** @type {any} */ (res),
    );

    expect(previewAccountPortfolioLots).toHaveBeenCalledWith(7);
    expect(res.ok).toHaveBeenCalledWith({
      account_id: 7,
      eligible_count: 2,
      transaction_ids: [11, 12],
      limit: 500,
      links: [],
    });
    expect(scheduleAggregationRefresh).not.toHaveBeenCalled();
    expect(invalidatePortfolioCaches).not.toHaveBeenCalled();
  });
});
