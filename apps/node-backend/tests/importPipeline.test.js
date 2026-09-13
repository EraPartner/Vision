import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockLogger } from "./helpers/mockLogger.js";
import { mockTxConnection } from "./helpers/repoMocks.js";
import { makeImportStagingRow } from "./builders/domainRows.js";
import { validateBatch } from "../src/services/importPipeline/validate.js";
import { stageBatch } from "../src/services/importPipeline/stage.js";
import { matchBatch } from "../src/services/importPipeline/match.js";
import { commitBatch } from "../src/services/importPipeline/commit.js";
import {
  query,
  poolQuery,
  withTransaction,
} from "../src/database/connection.js";
import transactionRepository, {
  clearTransactionCountCache,
} from "../src/repositories/transactionRepository.js";
import { getAdapter } from "../src/services/importPipeline/adapters/index.js";
import { findBestRecipientMatches } from "../src/services/calculations/normalization.js";
import {
  loadActivePatterns,
  applyPatterns,
} from "../src/services/recipientPatternService.js";

const baseWithTransaction = withTransaction.getMockImplementation();

// Ambient-aware connection mock: commitBatch's per-row writes now go through
// repositories, which issue module-level query() inside withTransaction — the
// ambient context routes those onto `mockClient`, alongside SAVEPOINTs issued
// through withSavepointIfInTransaction.
const { mockClient } = vi.hoisted(() => ({ mockClient: { query: vi.fn() } }));
vi.mock("../src/database/connection.js", () => mockTxConnection(mockClient));
vi.mock("../src/config/logger.js", () => ({
  logger: mockLogger(),
}));
vi.mock("../src/services/importPipeline/adapters/index.js", () => ({
  getAdapter: vi.fn(),
}));
vi.mock("../src/services/calculations/normalization.js", () => ({
  findBestRecipientMatches: vi.fn(),
  normalizeForMatching: vi.fn(),
}));
vi.mock("../src/services/recipientPatternService.js", () => ({
  loadActivePatterns: vi.fn(),
  applyPatterns: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  withTransaction.mockImplementation(baseWithTransaction);
  clearTransactionCountCache();
  poolQuery.mockReset();
  poolQuery.mockResolvedValue({ rows: [] });
  mockClient.query.mockReset();
  mockClient.query.mockResolvedValue({ rows: [] });
});

// ---------------------------------------------------------------------------
// validateBatch
// ---------------------------------------------------------------------------

describe("validateBatch", () => {
  function setupPending(row) {
    poolQuery
      .mockResolvedValueOnce({ rows: [] }) // UPDATE status='validating'
      .mockResolvedValueOnce({ rows: [row] }); // SELECT pending
  }

  const baseRow = makeImportStagingRow({
    id: 1,
    row_index: 0,
    tx_date: "2024-01-15",
    amount: "-12.50",
    recipient_raw: "SHOP",
    memo: "coffee",
    currency: "EUR",
    raw_data: null,
    bank_account: "BE12",
    balance: null,
  });

  function getValidationUpdate() {
    const call = poolQuery.mock.calls.find(([sql]) =>
      sql.includes("FROM unnest"),
    );
    expect(call).toBeDefined();
    return {
      statuses: call[1][1],
      hashes: call[1][2],
      sourceHashes: call[1][3],
      occurrences: call[1][5],
    };
  }

  it("returns {validated:1, duplicates:0, errors:0} for a valid row", async () => {
    setupPending(baseRow);
    expect(await validateBatch({ batchId: 1 })).toEqual({
      validated: 1,
      duplicates: 0,
      errors: 0,
    });
  });

  it("returns {validated:0, duplicates:0, errors:1} for missing tx_date", async () => {
    setupPending({ ...baseRow, tx_date: null });
    expect(await validateBatch({ batchId: 2 })).toEqual({
      validated: 0,
      duplicates: 0,
      errors: 1,
    });
  });

  it("returns {validated:0, duplicates:0, errors:1} for null amount", async () => {
    setupPending({ ...baseRow, amount: null });
    expect(await validateBatch({ batchId: 3 })).toEqual({
      validated: 0,
      duplicates: 0,
      errors: 1,
    });
  });

  it("returns {validated:0, duplicates:0, errors:1} for non-numeric amount", async () => {
    setupPending({ ...baseRow, amount: "N/A" });
    expect(await validateBatch({ batchId: 4 })).toEqual({
      validated: 0,
      duplicates: 0,
      errors: 1,
    });
  });

  it("keeps identical occurrences and assigns distinct fingerprints", async () => {
    const dupRow = { ...baseRow, id: 2, row_index: 1, raw_data: null };
    poolQuery
      .mockResolvedValueOnce({ rows: [] }) // UPDATE status='validating'
      .mockResolvedValueOnce({ rows: [baseRow, dupRow] }); // SELECT pending — two identical rows
    expect(await validateBatch({ batchId: 5 })).toEqual({
      validated: 2,
      duplicates: 0,
      errors: 0,
    });
    const update = getValidationUpdate();
    expect(update.statuses).toEqual(["validated", "validated"]);
    expect(update.hashes[0]).not.toBe(update.hashes[1]);
    expect(update.occurrences).toEqual([1, 2]);
  });

  it("keeps occurrence ordinals stable when validation resumes after a chunk", async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [
        { ...baseRow, id: 1, row_index: 0, status: "validated" },
        { ...baseRow, id: 2, row_index: 1, status: "pending" },
      ],
    });

    expect(await validateBatch({ batchId: 5 })).toEqual({
      validated: 1,
      duplicates: 0,
      errors: 0,
    });
    expect(getValidationUpdate().occurrences).toEqual([2]);
  });

  it("keeps fallback-hash rows in different currencies distinct", async () => {
    const usdRow = { ...baseRow, id: 2, row_index: 1, currency: "USD" };
    poolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [baseRow, usdRow] });

    expect(await validateBatch({ batchId: 6 })).toEqual({
      validated: 2,
      duplicates: 0,
      errors: 0,
    });
    const update = getValidationUpdate();
    expect(update.statuses).toEqual(["validated", "validated"]);
    expect(update.hashes[0]).not.toBe(update.hashes[1]);
  });

  it("treats a blank fallback currency as the EUR default", async () => {
    const blankRow = { ...baseRow, currency: null };
    const eurRow = { ...baseRow, id: 2, row_index: 1, currency: "EUR" };
    poolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [blankRow, eurRow] })
      .mockResolvedValueOnce({ rows: [] });

    expect(await validateBatch({ batchId: 7 })).toEqual({
      validated: 2,
      duplicates: 0,
      errors: 0,
    });
    const update = getValidationUpdate();
    expect(update.statuses).toEqual(["validated", "validated"]);
    expect(update.hashes[0]).not.toBe(update.hashes[1]);
    expect(update.occurrences).toEqual([1, 2]);
  });

  it("keeps literal raw_data as provenance instead of duplicate identity", async () => {
    const first = { ...baseRow, raw_data: "literal source row" };
    const changedFallbackFields = {
      ...baseRow,
      id: 2,
      row_index: 1,
      recipient_raw: "OTHER",
      memo: "different",
      currency: "USD",
      raw_data: "literal source row",
    };
    poolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [first, changedFallbackFields] })
      .mockResolvedValueOnce({ rows: [] });

    expect(await validateBatch({ batchId: 8 })).toEqual({
      validated: 2,
      duplicates: 0,
      errors: 0,
    });
    const update = getValidationUpdate();
    expect(update.sourceHashes[0]).toBe(update.sourceHashes[1]);
    expect(update.hashes[0]).not.toBe(update.hashes[1]);
  });
});

