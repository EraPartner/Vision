/**
 * filterBuilder tests.
 *
 * Covers: validateInt4Ids, buildTransactionWhere, buildExclusionClauses,
 *         buildAggregationFilter. Param-index sharing is exercised so callers
 *         can compose these into larger queries without collision.
 */

import { describe, it, expect } from "vitest";
import {
  buildTransactionWhere,
  buildExclusionClauses,
  __buildAggregationFilter as buildAggregationFilter,
  parseAmountFilter,
  validateInt4Ids,
} from "../src/lib/filterBuilder.js";
import { ValidationError } from "../src/middleware/errorHandler.js";

describe("parseAmountFilter", () => {
  it("returns undefined for missing or unparseable input", () => {
    expect(parseAmountFilter(undefined)).toBeUndefined();
    expect(parseAmountFilter(null)).toBeUndefined();
    expect(parseAmountFilter("")).toBeUndefined();
    expect(parseAmountFilter("abc")).toBeUndefined();
    expect(parseAmountFilter(Infinity)).toBeUndefined();
  });

  it("compares on magnitude by default", () => {
    expect(parseAmountFilter("-50")).toBe(50);
    expect(parseAmountFilter(12.5)).toBe(12.5);
  });

  it("keeps the sign when signed=true", () => {
    expect(parseAmountFilter("-50", true)).toBe(-50);
    expect(parseAmountFilter("50", true)).toBe(50);
  });
});

describe("validateInt4Ids", () => {
  it("keeps valid positive int4 ids", () => {
    expect(validateInt4Ids([1, 42, 2147483646])).toEqual([1, 42, 2147483646]);
  });

  // This block used to pin the opposite contract: `[null, undefined, '5', 1.5,
  // 0, -1, 2147483647, NaN, 7]` was expected to come back as `[7]`. That test
  // documented what `ids.filter(...)` happened to do — it was never a statement
  // that dropping is right. At SQL-build time a dropped id does not 404; it
  // changes which rows the query covers, with nothing surfaced to anyone. If
  // one of these flips back to a drop, that is a silent wrong-answer bug.
  it("rejects the whole list when any element is not a valid int4 id", () => {
    const rejected = [
      [1, "abc", 2, -5, 3], // the shape bulk selection used to accept as [1,2,3]
      ["12abc"], // trailing garbage
      [1.5], // decimals
      ["5.0"],
      ["1e3"], // exponent — Number() would have made this id 1000
      ["0x10"], // hex / octal / binary
      ["0o17"],
      ["0b11"],
      [" 5 "], // whitespace padding
      ["+5"], // signs and separators
      ["-5"],
      ["1_0"],
      [""], // empty / blank
      ["   "],
      [0], // out of range
      [-1],
      [2147483648],
      [null], // wrong types — Number() mapped these to 0/1/7
      [undefined],
      [NaN],
      [Infinity],
      [true],
      [false],
      [[7]],
      [{}],
      ["١٢"], // non-ASCII digits
    ];
    for (const ids of rejected) {
      expect(
        () => validateInt4Ids(ids),
        `expected ${JSON.stringify(ids)} to be rejected`,
      ).toThrow(ValidationError);
    }
  });

  // The off-by-one this filter used to carry on its own: it bounded ids with
  // `id < 2147483647`, while every route-layer validator accepts `<= 2147483647`.
  // A legal int4 id at the ceiling therefore passed validation at the edge and
  // was then dropped here — reachable today via ?excluded_category_ids=2147483647,
  // which 200s and silently applies no exclusion for it.
  it("accepts an id at the int4 ceiling and rejects the first value past it", () => {
    expect(validateInt4Ids([2147483647])).toEqual([2147483647]);
    expect(() => validateInt4Ids([2147483648])).toThrow(ValidationError);
  });

  // Shape parity with validateId, which the route layer already uses: a plain
  // base-10 digit string is a legal id, so a client sending stringified ids is
  // not broken by the tightening.
  it("accepts plain digit strings and normalises them to numbers", () => {
    expect(validateInt4Ids(["5", "00007", "2147483647"])).toEqual([
      5, 7, 2147483647,
    ]);
  });

  // Absent is not the same case as malformed, and is answered differently —
  // the same unset convention assertOptionalId and parseIdArrayQueryParam use.
  // Callers read [] as "no ids" and skip the clause entirely.
  it('treats nullish input as "no ids" rather than an error', () => {
    expect(validateInt4Ids(null)).toEqual([]);
    expect(validateInt4Ids(undefined)).toEqual([]);
    expect(validateInt4Ids([])).toEqual([]);
  });

  // Scalar-wrapping is inherited from validateIntArray, where it exists because
  // a repeatable query param arrives as a scalar when sent once.
  it("wraps a lone scalar id into a list", () => {
    expect(validateInt4Ids("42")).toEqual([42]);
    expect(validateInt4Ids(42)).toEqual([42]);
    expect(() => validateInt4Ids("4.2")).toThrow(ValidationError);
  });

  it("names the offending field and echoes the received value", () => {
    expect(() => validateInt4Ids([1, "evil"], "excludedCategoryIds")).toThrow(
      "excludedCategoryIds contains invalid value: evil",
    );
  });
});

