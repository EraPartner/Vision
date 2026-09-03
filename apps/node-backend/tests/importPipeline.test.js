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

  it("marks a second identical row in the same batch as a duplicate", async () => {
    const dupRow = { ...baseRow, id: 2, row_index: 1, raw_data: null };
    poolQuery
      .mockResolvedValueOnce({ rows: [] }) // UPDATE status='validating'
      .mockResolvedValueOnce({ rows: [baseRow, dupRow] }); // SELECT pending — two identical rows
    // The UPDATE import_batches rows_duplicate write also issues a query.
    poolQuery.mockResolvedValueOnce({ rows: [] });
    expect(await validateBatch({ batchId: 5 })).toEqual({
      validated: 1,
      duplicates: 1,
      errors: 0,
    });
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
      validated: 1,
      duplicates: 1,
      errors: 0,
    });
    const update = getValidationUpdate();
    expect(update.statuses).toEqual(["validated", "duplicate"]);
    expect(update.hashes[0]).toBe(update.hashes[1]);
  });

  it("keeps literal raw_data as the complete hash identity", async () => {
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
      validated: 1,
      duplicates: 1,
      errors: 0,
    });
    const update = getValidationUpdate();
    expect(update.hashes[0]).toBe(update.hashes[1]);
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
    // The chunk INSERT is multi-row (SELECT UNNEST(...)), so the date
    // parameter is the column array — this chunk holds the one row.
    expect(insertCall[1][0][0]).toBe("2026-06-15");
  });

  it("marks a duplicate row and skips aggregation refresh", async () => {
    // Drives the BATCHED path to the duplicate verdict: the chunk pre-load
    // hands back a matching candidate, so the row never reaches an INSERT and
    // the per-row `SELECT t.id` dup check is never issued. (Keying this
    // fixture on the per-row SQL would only ever exercise the fallback — the
    // batched planner does not issue that statement at all.)
    setupCommit(matchedRow);
    mockClient.query.mockImplementation(async (sql) => {
      if (sql.includes("INSERT INTO accounts"))
        return { rows: [{ id: BE12_ACCOUNT_ID }] };
      if (sql.includes("FROM transactions t") && sql.includes("t.date = ANY")) {
        return {
          rows: [
            {
              date_key: "2024-01-15",
              amount_key: "-5.0000",
              recipient_id: 42,
              memo_key: "coffee",
              account_id: BE12_ACCOUNT_ID,
              tx_hash: null,
              import_batch_id: "2",
            },
          ],
        };
      }
      return { rows: [] };
    });
    expect(await commitBatch({ batchId: 2 })).toEqual({
      imported: 0,
      duplicates: 1,
      errors: 0,
      autoLinkedCount: 0,
    });

    const statements = mockClient.query.mock.calls.map(([sql]) => String(sql));
    // Batched path only: no per-row dup check, no INSERT, no savepoint.
    expect(statements.some((s) => s.includes("SELECT t.id"))).toBe(false);
    expect(statements.some((s) => s.includes("INSERT INTO transactions"))).toBe(
      false,
    );
    expect(statements.some((s) => s.startsWith("SAVEPOINT"))).toBe(false);
    expect(
      statements.filter((s) => s.includes("status = 'duplicate'")),
    ).toHaveLength(1);
  });

  it("field-dedup is scoped to the same account and never matches a differing-hash row", async () => {
    // Two same-day card payments share date+amount+recipient+memo (Revolut
    // stamps the identical "CARD_PAYMENT - CURRENT") but differ by tx_hash
    // (running balance differs) — the second must NOT collapse into the first.
    // Likewise an identical purchase on a DIFFERENT account is distinct.
    //
    // The dup check is now a per-chunk pre-load plus a JS verdict, so the
    // fixture is the candidate row Postgres hands back rather than a bare id:
    // the first card payment, already written by THIS batch under hash 'h1'.
    setupCommit({ ...matchedRow, tx_hash: "h2" });
    let dupSql, dupParams;
    mockClient.query.mockImplementation(async (sql, params) => {
      if (sql.includes("INSERT INTO accounts"))
        return { rows: [{ id: BE12_ACCOUNT_ID }] };
      if (sql.includes("FROM transactions t") && sql.includes("t.date = ANY")) {
        dupSql = sql;
        dupParams = params;
        return {
          rows: [
            // Same field tuple, same account, same batch, DIFFERENT hash.
            {
              date_key: "2024-01-15",
              amount_key: "-5.0000",
              recipient_id: 42,
              memo_key: "coffee",
              account_id: BE12_ACCOUNT_ID,
              tx_hash: "h1",
              import_batch_id: "9",
            },
            // Identical purchase on a DIFFERENT account — never a duplicate.
            {
              date_key: "2024-01-15",
              amount_key: "-5.0000",
              recipient_id: 42,
              memo_key: "coffee",
              account_id: 88,
              tx_hash: null,
              import_batch_id: null,
            },
          ],
        };
      }
      if (sql.includes("INSERT INTO transactions"))
        return { rows: [{ id: 100, tx_hash: "h2" }] };
      return { rows: [] };
    });
    expect(await commitBatch({ batchId: 9 })).toEqual({
      imported: 1,
      duplicates: 0,
      errors: 0,
      autoLinkedCount: 0,
    });
    // Pre-load scope must stay a strict superset of the old per-row WHERE:
    // active rows on the chunk's dates, with every discriminating column read
    // back so the JS verdict can apply the rest of the predicate.
    expect(dupSql).toContain("t.is_active = true");
    expect(dupSql).toContain("t.date = ANY($1::date[])");
    // ADR-088: the account guard reads the FK, never the retired string.
    expect(dupSql).toContain("t.account_id");
    expect(dupSql).not.toContain("t.bank_account");
    expect(dupSql).toContain("t.tx_hash");
    expect(dupSql).toContain("t.import_batch_id");
    expect(dupParams[0]).toEqual(["2024-01-15"]);
  });

  it("collapses a same-account same-hash-less field duplicate found by the pre-load", async () => {
    // Same field tuple from a DIFFERENT batch: the hash exemption does not
    // apply, so this is the ordinary "re-import is a no-op" duplicate.
    setupCommit({ ...matchedRow, tx_hash: "h2" });
    mockClient.query.mockImplementation(async (sql) => {
      if (sql.includes("INSERT INTO accounts"))
        return { rows: [{ id: BE12_ACCOUNT_ID }] };
      if (sql.includes("FROM transactions t") && sql.includes("t.date = ANY")) {
        return {
          rows: [
            {
              date_key: "2024-01-15",
              amount_key: "-5.0000",
              recipient_id: 42,
              memo_key: "coffee",
              account_id: BE12_ACCOUNT_ID,
              tx_hash: "other-hash",
              import_batch_id: "4",
            },
          ],
        };
      }
      if (sql.includes("INSERT INTO transactions"))
        return { rows: [{ id: 100, tx_hash: "h2" }] };
      return { rows: [] };
    });
    expect(await commitBatch({ batchId: 9 })).toEqual({
      imported: 0,
      duplicates: 1,
      errors: 0,
      autoLinkedCount: 0,
    });
  });

  it("keeps an orphaned imported transaction visible to field dedup", async () => {
    setupCommit({ ...matchedRow, tx_hash: "incoming-hash" });
    mockClient.query.mockImplementation(async (sql) => {
      if (sql.includes("INSERT INTO accounts"))
        return { rows: [{ id: BE12_ACCOUNT_ID }] };
      if (sql.includes("FROM transactions t") && sql.includes("t.date = ANY")) {
        return {
          rows: [
            {
              date_key: "2024-01-15",
              amount_key: "-5.0000",
              recipient_id: 42,
              memo_key: "coffee",
              account_id: BE12_ACCOUNT_ID,
              tx_hash: "orphaned-source-hash",
              import_batch_id: null,
            },
          ],
        };
      }
      return { rows: [] };
    });

    expect(await commitBatch({ batchId: 9 })).toEqual({
      imported: 0,
      duplicates: 1,
      errors: 0,
      autoLinkedCount: 0,
    });
  });

  it("deduplicates hashless tab-padded memos inside the batched planner", async () => {
    const rows = [
      { ...matchedRow, id: 1, row_index: 0, memo: "TEA\t", tx_hash: null },
      { ...matchedRow, id: 2, row_index: 1, memo: "TEA\t", tx_hash: null },
    ];
    poolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows })
      .mockResolvedValueOnce({ rows: [] });
    mockClient.query.mockImplementation(async (sql) => {
      if (sql.includes("INSERT INTO accounts"))
        return { rows: [{ id: BE12_ACCOUNT_ID }] };
      if (sql.includes("INSERT INTO transactions"))
        return { rows: [{ id: 100, tx_hash: null }] };
      return { rows: [] };
    });

    expect(await commitBatch({ batchId: 9 })).toEqual({
      imported: 1,
      duplicates: 1,
      errors: 0,
      autoLinkedCount: 0,
    });
    const statements = mockClient.query.mock.calls.map(([sql]) => String(sql));
    expect(
      statements.filter((sql) => sql.includes("INSERT INTO transactions")),
    ).toHaveLength(1);
    expect(
      statements.some((sql) => sql.startsWith("ROLLBACK TO SAVEPOINT")),
    ).toBe(false);
    expect(statements.some((sql) => sql.includes("sp_commit_row"))).toBe(false);
  });

  it("still submits a hash-conflicting row to the INSERT so Postgres checks its tuple", async () => {
    // Predicted conflicts are counted as duplicates but are NOT withheld from
    // the INSERT: Postgres validates NOT NULL / CHECK / numeric overflow before
    // it resolves the conflict, so a row that both conflicts AND violates one
    // of those must still raise. Withholding it downgrades a real failure to
    // 'duplicate'. ON CONFLICT DO NOTHING is what drops it — hence the empty
    // RETURNING, which is the EXPECTED result here, not a plan mismatch.
    setupCommit({ ...matchedRow, tx_hash: "h2" });
    let hashSql;
    let insertIssued = false;
    mockClient.query.mockImplementation(async (sql) => {
      if (sql.includes("SELECT tx_hash FROM transactions")) {
        hashSql = sql;
        return { rows: [{ tx_hash: "h2" }] };
      }
      if (sql.includes("INSERT INTO transactions")) {
        insertIssued = true;
        return { rows: [] };
      }
      return { rows: [] };
    });
    expect(await commitBatch({ batchId: 9 })).toEqual({
      imported: 0,
      duplicates: 1,
      errors: 0,
      autoLinkedCount: 0,
    });
    expect(insertIssued).toBe(true);
    // The pre-load is deliberately unfiltered by is_active — the unique index
    // has no is_active predicate, so a soft-deleted row still conflicts.
    expect(hashSql).not.toContain("is_active");
    // Dropped by ON CONFLICT ⇒ 'duplicate' staging only, never 'committed',
    // and no fallback (the empty RETURNING matched the prediction exactly).
    const statements = mockClient.query.mock.calls.map(([sql]) => String(sql));
    expect(
      statements.filter((s) => s.includes("status = 'duplicate'")),
    ).toHaveLength(1);
    expect(statements.some((s) => s.includes("status = 'committed'"))).toBe(
      false,
    );
    expect(statements.some((s) => s.startsWith("ROLLBACK TO SAVEPOINT"))).toBe(
      false,
    );
  });

  it("replays the chunk per row when the bulk INSERT drops an unpredicted row", async () => {
    // A concurrent import won a tx_hash race: the plan predicted no conflict,
    // so a short RETURNING invalidates every verdict downstream of the missing
    // row. The chunk must roll back to its savepoint and go row by row.
    setupCommit({ ...matchedRow, tx_hash: "h2" });
    mockClient.query.mockImplementation(async (sql) => {
      // Pre-load says the hash is free; the INSERT then returns nothing.
      if (sql.includes("INSERT INTO transactions")) return { rows: [] };
      if (sql.includes("SELECT t.id")) return { rows: [{ id: 999 }] }; // per-row dup check
      return { rows: [] };
    });
    expect(await commitBatch({ batchId: 9 })).toEqual({
      imported: 0,
      duplicates: 1,
      errors: 0,
      autoLinkedCount: 0,
    });
    const statements = mockClient.query.mock.calls.map(([sql]) => String(sql));
    expect(statements).toContain("ROLLBACK TO SAVEPOINT sp_commit_chunk");
    expect(statements.some((s) => s.includes("SELECT t.id"))).toBe(true);
  });

  it("issues one INSERT and one staging UPDATE per chunk, not per row", async () => {
    // The finding this rewrite closes: five sequential statements per row.
    const rows = Array.from({ length: 25 }, (_, i) => ({
      ...matchedRow,
      id: i + 1,
      row_index: i,
      memo: `coffee ${i}`,
      tx_hash: `h${i}`,
    }));
    poolQuery
      .mockResolvedValueOnce({ rows: [] }) // UPDATE status='committing'
      .mockResolvedValueOnce({ rows }) // SELECT matched
      .mockResolvedValueOnce({ rows: [] }); // UPDATE counters
    mockClient.query.mockImplementation(async (sql) => {
      if (sql.includes("INSERT INTO transactions")) {
        return {
          rows: rows.map((r, i) => ({ id: 1000 + i, tx_hash: r.tx_hash })),
        };
      }
      return { rows: [] };
    });
    expect(await commitBatch({ batchId: 11 })).toEqual({
      imported: 25,
      duplicates: 0,
      errors: 0,
      autoLinkedCount: 0,
    });

    const statements = mockClient.query.mock.calls.map(([sql]) => String(sql));
    const count = (needle) =>
      statements.filter((s) => s.includes(needle)).length;
    expect(count("INSERT INTO transactions")).toBe(1);
    expect(count("UPDATE import_staging_rows")).toBe(1);
    // One account resolution for the chunk's single distinct label (inside
    // the chunk transaction — ADR-088), regardless of row count.
    expect(count("INSERT INTO accounts")).toBe(1);
    expect(statements.filter((s) => s.startsWith("SAVEPOINT"))).toHaveLength(1);
    // Account resolve + two pre-loads + SAVEPOINT + INSERT + RELEASE + one
    // staging UPDATE.
    expect(statements).toHaveLength(7);
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
    expect(statements).toContain("ROLLBACK TO SAVEPOINT sp_commit_chunk");
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
    // With the decision made before planning, the rest of the chunk must stay
    // on the batched path — one INSERT, no rollback, no per-row savepoints.
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
    ).toHaveLength(1);
    expect(statements.some((s) => s.includes("ROLLBACK TO SAVEPOINT"))).toBe(
      false,
    );
    expect(statements).not.toContain("SAVEPOINT sp_commit_row");
    expect(
      statements.filter((s) => s.includes("status = 'committed'")),
    ).toHaveLength(1);

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