// ---------------------------------------------------------------------------
// stageBatch
// ---------------------------------------------------------------------------

describe("stageBatch", () => {
  it("throws for an unknown adapter", async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE status='staging'
    getAdapter.mockReturnValue(null);
    await expect(
      stageBatch({ batchId: 1, filePath: "/tmp/x.csv", adapterName: "bogus" }),
    ).rejects.toThrow("Unknown adapter: bogus");
  });

  it("returns {rowsTotal, rowsSkipped} after staging parsed rows", async () => {
    const parsed = [
      {
        date: "2024-01-01",
        amount: "-10",
        recipient: "A",
        memo: "",
        currency: "EUR",
      },
      {
        date: "2024-01-02",
        amount: "-20",
        recipient: "B",
        memo: "",
        currency: "EUR",
      },
    ];
    parsed.skipped = 3; // adapter reported 3 unparseable rows
    getAdapter.mockReturnValue({ parse: vi.fn().mockResolvedValue(parsed) });
    poolQuery
      .mockResolvedValueOnce({ rows: [] }) // UPDATE status='staging'
      .mockResolvedValueOnce({ rows: [] }); // UPDATE rows_total
    expect(
      await stageBatch({
        batchId: 1,
        filePath: "/tmp/x.csv",
        adapterName: "belfius",
      }),
    ).toEqual({ rowsTotal: 2, rowsSkipped: 3 });
  });
});