describe("buildTransactionWhere", () => {
  it("defaults to active-only filter when given no options", () => {
    const { sql, params, nextParamIdx } = buildTransactionWhere();
    expect(sql).toBe("1=1 AND t.is_active = true");
    expect(params).toEqual([]);
    expect(nextParamIdx).toBe(1);
  });

  it("omits active clause when active=false", () => {
    const { sql } = buildTransactionWhere({ active: false });
    expect(sql).toBe("1=1");
  });

  it("builds date-range + bank-account filter with sequential $-indices", () => {
    const { sql, params, nextParamIdx } = buildTransactionWhere({
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      bankAccount: "BE12",
    });
    expect(sql).toContain("t.date >= $1");
    expect(sql).toContain("t.date <= $2");
    // ADR-088 contract phase: the bank filter resolves through account_id and
    // matches accounts.name — the SQL must NOT touch the retired string column.
    expect(sql).toContain(
      "t.account_id IN (SELECT fa.id FROM accounts fa WHERE fa.name ILIKE $3)",
    );
    expect(sql).not.toContain("t.bank_account");
    expect(params).toEqual(["2026-01-01", "2026-01-31", "%BE12%"]);
    expect(nextParamIdx).toBe(4);
  });

  it("categoryId expands the effective-category chain into an indexable disjunction", () => {
    const { sql, params, nextParamIdx } = buildTransactionWhere({
      categoryId: 9,
    });
    // Effective category = own → recipient default → primary default, expanded
    // to semi-joins (replaces the non-indexable COALESCE(...) = $ wrapper).
    expect(sql).toContain("t.category_id = $1");
    expect(sql).toContain(
      "t.recipient_id IN (SELECT id FROM recipients WHERE default_category_id = $1)",
    );
    expect(sql).toContain("pr2.default_category_id = $1");
    expect(sql).toContain("r2.default_category_id IS NULL");
    // COALESCE precedence preserved: recipient/primary fallbacks only apply when
    // the txn's own category is NULL.
    expect(sql).toContain("t.category_id IS NULL AND t.recipient_id IN");
    expect(sql).not.toContain("COALESCE(t.category_id");
    expect(params).toEqual([9]);
    // Single param slot reused across all three leaves — param count unchanged.
    expect(nextParamIdx).toBe(2);
  });

  it("recipientId matches both direct and primary-recipient children via a semi-join", () => {
    const { sql, params } = buildTransactionWhere({ recipientId: 5 });
    // Semi-join (indexable on t.recipient_id) equivalent to the old
    // (t.recipient_id = $ OR r.primary_recipient_id = $).
    expect(sql).toContain(
      "t.recipient_id IN (SELECT id FROM recipients WHERE id = $1 OR primary_recipient_id = $1)",
    );
    expect(params).toEqual([5]);
  });

  it("recipientGroupId resolves full primary group including parent and siblings", () => {
    const { sql, params, nextParamIdx } = buildTransactionWhere({
      recipientGroupId: 7,
    });
    // All four group branches, in the same order as the pre-semi-join shape:
    // the recipient itself, its aliases, its own primary, that primary's siblings.
    expect(sql).toContain("t.recipient_id IN (");
    expect(sql).toContain("id = $1");
    expect(sql).toContain("primary_recipient_id = $1");
    expect(sql).toContain(
      "SELECT primary_recipient_id FROM recipients WHERE id = $1 AND primary_recipient_id IS NOT NULL",
    );
    expect(params).toEqual([7]);
    expect(nextParamIdx).toBe(2);
  });

  it("recipientGroupId is a semi-join: t.recipient_id is the only transactions-side column", () => {
    const { sql } = buildTransactionWhere({ recipientGroupId: 7 });
    const groupClause = sql.slice(sql.indexOf("t.recipient_id IN ("));
    // The pre-fix shape ORed t.recipient_id against the JOINED r.primary_recipient_id,
    // so the predicate spanned two relations and the planner could only evaluate it
    // as a join Filter — idx_transactions_recipient_id never got an Index Cond.
    // Every branch must now resolve inside `recipients`.
    expect(groupClause).not.toContain("r.primary_recipient_id");
    expect(groupClause).not.toMatch(/\bt\.recipient_id\s*=/);
    // `t.` may appear only as the single semi-join probe column.
    expect(groupClause.match(/\bt\.\w+/g)).toEqual(["t.recipient_id"]);
  });

  it("recipientGroupId needs no join at all — it references no aliased relation", () => {
    const { sql } = buildTransactionWhere({
      recipientGroupId: 7,
      active: true,
    });
    // Whole clause is self-contained: safe to use in a count query that joins nothing.
    expect(sql).not.toMatch(/\br\.\w+/);
    expect(sql).not.toMatch(/\bpr\.\w+/);
  });

  it("recipientGroupId and recipientId can coexist and use sequential $-indices", () => {
    const { sql, params, nextParamIdx } = buildTransactionWhere({
      recipientId: 3,
      recipientGroupId: 7,
    });
    expect(sql).toContain(
      "t.recipient_id IN (SELECT id FROM recipients WHERE id = $1 OR primary_recipient_id = $1)",
    );
    expect(sql).toContain("id = $2");
    expect(sql).toContain(
      "SELECT primary_recipient_id FROM recipients WHERE id = $2 AND primary_recipient_id IS NOT NULL",
    );
    expect(params).toEqual([3, 7]);
    expect(nextParamIdx).toBe(3);
  });

  it("recipientName is the only filter that references a join alias", () => {
    // The invariant transactionRepository's reduced COUNT_JOINS rests on: a count
    // query over this builder needs `r` and nothing else. If a new filter starts
    // referencing pr/c/rc/pc/acct, this test fails and the count join set must grow.
    const everything = {
      transactionId: 1,
      startDate: "2024-01-01",
      endDate: "2024-12-31",
      accountId: 2,
      categoryId: 3,
      categoryIds: [3, 4],
      recipientId: 5,
      recipientGroupId: 6,
      search: "coffee",
      active: true,
      transactionType: "expense",
      amountMin: 1,
      amountMax: 2,
      tagSlugs: ["x"],
    };
    const withoutName = buildTransactionWhere(everything).sql;
    expect(withoutName).not.toMatch(/\b(r|pr|c|rc|pc|acct)\.\w+/);

    const withName = buildTransactionWhere({
      ...everything,
      recipientName: "delh",
    }).sql;
    expect(withName).toMatch(/\br\.name ILIKE/);
    expect(withName).not.toMatch(/\b(pr|c|rc|pc|acct)\.\w+/);
  });

  it("search builds an indexable t.id IN (UNION ...) with a single $-slot", () => {
    const { sql, params, nextParamIdx } = buildTransactionWhere({
      search: "groceries",
    });
    // One id-producing branch per relation instead of an OR chain over the
    // outer join aliases, so each branch can use its own index.
    expect(sql).toContain("t.id IN (");
    expect(sql).toContain("st.memo ILIKE $1 OR st.comment ILIKE $1");
    // Bank-label branch goes through the account entity (ADR-088), the
    // currency branch stays on the transaction row.
    expect(sql).toContain(
      "st.account_id IN (SELECT sa.id FROM accounts sa WHERE sa.name ILIKE $1)",
    );
    expect(sql).toContain("st.currency ILIKE $1");
    expect(sql).not.toContain("bank_account");
    expect(sql).toContain("sr.name ILIKE $1");
    expect(sql).toContain("sc.general ILIKE $1 OR sc.detail ILIKE $1");
    expect(sql).toContain("sr.default_category_id IN");
    expect(sql).toContain("srp.default_category_id IN");
    expect(params).toEqual(["%groceries%"]);
    expect(nextParamIdx).toBe(2);
  });

  it("search also spans the transaction date text and active tag slugs", () => {
    const { sql, params, nextParamIdx } = buildTransactionWhere({
      search: "2026-06",
    });
    // Date is matched as ISO text so "2026-06" finds June 2026.
    expect(sql).toContain("CAST(st.date AS TEXT) ILIKE $1");
    // Tags are matched via the junction table, reusing the same slot.
    expect(sql).toContain("FROM transaction_tags tt");
    expect(sql).toContain("tg.slug ILIKE $1");
    expect(sql).toContain("tg.is_active = true");
    expect(params).toEqual(["%2026-06%"]);
    expect(nextParamIdx).toBe(2);
  });

  it("search omits the amount/date CAST branches when the term cannot match them", () => {
    const { sql } = buildTransactionWhere({ search: "groceries" });
    // 'groceries' contains letters, which never appear in amount/date text.
    expect(sql).not.toContain("CAST(");
  });

  it("search includes the amount CAST branch only for numeric-shaped terms", () => {
    const { sql } = buildTransactionWhere({ search: "12.5" });
    expect(sql).toContain("CAST(st.amount AS TEXT) ILIKE $1");
    // '.' never appears in date text, so the date branch is skipped.
    expect(sql).not.toContain("CAST(st.date AS TEXT)");
  });

  it("search shorter than MIN_SEARCH_LENGTH after trimming is ignored", () => {
    for (const term of ["a", " a ", "", "  "]) {
      const { sql, params, nextParamIdx } = buildTransactionWhere({
        search: term,
      });
      expect(sql).not.toContain("t.id IN (");
      expect(sql).not.toContain("ILIKE");
      expect(params).toEqual([]);
      expect(nextParamIdx).toBe(1);
    }
  });

  it("amountMin/amountMax filter on magnitude (sign-agnostic) with sequential slots", () => {
    const { sql, params, nextParamIdx } = buildTransactionWhere({
      amountMin: 10,
      amountMax: 50,
    });
    expect(sql).toContain("ABS(t.amount) >= $1");
    expect(sql).toContain("ABS(t.amount) <= $2");
    expect(params).toEqual([10, 50]);
    expect(nextParamIdx).toBe(3);
  });

  it("amount bounds are skipped when null or non-finite", () => {
    const { sql, params } = buildTransactionWhere({
      amountMin: null,
      amountMax: undefined,
    });
    expect(sql).not.toContain("ABS(t.amount)");
    expect(params).toEqual([]);
  });

  it("amountSigned compares the signed amount instead of its magnitude", () => {
    const { sql, params } = buildTransactionWhere({
      amountMin: -50,
      amountMax: -50,
      amountSigned: true,
    });
    expect(sql).toContain("t.amount >= $1");
    expect(sql).toContain("t.amount <= $2");
    expect(sql).not.toContain("ABS(t.amount)");
    expect(params).toEqual([-50, -50]);
  });

  it("respects startParamIdx so it can be composed into a bigger query", () => {
    const { sql, params, nextParamIdx } = buildTransactionWhere({
      startDate: "2026-01-01",
      startParamIdx: 5,
    });
    expect(sql).toContain("t.date >= $5");
    expect(params).toEqual(["2026-01-01"]);
    expect(nextParamIdx).toBe(6);
  });
});

