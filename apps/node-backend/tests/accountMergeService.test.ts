import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { mockTxConnection } from "./helpers/repoMocks.ts";
import { accountRow } from "./helpers/pgRows.ts";
import {
  asAccountId,
  asCurrencyCode,
  type CurrencyCode,
} from "@vision/types/brands";
import { loose } from "./helpers/partial.ts";

const { mockClient } = vi.hoisted(() => ({ mockClient: { query: vi.fn() } }));

vi.mock("../src/database/connection.ts", () => mockTxConnection(mockClient));
// Real conversion arithmetic, fixed latest stored rates: 1 USD = 0.5 EUR (the
// canonical fixture from the cross-currency finding).
vi.mock(
  "../src/services/currency/currencyConversionService.ts",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    listLatestStoredRates: vi.fn(async () => ({
      rows: [
        {
          currency_code: "USD",
          rate_to_eur: "0.5",
          rate_date: "2026-06-01",
          fetched_at: "2026-06-01T10:00:00Z",
        },
      ],
    })),
  }),
);

import * as connection from "../src/database/connection.ts";
import type { PgQueryResult } from "../src/database/connection.ts";
import {
  __collidingAnchorCurrencies as collidingAnchorCurrencies,
  mergeAccounts,
  previewMerge,
  __stampRangesOverlap as stampRangesOverlap,
} from "../src/services/accountMergeService.ts";
import {
  ValidationError,
  NotFoundError,
} from "../src/middleware/errorHandler.ts";
import { must } from "./helpers/must.ts";

type SqlSpy = Mock<
  (
    sql: string,
    params?: readonly unknown[],
  ) => Promise<Partial<PgQueryResult<unknown>>>
>;
// mockTxConnection adds the `poolQuery` sink, which the real module lacks.
const { query, poolQuery } = connection as unknown as {
  query: SqlSpy;
  poolQuery: SqlSpy;
};

