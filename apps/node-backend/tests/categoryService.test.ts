import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockConnection } from "./helpers/repoMocks.ts";
import { partial } from "./helpers/partial.ts";

vi.mock("../src/database/connection.ts", () =>
  mockConnection({ query: vi.fn() }),
);

import { query as rawQuery } from "../src/database/connection.ts";
import type { PgQueryResult } from "../src/database/connection.ts";
import { resolveCategoryIdByName } from "../src/services/categoryService.ts";

const query = vi.mocked(rawQuery);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveCategoryIdByName", () => {
  it("only resolves active categories", async () => {
    query.mockResolvedValue(partial<PgQueryResult>({ rows: [{ id: 12 }] }));

    await expect(resolveCategoryIdByName("Income:Dividends")).resolves.toBe(12);

    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/path_name = \$1 AND is_active = true/),
      ["INCOME:DIVIDENDS"],
    );
  });

  it("resolves a depth-four path without splitting display text", async () => {
    query.mockResolvedValueOnce(partial<PgQueryResult>({ rows: [{ id: 23 }] }));

    await expect(
      resolveCategoryIdByName("Home:Utilities:Power:Solar"),
    ).resolves.toBe(23);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("rejects ambiguous rendered paths and requires an id", async () => {
    query.mockResolvedValueOnce(
      partial<PgQueryResult>({ rows: [{ id: 1 }, { id: 2 }] }),
    );

    await expect(resolveCategoryIdByName("A:B:C")).rejects.toThrow("ambiguous");
  });

  it("rejects a name when no active category matches", async () => {
    query.mockResolvedValue(partial<PgQueryResult>({ rows: [] }));

    await expect(resolveCategoryIdByName("Income:Dividends")).rejects.toThrow(
      "does not exist",
    );
  });

  it("resolves a merged legacy name through its durable alias", async () => {
    query
      .mockResolvedValueOnce(partial<PgQueryResult>({ rows: [] }))
      .mockResolvedValueOnce(partial<PgQueryResult>({ rows: [{ id: 42 }] }));

    await expect(resolveCategoryIdByName("Food:Groceries")).resolves.toBe(42);
    expect(query.mock.calls[1]![0]).toContain("category_merge_aliases");
  });
});