// ---------------------------------------------------------------------------
// matchBatch
// ---------------------------------------------------------------------------

describe("matchBatch", () => {
  it("marks a pattern-matched row as matched with source=pattern", async () => {
    poolQuery
      .mockResolvedValueOnce({ rows: [] }) // UPDATE status='matching'
      .mockResolvedValueOnce({ rows: [{ id: 1, recipient_raw: "COLRUYT" }] });
    loadActivePatterns.mockResolvedValue([]);
    applyPatterns.mockResolvedValue(
      new Map([["COLRUYT", { recipientId: 42, patternId: 7 }]]),
    );
    findBestRecipientMatches.mockResolvedValue(new Map());

    const result = await matchBatch({ batchId: 1 });
    expect(result.matched).toBe(1);
    expect(result.unresolved).toBe(0);
    expect(result.matchSourceCounts.pattern).toBe(1);
  });

  it("marks row as unresolved when recipient_raw is null", async () => {
    poolQuery
      .mockResolvedValueOnce({ rows: [] }) // UPDATE status='matching'
      .mockResolvedValueOnce({ rows: [{ id: 2, recipient_raw: null }] });
    loadActivePatterns.mockResolvedValue([]);
    applyPatterns.mockResolvedValue(new Map());
    findBestRecipientMatches.mockResolvedValue(new Map());

    const result = await matchBatch({ batchId: 2 });
    expect(result.matched).toBe(0);
    expect(result.unresolved).toBe(1);

    // The stamped-status contract for unresolved rows: 'matched' with a NULL
    // resolved_recipient_id. 'matched' is the only status the review preview
    // and the recipient-override paths accept, so this is what keeps the row
    // visible and fixable in the review UI (prepareImport forces review when
    // unresolved > 0). commitBatch — not a NOT NULL violation — decides a row
    // still unassigned at commit time into 'error'.
    const updateCall = query.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE import_staging_rows"),
    );
    expect(updateCall[0]).toContain("'matched'");
    expect(updateCall[1][0]).toEqual([2]); // staging row ids
    expect(updateCall[1][1]).toEqual([null]); // resolved_recipient_id stays NULL
  });
});

// ---------------------------------------------------------------------------
// commitBatch
// ---------------------------------------------------------------------------

