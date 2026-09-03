import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockConnection } from "./helpers/repoMocks.js";
import { mockCurrencyConversion } from "./helpers/mockCurrencyConversion.js";

vi.mock("../src/database/connection.js", () => mockConnection());
vi.mock("../src/services/currency/currencyConversionService.js", () =>
  mockCurrencyConversion(),
);

import { query } from "../src/database/connection.js";
import { convertRowsToEur } from "../src/services/currency/currencyConversionService.js";
import { tagInsightsRepository } from "../src/repositories/infoRepositoryTags.js";

beforeEach(() => vi.clearAllMocks());

describe("tagInsightsRepository.getTagPivot id validation", () => {
  it("rejects a malformed selection before querying", async () => {
    await expect(
      tagInsightsRepository.getTagPivot({ tagIds: [5, "evil"] }),
    ).rejects.toThrow(/tagIds contains invalid value/);
    expect(query).not.toHaveBeenCalled();
  });

  it("retains a selected tag at the int4 ceiling", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    convertRowsToEur.mockResolvedValueOnce([]);

    await tagInsightsRepository.getTagPivot({ tagIds: [2147483647] });

    expect(query.mock.calls[0][1]).toEqual([[2147483647]]);
  });
});
