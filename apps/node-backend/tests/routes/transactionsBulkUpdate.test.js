/**
 * POST /bulk-update — field validation, FK pre-checks, single transaction.
 *
 * Driven over HTTP against the real router (tests/helpers/routeApp.js), so the
 * route's rate limiter, JSON body parsing and the centralized error handler are
 * all on the tested path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockPooledTxConnection } from "../helpers/repoMocks.js";
import {
  mockTransactionRepository,
  mockDeduplication,
  mockTransferReconciliation,
  mockCurrencyConversion,
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

const { default: transactionsRouter } =
  await import("../../src/routes/transactions.js");

import { getClient, query as dbQuery } from "../../src/database/connection.js";
import { scheduleReconcile } from "../../src/services/transferReconciliationService.js";

const api = routeAgent(transactionsRouter, { mountPath: "/api/transactions" });
const bulkUpdate = (body) =>
  api.post("/api/transactions/bulk-update").send(body);

describe("POST /bulk-update — field validation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects when fields object is missing", async () => {
    await bulkUpdate({ ids: [1] }).expect(400);
  });

  it("rejects when no recognized field is set", async () => {
    const res = await bulkUpdate({ ids: [1], fields: { foo: 1 } }).expect(400);
    expect(res.body.error.message).toMatch(/at least one/i);
  });

  it("rejects non-integer category_id", async () => {
    await bulkUpdate({ ids: [1], fields: { category_id: "abc" } }).expect(400);
  });

  it("accepts category_id = null (uncategorize)", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })
      .mockResolvedValueOnce({});
    const release = vi.fn();
    getClient.mockResolvedValue({ query: clientQuery, release });

    const res = await bulkUpdate({
      ids: [1],
      fields: { category_id: null },
    }).expect(200);

    expect(res.body.data.updated).toBe(1);
    expect(res.body.data.requested).toBe(1);
    expect(res.body.data.matched).toBe(1);
    const updateCall = clientQuery.mock.calls.find(([sql]) =>
      sql.includes("UPDATE transactions"),
    );
    expect(updateCall[0]).toMatch(/category_id = \$2/);
    expect(updateCall[1]).toEqual([[1], null]);
  });

  it("rejects null recipient_id (column is NOT NULL)", async () => {
    await bulkUpdate({ ids: [1], fields: { recipient_id: null } }).expect(400);
  });

  it("rejects non-boolean is_active", async () => {
    await bulkUpdate({ ids: [1], fields: { is_active: "true" } }).expect(400);
  });
});

describe("POST /bulk-update — FK pre-checks", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 400 when category does not exist", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] }); // category lookup

    await bulkUpdate({ ids: [1], fields: { category_id: 999 } }).expect(400);

    expect(getClient).not.toHaveBeenCalled();
  });

  it("returns 400 when recipient does not exist", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] }); // recipient lookup

    await bulkUpdate({ ids: [1], fields: { recipient_id: 999 } }).expect(400);

    expect(getClient).not.toHaveBeenCalled();
  });
});

describe("POST /bulk-update — success paths", () => {
  beforeEach(() => vi.clearAllMocks());

  it("updates a single field and schedules a refresh", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ id: 7 }] }); // category exists
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }] })
      .mockResolvedValueOnce({});
    const release = vi.fn();
    getClient.mockResolvedValue({ query: clientQuery, release });

    const res = await bulkUpdate({
      ids: [1, 2],
      fields: { category_id: 7 },
    }).expect(200);

    expect(res.body.data.updated).toBe(2);
    expect(res.body.data.requested).toBe(2);
    expect(res.body.data.matched).toBe(2);
    expect(scheduleReconcile).toHaveBeenCalledTimes(1);
  });

  it("updates multiple fields in one statement", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ id: 7 }] }) // category exists
      .mockResolvedValueOnce({ rows: [{ id: 99 }] }); // recipient exists
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: 5 }] })
      .mockResolvedValueOnce({});
    const release = vi.fn();
    getClient.mockResolvedValue({ query: clientQuery, release });

    const res = await bulkUpdate({
      ids: [5],
      fields: { category_id: 7, recipient_id: 99, is_active: false },
    }).expect(200);

    expect(res.body.data.updated).toBe(1);
    expect(res.body.data.requested).toBe(1);
    expect(res.body.data.matched).toBe(1);
    const updateCall = clientQuery.mock.calls.find(([sql]) =>
      sql.includes("UPDATE transactions"),
    );
    expect(updateCall[0]).toMatch(
      /category_id = \$2.*recipient_id = \$3.*is_active = \$4.*updated_at = NOW\(\)/s,
    );
    expect(updateCall[1]).toEqual([[5], 7, 99, false]);
  });

  it("does not schedule a refresh when nothing was updated", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({});
    const release = vi.fn();
    getClient.mockResolvedValue({ query: clientQuery, release });

    const res = await bulkUpdate({
      ids: [12345],
      fields: { is_active: true },
    }).expect(200);

    expect(res.body.data.updated).toBe(0);
    expect(res.body.data.requested).toBe(1);
    expect(res.body.data.matched).toBe(1);
    expect(scheduleReconcile).not.toHaveBeenCalled();
  });

  it("reports filter selection drift to zero without scheduling reconciliation", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ n: 0 }] })
      .mockResolvedValueOnce({ rows: [] });
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({});
    getClient.mockResolvedValue({ query: clientQuery, release: vi.fn() });

    const res = await bulkUpdate({
      filter: { search: "disappeared" },
      expected_count: 2,
      fields: { is_active: false },
    }).expect(200);

    expect(res.body.data).toEqual({ updated: 0, requested: 2, matched: 0 });
    expect(scheduleReconcile).not.toHaveBeenCalled();
  });
});

describe("POST /bulk-update — atomicity", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rolls back and skips refresh when UPDATE fails", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce({});
    const release = vi.fn();
    getClient.mockResolvedValue({ query: clientQuery, release });

    await bulkUpdate({ ids: [1], fields: { is_active: false } }).expect(500);

    expect(scheduleReconcile).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
