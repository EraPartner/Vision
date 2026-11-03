/**
 * Recipient Repository guards that need no database: the reserved SYSTEM
 * name, the sort-column allowlist, and row shaping. Filter, create and update
 * behaviour against real rows lives in catalogRepositoryBoundary.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockTxConnection } from "./helpers/repoMocks.ts";
import type { ConnectionMockSurface } from "./helpers/repoMocks.ts";
import {
  asRecipientId,
} from "@vision/types/brands";

// withTransaction runs its callback; with no client, statements inside it
// land on the module-level `query` spy, in order.
vi.mock("../src/database/connection.ts", () => mockTxConnection());
vi.mock("../src/lib/textNormalization.ts", () => ({
  normalizeForMatching: vi.fn((s) => `norm:${String(s).trim().toLowerCase()}`),
}));

import * as connection from "../src/database/connection.ts";
import recipientRepository from "../src/repositories/recipientRepository.ts";
import type {
  EnrichedRecipientRow,
  RecipientRow,
} from "../src/repositories/recipientRepository.ts";
import { must } from "./helpers/must.ts";
import { valueAt } from "./helpers/responseBody.ts";

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
      expect(must(query.mock.calls[0], "query.mock.calls[0]")[0]).toContain("ORDER BY r.name ASC");
    });
  });

  describe("getById / getByName", () => {
    it("getById returns the row", async () => {
      const row = enrichedRow({ id: asRecipientId(3), name: "X" });
      query.mockResolvedValueOnce({ rows: [row] });
      expect(await recipientRepository.getById(asRecipientId(3))).toEqual(row);
    });

    it("getById returns null when absent", async () => {
      query.mockResolvedValueOnce({ rows: [] });
      expect(await recipientRepository.getById(asRecipientId(3))).toBeNull();
    });

  });

  describe("createOrGet", () => {

    it("returns the winning row after a concurrent insert", async () => {
      query
        .mockResolvedValueOnce({ rows: [] }) // concurrent miss
        .mockResolvedValueOnce({ rows: [] }) // ON CONFLICT DO NOTHING: lost the race
        .mockResolvedValueOnce({ rows: [{ id: 8 }] }) // the winner, same transaction
        .mockResolvedValueOnce({
          rows: [enrichedRow({ id: asRecipientId(8), name: "ALDI" })],
        });
      const result = await recipientRepository.createOrGet({ name: "Aldi" });
      expect(result).toEqual({
        recipient: enrichedRow({ id: asRecipientId(8), name: "ALDI" }),
        created: false,
      });
      // The insert and the winner read share one write transaction, so the
      // winner cannot be deleted between them (PostgreSQL's DO UPDATE upsert
      // returned it in one statement).
      expect(connection.withTransaction).toHaveBeenCalledTimes(1);
      const [insertSql, insertParams] = must(query.mock.calls[1], "query.mock.calls[1]") as [
        string,
        unknown[],
      ];
      expect(insertSql).toMatch(/^insert into "recipients"/);
      expect(insertSql).toContain('on conflict ("normalized_name") do nothing');
      expect(insertParams).toEqual(["ALDI", "norm:aldi", true]);
      expect(must(query.mock.calls[2], "query.mock.calls[2]")[1]).toEqual(["norm:aldi"]);
    });

    it("reports created when the insert wins", async () => {
      query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 9 }] })
        .mockResolvedValueOnce({
          rows: [enrichedRow({ id: asRecipientId(9), name: "LIDL" })],
        });
      expect(await recipientRepository.createOrGet({ name: "Lidl" })).toEqual({
        recipient: enrichedRow({ id: asRecipientId(9), name: "LIDL" }),
        created: true,
      });
      expect(query).toHaveBeenCalledTimes(3);
    });

    it("reserves SYSTEM for server-generated transactions", async () => {
      const rejection = await recipientRepository
        .createOrGet({ name: " system " })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(rejection).toMatchObject({ code: "VALIDATION_ERROR" });
      expect(valueAt(rejection, "message")).toMatch(/reserved/);
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe("update", () => {

    it("does not allow a public recipient to be renamed to SYSTEM", async () => {
      await expect(
        recipientRepository.update(asRecipientId(1), { name: " system " }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe("mutations", () => {
    it("hardDelete reflects rowCount", async () => {
      query.mockResolvedValueOnce({ rowCount: 1 });
      expect(await recipientRepository.hardDelete(asRecipientId(2))).toBe(true);
      query.mockResolvedValueOnce({ rowCount: 0 });
      expect(await recipientRepository.hardDelete(asRecipientId(2))).toBe(false);
    });

    it("unmergeRecipient returns boolean", async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 5 }] });
      expect(await recipientRepository.unmergeRecipient(asRecipientId(5))).toBe(true);
      query.mockResolvedValueOnce({ rows: [] });
      expect(await recipientRepository.unmergeRecipient(asRecipientId(5))).toBe(false);
    });

    it("getAliases returns rows", async () => {
      const alias = { ...recipientRow({ id: asRecipientId(8) }), default_category_name: null };
      query.mockResolvedValueOnce({ rows: [alias] });
      expect(await recipientRepository.getAliases(asRecipientId(1))).toEqual([alias]);
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
      const map = await recipientRepository.getClusterRootMap([asRecipientId(1), asRecipientId(2), asRecipientId(2), null]);
      expect(map.get(asRecipientId(1))).toBe(1);
      expect(map.get(asRecipientId(2))).toBe(1);
      // The deduplicated ids bind as one JSON list for json_each.
      expect(must(query.mock.calls[0], "query.mock.calls[0]")[1]).toEqual(["[1,2]"]);
    });
  });
});
