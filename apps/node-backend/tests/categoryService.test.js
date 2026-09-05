import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockConnection } from "./helpers/repoMocks.js";

vi.mock("../src/database/connection.js", () =>
  mockConnection({ query: vi.fn() }),
);

import { query } from "../src/database/connection.js";
import { resolveCategoryIdByName } from "../src/services/categoryService.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveCategoryIdByName", () => {
  it("only resolves active categories", async () => {
    query.mockResolvedValue({ rows: [{ id: 12 }] });

    await expect(resolveCategoryIdByName("Income:Dividends")).resolves.toBe(12);

    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/detail = \$2 AND is_active = true/),
      ["INCOME", "DIVIDENDS"],
    );
  });

  it("rejects a name when no active category matches", async () => {
    query.mockResolvedValue({ rows: [] });

    await expect(resolveCategoryIdByName("Income:Dividends")).rejects.toThrow(
      "does not exist",
    );
  });
});
