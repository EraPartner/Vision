import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ upsert: vi.fn() }));
vi.mock("../../src/repositories/infoRepository.js", () => ({
  infoRepository: {
    getIncludeTransfers: vi.fn(async () => false),
    getCashflowForecastData: vi.fn(async () => ({
      history: [],
      currentActual: [],
      plannedCurrent: [],
      plannedHist: [],
      historyMonths: 36,
    })),
  },
}));
vi.mock("../../src/repositories/cashflowForecastMcRepository.js", () => ({
  default: { upsert: mocks.upsert },
}));
vi.mock("../../src/services/calculations/forecast/accuracyStore.js", () => ({
  recordAccuracy: vi.fn(),
  getLatestAccuracyByMethod: vi.fn(async () => []),
}));
import { computeCashflowForecast } from "../../src/services/calculations/forecast/index.js";
beforeEach(() => vi.clearAllMocks());
describe("daily forecast completion requires acknowledged persistence", () => {
  it("propagates forced cache write failure", async () => {
    mocks.upsert.mockRejectedValue(new Error("cache persistence failed"));
    await expect(
      computeCashflowForecast({
        _forceCache: true,
        includeBacktest: false,
        mcPaths: 1000,
        mcPercentiles: [10, 50, 90],
      }),
    ).rejects.toThrow("cache persistence failed");
  });
  it("awaits forced cache writes before returning success", async () => {
    let finish;
    let completed = false;
    mocks.upsert.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const result = computeCashflowForecast({
      _forceCache: true,
      includeBacktest: false,
      mcPaths: 1000,
      mcPercentiles: [10, 50, 90],
    }).then(() => {
      completed = true;
    });
    await vi.waitFor(() => expect(mocks.upsert).toHaveBeenCalledOnce());
    expect(completed).toBe(false);
    finish();
    await result;
    expect(completed).toBe(true);
  });
});
