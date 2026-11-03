import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockConnection } from "./helpers/repoMocks.ts";
import {
  asAccountId,
  asCurrencyCode,
  asRecipientId,
} from "@vision/types/brands";
vi.mock("../src/database/connection.ts", () => mockConnection());
import { query } from "../src/database/connection.ts";
import {
  commitFingerprintRows,
  type BulkImportRow,
} from "../src/repositories/importCommitRepository.ts";
import { must } from "./helpers/must.ts";
const queryMock = vi.mocked(query);
const row = (stagingId: string, fingerprint = stagingId): BulkImportRow => ({
  stagingId,
  date: "2026-07-01",
  accountId: asAccountId(1),
  recipientId: asRecipientId(2),
  categoryId: null,
  amount: "-10",
  memo: "fixture",
  memoNormalized: "fixture",
  currency: asCurrencyCode("EUR"),
  balance: null,
  comment: null,
  importBatchId: 1,
  matchedPatternId: null,
  dedupFingerprint: fingerprint,
  fingerprintVersion: 1,
  dedupOccurrence: 1,
});
beforeEach(() => {
  queryMock.mockReset();
});
describe("chunk import outcome mapping", () => {
  it("assigns a newly inserted repeated fingerprint only to its first staging row", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { staging_id: "1", duplicate: false, legacy_count: 0 },
        { staging_id: "2", duplicate: false, legacy_count: 0 },
      ],
      rowCount: 2,
    });
    queryMock.mockResolvedValueOnce({
      rows: [
        { id: 10, dedup_fingerprint: "same", dedup_fingerprint_version: 1 },
      ],
      rowCount: 1,
    });
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 2 });
    expect(
      await commitFingerprintRows([row("1", "same"), row("2", "same")]),
    ).toEqual([
      { stagingId: "1", transactionId: 10 },
      { stagingId: "2", transactionId: undefined },
    ]);
    expect(queryMock).toHaveBeenCalledTimes(3);
    // The statuses travel as one JSON array; the staging ids stay BIGINT text.
    const statusParams = must(queryMock.mock.calls[2], "queryMock.mock.calls[2]")[1];
    expect(statusParams).toHaveLength(1);
    expect(JSON.parse(String(must(statusParams, "status params")[0]))).toEqual([
      { id: "1", status: "committed" },
      { id: "2", status: "duplicate" },
    ]);
  });
  it("binds money as decimal text for the probe and the insert", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ staging_id: "1", duplicate: false, legacy_count: 0 }],
      rowCount: 1,
    });
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 10, dedup_fingerprint: "1", dedup_fingerprint_version: 1 }],
      rowCount: 1,
    });
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await commitFingerprintRows([
      // A JSON number would reach SQLite as a REAL; the probe and the insert
      // read amount and balance as exact decimal text.
      { ...row("1"), amount: -0.1, balance: "12345678901234.5678" },
    ]);
    const [probeSql, probeParams] = must(queryMock.mock.calls[0], "probe");
    expect(probeSql).toContain("dec_eq(legacy.amount, i.amount)");
    const probed = JSON.parse(String(must(probeParams, "probe params")[0])) as Array<Record<string, unknown>>;
    expect(probed[0]).toMatchObject({ amount: "-0.1", balance: "12345678901234.5678" });
    const [insertSql, insertParams] = must(queryMock.mock.calls[1], "insert");
    expect(insertSql).toContain("vision_numeric(i.value ->> 'amount', 18, 4)");
    expect(insertSql).toContain("vision_numeric(i.value ->> 'balance', 18, 4)");
    const inserted = JSON.parse(String(must(insertParams, "insert params")[0])) as Array<Record<string, unknown>>;
    expect(inserted[0]).toMatchObject({ amount: "-0.1", balance: "12345678901234.5678" });
  });
  it("treats a concurrent unique-index loser as duplicate", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ staging_id: "1", duplicate: false, legacy_count: 0 }],
      rowCount: 1,
    });
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    expect(await commitFingerprintRows([row("1")])).toEqual([
      { stagingId: "1", transactionId: undefined },
    ]);
  });
  it("consumes legacy occurrences without suppressing later distinct occurrence fingerprints", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { staging_id: "1", duplicate: false, legacy_count: 1 },
        { staging_id: "2", duplicate: false, legacy_count: 1 },
      ],
      rowCount: 2,
    });
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 12, dedup_fingerprint: "2", dedup_fingerprint_version: 1 }],
      rowCount: 1,
    });
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 2 });
    expect(
      await commitFingerprintRows([
        row("1"),
        { ...row("2"), dedupOccurrence: 2 },
      ]),
    ).toEqual([
      { stagingId: "1", transactionId: undefined },
      { stagingId: "2", transactionId: 12 },
    ]);
  });
});