describe("buildExclusionClauses", () => {
  it("returns empty whereSql and no params when exclusions are absent", () => {
    const result = buildExclusionClauses();
    expect(result.whereSql).toBe("");
    expect(result.params).toEqual([]);
    expect(result.nextParamIdx).toBe(1);
    expect(result.joinSql).toContain("LEFT JOIN recipients r");
    expect(result.joinSql).toContain("LEFT JOIN recipients pr");
  });

  // Was: the same input asserted whereSql === '' and params === []. That is the
  // worst version of the silent drop — every excluded id is discarded, no
  // predicate is emitted at all, and the caller gets the FULL dataset back
  // while believing its exclusions were applied. It now rejects.
  it("rejects a malformed exclusion list instead of emitting no predicate", () => {
    expect(() =>
      buildExclusionClauses({
        excludedCategoryIds: [null, 0, "oops", 2147483647],
        excludedRecipientIds: [-1, NaN],
      }),
    ).toThrow(ValidationError);

    expect(() =>
      buildExclusionClauses({ excludedCategoryIds: [1, "oops"] }),
    ).toThrow("excludedCategoryIds contains invalid value: oops");
    expect(() =>
      buildExclusionClauses({ excludedRecipientIds: [1, -1] }),
    ).toThrow("excludedRecipientIds contains invalid value: -1");
  });

  // The id at the ceiling was in the rejected list above only because of the
  // old exclusive `< MAX_INT4` bound. It is a legal int4 id and now excludes.
  it("excludes an id at the int4 ceiling instead of dropping it", () => {
    const result = buildExclusionClauses({ excludedCategoryIds: [2147483647] });
    expect(result.whereSql).toBe(
      "COALESCE(t.category_id, r.default_category_id, pr.default_category_id, -1) NOT IN ($1)",
    );
    expect(result.params).toEqual([2147483647]);
  });

  it("builds NOT IN predicate for categories using the same COALESCE chain", () => {
    const result = buildExclusionClauses({ excludedCategoryIds: [1, 2, 3] });
    expect(result.whereSql).toBe(
      "COALESCE(t.category_id, r.default_category_id, pr.default_category_id, -1) NOT IN ($1, $2, $3)",
    );
    expect(result.params).toEqual([1, 2, 3]);
    expect(result.nextParamIdx).toBe(4);
  });

  it("builds NOT IN predicate for recipients using primary-first COALESCE", () => {
    const result = buildExclusionClauses({ excludedRecipientIds: [7, 8] });
    expect(result.whereSql).toBe(
      "COALESCE(r.primary_recipient_id, t.recipient_id, -1) NOT IN ($1, $2)",
    );
    expect(result.params).toEqual([7, 8]);
    expect(result.nextParamIdx).toBe(3);
  });

  it("coalesces NULL to -1 so uncategorized/recipient-less rows are kept, not dropped", () => {
    // A bare `NULL NOT IN (...)` is NULL (falsy), which silently dropped every
    // uncategorized row on any exclusion. -1 can never be an excluded id.
    const cat = buildExclusionClauses({ excludedCategoryIds: [1] });
    expect(cat.whereSql).toContain(", -1) NOT IN");
    const rec = buildExclusionClauses({ excludedRecipientIds: [1] });
    expect(rec.whereSql).toContain(", -1) NOT IN");
  });

  it("combines both exclusion lists with AND and sequential $-indices", () => {
    const result = buildExclusionClauses({
      excludedCategoryIds: [10, 11],
      excludedRecipientIds: [20],
      startParamIdx: 4,
    });
    expect(result.whereSql).toBe(
      "COALESCE(t.category_id, r.default_category_id, pr.default_category_id, -1) NOT IN ($4, $5)" +
        " AND COALESCE(r.primary_recipient_id, t.recipient_id, -1) NOT IN ($6)",
    );
    expect(result.params).toEqual([10, 11, 20]);
    expect(result.nextParamIdx).toBe(7);
  });
});

