/**
 * Category projection properties for the production materialized-view helper.
 * Inputs have already been filtered and converted to EUR. These tests cover
 * grouping and totals, not database exclusions or currency conversion.
 */
import { describe, expect, it, vi } from "vitest";
import { mockConnection } from "../helpers/repoMocks.js";

vi.mock("../../src/database/connection.ts", () => mockConnection());

import { buildCategoryFromConvertedRows } from "../../src/repositories/infoRepositoryHelpers.js";

function seeded(seed) {
  let t = seed >>> 0;
  return function next() {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

describe("property: production category totals", () => {
  it("conserves signed cents and counts across repeated category rows", () => {
    const rng = seeded(0xca1ec0e);
    const categories = [-1, 1, 2, 3, 4];

    for (let trial = 0; trial < 100; trial++) {
      const entries = Array.from(
        { length: 50 + Math.floor(rng() * 500) },
        () => {
          const id = categories[Math.floor(rng() * categories.length)];
          return {
            id,
            cents: Math.floor(rng() * 500001) - 250000,
            count: 1 + Math.floor(rng() * 10),
            stringify: rng() < 0.5,
          };
        },
      );
      const rows = entries.map(({ id, cents, count, stringify }) => ({
        category_id: id !== -1 && stringify ? String(id) : id,
        name: id === -1 ? "Uncategorized" : `Category ${id}`,
        amount_eur: cents / 100,
        count: stringify ? String(count) : count,
      }));
      const result = buildCategoryFromConvertedRows(rows);

      expect(result).toHaveLength(categories.length);
      for (const id of categories) {
        const expectedEntries = entries.filter((entry) => entry.id === id);
        const expectedCents = expectedEntries.reduce(
          (total, entry) => total + BigInt(entry.cents),
          0n,
        );
        const category = result.find(
          (entry) => entry.id === (id === -1 ? null : id),
        );
        expect(category?.name).toBe(
          id === -1 ? "Uncategorized" : `Category ${id}`,
        );
        expect(Math.round(category.total * 100)).toBe(Number(expectedCents));
        expect(category.count).toBe(
          expectedEntries.reduce((total, entry) => total + entry.count, 0),
        );
      }
      expect(
        Math.round(
          result.reduce((total, entry) => total + entry.total, 0) * 100,
        ),
      ).toBe(entries.reduce((total, entry) => total + entry.cents, 0));
      expect(buildCategoryFromConvertedRows([...rows].reverse())).toEqual(
        expect.arrayContaining(
          result.map((entry) =>
            expect.objectContaining({
              id: entry.id,
              count: entry.count,
              total: expect.closeTo(entry.total, 8),
            }),
          ),
        ),
      );
    }
  });

  it("preserves duplicate contributions and negative uncategorized amounts", () => {
    const duplicate = {
      category_id: "7",
      name: "Food",
      amount_eur: 0.1,
      count: "2",
    };
    expect(
      buildCategoryFromConvertedRows([
        duplicate,
        duplicate,
        {
          category_id: -1,
          name: "Uncategorized",
          amount_eur: -0.03,
          count: "1",
        },
      ]),
    ).toEqual([
      { id: 7, name: "Food", total: 0.2, count: 4 },
      { id: null, name: "Uncategorized", total: -0.03, count: 1 },
    ]);
  });

  it("returns no categories for empty input", () => {
    expect(buildCategoryFromConvertedRows([])).toEqual([]);
  });
});
