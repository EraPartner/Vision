import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/repositories/infoRepository.ts", () => ({
  default: {
    getCategoryPivot: vi.fn(),
    getRecipientByYear: vi.fn(),
  },
}));

vi.mock("../src/repositories/infoRepositoryRecipients.ts", () => ({
  recipientInsightsRepository: { getRecipientPivot: vi.fn() },
}));

vi.mock("../src/repositories/infoRepositoryTags.ts", () => ({
  tagInsightsRepository: { getTagPivot: vi.fn() },
}));

import rawInfoRepository from "../src/repositories/infoRepository.ts";
import { recipientInsightsRepository as rawRecipientInsightsRepository } from "../src/repositories/infoRepositoryRecipients.ts";
import { tagInsightsRepository as rawTagInsightsRepository } from "../src/repositories/infoRepositoryTags.ts";
import { computeCategoryPivot } from "../src/services/calculations/aggregation/categoryPivot.ts";
import { computeRecipientByYear } from "../src/services/calculations/aggregation/recipientByYear.ts";
import { computeRecipientPivot } from "../src/services/calculations/aggregation/recipientPivot.ts";
import { computeTagPivot } from "../src/services/calculations/aggregation/tagPivot.ts";
import { statsKeyPart } from "../src/services/calculations/aggregation/_statisticsCache.ts";
import { invalidateStatisticsCaches } from "../src/services/info/cache.ts";
import { loose } from "./helpers/partial.ts";

const infoRepository = vi.mocked(rawInfoRepository);
const recipientInsightsRepository = vi.mocked(rawRecipientInsightsRepository);
const tagInsightsRepository = vi.mocked(rawTagInsightsRepository);

beforeEach(() => {
  vi.clearAllMocks();
  invalidateStatisticsCaches(); // module-scoped cache is shared across tests
  // The cache tests only compare identity and call counts, so the loaders
  // return placeholder rows rather than the repositories' real result shapes.
  infoRepository.getCategoryPivot.mockResolvedValue(
    loose([{ category_id: 1, total: 10 }]),
  );
  infoRepository.getRecipientByYear.mockResolvedValue(
    loose([{ recipient_id: 1, total: 10 }]),
  );
  recipientInsightsRepository.getRecipientPivot.mockResolvedValue(
    loose([{ recipient_id: 1, m: "2026-01", total: 10 }]),
  );
  tagInsightsRepository.getTagPivot.mockResolvedValue(
    loose([{ tag_id: 1, m: "2026-01", total: 10 }]),
  );
});

