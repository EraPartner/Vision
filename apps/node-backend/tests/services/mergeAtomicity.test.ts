/**
 * Transaction atomicity for the repo-composed write services (ADR-006/ADR-067).
 *
 * These services no longer thread a client through their statements — they call
 * repository methods, which issue module-level query() and rely on the ambient
 * transaction context to land on the open transaction's connection. That is
 * exactly the property worth pinning: if any repo call silently ran on the pool
 * instead, it would survive the ROLLBACK and leave a half-repointed ledger
 * (an account merge that moved transactions but never deleted the source, a
 * recipient merge that moved money rows but never flagged the alias).
 *
 * So these tests drive the REAL connection module over a mocked pg pool — real
 * BEGIN/COMMIT/ROLLBACK, real AsyncLocalStorage routing — force a late failure
 * inside the transaction, and assert the whole statement sequence ran on ONE
 * connection between BEGIN and ROLLBACK, with the pool never touched.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { accountRow } from "../helpers/pgRows.ts";
import {
  asAccountId,
  asRecipientId,
  asTransactionId,
} from "@vision/types/brands";
import { must } from "../helpers/must.ts";

/**
 * Load the real connection module against a mocked pg pool, so `withTransaction`
 * performs its genuine ceremony and module-level query() genuinely reroutes.
 */
async function loadRealTransactionStack() {
  vi.resetModules();

  const client = {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: vi.fn(),
  };
  const pool = {
    on: vi.fn(),
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: vi.fn().mockResolvedValue(client),
    end: vi.fn(),
  };

  // Must be a real function: connection.js calls `new pg.Pool(...)`.
  const poolCtor = vi.fn().mockImplementation(function MockPool() {
    return pool;
  });
  vi.doMock("pg", () => ({ default: { Pool: poolCtor } }));
  vi.doMock("../../src/config/config.ts", () => ({
    default: {
      database: {
        url: "postgresql://test",
        poolSize: 5,
        maxOverflow: 10,
        echo: false,
      },
    },
  }));
  vi.doMock("../../src/config/logger.ts", () => ({
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  }));

  return { client, pool };
}

/** BEGIN … ROLLBACK bracket + nothing on the pool: the rollback covered it all. */
function expectRolledBackOnOneConnection(
  client: { query: Mock; release: Mock },
  pool: { query: Mock },
): string[] {
  const sqls: string[] = client.query.mock.calls.map(([sql]) => sql);
  expect(sqls[0]).toBe("BEGIN");
  expect(sqls.at(-1)).toBe("ROLLBACK");
  expect(sqls).not.toContain("COMMIT");
  // Nothing escaped to a pooled connection, which a ROLLBACK could not undo.
  expect(pool.query).not.toHaveBeenCalled();
  expect(client.release).toHaveBeenCalled();
  return sqls;
}

/**
 * A manual transfer-leg mark: `SET is_transfer, transfer_peer_id,
 * transfer_source` with 'manual' bound as the source; the leg id follows.
 */
function isManualMark(sql: string, params?: unknown[]): boolean {
  return (
    norm(sql).startsWith("update transactions set is_transfer") &&
    params?.[2] === "manual"
  );
}

