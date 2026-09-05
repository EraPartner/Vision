import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockConnection } from "./helpers/repoMocks.js";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  withTransaction: vi.fn(async (callback) => callback()),
}));

vi.mock("../src/database/connection.js", () =>
  mockConnection({
    query: mocks.query,
    withTransaction: mocks.withTransaction,
  }),
);

import savedChartsRepository from "../src/repositories/savedChartsRepository.js";

const storedRow = {
  id: 7,
  name: "Spending",
  chart_type: "bar",
  category_ids: [1, 2],
  recipient_ids: [],
  tag_ids: [5],
  all_categories: false,
  all_recipients: false,
  all_tags: false,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("savedChartsRepository normalized memberships", () => {
  it("reads the existing array contract from all three membership tables", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [storedRow] });

    await expect(savedChartsRepository.getById(7)).resolves.toMatchObject({
      category_ids: [1, 2],
      recipient_ids: [],
      tag_ids: [5],
    });

    const sql = mocks.query.mock.calls[0][0];
    expect(sql).toContain("FROM saved_chart_categories");
    expect(sql).toContain("FROM saved_chart_recipients");
    expect(sql).toContain("FROM saved_chart_tags");
    expect(sql).toContain("array_agg(category_id ORDER BY category_id)");
  });

  it("creates the chart and deduplicated memberships in one transaction", async () => {
    mocks.query.mockImplementation(async (sql) => {
      if (sql.includes("INSERT INTO saved_charts"))
        return { rows: [{ id: 7 }] };
      if (sql.includes("FROM saved_charts sc WHERE")) {
        return { rows: [storedRow] };
      }
      return { rows: [] };
    });

    await savedChartsRepository.create({
      name: "Spending",
      chartType: "bar",
      categoryIds: [2, 1, 2],
      recipientIds: [],
      tagIds: [5],
      chartVariant: "default",
      timeBucket: "monthly",
    });

    expect(mocks.withTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO saved_chart_categories"),
      [7, [1, 2]],
    );
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO saved_chart_tags"),
      [7, [5]],
    );
    expect(
      mocks.query.mock.calls.some(([sql]) =>
        sql.includes("INSERT INTO saved_chart_recipients"),
      ),
    ).toBe(false);
  });

  it("locks the chart and changes only membership sets present in a patch", async () => {
    mocks.query.mockImplementation(async (sql) => {
      if (sql.includes("FOR UPDATE")) return { rows: [{ id: 7 }] };
      if (sql.includes("FROM saved_charts sc WHERE")) {
        return { rows: [{ ...storedRow, category_ids: [9] }] };
      }
      return { rows: [] };
    });

    await savedChartsRepository.update(7, { categoryIds: [9, 9] });

    expect(mocks.query.mock.calls[0][0]).toContain("FOR UPDATE");
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM saved_chart_categories"),
      [7],
    );
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO saved_chart_categories"),
      [7, [9]],
    );
    expect(
      mocks.query.mock.calls.some(([sql]) =>
        sql.includes("DELETE FROM saved_chart_recipients"),
      ),
    ).toBe(false);
    expect(
      mocks.query.mock.calls.some(([sql]) =>
        sql.startsWith("UPDATE saved_charts"),
      ),
    ).toBe(false);
  });

  it("does not read a partially-created chart after membership insertion fails", async () => {
    const foreignKeyError = Object.assign(new Error("missing category"), {
      code: "23503",
    });
    mocks.query.mockImplementation(async (sql) => {
      if (sql.includes("INSERT INTO saved_charts"))
        return { rows: [{ id: 7 }] };
      if (sql.includes("INSERT INTO saved_chart_categories")) {
        throw foreignKeyError;
      }
      return { rows: [] };
    });

    await expect(
      savedChartsRepository.create({
        name: "Invalid",
        chartType: "line",
        categoryIds: [999],
        chartVariant: "default",
        timeBucket: "monthly",
      }),
    ).rejects.toBe(foreignKeyError);

    expect(mocks.withTransaction).toHaveBeenCalledTimes(1);
    expect(
      mocks.query.mock.calls.some(([sql]) =>
        sql.includes("FROM saved_charts sc WHERE"),
      ),
    ).toBe(false);
  });
});