describe("statistics pivot cache", () => {
  it("serves a repeat call from cache without re-hitting the repository", async () => {
    const a = await computeCategoryPivot({ targetCurrency: "EUR" });
    const b = await computeCategoryPivot({ targetCurrency: "EUR" });
    expect(a).toEqual(b);
    expect(infoRepository.getCategoryPivot).toHaveBeenCalledTimes(1);
  });

  it("keys on the arguments — different exclusions recompute", async () => {
    await computeCategoryPivot({
      targetCurrency: "EUR",
      excludedCategoryIds: [1],
    });
    await computeCategoryPivot({
      targetCurrency: "EUR",
      excludedCategoryIds: [2],
    });
    expect(infoRepository.getCategoryPivot).toHaveBeenCalledTimes(2);
  });

  it("keys on currency — a different target currency recomputes", async () => {
    await computeCategoryPivot({ targetCurrency: "EUR" });
    await computeCategoryPivot({ targetCurrency: "USD" });
    expect(infoRepository.getCategoryPivot).toHaveBeenCalledTimes(2);
  });

  it("keys category and recipient-by-year pivots on the date range", async () => {
    await computeCategoryPivot({
      startDate: "2024-10-01",
      endDate: "2026-09-07",
    });
    await computeCategoryPivot({
      startDate: "2024-11-01",
      endDate: "2026-09-07",
    });
    await computeRecipientByYear({
      startDate: "2024-10-01",
      endDate: "2026-09-07",
    });
    await computeRecipientByYear({
      startDate: "2024-11-01",
      endDate: "2026-09-07",
    });
    expect(infoRepository.getCategoryPivot).toHaveBeenCalledTimes(2);
    expect(infoRepository.getRecipientByYear).toHaveBeenCalledTimes(2);
  });

  it("invalidateStatisticsCaches() forces the next call to recompute", async () => {
    await computeCategoryPivot({ targetCurrency: "EUR" });
    invalidateStatisticsCaches();
    await computeCategoryPivot({ targetCurrency: "EUR" });
    expect(infoRepository.getCategoryPivot).toHaveBeenCalledTimes(2);
  });

  it("recipient pivot caches, and keys on bucket/date/id params", async () => {
    const base = {
      targetCurrency: "EUR",
      bucket: "monthly",
      startDate: "2026-01-01",
      endDate: "2026-06-30",
    };
    await computeRecipientPivot(base);
    await computeRecipientPivot(base); // cache hit
    expect(recipientInsightsRepository.getRecipientPivot).toHaveBeenCalledTimes(
      1,
    );
    await computeRecipientPivot({ ...base, bucket: "yearly" }); // different bucket → miss
    await computeRecipientPivot({ ...base, recipientIds: [5] }); // different ids → miss
    expect(recipientInsightsRepository.getRecipientPivot).toHaveBeenCalledTimes(
      3,
    );
  });

  it("tag pivot caches, and keys on allTags/date params", async () => {
    const base = {
      targetCurrency: "EUR",
      bucket: "monthly",
      startDate: "2026-01-01",
    };
    await computeTagPivot(base);
    await computeTagPivot(base); // cache hit
    expect(tagInsightsRepository.getTagPivot).toHaveBeenCalledTimes(1);
    await computeTagPivot({ ...base, allTags: true }); // different allTags → miss
    expect(tagInsightsRepository.getTagPivot).toHaveBeenCalledTimes(2);
  });

  it("does not collide across endpoints sharing the cache map", async () => {
    await computeCategoryPivot({ targetCurrency: "EUR" });
    await computeRecipientByYear({ targetCurrency: "EUR" });
    // Distinct key prefixes → both compute despite the shared Map.
    expect(infoRepository.getCategoryPivot).toHaveBeenCalledTimes(1);
    expect(infoRepository.getRecipientByYear).toHaveBeenCalledTimes(1);
  });

  it("forwards named pivot options to every repository boundary", async () => {
    const common = {
      targetCurrency: "USD",
      bucket: "yearly",
      startDate: "2025-01-02",
      endDate: "2025-12-30",
    };

    await computeCategoryPivot({
      targetCurrency: common.targetCurrency,
      excludedCategoryIds: [11],
      excludedRecipientIds: [22],
      startDate: common.startDate,
      endDate: common.endDate,
    });
    await computeRecipientByYear({
      targetCurrency: common.targetCurrency,
      excludedRecipientIds: [22],
      excludedCategoryIds: [11],
      startDate: common.startDate,
      endDate: common.endDate,
    });
    await computeRecipientPivot({
      ...common,
      excludedRecipientIds: [22],
      recipientIds: [33],
    });
    await computeTagPivot({
      ...common,
      tagIds: [44],
      allTags: true,
    });

    expect(infoRepository.getCategoryPivot).toHaveBeenCalledWith({
      excludedCategoryIds: [11],
      targetCurrency: "USD",
      excludedRecipientIds: [22],
      startDate: "2025-01-02",
      endDate: "2025-12-30",
    });
    expect(infoRepository.getRecipientByYear).toHaveBeenCalledWith({
      targetCurrency: "USD",
      excludedRecipientIds: [22],
      excludedCategoryIds: [11],
      startDate: "2025-01-02",
      endDate: "2025-12-30",
    });
    expect(recipientInsightsRepository.getRecipientPivot).toHaveBeenCalledWith({
      excludedRecipientIds: [22],
      targetCurrency: "USD",
      bucket: "yearly",
      startDate: "2025-01-02",
      endDate: "2025-12-30",
      recipientIds: [33],
    });
    expect(tagInsightsRepository.getTagPivot).toHaveBeenCalledWith({
      targetCurrency: "USD",
      bucket: "yearly",
      startDate: "2025-01-02",
      endDate: "2025-12-30",
      tagIds: [44],
      allTags: true,
    });
  });

  it("an in-flight call is deduped (concurrent identical requests share one load)", async () => {
    let resolveLoad!: (value: unknown) => void;
    infoRepository.getCategoryPivot.mockReturnValue(
      loose(
        new Promise((r) => {
          resolveLoad = r;
        }),
      ),
    );
    const p1 = computeCategoryPivot({ targetCurrency: "EUR" });
    const p2 = computeCategoryPivot({ targetCurrency: "EUR" });
    resolveLoad([{ category_id: 1, total: 10 }]);
    await Promise.all([p1, p2]);
    expect(infoRepository.getCategoryPivot).toHaveBeenCalledTimes(1);
  });
});

describe("statsKeyPart", () => {
  it("is order-independent and treats empty/null/undefined alike", () => {
    expect(statsKeyPart([2, 1, 3])).toBe("1,2,3");
    expect(statsKeyPart([])).toBe("");
    expect(statsKeyPart(null)).toBe("");
    expect(statsKeyPart(undefined)).toBe("");
  });
});