/** SQL text without identifier quotes, case or layout differences. */
function norm(sql: string): string {
  return sql.replaceAll('"', "").toLowerCase().replace(/\s+/g, " ").trim();
}

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe("account merge atomicity (ADR-088)", () => {
  it("keeps hard-delete funding-edge cascades behind the graph lock", async () => {
    const { client, pool } = await loadRealTransactionStack();
    client.query.mockImplementation(async (sql) => {
      if (sql === "BEGIN" || sql === "ROLLBACK" || sql === "COMMIT") {
        return { rows: [] };
      }
      if (norm(sql).startsWith("delete from accounts")) {
        return { rows: [{ id: 7 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    const { accountService } =
      await import("../../src/services/accountService.ts");
    await expect(accountService.remove(asAccountId(7))).resolves.toBe(7);

    const sqls = client.query.mock.calls.map(([sql]) => norm(sql));
    expect(sqls[0]).toBe("begin");
    expect(sqls[1]).toContain("pg_advisory_xact_lock");
    expect(sqls[2]).toBe("delete from accounts where id = $1 returning id");
    expect(sqls.at(-1)).toBe("commit");
    expect(pool.query).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalled();
  });

  it("keeps a funding PATCH lock and write inside one real transaction stack", async () => {
    const { client, pool } = await loadRealTransactionStack();
    client.query.mockImplementation(async (sql) => {
      if (sql === "BEGIN" || sql === "ROLLBACK" || sql === "COMMIT") {
        return { rows: [] };
      }
      if (norm(sql).includes("from accounts where id = $1")) {
        return { rows: [accountRow({ id: asAccountId(2), funding_account_id: null })] };
      }
      if (norm(sql).startsWith("update accounts set")) {
        throw new Error("late account update failure");
      }
      return { rows: [], rowCount: 1 };
    });

    const { accountService } =
      await import("../../src/services/accountService.ts");
    await expect(
      accountService.update(asAccountId(1), { funding_account_id: 2 }),
    ).rejects.toThrow("late account update failure");

    const sqls = expectRolledBackOnOneConnection(client, pool).map(norm);
    const graphLock = sqls.findIndex((sql) =>
      sql.includes("pg_advisory_xact_lock"),
    );
    const validationRead = sqls.findIndex((sql) =>
      sql.includes("from accounts where id = $1"),
    );
    const update = sqls.findIndex((sql) =>
      sql.startsWith("update accounts set"),
    );
    expect(graphLock).toBe(1);
    expect(validationRead).toBeGreaterThan(graphLock);
    expect(update).toBeGreaterThan(validationRead);
  });

  it("rolls back every repoint on one connection when the source DELETE fails", async () => {
    const { client, pool } = await loadRealTransactionStack();
    client.query.mockImplementation(async (raw) => {
      if (raw === "BEGIN" || raw === "ROLLBACK" || raw === "COMMIT")
        return { rows: [] };
      const sql = norm(raw);
      if (sql.includes("for update") && sql.includes("where id = $1")) {
        return { rows: [{ id: 2, name: "TARGET" }] };
      }
      if (sql.includes("for update") && sql.includes("any"))
        return { rows: [{ id: 1 }] };
      if (sql.includes("group by account_id")) return { rows: [] };
      // The realistic late failure: account_id FKs are ON DELETE RESTRICT, so a
      // missed reference makes the final DELETE raise after every repoint ran.
      if (sql.includes("delete from accounts"))
        throw new Error("23503 foreign key violation");
      return { rows: [], rowCount: 1 };
    });

    const { mergeAccounts } =
      await import("../../src/services/accountMergeService.ts");
    await expect(mergeAccounts(asAccountId(2), [asAccountId(1)])).rejects.toThrow(
      "23503 foreign key violation",
    );

    const sqls = expectRolledBackOnOneConnection(client, pool).map(norm);
    // All repoints were issued by repositories, inside this transaction —
    // so the ROLLBACK above undoes every one of them.
    expect(
      sqls.some((s) => s.includes("update transactions set account_id")),
    ).toBe(true);
    expect(
      sqls.some((s) =>
        s.includes("update planned_transactions set account_id"),
      ),
    ).toBe(true);
    expect(
      sqls.some((s) =>
        s.includes("update portfolio_transactions set account_id"),
      ),
    ).toBe(true);
    expect(
      sqls.some((s) => s.includes("update accounts set funding_account_id")),
    ).toBe(true);
    // The graph-wide protocol lock, pending-import lock, and survivor row lock
    // were taken on the same connection, in that order, before any repoint.
    expect(sqls[1]).toContain("pg_advisory_xact_lock");
    expect(sqls[2]).toContain("portfolio_import_batches");
    expect(
      sqls.indexOf("select id, name from accounts where id = $1 for update"),
    ).toBe(3);
  });
});

describe("recipient merge atomicity (ADR-014)", () => {
  it("rolls back the FK reassignments when the grandchild re-point fails", async () => {
    const { client, pool } = await loadRealTransactionStack();
    client.query.mockImplementation(async (sql) => {
      if (sql === "BEGIN" || sql === "ROLLBACK" || sql === "COMMIT")
        return { rows: [] };
      if (norm(sql).includes("for update"))
        return { rows: [{ id: 1, primary_recipient_id: null }] };
      if (norm(sql).includes("information_schema")) return { rows: [] };
      // Last statement of the merge — fails after every FK has been reassigned.
      if (norm(sql).includes("where primary_recipient_id = any")) {
        throw new Error("deadlock detected");
      }
      if (norm(sql).includes("returning id"))
        return { rows: [{ id: 3 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });

    const { mergeRecipients } =
      await import("../../src/services/recipientMergeService.ts");
    await expect(mergeRecipients(asRecipientId(1), [asRecipientId(3)])).rejects.toThrow("deadlock detected");

    const sqls = expectRolledBackOnOneConnection(client, pool);
    // Every money-bearing reassignment ran inside the rolled-back transaction.
    expect(
      sqls.some(
        (s) =>
          norm(s).includes("update transactions") &&
          norm(s).includes("recipient_id = $1"),
      ),
    ).toBe(true);
    expect(sqls.some((s) => norm(s).includes("update transaction_splits"))).toBe(
      true,
    );
    expect(
      sqls.some((s) => norm(s).includes("delete from recipient_bank_accounts")),
    ).toBe(true);
    expect(sqls.some((s) => norm(s).includes("update recipient_bank_accounts"))).toBe(
      true,
    );
    expect(sqls.some((s) => norm(s).includes("returning id"))).toBe(true);
  });
});

describe("transfer mark atomicity (ADR-083)", () => {
  it("rolls back the released peers and the first leg when the second leg fails", async () => {
    const { client, pool } = await loadRealTransactionStack();
    client.query.mockImplementation(async (sql, params) => {
      if (sql === "BEGIN" || sql === "ROLLBACK" || sql === "COMMIT")
        return { rows: [] };
      if (
        norm(sql).startsWith(
          "select id, amount, account_id, is_active, transfer_source, transfer_peer_id",
        )
      ) {
        return {
          rows: [
            {
              id: 10,
              amount: "-100.0000",
              account_id: 1,
              is_active: true,
              transfer_source: "auto",
              transfer_peer_id: 30,
            },
            {
              id: 20,
              amount: "100.0000",
              account_id: 2,
              is_active: true,
              transfer_source: null,
              transfer_peer_id: null,
            },
            {
              id: 30,
              amount: "100.0000",
              account_id: 3,
              is_active: true,
              transfer_source: "auto",
              transfer_peer_id: 10,
            },
          ],
        };
      }
      // The SECOND manual leg fails, after the peer release and the first leg.
      if (isManualMark(sql, params) && params?.[3] === 20) {
        throw new Error("serialization failure");
      }
      return { rows: [], rowCount: 1 };
    });

    const { markTransfer } =
      await import("../../src/services/transferReconciliationService.ts");
    await expect(markTransfer(asTransactionId(10), asTransactionId(20))).rejects.toThrow("serialization failure");

    const sqls = expectRolledBackOnOneConnection(client, pool);
    // The peer release and the first leg are undone together — without one
    // transaction, leg 10 would stay marked against an unmarked peer, and the
    // prior counterparts released above would never come back.
    const isPeerRelease = (sql: string) =>
      /transfer_peer_id = any\(\$\d+\).*id <> all\(\$\d+\)/.test(norm(sql));
    expect(sqls.some(isPeerRelease)).toBe(true);
    const peerRelease = client.query.mock.calls.find(
      ([sql]) => typeof sql === "string" && isPeerRelease(sql),
    );
    // The legs being re-paired, and the locked graph the release may touch.
    expect(peerRelease?.[1]).toContainEqual([10, 20]);
    expect(peerRelease?.[1].at(-1)).toEqual([10, 20, 30]);
    const manualMarks = client.query.mock.calls.filter(
      ([sql, params]) => typeof sql === "string" && isManualMark(sql, params),
    );
    expect(manualMarks).toHaveLength(2); // first succeeded, second threw
    // Leg 10 marked against peer 20.
    expect(must(manualMarks[0], "manualMarks[0]")[1][3]).toBe(10);
    expect(must(manualMarks[0], "manualMarks[0]")[1][1]).toBe(20);
  });
});