describe("buildAggregationFilter", () => {
  it("merges base where with exclusions and shares the param counter", () => {
    const { joinSql, whereSql, params, nextParamIdx } = buildAggregationFilter({
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      excludedCategoryIds: [10],
      excludedRecipientIds: [20, 21],
    });

    expect(joinSql).toContain("LEFT JOIN recipients r");
    expect(whereSql).toContain("t.is_active = true");
    expect(whereSql).toContain("t.date >= $1");
    expect(whereSql).toContain("t.date <= $2");
    expect(whereSql).toContain(
      "COALESCE(t.category_id, r.default_category_id, pr.default_category_id, -1) NOT IN ($3)",
    );
    expect(whereSql).toContain(
      "COALESCE(r.primary_recipient_id, t.recipient_id, -1) NOT IN ($4, $5)",
    );
    expect(params).toEqual(["2026-01-01", "2026-01-31", 10, 20, 21]);
    expect(nextParamIdx).toBe(6);
  });

  it("omits exclusion clauses when lists are empty, keeping base where intact", () => {
    const { whereSql, params, nextParamIdx } = buildAggregationFilter({
      bankAccount: "BE12",
    });
    expect(whereSql).toBe(
      "1=1 AND t.is_active = true AND t.account_id IN (SELECT fa.id FROM accounts fa WHERE fa.name ILIKE $1)",
    );
    expect(params).toEqual(["%BE12%"]);
    expect(nextParamIdx).toBe(2);
  });
});

