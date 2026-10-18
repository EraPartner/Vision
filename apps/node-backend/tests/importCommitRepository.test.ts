import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockConnection } from "./helpers/repoMocks.ts";
vi.mock("../src/database/connection.ts", () => mockConnection());
import { query } from "../src/database/connection.ts";
import {
  commitFingerprintRows,
  type BulkImportRow,
} from "../src/repositories/importCommitRepository.ts";
const queryMock = vi.mocked(query);
const row = (stagingId: string, fingerprint = stagingId): BulkImportRow => ({
  stagingId,
  date: "2026-07-01",
  accountId: 1,
  recipientId: 2,
  categoryId: null,
  amount: "-10",
  memo: "fixture",
  memoNormalized: "fixture",
  currency: "EUR",
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
    expect(queryMock.mock.calls[2]![1]).toEqual([
      ["1", "2"],
      ["committed", "duplicate"],
    ]);
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
