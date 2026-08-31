import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/database/connection.js", () => ({ query: vi.fn() }));
vi.mock("../../src/repositories/infoRepositoryHelpers.js", () => ({
  getIncludeTransfers: vi.fn(),
}));

import { query } from "../../src/database/connection.js";
import { getIncludeTransfers } from "../../src/repositories/infoRepositoryHelpers.js";
import { getSankeyAggregates } from "../../src/repositories/infoRepositorySankey.js";

beforeEach(() => {
  query.mockReset();
  getIncludeTransfers.mockReset();
  getIncludeTransfers.mockResolvedValue(false);
});

describe("getSankeyAggregates", () => {
  it("owns grouped SQL, category identity, canonical exclusions, and transfer policy", async () => {
    query.mockResolvedValueOnce({ rows: [{ category_id: null }] });

    const rows = await getSankeyAggregates({
      yearStart: "2025-01-01",
      yearEnd: "2025-12-31",
      excludedCategoryIds: [7],
      excludedRecipientIds: [9],
    });

    const [sql, params] = query.mock.calls[0];
    expect(rows).toEqual([{ category_id: null }]);
    expect(sql).toContain("c.id AS category_id");
    expect(sql).toContain("SUM(ABS(t.amount))");
    expect(sql).toContain(
      "LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id",
    );
    expect(sql).toContain(
      "COALESCE(t.category_id, r.default_category_id, pr.default_category_id, -1) NOT IN ($3)",
    );
    expect(sql).toContain(
      "COALESCE(r.primary_recipient_id, t.recipient_id, -1) NOT IN ($4)",
    );
    expect(sql).toContain("AND t.is_transfer = false");
    expect(params).toEqual(["2025-01-01", "2025-12-31", 7, 9]);
  });

  it("omits the transfer predicate only when requested", async () => {
    getIncludeTransfers.mockResolvedValueOnce(true);
    query.mockResolvedValueOnce({ rows: [] });
    await getSankeyAggregates({
      yearStart: "2025-01-01",
      yearEnd: "2025-12-31",
    });
    expect(query.mock.calls[0][0]).not.toContain("t.is_transfer = false");
  });
});