describe("buildTransactionWhere — accountId / accountIds (FK filter, ADR-088)", () => {
  it("builds an exact account_id predicate", () => {
    const { sql, params, nextParamIdx } = buildTransactionWhere({
      accountId: 7,
      active: false,
    });
    expect(sql).toContain("t.account_id = $1");
    expect(params).toEqual([7]);
    expect(nextParamIdx).toBe(2);
  });

  it("builds an IN clause for accountIds", () => {
    const { sql, params } = buildTransactionWhere({
      accountIds: [3, 9],
      active: false,
    });
    expect(sql).toContain("t.account_id IN ($1, $2)");
    expect(params).toEqual([3, 9]);
  });

  // Was: `[3, -1, 9, 0.5]` asserted to narrow to `[3, 9]`. A dropped account id
  // widens the export/list result to accounts the caller did not ask for, which
  // is a wrong answer rather than a smaller one.
  it("rejects a malformed accountIds element instead of narrowing the IN list", () => {
    for (const accountIds of [[3, -1, 9, 0.5], [0], ["12abc"], [2147483648]]) {
      expect(() =>
        buildTransactionWhere({ accountIds, active: false }),
      ).toThrow(ValidationError);
    }
  });

  it("accountId wins over accountIds; the bank-name filter still composes", () => {
    const { sql, params } = buildTransactionWhere({
      accountId: 4,
      accountIds: [5, 6],
      bankAccount: "BE12",
      active: false,
    });
    expect(sql).toContain("t.account_id = $1");
    expect(sql).not.toContain("t.account_id IN ($");
    expect(sql).toContain(
      "t.account_id IN (SELECT fa.id FROM accounts fa WHERE fa.name ILIKE $2)",
    );
    expect(params).toEqual([4, "%BE12%"]);
  });

  it("skips the clause entirely when neither is provided", () => {
    const { sql } = buildTransactionWhere({ active: false });
    expect(sql).not.toContain("t.account_id");
  });
});