describe("commitBatch", () => {
  const matchedRow = makeImportStagingRow({
    id: 1,
    row_index: 0,
    tx_date: "2024-01-15",
    bank_account: "BE12",
    recipient_raw: "SHOP",
    memo: "coffee",
    amount: "-5.00",
    currency: "EUR",
    balance: null,
    comment: null,
    resolved_recipient_id: 42,
    user_override_recipient_id: null,
    matched_pattern_id: 7,
    override_category_id: null,
    recipient_default_category_id: 3,
  });

  // The account id the run's one distinct staging label ('BE12') resolves to
  // (ADR-088: dedup and the INSERT key on the FK, not the retired string).
  // The resolver runs INSIDE the chunk transaction (so failed chunks roll the
  // minting back), i.e. on `mockClient` via the ambient context — tests that
  // need the id prime an `INSERT INTO accounts` branch on mockClient; with the
  // default `{ rows: [] }` the label resolves to null, which is fine wherever
  // the dedup candidates carry no account.
  const BE12_ACCOUNT_ID = 77;

  // Primes the POOL sink, not the exported spy: commitBatch's per-row work now
  // runs through repositories inside the chunk transaction, and the ambient
  // context routes those onto `mockClient`. Priming the pool keeps this ordered
  // sequence matched to the three genuinely pooled statements.
  function setupCommit(row) {
    poolQuery
      .mockResolvedValueOnce({ rows: [] }) // UPDATE status='committing'
      .mockResolvedValueOnce({ rows: [row] }) // SELECT matched
      .mockResolvedValueOnce({ rows: [] }); // UPDATE counters
  }

  it("imports a clean row and triggers aggregation refresh", async () => {
    setupCommit(matchedRow);
    // The transactions INSERT now uses ON CONFLICT ... RETURNING id — a
    // returned row means the insert landed (vs. a tx_hash conflict).
    mockClient.query.mockImplementation(async (sql) => {
      if (sql.includes("INSERT INTO transactions"))
        return { rows: [{ id: 100 }] };
      return { rows: [] };
    });
    expect(await commitBatch({ batchId: 1 })).toEqual({
      imported: 1,
      duplicates: 0,
      errors: 0,
      autoLinkedCount: 0,
    });
  });

  it("commits versioned provenance and uses the fingerprint as the race guard", async () => {
    setupCommit({
      ...matchedRow,
      tx_hash: "fingerprint-1",
      source_record_hash: "source-hash-1",
      dedup_fingerprint: "fingerprint-1",
      dedup_fingerprint_version: 1,
      dedup_occurrence: 1,
    });
    mockClient.query.mockImplementation(async (sql, params) => {
      if (sql.includes("INSERT INTO accounts"))
        return { rows: [{ id: BE12_ACCOUNT_ID }] };
      if (sql.includes("WHERE dedup_fingerprint_version")) return { rows: [] };
      if (sql.includes("dedup_fingerprint IS NULL AND tx_hash"))
        return { rows: [] };
      if (sql.includes("COUNT(*)::int AS n")) return { rows: [{ n: 0 }] };
      if (sql.includes("INSERT INTO transactions")) {
        expect(params.slice(11, 14)).toEqual([
          "source-hash-1",
          "fingerprint-1",
          1,
        ]);
        expect(sql).toContain("ON CONFLICT DO NOTHING");
        return { rows: [{ id: 100 }] };
      }
      return { rows: [] };
    });

    expect(await commitBatch({ batchId: 1 })).toEqual({
      imported: 1,
      duplicates: 0,
      errors: 0,
      autoLinkedCount: 0,
    });
  });

  it("uses the source hash to recognize an edited historical import", async () => {
    setupCommit({
      ...matchedRow,
      memo: "canonically edited later",
      tx_hash: "fingerprint-1",
      source_record_hash: "historical-raw-hash",
      dedup_fingerprint: "fingerprint-1",
      dedup_fingerprint_version: 1,
      dedup_occurrence: 1,
    });
    mockClient.query.mockImplementation(async (sql) => {
      if (sql.includes("INSERT INTO accounts"))
        return { rows: [{ id: BE12_ACCOUNT_ID }] };
      if (sql.includes("WHERE dedup_fingerprint_version")) return { rows: [] };
      if (sql.includes("COUNT(*)::int AS n")) return { rows: [{ n: 1 }] };
      return { rows: [] };
    });

    expect(await commitBatch({ batchId: 1 })).toEqual({
      imported: 0,
      duplicates: 1,
      errors: 0,
      autoLinkedCount: 0,
    });
    expect(
      mockClient.query.mock.calls.some(([sql]) =>
        String(sql).includes("COUNT(*)::int AS n"),
      ),
    ).toBe(true);
  });

  it("consumes one legacy source match without collapsing later repeated occurrences", async () => {
    const first = {
      ...matchedRow,
      tx_hash: "fingerprint-1",
      source_record_hash: "historical-raw-hash",
      dedup_fingerprint: "fingerprint-1",
      dedup_fingerprint_version: 1,
      dedup_occurrence: 1,
    };
    const second = {
      ...first,
      id: 2,
      row_index: 1,
      tx_hash: "fingerprint-2",
      dedup_fingerprint: "fingerprint-2",
      dedup_occurrence: 2,
    };
    poolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [first, second] })
      .mockResolvedValueOnce({ rows: [] });
    mockClient.query.mockImplementation(async (sql) => {
      if (sql.includes("INSERT INTO accounts"))
        return { rows: [{ id: BE12_ACCOUNT_ID }] };
      if (sql.includes("WHERE dedup_fingerprint_version")) return { rows: [] };
      if (sql.includes("COUNT(*)::int AS n")) return { rows: [{ n: 1 }] };
      if (sql.includes("INSERT INTO transactions"))
        return { rows: [{ id: 100 }] };
      return { rows: [] };
    });

    expect(await commitBatch({ batchId: 1 })).toEqual({
      imported: 1,
      duplicates: 1,
      errors: 0,
      autoLinkedCount: 0,
    });
  });

  it("skips an existing versioned fingerprint without invoking legacy matching", async () => {
    setupCommit({
      ...matchedRow,
      tx_hash: "fingerprint-1",
      dedup_fingerprint: "fingerprint-1",
      dedup_fingerprint_version: 1,
      dedup_occurrence: 1,
    });
    mockClient.query.mockImplementation(async (sql) => {
      if (sql.includes("INSERT INTO accounts"))
        return { rows: [{ id: BE12_ACCOUNT_ID }] };
      if (sql.includes("WHERE dedup_fingerprint_version"))
        return { rows: [{ id: 91 }] };
      return { rows: [] };
    });

    expect(await commitBatch({ batchId: 1 })).toEqual({
      imported: 0,
      duplicates: 1,
      errors: 0,
      autoLinkedCount: 0,
    });
    expect(
      mockClient.query.mock.calls.some(([sql]) =>
        String(sql).includes("COUNT(*)::int AS n"),
      ),
    ).toBe(false);
  });

  it("invalidates a count only after the import transaction commits", async () => {
    let resolveTxBody;
    const txBodyDone = new Promise((resolve) => {
      resolveTxBody = resolve;
    });
    let releaseCommit;
    const commitReleased = new Promise((resolve) => {
      releaseCommit = resolve;
    });
    let countReads = 0;
    poolQuery.mockImplementation(async (sql) => {
      if (/SELECT COUNT\(\*\)::int AS total/.test(sql)) {
        countReads += 1;
        return { rows: [{ total: countReads === 1 ? 5 : 6 }] };
      }
      if (sql.includes("FROM import_staging_rows isr")) {
        return { rows: [matchedRow] };
      }
      return { rows: [] };
    });
    mockClient.query.mockImplementation(async (sql) => {
      if (sql.includes("INSERT INTO transactions")) {
        return { rows: [{ id: 100, tx_hash: null }] };
      }
      return { rows: [] };
    });

    await expect(
      transactionRepository.getAllWithCount({ search: "rent" }),
    ).resolves.toMatchObject({ total: 5 });

    withTransaction.mockImplementation(async (fn) => {
      const result = await baseWithTransaction(fn);
      resolveTxBody();
      await commitReleased;
      return result;
    });
    const committing = commitBatch({ batchId: 1 });
    await txBodyDone;

    // The insert is still uncommitted, so an outside reader must keep the old
    // cached count rather than repopulate the cache during the commit window.
    await expect(
      transactionRepository.getAllWithCount({ search: "rent", offset: 50 }),
    ).resolves.toMatchObject({ total: 5 });
    expect(countReads).toBe(1);

    releaseCommit();
    await expect(committing).resolves.toMatchObject({ imported: 1 });
    await expect(
      transactionRepository.getAllWithCount({ search: "rent", offset: 100 }),
    ).resolves.toMatchObject({ total: 6 });
    expect(countReads).toBe(2);
  });

  it("inserts the local calendar day when tx_date is a Date (no UTC day-shift)", async () => {
    // node-postgres parses DATE columns into a server-local-midnight Date.
    // toISOString() would roll this back a day under a TZ east of UTC.
    setupCommit({ ...matchedRow, tx_date: new Date(2026, 5, 15) });
    mockClient.query.mockImplementation(async (sql, params) => {
      if (/INSERT INTO transactions\s+\(/.test(sql)) {
        return { rows: [{ id: 100, tx_hash: null }] };
      }
      return { rows: [] };
    });
    await commitBatch({ batchId: 7 });
    const insertCall = mockClient.query.mock.calls.find(([sql]) =>
      /INSERT INTO transactions\s+\(/.test(sql),
    );
    expect(insertCall[1][0]).toBe("2026-06-15");
  });

  it("marks a duplicate row and skips aggregation refresh", async () => {
    setupCommit({
      ...matchedRow,
      dedup_fingerprint: "fingerprint-1",
      dedup_fingerprint_version: 1,
      dedup_occurrence: 1,
    });
    mockClient.query.mockImplementation(async (sql) => {
      if (sql.includes("INSERT INTO accounts"))
        return { rows: [{ id: BE12_ACCOUNT_ID }] };
      if (sql.includes("WHERE dedup_fingerprint_version"))
        return { rows: [{ id: 91 }] };
      return { rows: [] };
    });
    expect(await commitBatch({ batchId: 2 })).toEqual({
      imported: 0,
      duplicates: 1,
      errors: 0,
      autoLinkedCount: 0,
    });

    const statements = mockClient.query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((s) => s.includes("INSERT INTO transactions"))).toBe(
      false,
    );
    expect(statements.some((s) => s.startsWith("SAVEPOINT"))).toBe(false);
    expect(
      statements.filter((s) => s.includes("status = 'duplicate'")),
    ).toHaveLength(1);
  });

  it("records an insert error via SAVEPOINT rollback", async () => {
    // Deliberately a FALLBACK test, and the only one that covers the whole
    // degradation chain end to end: the chunk INSERT throws, the chunk rolls
    // back to its savepoint, the per-row replay re-issues the insert under a
    // per-row savepoint, that throws too, and the row is recorded as an error.
    // The batched failure path on its own is covered by the plan-mismatch test
    // above; this one pins that a throwing insert still ends in errors: 1 with
    // the staging row marked, exactly as the per-row loop always did.
    setupCommit(matchedRow);
    mockClient.query.mockImplementation(async (sql) => {
      if (sql.includes("INSERT INTO transactions"))
        throw new Error("constraint violation");
      return { rows: [] };
    });
    expect(await commitBatch({ batchId: 3 })).toEqual({
      imported: 0,
      duplicates: 0,
      errors: 1,
      autoLinkedCount: 0,
    });

    const statements = mockClient.query.mock.calls.map(([sql]) => String(sql));
    expect(statements).toContain("SAVEPOINT sp_commit_row");
    expect(statements).toContain("ROLLBACK TO SAVEPOINT sp_commit_row");
    expect(statements.some((s) => s.includes("status = 'error'"))).toBe(true);
  });

  it("decides a row with no recipient into 'error' without attempting the INSERT", async () => {
    // Matcher resolved nothing, user assigned nothing in review. The row must
    // be decided into 'error' up front — transactions.recipient_id is NOT
    // NULL, so attempting it would 23502 inside the bulk INSERT and demote
    // the whole chunk to the per-row replay.
    setupCommit({ ...matchedRow, resolved_recipient_id: null });
    expect(await commitBatch({ batchId: 5 })).toEqual({
      imported: 0,
      duplicates: 0,
      errors: 1,
      autoLinkedCount: 0,
    });

    // Decided before any chunk work: no transaction is even opened.
    expect(mockClient.query).not.toHaveBeenCalled();

    const errorUpdate = poolQuery.mock.calls.find(([sql]) =>
      String(sql).includes("status = 'error'"),
    );
    expect(errorUpdate[1]).toEqual([
      [1],
      expect.stringContaining("unresolved recipient"),
    ]);
    const counterUpdate = poolQuery.mock.calls.find(([sql]) =>
      String(sql).includes("rows_error"),
    );
    expect(counterUpdate[1]).toEqual([5, 1]);
  });

  it("commits an unresolved row once the user assigned a recipient in review", async () => {
    // The review-UI fix path: the row stayed 'matched' with a NULL
    // resolved_recipient_id, the user set user_override_recipient_id, and the
    // commit honours the override instead of erroring the row.
    setupCommit({
      ...matchedRow,
      resolved_recipient_id: null,
      user_override_recipient_id: 42,
    });
    mockClient.query.mockImplementation(async (sql) => {
      if (sql.includes("INSERT INTO transactions"))
        return { rows: [{ id: 100, tx_hash: null }] };
      return { rows: [] };
    });
    expect(await commitBatch({ batchId: 6 })).toEqual({
      imported: 1,
      duplicates: 0,
      errors: 0,
      autoLinkedCount: 0,
    });
    const statements = mockClient.query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((s) => s.includes("status = 'error'"))).toBe(false);
  });

  it("keeps a chunk containing an unresolved row on the batched path", async () => {
    // Post-c1d6761 regression the up-front decision closes: an unresolved row
    // reaching the bulk INSERT used to fail the chunk to the per-row replay.
    // With the decision made before commit, the remaining rows still commit.
    const rows = [
      { ...matchedRow, id: 1, row_index: 0, resolved_recipient_id: null },
      { ...matchedRow, id: 2, row_index: 1, memo: "coffee 1", tx_hash: "h1" },
      { ...matchedRow, id: 3, row_index: 2, memo: "coffee 2", tx_hash: "h2" },
    ];
    poolQuery
      .mockResolvedValueOnce({ rows: [] }) // UPDATE status='committing'
      .mockResolvedValueOnce({ rows }) // SELECT matched
      .mockResolvedValueOnce({ rows: [] }) // staging error UPDATE (unresolved row)
      .mockResolvedValueOnce({ rows: [] }) // rows_error checkpoint
      .mockResolvedValueOnce({ rows: [] }); // UPDATE counters
    mockClient.query.mockImplementation(async (sql) => {
      if (sql.includes("INSERT INTO transactions")) {
        return {
          rows: [
            { id: 100, tx_hash: "h1" },
            { id: 101, tx_hash: "h2" },
          ],
        };
      }
      return { rows: [] };
    });
    expect(await commitBatch({ batchId: 12 })).toEqual({
      imported: 2,
      duplicates: 0,
      errors: 1,
      autoLinkedCount: 0,
    });

    const statements = mockClient.query.mock.calls.map(([sql]) => String(sql));
    expect(
      statements.filter((s) => s.includes("INSERT INTO transactions")),
    ).toHaveLength(2);
    expect(statements.some((s) => s.includes("ROLLBACK TO SAVEPOINT"))).toBe(
      false,
    );
    expect(
      statements.filter((s) => s === "SAVEPOINT sp_commit_row"),
    ).toHaveLength(2);
    expect(
      statements.filter((s) => s.includes("status = 'committed'")),
    ).toHaveLength(2);

    // The unresolved row was written 'error' on the pool, before the chunk.
    const errorUpdate = poolQuery.mock.calls.find(([sql]) =>
      String(sql).includes("status = 'error'"),
    );
    expect(errorUpdate[1][0]).toEqual([1]);
  });

  it("rejects a non-integer staging row.id before issuing SAVEPOINT", async () => {
    // Defence-in-depth: import_staging_rows.id is BIGSERIAL today, but if a
    // future schema change ever loosened that contract, repository and staging
    // writes must not receive an arbitrary identifier. Validation also stays
    // before the per-row savepoint, so no transaction work starts for it.
    setupCommit({ ...matchedRow, id: "1; DROP TABLE x" });
    expect(await commitBatch({ batchId: 4 })).toEqual({
      imported: 0,
      duplicates: 0,
      errors: 1,
      autoLinkedCount: 0,
    });
    const savepointCalls = mockClient.query.mock.calls.filter(
      ([sql]) => typeof sql === "string" && sql.startsWith("SAVEPOINT"),
    );
    expect(savepointCalls).toHaveLength(0);
  });
});
