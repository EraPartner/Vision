/**
 * Recipient Repository guards that need no database: the reserved SYSTEM
 * name, the sort-column allowlist, and row shaping. Filter, create and update
 * behaviour against real rows lives in catalogRepositoryBoundary.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockConnection } from "./helpers/repoMocks.ts";
import type { ConnectionMockSurface } from "./helpers/repoMocks.ts";

vi.mock("../src/database/connection.ts", () => mockConnection());
vi.mock("../src/lib/textNormalization.ts", () => ({
  normalizeForMatching: vi.fn((s) => `norm:${String(s).trim().toLowerCase()}`),
}));

import * as connection from "../src/database/connection.ts";
import recipientRepository from "../src/repositories/recipientRepository.ts";
import type {
  EnrichedRecipientRow,
  RecipientRow,
} from "../src/repositories/recipientRepository.ts";

const STAMP = new Date("2026-01-01T00:00:00Z");

/** A complete `recipients` row (`SELECT *`), as the checked reads require. */
function recipientRow(
  fields: Partial<RecipientRow> & { id: number },
): RecipientRow {
  return {
    name: "RECIPIENT",
    normalized_name: "recipient",
    default_category_id: null,
    primary_recipient_id: null,
    notes: null,
    is_active: true,
    created_at: STAMP,
    updated_at: STAMP,
    ...fields,
  };
}

/** A list / detail / update row: the recipient plus its join columns. */
function enrichedRow(
  fields: Partial<EnrichedRecipientRow> & { id: number },
): EnrichedRecipientRow {
  return {
    ...recipientRow(fields),
    default_category_name: null,
    primary_bank_account: null,
    primary_recipient_name: null,
    alias_count: 0,
    ...fields,
  };
}

// The connection module is the mock surface; its spies stay untyped because
// the tests read raw SQL and params from mock.calls.
const { query } = connection as unknown as ConnectionMockSurface;

describe("recipientRepository", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("getAll", () => {

    it("ignores an unknown sort column and falls back to name", async () => {
      query.mockResolvedValueOnce({ rows: [] });
      await recipientRepository.getAll({
        sortBy: "evil; DROP",
        sortDir: "asc",
      });
      expect(query.mock.calls[0]![0]).toContain("ORDER BY r.name ASC");
    });
  });

  describe("getById / getByName", () => {
    it("getById returns the row", async () => {
      const row = enrichedRow({ id: 3, name: "X" });
      query.mockResolvedValueOnce({ rows: [row] });
      expect(await recipientRepository.getById(3)).toEqual(row);
    });

    it("getById returns null when absent", async () => {
      query.mockResolvedValueOnce({ rows: [] });
      expect(await recipientRepository.getById(3)).toBeNull();
    });

  });

  describe("createOrGet", () => {

    it("returns the winning row after a concurrent insert", async () => {
      query
        .mockResolvedValueOnce({ rows: [] }) // concurrent miss
        .mockResolvedValueOnce({ rows: [{ id: 8, created: false }] })
        .mockResolvedValueOnce({
          rows: [enrichedRow({ id: 8, name: "ALDI" })],
        });
      const result = await recipientRepository.createOrGet({ name: "Aldi" });
      expect(result).toEqual({
        recipient: enrichedRow({ id: 8, name: "ALDI" }),
        created: false,
      });
    });

    it("reserves SYSTEM for server-generated transactions", async () => {
      await expect(
        recipientRepository.createOrGet({ name: " system " }),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        message: expect.stringContaining("reserved"),
      });
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe("update", () => {

    it("does not allow a public recipient to be renamed to SYSTEM", async () => {
      await expect(
        recipientRepository.update(1, { name: " system " }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe("mutations", () => {
    it("hardDelete reflects rowCount", async () => {
      query.mockResolvedValueOnce({ rowCount: 1 });
      expect(await recipientRepository.hardDelete(2)).toBe(true);
      query.mockResolvedValueOnce({ rowCount: 0 });
      expect(await recipientRepository.hardDelete(2)).toBe(false);
    });

    it("unmergeRecipient returns boolean", async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 5 }] });
      expect(await recipientRepository.unmergeRecipient(5)).toBe(true);
      query.mockResolvedValueOnce({ rows: [] });
      expect(await recipientRepository.unmergeRecipient(5)).toBe(false);
    });

    it("getAliases returns rows", async () => {
      const alias = { ...recipientRow({ id: 8 }), default_category_name: null };
      query.mockResolvedValueOnce({ rows: [alias] });
      expect(await recipientRepository.getAliases(1)).toEqual([alias]);
    });
  });

  describe("getClusterRootMap", () => {
    it("returns an empty map for empty/null input", async () => {
      expect(await recipientRepository.getClusterRootMap([])).toEqual(
        new Map(),
      );
      expect(await recipientRepository.getClusterRootMap(null)).toEqual(
        new Map(),
      );
      expect(query).not.toHaveBeenCalled();
    });

    it("dedupes ids and maps id -> cluster root", async () => {
      query.mockResolvedValueOnce({
        rows: [
          { id: 1, cluster_root: 1 },
          { id: 2, cluster_root: 1 },
        ],
      });
      const map = await recipientRepository.getClusterRootMap([1, 2, 2, null]);
      expect(map.get(1)).toBe(1);
      expect(map.get(2)).toBe(1);
      expect(query.mock.calls[0]![1]).toEqual([[1, 2]]);
    });
  });
});
