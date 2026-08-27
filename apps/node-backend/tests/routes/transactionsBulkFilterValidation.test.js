/**
 * The `filter` selector of POST /bulk-delete, /bulk-update and /bulk-export,
 * driven over HTTP against the real router (tests/helpers/routeApp.js).
 *
 * All three endpoints resolve their selection through the one
 * `resolveBulkSelection` → `normalizeBulkFilter` pair, and that normaliser used
 * to apply every field on a best-effort basis: a field that failed its type
 * guard was SKIPPED rather than rejected. On bulk-delete that meant the hard
 * delete ran against a WIDER set than the caller named while answering 200 with
 * a plausible count — invisible by construction. Reproduced end-to-end against
 * a real migrated Postgres before the fix: a 4-row corpus, a filter naming 2 of
 * them (`{category_ids: '<catId>'}`, a string where the array was expected),
 * response `{"deleted": 4}`.
 *
 * A separate file rather than more cases in transactionsBulkDelete.test.js:
 * that suite runs against the route's REAL 30-requests/minute limiter and is
 * already close to it, so these ~25 extra requests would make it self-throttle.
 * Each file gets its own module registry, hence its own limiter counter.
 *
 * The per-field accept/reject matrix lives one layer down, in
 * tests/services/bulkSelectionFilter.test.js. What is pinned HERE is the wire
 * behaviour: the status code, and that neither the COUNT(*) precheck nor the
 * pooled write client is ever reached.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockPooledTxConnection } from "../helpers/repoMocks.js";
import {
  mockTransactionRepository,
  mockDeduplication,
  mockTransferReconciliation,
  mockCurrencyConversion,
  mockAttachmentRecordService,
  mockAttachmentService,
} from "../helpers/transactionsRouteMocks.js";
import { mockLogger } from "../helpers/mockLogger.js";
import { routeAgent } from "../helpers/routeApp.js";

vi.mock("../../src/repositories/transactionRepository.js", () =>
  mockTransactionRepository(),
);

vi.mock("../../src/services/deduplication.js", () => mockDeduplication());

vi.mock("../../src/config/logger.js", () => ({
  logger: mockLogger(),
}));

vi.mock("../../src/services/transferReconciliationService.js", () =>
  mockTransferReconciliation(),
);

vi.mock("../../src/services/currency/currencyConversionService.js", () =>
  mockCurrencyConversion(),
);

vi.mock("../../src/database/connection.js", () => mockPooledTxConnection());

vi.mock("../../src/services/attachmentRecordService.js", () =>
  mockAttachmentRecordService(),
);

vi.mock("../../src/services/attachmentService.js", () =>
  mockAttachmentService(),
);

const { default: transactionsRouter } =
  await import("../../src/routes/transactions.js");

import { getClient, query as dbQuery } from "../../src/database/connection.js";

const api = routeAgent(transactionsRouter, { mountPath: "/api/transactions" });
const bulkDelete = (body) =>
  api.post("/api/transactions/bulk-delete").send(body);
const bulkUpdate = (body) =>
  api.post("/api/transactions/bulk-update").send(body);
const bulkExport = (body) =>
  api.post("/api/transactions/bulk-export").send(body);

/**
 * One instance of each widen shape. Each of these used to be dropped silently,
 * leaving the named filter unapplied and the action covering more rows.
 */
const WIDENING_FILTERS = [
  { category_ids: "5" }, // string where the array is expected — the named case
  { bank_accounts: "KBC" }, // same Array.isArray guard in the builder
  { tags: "rome-2020," }, // trailing empty slug was filtered out
  { transaction_type: "Expense" }, // value guard: income rows swept in too
  { amount_min: "25abc" }, // unparseable bound, clause dropped entirely
  { active: 0 }, // collapsed to the `active: true` default
];

/** Malformed scalar ids and dates: these reached Postgres as a 22P02/22007 500. */
const MALFORMED_SCALARS = [
  { recipient_id: "12abc" },
  { transaction_id: "1e3" },
  { account_id: "abc" },
  { category_id: 0 },
  { recipient_group_id: -4 },
  { start_date: "banana" },
];