describe("buildTransactionWhere — bankAccounts (plural IN clause)", () => {
  it("builds an exact accounts.name match resolved through account_id (ADR-088)", () => {
    const { sql, params, nextParamIdx } = buildTransactionWhere({
      bankAccounts: ["NL12INGB0001234567", "BE68539007547034"],
      active: false,
    });
    expect(sql).toContain(
      "t.account_id IN (SELECT fa.id FROM accounts fa WHERE fa.name IN ($1, $2))",
    );
    expect(sql).not.toContain("bank_account");
    expect(params).toEqual(["NL12INGB0001234567", "BE68539007547034"]);
    expect(nextParamIdx).toBe(3);
  });

  it("skips clause when array is empty", () => {
    const { sql, params } = buildTransactionWhere({
      bankAccounts: [],
      active: false,
    });
    expect(sql).not.toContain("fa.name IN");
    expect(params).toHaveLength(0);
  });

  it("filters out empty string values", () => {
    const { sql, params } = buildTransactionWhere({
      bankAccounts: ["", "  "],
      active: false,
    });
    expect(sql).not.toContain("fa.name IN");
    expect(params).toHaveLength(0);
  });

  it("bankAccount (singular ILIKE) takes precedence over bankAccounts", () => {
    const { sql, params } = buildTransactionWhere({
      bankAccount: "NL12",
      bankAccounts: ["BE68539007547034"],
      active: false,
    });
    expect(sql).toContain("fa.name ILIKE");
    expect(sql).not.toContain("fa.name IN (");
    expect(params).toEqual(["%NL12%"]);
  });

  it("caps at MAX_LIST_SIZE (50) entries", () => {
    const accounts = Array.from({ length: 60 }, (_, i) => `IBAN${i}`);
    const { params } = buildTransactionWhere({
      bankAccounts: accounts,
      active: false,
    });
    expect(params).toHaveLength(50);
  });

  it("respects startParamIdx offset", () => {
    const { sql, params, nextParamIdx } = buildTransactionWhere({
      bankAccounts: ["NL12INGB0001234567"],
      active: false,
      startParamIdx: 4,
    });
    expect(sql).toContain("IN ($4)");
    expect(params).toEqual(["NL12INGB0001234567"]);
    expect(nextParamIdx).toBe(5);
  });
});

