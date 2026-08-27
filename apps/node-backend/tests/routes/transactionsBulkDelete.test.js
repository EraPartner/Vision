/**
 * POST /bulk-delete — id-mode, filter-mode, validation, atomicity.
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
import { scheduleReconcile } from "../../src/services/transferReconciliationService.js";

const api = routeAgent(transactionsRouter, { mountPath: "/api/transactions" });
const bulkDelete = (body) =>
  api.post("/api/transactions/bulk-delete").send(body);

describe("POST /bulk-delete — input validation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 400 when neither ids nor filter is given", async () => {
    await bulkDelete({}).expect(400);
  });

  it("returns 400 when both ids and filter are given", async () => {
    await bulkDelete({ ids: [1], filter: { search: "x" } }).expect(400);
  });

  it("returns 400 when ids exceeds 500 entries", async () => {
    await bulkDelete({
      ids: Array.from({ length: 501 }, (_, i) => i + 1),
    }).expect(400);
  });

  // The worst reachable form of the silent-drop class, on the one endpoint
  // where the damage is irreversible. `ids` is read straight off req.body here
  // — no route-layer id validation stands in front of it — and the resolver
  // ran `.map(Number)` before filtering, so '1e3' became id 1000, '0x10' became
  // 16, [7] became 7 and true became 1. A hard DELETE then hit a row the client
  // never named, with a 200 and a plausible-looking count. Nothing logged it.
  it("rejects a coercible non-id instead of hard-deleting a different record", async () => {
    for (const bad of [
      "1e3",
      "0x10",
      "0o17",
      "0b11",
      [7],
      true,
      " 5 ",
      "5.0",
    ]) {
      await bulkDelete({ ids: [bad] }).expect(400);
    }
    expect(getClient).not.toHaveBeenCalled();
  });

  // A partly-valid list used to delete its valid members and silently ignore
  // the rest, so the caller could not tell a full delete from a partial one.
  it("rejects a partly-valid id list rather than deleting a subset", async () => {
    const res = await bulkDelete({ ids: [1, "abc", 2] }).expect(400);
    expect(res.body.error.message).toBe("ids contains invalid value: abc");
    expect(getClient).not.toHaveBeenCalled();
  });
});

describe("POST /bulk-delete — id-mode success", () => {
  beforeEach(() => vi.clearAllMocks());

  it("hard-deletes the listed transactions and schedules a refresh", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }, { id: 3 }] }) // DELETE RETURNING id
      .mockResolvedValueOnce({}); // COMMIT
    const release = vi.fn();
    getClient.mockResolvedValue({ query: clientQuery, release });

    const res = await bulkDelete({ ids: [1, 2, 3] }).expect(200);

    expect(res.body.data.deleted).toBe(3);
    expect(res.body.data.requested).toBe(3);
    expect(res.body.data.matched).toBe(3);
    expect(scheduleReconcile).toHaveBeenCalledTimes(1);

    const deleteCall = clientQuery.mock.calls.find(([sql]) =>
      sql.includes("DELETE FROM transactions"),
    );
    expect(deleteCall).toBeDefined();
    expect(deleteCall[1]).toEqual([[1, 2, 3]]);
  });

  it("does not schedule a refresh when nothing was deleted", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({});
    const release = vi.fn();
    getClient.mockResolvedValue({ query: clientQuery, release });

    const res = await bulkDelete({ ids: [9999] }).expect(200);

    expect(res.body.data.deleted).toBe(0);
    expect(res.body.data.requested).toBe(1);
    expect(res.body.data.matched).toBe(1);
    expect(scheduleReconcile).not.toHaveBeenCalled();
  });
});

describe("POST /bulk-delete — filter-mode", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects filter requests that exceed the cap", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ n: 6000 }] });

    await bulkDelete({
      filter: { search: "big" },
      expected_count: 5000,
    }).expect(400);

    expect(getClient).not.toHaveBeenCalled();
  });

  it("resolves filter to ids and deletes them", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ n: 2 }] }) // count
      .mockResolvedValueOnce({ rows: [{ id: 11 }, { id: 22 }] }); // ids

    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: 11 }, { id: 22 }] })
      .mockResolvedValueOnce({});
    const release = vi.fn();
    getClient.mockResolvedValue({ query: clientQuery, release });

    const res = await bulkDelete({
      filter: { search: "cafe" },
      expected_count: 3,
    }).expect(200);

    expect(res.body.data.deleted).toBe(2);
    expect(res.body.data.requested).toBe(3);
    expect(res.body.data.matched).toBe(2);
    const deleteCall = clientQuery.mock.calls.find(([sql]) =>
      sql.includes("DELETE"),
    );
    expect(deleteCall[1]).toEqual([[11, 22]]);
  });

  it("reports selection drift to zero without scheduling reconciliation", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ n: 0 }] })
      .mockResolvedValueOnce({ rows: [] });
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({});
    getClient.mockResolvedValue({ query: clientQuery, release: vi.fn() });

    const res = await bulkDelete({
      filter: { search: "disappeared" },
      expected_count: 2,
    }).expect(200);

    expect(res.body.data).toEqual({ deleted: 0, requested: 2, matched: 0 });
    expect(scheduleReconcile).not.toHaveBeenCalled();
  });
});

describe("POST /bulk-delete — atomicity", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rolls back and skips refresh when DELETE fails", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({});
    const release = vi.fn();
    getClient.mockResolvedValue({ query: clientQuery, release });

    const res = await bulkDelete({ ids: [1] }).expect(500);

    expect(scheduleReconcile).not.toHaveBeenCalled();
    expect(res.body.error.code).toBe("INTERNAL_SERVER_ERROR");
    const rollback = clientQuery.mock.calls.find(([sql]) => sql === "ROLLBACK");
    expect(rollback).toBeDefined();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
