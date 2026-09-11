import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/repositories/settingsRepository.js", () => ({
  settingsRepository: { get: vi.fn() },
}));

vi.mock("../src/services/portfolio/portfolioSummaryService.js", () => ({
  getPortfolioSummary: vi.fn(),
}));

import { settingsRepository } from "../src/repositories/settingsRepository.js";
import { getPortfolioSummary } from "../src/services/portfolio/portfolioSummaryService.js";
import {
  getAiDisplayCurrency,
  loadCanonicalPortfolioSummary,
} from "../src/services/aiChat/tools/_financialMetrics.js";

beforeEach(() => vi.resetAllMocks());

describe("AI canonical financial metric adapter", () => {
  it("uses the configured display currency and memoizes a dated summary", async () => {
    settingsRepository.get.mockResolvedValue({ defaultCurrency: "usd" });
    getPortfolioSummary.mockResolvedValue({ currency: "USD", summaries: [] });
    const cache = new Map();

    const first = await loadCanonicalPortfolioSummary(cache, {
      throughDate: "2025-12-31",
    });
    const second = await loadCanonicalPortfolioSummary(cache, {
      throughDate: "2025-12-31",
    });

    expect(first).toBe(second);
    expect(getPortfolioSummary).toHaveBeenCalledTimes(1);
    expect(getPortfolioSummary).toHaveBeenCalledWith("USD", {
      throughDate: "2025-12-31",
      activeInvestmentsOnly: true,
    });
  });

  it("keeps all-investment history separate from the active portfolio cache", async () => {
    settingsRepository.get.mockResolvedValue({ defaultCurrency: "EUR" });
    getPortfolioSummary.mockResolvedValue({ currency: "EUR", summaries: [] });
    const cache = new Map();

    await loadCanonicalPortfolioSummary(cache, {
      throughDate: "2025-12-31",
    });
    await loadCanonicalPortfolioSummary(cache, {
      throughDate: "2025-12-31",
      activeInvestmentsOnly: false,
    });

    expect(getPortfolioSummary).toHaveBeenNthCalledWith(1, "EUR", {
      throughDate: "2025-12-31",
      activeInvestmentsOnly: true,
    });
    expect(getPortfolioSummary).toHaveBeenNthCalledWith(2, "EUR", {
      throughDate: "2025-12-31",
      activeInvestmentsOnly: false,
    });
  });

  it("recovers invalid persisted currency values to EUR", async () => {
    settingsRepository.get.mockResolvedValue({ defaultCurrency: "EURO" });

    await expect(getAiDisplayCurrency()).resolves.toBe("EUR");
  });
});
