import { beforeEach, describe, expect, it, vi } from "vitest";

const exposure = vi.hoisted(() => ({
  getPortfolioExposure: vi.fn(),
  upsertPortfolioExposureBundle: vi.fn(),
}));

vi.mock(
  "../../src/services/portfolio/portfolioExposureService.js",
  () => exposure,
);
vi.mock("../../src/services/investmentService.js", () =>
  Object.fromEntries(
    [
      "listInvestments",
      "createInvestment",
      "listProviders",
      "refreshPrices",
      "getBulkTransactions",
      "getPriceHistory",
      "getInvestment",
      "updateInvestment",
      "deleteInvestment",
      "listTransactions",
      "createTransaction",
      "deleteTransaction",
      "updateTransaction",
      "getInvestmentSummary",
      "bulkRetagTransactions",
    ].map((name) => [name, vi.fn()]),
  ),
);

const { default: router } = await import("../../src/routes/investments.js");
const routeHandler = (method, path) =>
  router.stack
    .find((layer) => layer.route?.path === path && layer.route.methods[method])
    .route.stack.at(-1).handle;

beforeEach(() => vi.clearAllMocks());

describe("portfolio exposure routes", () => {
  it("normalizes a valid reporting currency and delegates aggregation", async () => {
    exposure.getPortfolioExposure.mockResolvedValue({ currency: "USD" });
    const ok = vi.fn();
    await routeHandler("get", "/exposure")(
      { query: { currency: "usd" } },
      { ok },
    );

    expect(exposure.getPortfolioExposure).toHaveBeenCalledWith("USD");
    expect(ok).toHaveBeenCalledWith({ currency: "USD" });
  });

  it("rejects a malformed currency before aggregation", async () => {
    await expect(
      routeHandler("get", "/exposure")(
        { query: { currency: "euro" } },
        { ok: vi.fn() },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(exposure.getPortfolioExposure).not.toHaveBeenCalled();
  });

  it("maps only typed source-validation failures to a safe 400", async () => {
    exposure.upsertPortfolioExposureBundle.mockRejectedValue(
      Object.assign(new Error("private parser detail"), {
        code: "INVALID_PORTFOLIO_EXPOSURE_SOURCE",
      }),
    );
    await expect(
      routeHandler("put", "/exposure/sources")(
        { body: { classifications: [], fundDocuments: [] } },
        { ok: vi.fn() },
      ),
    ).rejects.toMatchObject({
      code: "INVALID_PORTFOLIO_EXPOSURE_SOURCE",
      message: "The exposure source bundle is invalid",
    });
  });

  it("does not disguise unexpected persistence failures as user input errors", async () => {
    const failure = new Error("database unavailable");
    exposure.upsertPortfolioExposureBundle.mockRejectedValue(failure);

    await expect(
      routeHandler("put", "/exposure/sources")(
        { body: { classifications: [], fundDocuments: [] } },
        { ok: vi.fn() },
      ),
    ).rejects.toBe(failure);
  });
});
