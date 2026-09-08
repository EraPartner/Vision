import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());

vi.mock("../src/database/connection.js", () => ({ query }));

import { saveProjection } from "../src/repositories/insightCashProjectionRepository.js";

describe("insightCashProjectionRepository", () => {
  beforeEach(() => query.mockReset());

  it("updates the baseline and retention window in one atomic statement", async () => {
    query.mockResolvedValue({ rows: [] });

    await saveProjection("2026-09", "EUR", "ensemble", 250);

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][0]).toContain("WITH saved AS");
    expect(query.mock.calls[0][0]).toContain("ON CONFLICT");
    expect(query.mock.calls[0][0]).toContain(
      "DELETE FROM insight_cash_projections",
    );
    expect(query.mock.calls[0][1]).toEqual(["2026-09", "EUR", "ensemble", 250]);
  });
});
