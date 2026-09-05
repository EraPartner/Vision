/**
 * Deduplication Service Tests
 * Mirrors: apps/backend/services/deduplication_service.py
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockConnection } from "./helpers/repoMocks.js";

vi.mock("../src/database/connection.js", () => mockConnection());

import {
  __createTransactionHash as createTransactionHash,
  __createManualTransactionHash as createManualTransactionHash,
  isDuplicate,
  __isDuplicateByFields as isDuplicateByFields,
  isManualDuplicate,
  recordManualRawTransaction,
} from "../src/services/deduplication.js";
import { query } from "../src/database/connection.js";

describe("DeduplicationService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createTransactionHash", () => {
    it("creates hash from raw data", () => {
      const txData = {
        date: new Date("2024-01-15"),
        amount: -50.0,
        recipient: "TEST STORE",
        memo: "Groceries",
        rawData: "some,raw,csv,line",
      };
      const hash = createTransactionHash(txData);
      expect(hash).toBeTruthy();
      expect(hash).toHaveLength(64); // SHA256 hex
    });

    it("creates hash from fields when no raw data", () => {
      const txData = {
        date: new Date("2024-01-15"),
        amount: -50.0,
        recipient: "TEST STORE",
        memo: "Groceries",
        rawData: "",
      };
      const hash = createTransactionHash(txData);
      expect(hash).toBeTruthy();
      expect(hash).toHaveLength(64);
    });

    it("produces consistent hashes", () => {
      const txData = {
        date: new Date("2024-01-15"),
        amount: -50.0,
        recipient: "TEST STORE",
        memo: "Groceries",
        rawData: "identical,raw,data",
      };
      const hash1 = createTransactionHash(txData);
      const hash2 = createTransactionHash(txData);
      expect(hash1).toBe(hash2);
    });

    it("produces different hashes for different data", () => {
      const txData1 = {
        date: new Date("2024-01-15"),
        amount: -50.0,
        recipient: "STORE A",
        memo: "",
        rawData: "data1",
      };
      const txData2 = {
        date: new Date("2024-01-15"),
        amount: -50.0,
        recipient: "STORE B",
        memo: "",
        rawData: "data2",
      };
      expect(createTransactionHash(txData1)).not.toBe(
        createTransactionHash(txData2),
      );
    });
  });

  describe("createManualTransactionHash", () => {
    it("creates stable hash for equivalent manual payloads", () => {
      const payload = {
        date: "2026-02-10",
        amount: -50,
        recipientId: 22,
        memo: "Rent",
        bankAccount: "be123",
      };

      const a = createManualTransactionHash(payload);
      const b = createManualTransactionHash({
        ...payload,
        memo: "RENT",
        bankAccount: "BE123",
      });

      expect(a).toHaveLength(64);
      expect(a).toBe(b);
    });
  });

  describe("isDuplicate", () => {
    it("returns true when matching active transaction exists", async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 101 }] });

      const result = await isDuplicate({
        date: new Date("2026-02-10T12:34:56.000Z"),
        amount: -50,
        recipient: "rent recipient",
        memo: "Rent",
      });

      expect(result).toBe(true);
      expect(query).toHaveBeenCalledTimes(1);
      expect(query.mock.calls[0][0]).toContain("FROM transactions");
      expect(query.mock.calls[0][1]).toEqual([
        "2026-02-10",
        -50,
        "RENT RECIPIENT",
        "Rent",
      ]);
    });

    it("returns false when no duplicate is found", async () => {
      query.mockResolvedValueOnce({ rows: [] });

      const result = await isDuplicate({
        date: new Date("2026-02-11T00:00:00.000Z"),
        amount: 125,
        recipient: "salary",
        memo: "",
      });

      expect(result).toBe(false);
    });
  });

  describe("isDuplicateByFields", () => {
    it("returns true when field match exists", async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 333 }] });

      const result = await isDuplicateByFields(
        "2026-03-01",
        -12.5,
        "coffee shop",
        "morning coffee",
      );

      expect(result).toBe(true);
      expect(query).toHaveBeenCalledTimes(1);
      expect(query.mock.calls[0][0]).toContain("LEFT JOIN recipients");
      expect(query.mock.calls[0][1]).toEqual([
        "2026-03-01",
        -12.5,
        "COFFEE SHOP",
        "morning coffee",
      ]);
    });

    it("returns false when field match does not exist", async () => {
      query.mockResolvedValueOnce({ rows: [] });

      const result = await isDuplicateByFields(
        "2026-03-02",
        45,
        "No Match",
        "memo",
      );

      expect(result).toBe(false);
    });
  });

  describe("isManualDuplicate", () => {
    const manualTx = {
      date: "2026-02-10",
      amount: -50,
      recipientId: 22,
      memo: "Rent",
      bankAccount: "BE123",
    };

    it("returns duplicate when hash exists in manual raw table", async () => {
      query.mockResolvedValueOnce({ rows: [{ transaction_id: 345 }] });

      const result = await isManualDuplicate(manualTx);

      expect(result).toEqual({ isDuplicate: true, existingTransactionId: 345 });
      expect(query).toHaveBeenCalledTimes(1);
      expect(query.mock.calls[0][0]).toContain("FROM manual_raw_transactions");
    });

    it("only a live, active transaction blocks — a dangling hash row (ON DELETE SET NULL) does not", async () => {
      // The join filters out dangling rows in SQL: the hash query returns no
      // rows for them, and the field fallback (is_active = true) misses too.
      query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await isManualDuplicate(manualTx);

      expect(result).toEqual({
        isDuplicate: false,
        existingTransactionId: null,
      });
      expect(query.mock.calls[0][0]).toMatch(
        /JOIN transactions t ON t\.id = m\.transaction_id AND t\.is_active = true/,
      );
    });

    it("falls back to field-based lookup when manual raw table is unavailable", async () => {
      query
        .mockRejectedValueOnce(
          new Error('relation "manual_raw_transactions" does not exist'),
        )
        .mockResolvedValueOnce({ rows: [{ id: 901 }] });

      const result = await isManualDuplicate(manualTx);

      expect(result).toEqual({ isDuplicate: true, existingTransactionId: 901 });
      expect(query).toHaveBeenCalledTimes(2);
      expect(query.mock.calls[1][0]).toContain("FROM transactions");
    });

    it("returns non-duplicate when both hash and field checks miss", async () => {
      query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await isManualDuplicate(manualTx);

      expect(result).toEqual({
        isDuplicate: false,
        existingTransactionId: null,
      });
      expect(query.mock.calls[1][0]).toContain(
        "COALESCE(UPPER(bank_account), '') = $5",
      );
      expect(query.mock.calls[1][1]).toEqual([
        "2026-02-10",
        -50,
        22,
        "Rent",
        "BE123",
      ]);
    });
  });

  describe("recordManualRawTransaction", () => {
    it("inserts manual raw row with dedup hash", async () => {
      query.mockResolvedValueOnce({ rows: [] });

      await recordManualRawTransaction({
        date: "2026-02-10",
        amount: -50,
        recipientId: 22,
        memo: "Rent",
        bankAccount: "BE123",
        categoryId: 5,
        comment: "monthly rent",
        transactionId: 777,
      });

      expect(query).toHaveBeenCalledTimes(1);
      expect(query.mock.calls[0][0]).toContain(
        "INSERT INTO manual_raw_transactions",
      );
      // Upsert, so re-adding a deleted transaction re-claims its dangling hash row.
      expect(query.mock.calls[0][0]).toContain(
        "DO UPDATE SET transaction_id = EXCLUDED.transaction_id",
      );
      expect(query.mock.calls[0][1][1]).toBe(777);
    });

    it("swallows insert errors when table does not exist", async () => {
      query.mockRejectedValueOnce(new Error("relation does not exist"));

      await expect(
        recordManualRawTransaction({
          date: "2026-02-10",
          amount: -50,
          recipientId: 22,
          memo: "Rent",
          bankAccount: "BE123",
          categoryId: 5,
          comment: "monthly rent",
          transactionId: 777,
        }),
      ).resolves.toBeUndefined();
    });
  });
});