/** SQL text without identifier quotes, case or layout differences. */
function norm(sql: string): string {
  return sql.replaceAll('"', "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** The opening-anchor read, whether 'opening' is a literal or a parameter. */
function isOpeningAnchorRead(sql: string, params: readonly unknown[] = []) {
  const text = norm(sql);
  return (
    text.includes("transfer_source = 'opening'") ||
    (/transfer_source = \$\d/.test(text) && params.includes("opening"))
  );
}

interface StampRange {
  account_id: number;
  min_date: string;
  max_date: string;
}
interface OpeningAnchor {
  account_id: number;
  currency: string;
}

// Default happy-path SQL router: target #2 ('TARGET'), source #1 exists.
// `stampRanges` primes the per-original-account stamped-date ranges the
// overlapping-stamp guard reads before the repoint (default: nothing stamped).
function happyPath({
  stampRanges = [],
  openingAnchors = [],
  fundingAccounts = {},
}: {
  stampRanges?: StampRange[];
  openingAnchors?: OpeningAnchor[];
  fundingAccounts?: Record<
    number,
    { id: number; funding_account_id: number | null }
  >;
} = {}) {
  mockClient.query.mockImplementation(async (sql, params = []) => {
    if (isOpeningAnchorRead(sql, params))
      return { rows: openingAnchors };
    if (norm(sql).includes("for update") && norm(sql).includes("where id = $1"))
      return { rows: [{ id: 2, name: "TARGET" }] };
    if (norm(sql).includes("for update") && norm(sql).includes("any"))
      return { rows: [{ id: 1 }] };
    if (norm(sql).includes("from accounts where id = $1"))
      return {
        rows: fundingAccounts[params[0]] ? [fundingAccounts[params[0]]] : [],
      };
    if (norm(sql).includes("group by account_id")) return { rows: stampRanges };
    if (norm(sql).includes("update transactions")) return { rowCount: 3 };
    if (norm(sql).includes("update planned_transactions")) return { rowCount: 1 };
    if (norm(sql).includes("update portfolio_transactions")) return { rowCount: 2 };
    if (norm(sql).includes("update portfolio_import_batches")) return { rowCount: 1 };
    if (norm(sql).includes("update accounts set funding_account_id"))
      return { rowCount: 0 };
    if (norm(sql).includes("delete from accounts")) return { rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
}

const clearAnchorCall = () =>
  mockClient.query.mock.calls.find(([sql]) =>
    norm(sql).includes("delete from account_statement_balances"),
  );

beforeEach(() => {
  vi.clearAllMocks();
  poolQuery.mockReset();
  mockClient.query.mockReset();
});

describe("mergeAccounts (ADR-088)", () => {
  it("rejects an empty source set or any self-reference before opening a transaction", async () => {
    await expect(mergeAccounts(asAccountId(2), [])).rejects.toThrow(ValidationError);
    await expect(mergeAccounts(asAccountId(2), [asAccountId(2)])).rejects.toThrow(ValidationError);
    await expect(mergeAccounts(asAccountId(2), [asAccountId(1), asAccountId(2)])).rejects.toThrow(
      /must not include the survivor/,
    );
    expect(mockClient.query).not.toHaveBeenCalled();
  });

  it("rejects more than 500 sources before opening a transaction", async () => {
    await expect(
      mergeAccounts(
        asAccountId(2),
        Array.from({ length: 501 }, (_, index) => asAccountId(index + 3)),
      ),
    ).rejects.toThrow(/at most 500/);
    expect(mockClient.query).not.toHaveBeenCalled();
  });

  it("throws NotFound when the survivor is missing", async () => {
    mockClient.query.mockImplementation(async (sql) =>
      norm(sql).includes("where id = $1") ? { rows: [] } : { rows: [], rowCount: 0 },
    );
    await expect(mergeAccounts(asAccountId(2), [asAccountId(1)])).rejects.toThrow(NotFoundError);
  });

  it("throws NotFound when a source is missing", async () => {
    mockClient.query.mockImplementation(async (sql) => {
      if (norm(sql).includes("where id = $1"))
        return { rows: [{ id: 2, name: "TARGET" }] };
      if (norm(sql).includes("any")) return { rows: [] }; // no sources found
      return { rows: [], rowCount: 0 };
    });
    await expect(mergeAccounts(asAccountId(2), [asAccountId(1)])).rejects.toThrow(NotFoundError);
  });

  it("repoints every reference to the survivor, deletes the source, returns counts", async () => {
    happyPath();
    const result = await mergeAccounts(asAccountId(2), [asAccountId(1)]);

    expect(result).toEqual({
      into: 2,
      merged: [1],
      reassigned: { transactions: 3, planned: 1, portfolio: 2, funding: 0 },
      stampsInterleaved: false,
    });

    const calls = mockClient.query.mock.calls.map(([sql]) => sql);
    const batchLockIndex = calls.findIndex(
      (s) =>
        norm(s).includes("from portfolio_import_batches") && norm(s).includes("for update"),
    );
    const accountLockIndex = calls.findIndex(
      (s) => norm(s).includes("from accounts") && norm(s).includes("for update"),
    );
    expect(batchLockIndex).toBeGreaterThan(-1);
    expect(batchLockIndex).toBeLessThan(accountLockIndex);
    expect(
      calls.some(
        (s) => norm(s).includes("update transactions") && !norm(s).includes("bank_account"),
      ),
    ).toBe(true);
    expect(
      calls.some(
        (s) =>
          norm(s).includes("update planned_transactions") &&
          !norm(s).includes("bank_account"),
      ),
    ).toBe(true);
    expect(calls.some((s) => norm(s).includes("update portfolio_transactions"))).toBe(
      true,
    );
    const batchRepointIndex = calls.findIndex((s) =>
      norm(s).includes("update portfolio_import_batches"),
    );
    const deleteSourcesIndex = calls.findIndex((s) =>
      norm(s).includes("delete from accounts"),
    );
    expect(batchRepointIndex).toBeGreaterThan(-1);
    expect(batchRepointIndex).toBeLessThan(deleteSourcesIndex);
    const batchCall = must(mockClient.query.mock.calls[batchRepointIndex], "mockClient.query.mock.calls[batchRepointIndex]");
    expect(batchCall[1]).toEqual([2, [1]]);
    expect(
      calls.some((s) => norm(s).includes("update accounts set funding_account_id")),
    ).toBe(true);
    expect(calls.some((s) => norm(s).includes("delete from accounts"))).toBe(true);

    // transactions repoint carries the survivor's name (so the dual-write trigger keeps it merged)
    const txCall = mockClient.query.mock.calls.find(([sql]) =>
      norm(sql).includes("update transactions"),
    );
    expect(must(txCall, "txCall")[1]).toEqual([2, [1]]);
  });

  it("rejects a merge that would turn the survivor's source reference into a self-cycle", async () => {
    happyPath({
      fundingAccounts: {
        2: accountRow({ id: asAccountId(2), funding_account_id: asAccountId(1) }),
      },
    });

    await expect(mergeAccounts(asAccountId(2), [asAccountId(1)])).rejects.toThrow(
      /would create a funding-account cycle/,
    );

    const writes = mockClient.query.mock.calls
      .map(([sql]) => sql)
      .filter((sql) => /^\s*(UPDATE|DELETE|INSERT)\b/i.test(sql));
    expect(writes).toEqual([]);
  });

  it("rejects a longer cycle introduced by the projected funding repoint", async () => {
    happyPath({
      fundingAccounts: {
        2: accountRow({ id: asAccountId(2), funding_account_id: asAccountId(3) }),
        3: accountRow({ id: asAccountId(3), funding_account_id: asAccountId(1) }),
      },
    });

    await expect(mergeAccounts(asAccountId(2), [asAccountId(1)])).rejects.toThrow(
      /would create a funding-account cycle/,
    );

    const calls = mockClient.query.mock.calls.map(([sql]) => sql);
    const graphLockIndex = calls.findIndex((sql) =>
      norm(sql).includes("pg_advisory_xact_lock"),
    );
    const firstGraphReadIndex = calls.findIndex((sql) =>
      norm(sql).includes("from accounts where id = $1"),
    );
    expect(graphLockIndex).toBeGreaterThanOrEqual(0);
    expect(graphLockIndex).toBeLessThan(firstGraphReadIndex);
  });

  it("does not make an unrelated pre-existing funding cycle a merge blocker", async () => {
    happyPath({
      fundingAccounts: {
        2: accountRow({ id: asAccountId(2), funding_account_id: asAccountId(3) }),
        3: accountRow({ id: asAccountId(3), funding_account_id: asAccountId(4) }),
        4: accountRow({ id: asAccountId(4), funding_account_id: asAccountId(3) }),
      },
    });

    await expect(mergeAccounts(asAccountId(2), [asAccountId(1)])).resolves.toMatchObject({ into: 2 });
  });

  it("filters invalid direct-call ids and duplicates without coercing strings", async () => {
    happyPath();
    // @ts-expect-error -- direct callers may pass non-integer ids; the service filters them
    await mergeAccounts(2, [1, 1, 0, -1, 1.5, "1", null]);

    const txCall = mockClient.query.mock.calls.find(([sql]) =>
      norm(sql).includes("update transactions"),
    );
    expect(must(txCall, "txCall")[1]).toEqual([2, [1]]);
  });

  // §1 F2 regression: two concurrently-imported accounts (survivor KBC stamped
  // Jan–Jul 1, source Belfius stamped Mar–Jul 5) have INTERLEAVED stamp
  // histories. Post-merge the anchor would silently become Belfius's latest
  // stamp — dropping KBC's balance — so the merge must flag it and clear the
  // survivor's now-invalidated statement anchor.
  it("interleaved-stamp fixture: flags stampsInterleaved and clears the survivor statement anchor", async () => {
    happyPath({
      stampRanges: [
        { account_id: 2, min_date: "2026-01-01", max_date: "2026-07-01" }, // survivor (KBC)
        { account_id: 1, min_date: "2026-03-01", max_date: "2026-07-05" }, // source (Belfius)
      ],
    });
    const result = await mergeAccounts(asAccountId(2), [asAccountId(1)]);

    expect(result.stampsInterleaved).toBe(true);
    const clear = clearAnchorCall();
    expect(clear).toBeDefined();
    expect(norm(must(clear, "clear")[0])).toContain("where account_id = $1");
    expect(must(clear, "clear")[1]).toEqual([2]); // clears the SURVIVOR's anchor only

    // Historical per-row stamps are never rewritten — no UPDATE touches
    // transactions.balance.
    const balanceRewrites = mockClient.query.mock.calls.filter(
      ([sql]) => norm(sql).includes("update transactions") && norm(sql).includes("balance"),
    );
    expect(balanceRewrites).toEqual([]);
  });

  it("sequential (non-overlapping) stamp histories do NOT flag or clear the anchor", async () => {
    happyPath({
      stampRanges: [
        { account_id: 2, min_date: "2024-01-01", max_date: "2025-01-31" }, // old account, closed
        { account_id: 1, min_date: "2025-02-01", max_date: "2026-07-01" }, // successor
      ],
    });
    const result = await mergeAccounts(asAccountId(2), [asAccountId(1)]);
    expect(result.stampsInterleaved).toBe(false);
    expect(clearAnchorCall()).toBeUndefined();
  });

  it("a single stamped account (only the source ever stamped) does not flag", async () => {
    happyPath({
      stampRanges: [
        { account_id: 1, min_date: "2026-01-01", max_date: "2026-07-01" },
      ],
    });
    const result = await mergeAccounts(asAccountId(2), [asAccountId(1)]);
    expect(result.stampsInterleaved).toBe(false);
    expect(clearAnchorCall()).toBeUndefined();
  });

  it("reads the stamp ranges BEFORE the repoint (provenance would otherwise be erased)", async () => {
    happyPath({
      stampRanges: [
        { account_id: 2, min_date: "2026-01-01", max_date: "2026-07-01" },
        { account_id: 1, min_date: "2026-03-01", max_date: "2026-07-05" },
      ],
    });
    await mergeAccounts(asAccountId(2), [asAccountId(1)]);
    const calls = mockClient.query.mock.calls.map(([sql]) => sql);
    const rangeIdx = calls.findIndex((s) => norm(s).includes("group by account_id"));
    const repointIdx = calls.findIndex((s) =>
      norm(s).includes("update transactions"),
    );
    expect(rangeIdx).toBeGreaterThanOrEqual(0);
    expect(rangeIdx).toBeLessThan(repointIdx);
  });

  // Opening anchors are unique per (account, currency) (migration 0077), so the
  // repoint would violate that index and abort the transaction with a 23505 —
  // which nothing maps to a status. Refuse first, with the currency named.
  it("refuses a merge when both accounts hold an opening balance in one currency", async () => {
    happyPath({
      openingAnchors: [
        { account_id: 2, currency: "EUR" }, // survivor
        { account_id: 1, currency: "EUR" }, // source
      ],
    });

    await expect(mergeAccounts(asAccountId(2), [asAccountId(1)])).rejects.toThrow(ValidationError);
    await expect(mergeAccounts(asAccountId(2), [asAccountId(1)])).rejects.toThrow(
      /opening balance in EUR/,
    );

    // Refused BEFORE any write: nothing was repointed or deleted. (Anchored to
    // the start of the statement so the `FOR UPDATE` lock SELECTs don't match.)
    const writes = mockClient.query.mock.calls
      .map(([sql]) => sql)
      .filter((s) => /^\s*(UPDATE|DELETE|INSERT)\b/i.test(s));
    expect(writes).toEqual([]);
  });

  it("allows the merge when the anchors are in different currencies", async () => {
    happyPath({
      openingAnchors: [
        { account_id: 2, currency: "EUR" },
        { account_id: 1, currency: "USD" },
      ],
    });
    const result = await mergeAccounts(asAccountId(2), [asAccountId(1)]);
    expect(result.into).toBe(2);
  });

  it("reads the opening anchors BEFORE the repoint (which is what would collide)", async () => {
    happyPath({ openingAnchors: [{ account_id: 1, currency: "EUR" }] });
    await mergeAccounts(asAccountId(2), [asAccountId(1)]);
    const calls = mockClient.query.mock.calls.map(([sql]) => sql);
    const anchorIdx = mockClient.query.mock.calls.findIndex(([sql, params]) =>
      isOpeningAnchorRead(sql, params),
    );
    const repointIdx = calls.findIndex((s) =>
      norm(s).includes("update transactions"),
    );
    expect(anchorIdx).toBeGreaterThanOrEqual(0);
    expect(anchorIdx).toBeLessThan(repointIdx);
  });
});

describe("stampRangesOverlap (§1 F2 predicate)", () => {
  it("is false for empty / single-account ranges", () => {
    expect(stampRangesOverlap([])).toBe(false);
    expect(
      stampRangesOverlap([
        { account_id: asAccountId(1), min_date: "2026-01-01", max_date: "2026-07-01" },
      ]),
    ).toBe(false);
  });

  it("detects overlap in either nesting order and on shared boundary days", () => {
    const a = { account_id: asAccountId(1), min_date: "2026-01-01", max_date: "2026-06-30" };
    const b = { account_id: asAccountId(2), min_date: "2026-06-30", max_date: "2026-12-01" }; // touches a.max
    const c = { account_id: asAccountId(3), min_date: "2026-02-01", max_date: "2026-03-01" }; // nested inside a
    expect(stampRangesOverlap([a, b])).toBe(true);
    expect(stampRangesOverlap([b, a])).toBe(true);
    expect(stampRangesOverlap([a, c])).toBe(true);
  });

  it("is false for strictly sequential ranges, true when ANY pair among three overlaps", () => {
    const a = { account_id: asAccountId(1), min_date: "2024-01-01", max_date: "2024-12-31" };
    const b = { account_id: asAccountId(2), min_date: "2025-01-01", max_date: "2025-12-31" };
    const c = { account_id: asAccountId(3), min_date: "2025-06-01", max_date: "2026-06-01" };
    expect(stampRangesOverlap([a, b])).toBe(false);
    expect(stampRangesOverlap([a, b, c])).toBe(true); // b × c overlap
  });
});

describe("collidingAnchorCurrencies (opening-anchor merge guard)", () => {
  it("is empty when each currency has at most one account holding an anchor", () => {
    expect(collidingAnchorCurrencies([])).toEqual([]);
    expect(
      collidingAnchorCurrencies([
        { account_id: asAccountId(1), currency: asCurrencyCode("EUR") },
        { account_id: asAccountId(2), currency: asCurrencyCode("USD") },
      ]),
    ).toEqual([]);
    // Two anchors on the SAME account (one per currency) is the normal shape.
    expect(
      collidingAnchorCurrencies([
        { account_id: asAccountId(1), currency: asCurrencyCode("EUR") },
        { account_id: asAccountId(1), currency: asCurrencyCode("USD") },
      ]),
    ).toEqual([]);
  });

  it("reports every currency held by more than one account, ordered and deduped", () => {
    expect(
      collidingAnchorCurrencies([
        { account_id: asAccountId(1), currency: asCurrencyCode("USD") },
        { account_id: asAccountId(2), currency: asCurrencyCode("USD") },
        { account_id: asAccountId(1), currency: asCurrencyCode("EUR") },
        { account_id: asAccountId(2), currency: asCurrencyCode("EUR") },
        { account_id: asAccountId(3), currency: asCurrencyCode("GBP") },
      ]),
    ).toEqual(["EUR", "USD"]);
  });

  it("compares currencies case-insensitively and defaults a missing code to EUR", () => {
    // uq_transactions_opening_anchor is on the stored value; the column is
    // NOT NULL + upper-cased in practice, so this is belt-and-braces.
    expect(
      collidingAnchorCurrencies([
        { account_id: asAccountId(1), currency: loose<CurrencyCode>("eur") },
        { account_id: asAccountId(2), currency: asCurrencyCode("EUR") },
      ]),
    ).toEqual(["EUR"]);
    expect(
      collidingAnchorCurrencies([
        // @ts-expect-error -- a NULL currency must default to EUR at runtime
        { account_id: 1, currency: null },
        { account_id: asAccountId(2), currency: asCurrencyCode("EUR") },
      ]),
    ).toEqual(["EUR"]);
  });
});

describe("previewMerge (GET /api/accounts/:id/merge-preview)", () => {
  // Routes the dedicated pool sink (previewMerge is read-only — it never opens a
  // transaction). Source #1 merged INTO survivor #2 (EUR).
  function primePreview({
    accounts = [
      { id: 1, currency: "USD" },
      { id: 2, currency: "EUR" },
    ],
    counts = { transactions: "3", planned: "1", portfolio: "2", funding: "0" },
    parts = [{ currency: "EUR", balance: "1234.505" }],
    stampRanges = [],
    openingAnchors = [],
  }: {
    accounts?: { id: number; currency: string }[];
    counts?: Record<
      "transactions" | "planned" | "portfolio" | "funding",
      string
    >;
    parts?: { currency: string; balance: string }[] | null;
    stampRanges?: StampRange[];
    openingAnchors?: OpeningAnchor[];
  } = {}) {
    poolQuery.mockImplementation(async (sql, params = []) => {
      if (isOpeningAnchorRead(sql, params))
        return { rows: openingAnchors };
      if (norm(sql).includes("group by account_id")) return { rows: stampRanges };
      if (norm(sql).includes("select id, currency from accounts"))
        return { rows: accounts };
      if (norm(sql).includes("balance_parts"))
        return { rows: [{ balance_parts: parts }] };
      if (norm(sql).includes("from transactions where account_id"))
        return { rows: [{ n: counts.transactions }] };
      if (norm(sql).includes("from planned_transactions"))
        return { rows: [{ n: counts.planned }] };
      if (norm(sql).includes("portfolio_transactions"))
        return { rows: [{ n: counts.portfolio }] };
      if (norm(sql).includes("funding_account_id"))
        return { rows: [{ n: counts.funding }] };
      return { rows: [], rowCount: 0 };
    });
  }

  it("rejects a non-integer / non-positive into and self-merge with 400", async () => {
    await expect(previewMerge(asAccountId(1), asAccountId(NaN))).rejects.toThrow(ValidationError); // ?into= missing
    await expect(previewMerge(asAccountId(1), asAccountId(0))).rejects.toThrow(ValidationError);
    await expect(previewMerge(asAccountId(1), asAccountId(2.5))).rejects.toThrow(ValidationError);
    await expect(previewMerge(asAccountId(1), asAccountId(1))).rejects.toThrow(ValidationError); // into === :id
    expect(query).not.toHaveBeenCalled();
  });

  it("404s when the survivor or the source is missing", async () => {
    primePreview({ accounts: [{ id: 1, currency: "EUR" }] }); // survivor #2 missing
    await expect(previewMerge(asAccountId(1), asAccountId(2))).rejects.toThrow(NotFoundError);

    primePreview({ accounts: [{ id: 2, currency: "EUR" }] }); // source #1 missing
    await expect(previewMerge(asAccountId(1), asAccountId(2))).rejects.toThrow(NotFoundError);
  });

  it("returns counts, projected union balance (survivor currency), and stampsInterleaved", async () => {
    primePreview({
      stampRanges: [
        { account_id: 2, min_date: "2026-01-01", max_date: "2026-07-01" },
        { account_id: 1, min_date: "2026-03-01", max_date: "2026-07-05" },
      ],
    });
    const result = await previewMerge(asAccountId(1), asAccountId(2));

    expect(result).toEqual({
      into: 2,
      source: 1,
      reassigned: { transactions: 3, planned: 1, portfolio: 2, funding: 0 },
      projectedBalance: 1234.5, // pg NUMERIC string → rounded number (banker's)
      projectedBalanceCurrency: "EUR", // the SURVIVOR's native currency
      balanceParts: [{ currency: "EUR", balance: 1234.505 }],
      projectedBalanceIncomplete: false,
      unconvertedCurrencies: [],
      stampsInterleaved: true,
      openingAnchorCollision: false,
    });
  });

  it("does not flag sequential stamp histories", async () => {
    primePreview({
      stampRanges: [
        { account_id: 2, min_date: "2024-01-01", max_date: "2025-01-31" },
        { account_id: 1, min_date: "2025-02-01", max_date: "2026-07-01" },
      ],
    });
    const result = await previewMerge(asAccountId(1), asAccountId(2));
    expect(result.stampsInterleaved).toBe(false);
  });

  it("is strictly read-only: only SELECTs, and never opens a transaction", async () => {
    primePreview();
    await previewMerge(asAccountId(1), asAccountId(2));
    const sqls = query.mock.calls.map(([sql]) => sql);
    expect(sqls.length).toBeGreaterThan(0);
    for (const sql of sqls) {
      expect(sql).not.toMatch(/\b(UPDATE|DELETE|INSERT)\b/i);
    }
    expect(mockClient.query).not.toHaveBeenCalled();
  });

  it("evaluates the projected balance per currency over the UNION of both accounts", async () => {
    primePreview();
    await previewMerge(asAccountId(1), asAccountId(2));
    const projectedCall = query.mock.calls.find(([sql]) =>
      norm(sql).includes("balance_parts"),
    );
    expect(projectedCall).toBeDefined();
    const [projectedSql] = must(projectedCall, "projectedCall");
    // The shared hub builder (jsonb partitions), with the union substituted
    // for a single account — so preview and hub cannot compute the merged
    // balance differently.
    expect(projectedSql).toContain("jsonb_agg(");
    // Union set: account_id = ANY(...) — not a single-account filter.
    expect(projectedSql).toMatch(/t\.account_id = ANY\(\$\d+::int\[\]\)/);
    expect(projectedSql).not.toMatch(/t\.account_id = a\.id/);
    // Anchor = latest stamped row of THAT currency across the union.
    expect(projectedSql).toContain("t.balance IS NOT NULL");
    expect(projectedSql).toContain(
      "COALESCE(t.currency, 'EUR') = ccy.currency",
    );
    // Every bound id list is survivor + source; every other value is the
    // app-timezone as-of day.
    const params = must(projectedCall, "projectedCall")[1] ?? [];
    expect(params.length).toBeGreaterThan(0);
    for (const param of params) {
      if (Array.isArray(param)) expect(param).toEqual([2, 1]);
      else expect(param).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(params.some(Array.isArray)).toBe(true);
  });

  it("converts each currency partition at its own rate, into the survivor currency", async () => {
    // 100 EUR + 100 USD across the two accounts, USD at 0.5 → 150 EUR.
    // Summing the union cross-currency first and converting once (the previous
    // hand-inlined form) gives 200 × 0.5 = 100, or 200 unconverted.
    primePreview({
      parts: [
        { currency: "EUR", balance: "100" },
        { currency: "USD", balance: "100" },
      ],
    });
    const result = await previewMerge(asAccountId(1), asAccountId(2));
    expect(result.projectedBalance).toBe(150);
    expect(result.projectedBalanceCurrency).toBe("EUR");
  });

  it("excludes a partition with no rate and returns its native balance", async () => {
    primePreview({
      parts: [
        { currency: "EUR", balance: "100" },
        { currency: "ZZZ", balance: "40" },
      ],
    });
    const result = await previewMerge(asAccountId(1), asAccountId(2));
    expect(result.projectedBalance).toBe(100);
    expect(result.projectedBalanceIncomplete).toBe(true);
    expect(result.unconvertedCurrencies).toEqual(["ZZZ"]);
    expect(result.balanceParts).toContainEqual({
      currency: "ZZZ",
      balance: 40,
    });
  });

  it("surfaces the opening-anchor collision the merge would refuse on", async () => {
    primePreview({
      openingAnchors: [
        { account_id: 2, currency: "EUR" },
        { account_id: 1, currency: "EUR" },
      ],
    });
    const result = await previewMerge(asAccountId(1), asAccountId(2));
    // Reported alongside the balance, not instead of it: the dialog warns, and
    // the figure still describes what the merge WOULD produce.
    expect(result.openingAnchorCollision).toBe(true);
    expect(result.projectedBalance).toBe(1234.5);
  });

  it("does not flag anchors that sit in different currencies", async () => {
    primePreview({
      openingAnchors: [
        { account_id: 2, currency: "EUR" },
        { account_id: 1, currency: "USD" },
      ],
    });
    expect((await previewMerge(asAccountId(1), asAccountId(2))).openingAnchorCollision).toBe(false);
  });

  it("reports 0 when neither account has any active rows", async () => {
    // The aggregated lateral is a LEFT JOIN: no rows ⇒ balance_parts is SQL NULL.
    primePreview({ parts: null });
    const result = await previewMerge(asAccountId(1), asAccountId(2));
    expect(result.projectedBalance).toBe(0);
  });

  it("counts source lots against the flat portfolio_transactions table", async () => {
    primePreview({
      counts: { transactions: "0", planned: "0", portfolio: "7", funding: "0" },
    });
    const result = await previewMerge(asAccountId(1), asAccountId(2));
    expect(result.reassigned.portfolio).toBe(7);
    const portfolioSql = query.mock.calls
      .map(([sql]) => sql)
      .find((s) => norm(s).includes("portfolio_transactions") && norm(s).includes("count"));
    expect(norm(must(portfolioSql, "portfolioSql"))).toContain(
      "from portfolio_transactions where account_id = $1",
    );
  });
});
