import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockTxConnection } from "./helpers/repoMocks.js";

const mockClientQuery = vi.hoisted(() => vi.fn());
vi.mock("../src/database/connection.js", () =>
  mockTxConnection({ query: mockClientQuery }),
);

import {
  createCategoryNode,
  updateCategoryNode,
  deleteCategoryNode,
  mergeCategoryNodes,
} from "../src/repositories/categoryHierarchyRepository.js";

beforeEach(() => mockClientQuery.mockReset());

describe("category hierarchy mutations", () => {
  it("creates an assignable depth-one node with a stable id", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 42 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 42,
            name: "SAVINGS",
            parent_id: null,
            ids: [42],
            names: ["SAVINGS"],
            path_name: "SAVINGS",
            depth: 1,
            is_active: true,
            hierarchy_only: false,
            legacy_compatible: false,
          },
        ],
      });

    const node = await createCategoryNode({ name: "savings" });

    expect(node).toMatchObject({
      id: 42,
      pathIds: [42],
      path: ["SAVINGS"],
      depth: 1,
    });
    expect(mockClientQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO categories"),
      [42, "__HIERARCHY_42", "SAVINGS", "SAVINGS", null, null],
    );
  });

  it("rejects an invalid parent before insertion", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      createCategoryNode({ name: "solar", parentId: 999 }),
    ).rejects.toThrow("Parent category does not exist");
    expect(mockClientQuery).toHaveBeenCalledTimes(2);
  });

  it("keeps a node with children when deletion is requested", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: 2 }] });

    await expect(deleteCategoryNode(1)).rejects.toThrow(
      "Move or delete children",
    );
    expect(mockClientQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM categories"),
      expect.anything(),
    );
  });

  it("rejects a merge into the source subtree before moving any references", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          { id: 1, is_active: true },
          { id: 2, is_active: true },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });

    await expect(mergeCategoryNodes(1, 2)).rejects.toThrow(
      "inside the source subtree",
    );
    expect(mockClientQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("UPDATE categories SET parent_id"),
      expect.anything(),
    );
  });

  it("moves children and direct references before deleting the source", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          { id: 1, is_active: true },
          { id: 2, is_active: true },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            schema_name: "public",
            table_name: "transactions",
            column_name: "category_id",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          { id: 2, name: "TARGET", ids: [2], names: ["TARGET"], depth: 1 },
        ],
      });

    const node = await mergeCategoryNodes(1, 2);

    expect(node?.id).toBe(2);
    expect(mockClientQuery.mock.calls[3][0]).toContain(
      "UPDATE categories SET parent_id",
    );
    expect(mockClientQuery.mock.calls[5]).toEqual([
      expect.stringContaining('UPDATE public."transactions"'),
      [1, 2],
    ]);
    expect(mockClientQuery.mock.calls[8][0]).toContain(
      "DELETE FROM categories",
    );
  });

  it("maps a database cycle rejection to a conflict", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: 2, name: "SOLAR", parent_id: 1, is_active: true }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 1, is_active: true }] })
      .mockRejectedValueOnce(
        Object.assign(new Error("cycle"), { code: "23514" }),
      );

    await expect(updateCategoryNode(2, { parentId: 1 })).rejects.toThrow(
      "cannot be moved",
    );
  });
});
