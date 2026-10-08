import { describe, it, expect, vi, beforeEach } from "vitest";

import { mockLogger } from "./helpers/mockLogger.ts";
import { mockTxConnection } from "./helpers/repoMocks.ts";
// Ambient-aware connection mock: transactional SQL lands on `mockClient` whether
// the service threads the client through explicitly or a repository issues it
// via module-level query() inside withTransaction (see repoMocks.js).
const { mockClient } = vi.hoisted(() => ({ mockClient: { query: vi.fn() } }));
vi.mock("../src/database/connection.ts", () => mockTxConnection(mockClient));
vi.mock("../src/config/logger.ts", () => ({
  logger: mockLogger(),
}));

import {
  query,
  poolQuery,
  withTransaction,
} from "../src/database/connection.ts";
import {
  createPattern,
  updatePattern,
} from "../src/services/recipientPatternService.ts";
import { mergeRecipients } from "../src/services/recipientMergeService.ts";
import {
  ValidationError,
  NotFoundError,
} from "../src/middleware/errorHandler.ts";

beforeEach(() => {
  query.mockClear();
  withTransaction.mockClear();
  poolQuery.mockReset();
  mockClient.query.mockReset();
});

describe("updatePattern — validates the row merged with stored values", () => {
  it("allows a case_sensitive-only toggle on a regex row (keeps the stored pattern)", async () => {
    poolQuery
      .mockResolvedValueOnce({
        rows: [
          {
            pattern: "FOO[0-9]+",
            pattern_kind: "regex",
            case_sensitive: false,
          },
        ],
      })
      .mockResolvedValue({ rows: [] });
    await expect(
      updatePattern(1, { case_sensitive: true }),
    ).resolves.toBeUndefined();
    expect(query.mock.calls.length).toBe(2); // SELECT existing + UPDATE
  });

  it("runs the ReDoS guard on a pattern-only edit of a regex row", async () => {
    poolQuery.mockResolvedValueOnce({
      rows: [
        { pattern: "FOO[0-9]+", pattern_kind: "regex", case_sensitive: false },
      ],
    });
    await expect(
      updatePattern(1, { pattern: "(a+)+$" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("throws NotFoundError when the pattern row is missing", async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] });
    await expect(
      updatePattern(999, { case_sensitive: true }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("mergeRecipients — flattens nested alias chains", () => {
  it("locks the entire participant set in order before any repoint", async () => {
    mockClient.query.mockImplementation(async (sql) => {
      if (sql.includes("FOR UPDATE"))
        return { rows: [{ id: 4, primary_recipient_id: null }] };
      if (sql.includes("information_schema")) return { rows: [] };
      return { rows: [], rowCount: 0 };
    });
    await mergeRecipients(4, [9, 2, 9]);
    const lock = mockClient.query.mock.calls.find(([sql]) =>
      sql.includes("FOR UPDATE"),
    );
    expect(lock[0]).toContain("primary_recipient_id");
    expect(lock[0]).toContain("ORDER BY id FOR UPDATE");
    expect(lock[1]).toEqual([[2, 4, 9]]);
    const lockIndex = mockClient.query.mock.calls.indexOf(lock);
    const writeIndex = mockClient.query.mock.calls.findIndex(([sql]) =>
      sql.includes("UPDATE transactions"),
    );
    expect(lockIndex).toBeLessThan(writeIndex);
  });

  it("rejects a target that became an alias while waiting, before any write", async () => {
    mockClient.query.mockImplementation(async (sql) => {
      if (sql.includes("FOR UPDATE"))
        return { rows: [{ id: 2, primary_recipient_id: 1 }] };
      return { rows: [] };
    });
    await expect(mergeRecipients(2, [3])).rejects.toMatchObject({
      status: 409,
    });
    expect(
      mockClient.query.mock.calls.some(([sql]) =>
        /^\s*(UPDATE|DELETE)\b/.test(sql),
      ),
    ).toBe(false);
    expect(withTransaction).toHaveBeenCalledTimes(1);
  });

  it("reports a primary removed before the lock as not found without writes", async () => {
    mockClient.query.mockResolvedValue({ rows: [] });
    await expect(mergeRecipients(2, [3])).rejects.toBeInstanceOf(NotFoundError);
    expect(
      mockClient.query.mock.calls.some(([sql]) =>
        /^\s*(UPDATE|DELETE)\b/.test(sql),
      ),
    ).toBe(false);
  });

  it("re-points grandchildren aliases onto the new primary", async () => {
    const sqls = [];
    mockClient.query.mockImplementation(async (sql) => {
      sqls.push(sql);
      if (sql.includes("FOR UPDATE")) return { rows: [{ id: 1 }] };
      if (sql.includes("information_schema")) return { rows: [] };
      if (sql.includes("RETURNING id")) return { rows: [{ id: 3 }] };
      return { rows: [], rowCount: 0 };
    });

    await mergeRecipients(1, [3]);

    // The grandchildren re-point updates rows WHERE primary_recipient_id = ANY(...)
    // (distinct from the alias flag update which keys on id = ANY(...)).
    const grandchild = sqls.find(
      (s) =>
        /SET\s+primary_recipient_id = \$1/.test(s) &&
        /WHERE primary_recipient_id = ANY\(\$2::int\[\]\)/.test(s),
    );
    expect(grandchild).toBeTruthy();
  });

  it("filters invalid direct-call ids and the primary id without coercing strings", async () => {
    const paramsBySql = [];
    mockClient.query.mockImplementation(async (sql, params) => {
      paramsBySql.push([sql, params]);
      if (sql.includes("FOR UPDATE")) return { rows: [{ id: 1 }] };
      if (sql.includes("information_schema")) return { rows: [] };
      if (sql.includes("RETURNING id")) return { rows: [{ id: 3 }] };
      return { rows: [], rowCount: 0 };
    });

    await mergeRecipients(
      1,
      /** @type {any} */ ([3, 3, 1, 0, -1, 1.5, "3", null]),
    );

    const transactionUpdate = paramsBySql.find(([sql]) =>
      sql.includes("UPDATE transactions"),
    );
    expect(transactionUpdate[1]).toEqual([1, [3, 3]]);
  });
});

describe("createPattern — validates the kind it stores", () => {
  it("accepts a regex-invalid literal when pattern_kind is omitted", async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ id: 7 }] });

    await expect(
      createPattern({ recipientId: 3, pattern: "ACME (BE" }),
    ).resolves.toEqual({ id: 7 });
    expect(poolQuery.mock.calls[0][1][2]).toBe("literal_prefix");
  });

  it("still rejects an invalid explicit regex", async () => {
    await expect(
      createPattern({
        recipientId: 3,
        pattern: "ACME (BE",
        pattern_kind: "regex",
      }),
    ).rejects.toThrow(ValidationError);
    expect(poolQuery).not.toHaveBeenCalled();
  });
});
