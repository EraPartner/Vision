import { describe, it, expect, vi, beforeEach } from "vitest";

import { mockLogger } from "./helpers/mockLogger.ts";
import { mockTxConnection } from "./helpers/repoMocks.ts";
import type { TxConnectionMock } from "./helpers/repoMocks.ts";
import {
  asRecipientId,
} from "@vision/types/brands";
// Ambient-aware connection mock: transactional SQL lands on `mockClient` whether
// the service threads the client through explicitly or a repository issues it
// via module-level query() inside withTransaction (see repoMocks.js).
const { mockClient } = vi.hoisted(() => ({
  mockClient: {
    query: vi.fn<(sql: string, params?: unknown[]) => Promise<unknown>>(),
  },
}));
vi.mock("../src/database/connection.ts", () => mockTxConnection(mockClient));
vi.mock("../src/config/logger.ts", () => ({
  logger: mockLogger(),
}));

import * as connection from "../src/database/connection.ts";
import {
  createPattern,
  updatePattern,
} from "../src/services/recipientPatternService.ts";
import { mergeRecipients } from "../src/services/recipientMergeService.ts";
import {
  ValidationError,
  NotFoundError,
} from "../src/middleware/errorHandler.ts";
import { must } from "./helpers/must.ts";

// The connection module is replaced by mockTxConnection above; `poolQuery` is
// the pool-side sink it adds.
const { query, poolQuery, withTransaction } = connection as unknown as Omit<
  TxConnectionMock<typeof mockClient, object>,
  "query" | "poolQuery"
> & { query: typeof mockClient.query; poolQuery: typeof mockClient.query };

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
    mockClient.query.mockImplementation((sql) => {
      if (/for update/i.test(sql))
        return Promise.resolve({ rows: [{ id: 4, primary_recipient_id: null }] });
      if (sql.includes("information_schema")) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    await mergeRecipients(asRecipientId(4), [asRecipientId(9), asRecipientId(2), asRecipientId(9)]);
    const lock = mockClient.query.mock.calls.find(([sql]) =>
      /for update/i.test(sql),
    );
    expect(must(lock, "lock")[0]).toContain("primary_recipient_id");
    expect(must(lock, "lock")[0]).toMatch(/order by "?id"? for update/i);
    expect(must(lock, "lock")[1]).toEqual([[2, 4, 9]]);
    const lockIndex = mockClient.query.mock.calls.indexOf(must(lock, "lock"));
    const writeIndex = mockClient.query.mock.calls.findIndex(([sql]) =>
      /update "?transactions"? set/i.test(sql),
    );
    expect(lockIndex).toBeLessThan(writeIndex);
  });

  it("rejects a target that became an alias while waiting, before any write", async () => {
    mockClient.query.mockImplementation((sql) => {
      if (/for update/i.test(sql))
        return Promise.resolve({ rows: [{ id: 2, primary_recipient_id: 1 }] });
      return Promise.resolve({ rows: [] });
    });
    await expect(mergeRecipients(asRecipientId(2), [asRecipientId(3)])).rejects.toMatchObject({
      status: 409,
    });
    expect(
      mockClient.query.mock.calls.some(([sql]) =>
        /^\s*(UPDATE|DELETE)\b/i.test(sql),
      ),
    ).toBe(false);
    expect(withTransaction).toHaveBeenCalledTimes(1);
  });

  it("reports a primary removed before the lock as not found without writes", async () => {
    mockClient.query.mockResolvedValue({ rows: [] });
    await expect(mergeRecipients(asRecipientId(2), [asRecipientId(3)])).rejects.toBeInstanceOf(NotFoundError);
    expect(
      mockClient.query.mock.calls.some(([sql]) =>
        /^\s*(UPDATE|DELETE)\b/i.test(sql),
      ),
    ).toBe(false);
  });

  it("re-points grandchildren aliases onto the new primary", async () => {
    const sqls: string[] = [];
    mockClient.query.mockImplementation((sql) => {
      sqls.push(sql);
      if (/for update/i.test(sql))
        return Promise.resolve({ rows: [{ id: 1, primary_recipient_id: null }] });
      if (sql.includes("information_schema")) return Promise.resolve({ rows: [] });
      if (/returning "?id"?/i.test(sql)) return Promise.resolve({ rows: [{ id: 3 }] });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    await mergeRecipients(asRecipientId(1), [asRecipientId(3)]);

    // The grandchildren re-point updates rows WHERE primary_recipient_id = ANY(...)
    // (distinct from the alias flag update which keys on id = ANY(...)).
    const grandchild = sqls.find(
      (s) =>
        /set\s+"?primary_recipient_id"? = \$\d+/i.test(s) &&
        /where "?primary_recipient_id"? = ANY\(\$\d+::int\[\]\)/i.test(s),
    );
    expect(grandchild).toBeTruthy();
  });

  it("filters invalid direct-call ids and the primary id without coercing strings", async () => {
    const paramsBySql: [string, unknown][] = [];
    mockClient.query.mockImplementation((sql, params) => {
      paramsBySql.push([sql, params]);
      if (/for update/i.test(sql))
        return Promise.resolve({ rows: [{ id: 1, primary_recipient_id: null }] });
      if (sql.includes("information_schema")) return Promise.resolve({ rows: [] });
      if (/returning "?id"?/i.test(sql)) return Promise.resolve({ rows: [{ id: 3 }] });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    await mergeRecipients(
      asRecipientId(1),
      // @ts-expect-error -- deliberately invalid ids: the service must filter them
      [3, 3, 1, 0, -1, 1.5, "3", null],
    );

    const transactionUpdate = paramsBySql.find(([sql]) =>
      /update "?transactions"? set/i.test(sql),
    );
    expect(must(transactionUpdate, "transactionUpdate")[1]).toEqual([1, [3, 3]]);
  });
});

describe("createPattern — validates the kind it stores", () => {
  it("accepts a regex-invalid literal when pattern_kind is omitted", async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ id: 7 }] });

    await expect(
      createPattern({ recipientId: 3, pattern: "ACME (BE" }),
    ).resolves.toEqual({ id: 7 });
    expect(
      must(
        must(poolQuery.mock.calls[0], "poolQuery.mock.calls[0]")[1],
        "poolQuery params",
      )[2],
    ).toBe("literal_prefix");
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