describe("buildTransactionWhere — transactionType", () => {
  it("adds t.amount > 0 for income", () => {
    const { sql } = buildTransactionWhere({
      transactionType: "income",
      active: false,
    });
    expect(sql).toContain("t.amount > 0");
    expect(sql).not.toContain("t.amount < 0");
  });

  it("adds t.amount < 0 for expense", () => {
    const { sql } = buildTransactionWhere({
      transactionType: "expense",
      active: false,
    });
    expect(sql).toContain("t.amount < 0");
    expect(sql).not.toContain("t.amount > 0");
  });

  it("adds no amount clause for null transactionType", () => {
    const { sql } = buildTransactionWhere({
      transactionType: null,
      active: false,
    });
    expect(sql).not.toContain("t.amount");
  });

  it("transactionType does not consume $-params", () => {
    const { params, nextParamIdx } = buildTransactionWhere({
      transactionType: "income",
      active: false,
    });
    expect(params).toHaveLength(0);
    expect(nextParamIdx).toBe(1);
  });
});

describe("buildTransactionWhere — categoryIds (plural IN clause)", () => {
  it("builds effective-category disjunction with the id list in every leaf", () => {
    const { sql, params, nextParamIdx } = buildTransactionWhere({
      categoryIds: [2, 5, 9],
      active: false,
    });
    // Same placeholder slots ($1,$2,$3) reused across own / recipient-default /
    // primary-default leaves — params allocated once, count unchanged.
    expect(sql).toContain("t.category_id IN ($1, $2, $3)");
    expect(sql).toContain("WHERE default_category_id IN ($1, $2, $3)");
    expect(sql).toContain("pr2.default_category_id IN ($1, $2, $3)");
    expect(sql).not.toContain("COALESCE(t.category_id");
    expect(params).toEqual([2, 5, 9]);
    expect(nextParamIdx).toBe(4);
  });

  // Was: `[0, -1, null, 1.5]` asserted to emit no clause at all — the filter
  // silently became "all categories". The test name even said "silently".
  it("rejects malformed categoryIds instead of silently skipping the clause", () => {
    for (const categoryIds of [
      [0, -1, null, 1.5],
      [1, "evil"],
      ["1e3"],
      [2147483648],
    ]) {
      expect(() =>
        buildTransactionWhere({ categoryIds, active: false }),
      ).toThrow(ValidationError);
    }
  });

  it("categoryId (singular) takes precedence over categoryIds", () => {
    const { sql, params } = buildTransactionWhere({
      categoryId: 3,
      categoryIds: [1, 2],
      active: false,
    });
    expect(sql).toContain("t.category_id = $1");
    expect(sql).not.toContain("t.category_id IN (");
    expect(params).toEqual([3]);
  });

  it("respects startParamIdx offset", () => {
    const { sql, params, nextParamIdx } = buildTransactionWhere({
      categoryIds: [4, 7],
      active: false,
      startParamIdx: 3,
    });
    expect(sql).toContain("t.category_id IN ($3, $4)");
    expect(params).toEqual([4, 7]);
    expect(nextParamIdx).toBe(5);
  });
});