describe("POST /bulk-delete — a filter field is rejected, not skipped", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a wrong-typed filter field instead of deleting a wider set", async () => {
    for (const filter of WIDENING_FILTERS) {
      const res = await bulkDelete({ filter, expected_count: 1 }).expect(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    }
    expect(dbQuery).not.toHaveBeenCalled();
    expect(getClient).not.toHaveBeenCalled();
  });

  it("rejects an unrecognised filter key rather than deleting everything", async () => {
    // The worst case of all: nothing in the body was understood, so the filter
    // resolved to "every active transaction" and the delete swept the table up
    // to the 5000-row cap. `account_ids` is a real list-endpoint param this
    // normaliser never supported.
    const res = await bulkDelete({
      filter: { account_ids: [7] },
      expected_count: 1,
    }).expect(400);
    expect(res.body.error.message).toMatch(/unknown field/i);
    expect(dbQuery).not.toHaveBeenCalled();
    expect(getClient).not.toHaveBeenCalled();
  });

  it("answers a malformed scalar filter id with a 400 rather than a 22P02 500", async () => {
    for (const filter of MALFORMED_SCALARS) {
      await bulkDelete({ filter, expected_count: 1 }).expect(400);
    }
    expect(dbQuery).not.toHaveBeenCalled();
    expect(getClient).not.toHaveBeenCalled();
  });

  it('still accepts the whole-table selection "select all N matching" sends', async () => {
    // With no filters set the Transactions page posts `{active: true}` and
    // nothing else (JSON drops the undefined keys). Legitimate, and bounded by
    // the 5000-row cap rather than by validation — it must not be mistaken for
    // an empty filter and rejected.
    dbQuery
      .mockResolvedValueOnce({ rows: [{ n: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: 11 }] });
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: 11 }] })
      .mockResolvedValueOnce({});
    getClient.mockResolvedValue({ query: clientQuery, release: vi.fn() });

    const res = await bulkDelete({
      filter: { active: true },
      expected_count: 1,
    }).expect(200);
    expect(res.body.data.deleted).toBe(1);
  });

  it("still accepts a well-formed filter unchanged", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ n: 2 }] })
      .mockResolvedValueOnce({ rows: [{ id: 11 }, { id: 22 }] });
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: 11 }, { id: 22 }] })
      .mockResolvedValueOnce({});
    getClient.mockResolvedValue({ query: clientQuery, release: vi.fn() });

    const res = await bulkDelete({
      filter: {
        category_ids: [5, 6],
        start_date: "2026-01-01",
        transaction_type: "expense",
      },
      expected_count: 2,
    }).expect(200);
    expect(res.body.data.deleted).toBe(2);
  });
});

describe("POST /bulk-update — same normaliser, same rejection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a wrong-typed or unknown filter field before any UPDATE", async () => {
    // Not destructive like the delete, but the same defect: the shared category
    // or recipient write landed on rows the caller never selected.
    for (const filter of [
      ...WIDENING_FILTERS.slice(0, 3),
      { account_ids: [7] },
      ...MALFORMED_SCALARS.slice(0, 2),
    ]) {
      await bulkUpdate({
        filter,
        expected_count: 1,
        fields: { is_active: false },
      }).expect(400);
    }
    expect(dbQuery).not.toHaveBeenCalled();
    expect(getClient).not.toHaveBeenCalled();
  });
});

describe("POST /bulk-export — same normaliser, same rejection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a wrong-typed or unknown filter field before streaming anything", async () => {
    // On the export path the widen is not destructive but it is a disclosure:
    // the user keeps a file containing rows their filter excluded.
    for (const filter of [
      ...WIDENING_FILTERS.slice(0, 3),
      { account_ids: [7] },
      ...MALFORMED_SCALARS.slice(0, 2),
    ]) {
      await bulkExport({ filter, expected_count: 1, format: "csv" }).expect(
        400,
      );
    }
    expect(dbQuery).not.toHaveBeenCalled();
  });
});