describe("buildTransactionWhere — tagSlugs", () => {
  it("emits EXISTS subquery for a single tag slug", () => {
    const { sql, params } = buildTransactionWhere({
      tagSlugs: ["rome-2020"],
      active: false,
    });
    expect(sql).toContain("EXISTS");
    expect(sql).toContain("transaction_tags");
    expect(sql).toContain("ANY($1::text[])");
    expect(params).toEqual([["rome-2020"]]);
  });

  it("passes multiple slugs as a single array param (OR semantics)", () => {
    const { sql, params } = buildTransactionWhere({
      tagSlugs: ["rome-2020", "lisbon-2024"],
      active: false,
    });
    expect(sql).toContain("ANY($1::text[])");
    expect(params).toHaveLength(1);
    expect(params[0]).toEqual(["rome-2020", "lisbon-2024"]);
  });

  it("filters only active tags (is_active = true)", () => {
    const { sql } = buildTransactionWhere({
      tagSlugs: ["rome-2020"],
      active: false,
    });
    expect(sql).toContain("is_active = true");
  });

  it("joins on tag_id so inactive tags are excluded from match", () => {
    const { sql } = buildTransactionWhere({
      tagSlugs: ["rome-2020"],
      active: false,
    });
    expect(sql).toContain("tg.id = tt.tag_id");
  });

  it("produces no clause when tagSlugs is empty", () => {
    const { sql, params } = buildTransactionWhere({
      tagSlugs: [],
      active: false,
    });
    expect(sql).not.toContain("transaction_tags");
    expect(params).toHaveLength(0);
  });

  it("produces no clause when tagSlugs is null", () => {
    const { sql } = buildTransactionWhere({ tagSlugs: null, active: false });
    expect(sql).not.toContain("transaction_tags");
  });

  it("strips blank/whitespace-only slug entries", () => {
    const { sql, params } = buildTransactionWhere({
      tagSlugs: ["rome-2020", "  ", ""],
      active: false,
    });
    expect(params[0]).toEqual(["rome-2020"]);
  });

  it("produces no clause when all slugs are blank after trim", () => {
    const { sql, params } = buildTransactionWhere({
      tagSlugs: ["  ", ""],
      active: false,
    });
    expect(sql).not.toContain("EXISTS");
    expect(params).toHaveLength(0);
  });

  it("caps at MAX_LIST_SIZE (50) entries", () => {
    const manySlugs = Array.from({ length: 60 }, (_, i) => `tag-${i}`);
    const { params } = buildTransactionWhere({
      tagSlugs: manySlugs,
      active: false,
    });
    expect(params[0]).toHaveLength(50);
  });

  it("respects startParamIdx offset", () => {
    const { sql, params, nextParamIdx } = buildTransactionWhere({
      tagSlugs: ["rome-2020"],
      active: false,
      startParamIdx: 5,
    });
    expect(sql).toContain("ANY($5::text[])");
    expect(params).toEqual([["rome-2020"]]);
    expect(nextParamIdx).toBe(6);
  });
});
