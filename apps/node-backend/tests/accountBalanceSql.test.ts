/**
 * Shape and semantics tests for the shared computed-balance SQL (ADR-094 / WP-A1).
 *
 * The shape tests lock down the contract every consumer (accountRepository,
 * infoRepositoryBanks, infoRepositoryNetWorth, reconcileService,
 * crossWorkspaceDataService) depends on: the exposed columns, the anchor+delta
 * structure, and the day-shift-safe date formatting. Every test file has its
 * own SQLite database (ADR-263), so the "real DB" block at the end also runs
 * the fragments: anchor+delta, per-currency partitions, exact decimals and the
 * daily series across a month end. The repository-level fixtures (manual-only,
 * stamped+manual, liability) stay in infoRepoBanks.test.ts /
 * infoRepository.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql as kyselySql } from "kysely";
import type { RawBuilder } from "kysely";

import { compileQuery, db } from "../src/database/db.ts";
import { closePool } from "../src/database/connection.ts";
import { bankChronologySql as chronologyFragment } from "../src/repositories/bankChronologySql.ts";
import {
  balanceProvenanceLateral as provenanceFragment,
  balancePartsColumn,
  computedBalanceByCurrencyLateral as byCurrencyFragment,
  computedBalanceByCurrencyAggLateral as aggFragment,
  statementPartition,
  computedBalanceSeriesCtes as seriesFragment,
} from "../src/repositories/accountBalanceSql.ts";
import {
  asCurrencyCode,
  type CurrencyCode,
} from "@vision/types/brands";
import { loose } from "./helpers/partial.ts";
import { closeTestPool, getTestPool, resetTestDatabase } from "./setup/db.ts";
import { firstRow } from "./helpers/must.ts";


// The fragments are Kysely `sql` templates; these read their compiled text.
// The constant SQL expressions passed in stand for the callers' fragments.
const text = (fragment: RawBuilder<unknown>) => fragment.compile(db).sql;
const bankChronologySql = (alias: string) => text(chronologyFragment(alias));
const balanceProvenanceLateral = (opts: { asOfDate?: string } = {}) =>
  text(
    provenanceFragment(
      opts.asOfDate === undefined ? {} : { asOfDate: kyselySql.raw(opts.asOfDate) },
    ),
  );
const computedBalanceByCurrencyLateral = (opts: {
  account: string;
  alias?: string;
  asOfDate?: string;
}) =>
  text(
    byCurrencyFragment({
      account: kyselySql.raw(opts.account),
      ...(opts.alias === undefined ? {} : { alias: opts.alias }),
      ...(opts.asOfDate === undefined ? {} : { asOfDate: kyselySql.raw(opts.asOfDate) }),
    }),
  );
const computedBalanceByCurrencyAggLateral = (opts: {
  account: string;
  alias?: string;
  column?: string;
}) =>
  text(
    aggFragment({
      account: kyselySql.raw(opts.account),
      ...(opts.alias === undefined ? {} : { alias: opts.alias }),
      ...(opts.column === undefined ? {} : { column: opts.column }),
    }),
  );
const computedBalanceSeriesCtes = (opts: { byCurrency?: boolean } = {}) =>
  text(seriesFragment(opts));

/** `row` strictly after `anchor` in bank chronology, as the fragments emit it. */
const afterAnchor = (row: string, anchor: string) =>
  `("${anchor}".id IS NULL OR ("${row}".date >= "${anchor}".date\n      AND ("${row}".date, ${bankChronologySql(row)}, "${row}".id) > ("${anchor}".date, ${bankChronologySql(anchor)}, "${anchor}".id)))`;
/** Newest-first bank chronology order, as the fragments emit it. */
const newestFirst = (alias: string) =>
  `ORDER BY "${alias}".date DESC, ${bankChronologySql(alias)} DESC, "${alias}".id DESC`;

/** The per-currency partition SELECT a fragment embeds (one definition). */
function partitionSelect(fragment: string): string {
  const start = fragment.indexOf("SELECT ccy.account_id, ccy.currency,");
  const endMarker = "LEFT JOIN transactions anch ON anch.id = ccy.anchor_id";
  const end = fragment.indexOf(endMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return fragment.slice(start, end + endMarker.length);
}

const BALANCE_PROVENANCE_LATERAL = balanceProvenanceLateral();

describe("BALANCE_PROVENANCE_LATERAL", () => {
  it("exposes anchor_date and post_anchor_count (WP-A1 provenance) and NO balance", () => {
    expect(BALANCE_PROVENANCE_LATERAL).toContain("AS anchor_date");
    expect(BALANCE_PROVENANCE_LATERAL).toContain("AS post_anchor_count");
    // The account-level figure summed amounts across currencies as bare
    // numbers. It had no readers and is gone; pinned so nothing re-adds it.
    expect(BALANCE_PROVENANCE_LATERAL).not.toContain("AS balance");
    expect(BALANCE_PROVENANCE_LATERAL).not.toContain("SUM(");
    expect(BALANCE_PROVENANCE_LATERAL).not.toContain("dec_sum(");
  });

  it("keeps the one-row-per-account LEFT JOIN contract aliased lb over account alias a", () => {
    // Consumers LEFT JOIN and read `lb.*`; the account must be aliased `a`.
    // SQLite has no LATERAL: the join is onto a derived table with one row per
    // account, so it never fans out or drops an account.
    expect(BALANCE_PROVENANCE_LATERAL.trim().startsWith("LEFT JOIN (")).toBe(true);
    expect(BALANCE_PROVENANCE_LATERAL).not.toContain("LATERAL");
    expect(BALANCE_PROVENANCE_LATERAL).toContain("FROM accounts lb_acc");
    expect(BALANCE_PROVENANCE_LATERAL).toContain(") lb ON lb.lb_account_id = a.id");
    expect(BALANCE_PROVENANCE_LATERAL).toContain("t.account_id = lb_acc.id");
  });

  it("anchors on the latest stamped active row and counts strictly-after activity", () => {
    // The `balance IS NOT NULL` predicate may appear ONLY inside the anchor
    // probe (picking the stamp) — never as a population gate on the result.
    expect(BALANCE_PROVENANCE_LATERAL.match(/balance IS NOT NULL/g)?.length).toBe(1);
    expect(BALANCE_PROVENANCE_LATERAL).toContain("t.balance IS NOT NULL");
    expect(BALANCE_PROVENANCE_LATERAL).toContain(newestFirst("t"));
    // Strictly-after tuple comparison + the no-stamp (count everything) fallback.
    expect(BALANCE_PROVENANCE_LATERAL).toContain(afterAnchor("t2", "lb_anc"));
    // The count covers that row set, so post_anchor_count is "entries since the
    // statement" (or total entries when nothing is stamped), as decimal text
    // like PostgreSQL's bigint COUNT(*).
    expect(BALANCE_PROVENANCE_LATERAL).toContain("SELECT COUNT(*)");
    expect(BALANCE_PROVENANCE_LATERAL).toContain("AS TEXT) AS post_anchor_count");
  });

  it("emits anchor_date via to_char so the driver never returns a local-midnight JS Date", () => {
    expect(BALANCE_PROVENANCE_LATERAL).toContain("to_char(lb_anc.date, 'YYYY-MM-DD')");
  });

  it("only considers active rows", () => {
    const inactiveSafe = BALANCE_PROVENANCE_LATERAL.split("\n").filter((l) =>
      l.includes("FROM transactions"),
    );
    expect(inactiveSafe.length).toBeGreaterThan(0);
    // Every transactions scan in the fragment is is_active-gated.
    expect(BALANCE_PROVENANCE_LATERAL.match(/is_active = 1/g)?.length).toBe(2);
  });

  it("excludes future rows from current provenance", () => {
    expect(BALANCE_PROVENANCE_LATERAL.match(/date <= today\(\)/g)?.length).toBe(2);
  });

  it("accepts the caller's app-timezone as-of expression", () => {
    expect(
      balanceProvenanceLateral({ asOfDate: "$1" }).match(/date <= \$1/g)?.length,
    ).toBe(2);
  });
});

describe("computedBalanceByCurrencyLateral", () => {
  const sql = computedBalanceByCurrencyLateral({ account: "a.id" });

  it("partitions every part of the computation by currency", () => {
    // The defect it fixes is a cross-currency SUM: the currency list, the
    // anchor probe and the delta sum must ALL be constrained to one currency,
    // or a partition silently absorbs another currency's rows again.
    expect(sql).toContain(`GROUP BY t.account_id, COALESCE(t.currency, 'EUR')`);
    expect(sql).toContain(`AND t.currency = g.currency`);
    expect(sql).toContain(`AND t2.currency = ccy.currency`);
  });

  it("keeps the anchor+delta structure, per partition, in exact decimals", () => {
    expect(sql).toContain("t.balance IS NOT NULL");
    expect(sql).toContain(newestFirst("t"));
    expect(sql).toContain(afterAnchor("t2", "anch"));
    expect(sql).toContain("dec_add(COALESCE(anch.balance, '0'), (");
    expect(sql).toContain("SELECT COALESCE(dec_sum(t2.amount), '0')");
    expect(sql).not.toMatch(/\bSUM\(/);
    expect(sql.match(/is_active = 1/g)?.length).toBe(3);
  });

  it("bounds every partition scan at the requested as-of date", () => {
    expect(sql.match(/date <= today\(\)/g)?.length).toBe(3);
    const bound = computedBalanceByCurrencyLateral({
      account: "a.id",
      asOfDate: "$1",
    });
    expect(bound.match(/date <= \$1/g)?.length).toBe(3);
  });

  it("is set-returning and aliased, exposing currency and balance", () => {
    expect(sql.trim().startsWith("JOIN (")).toBe(true);
    expect(sql).not.toContain("LATERAL");
    expect(sql).toContain(') "bal" ON "bal"."bal_account_id" = a.id');
    expect(sql).toContain("AS balance");
    // It is a CURRENT balance: it carries no per-partition FX date, because
    // callers must convert it at today's rate (the day the chart ends on), not
    // at the partition's last activity.
    expect(sql).not.toContain("last_activity");
    expect(
      computedBalanceByCurrencyLateral({ account: "a.id", alias: "x" }),
    ).toContain(') "x" ON "x"."x_account_id" = a.id');
  });
});

describe("computedBalanceByCurrencyAggLateral", () => {
  const sql = computedBalanceByCurrencyAggLateral({ account: "a.id" });

  it("embeds the per-currency partition definition without altering it", () => {
    // The whole point is that there is ONE partitioned definition: the
    // aggregated form must embed it verbatim, not restate it. Only the account
    // filter differs (one correlated account instead of every account).
    const perCurrency = partitionSelect(
      computedBalanceByCurrencyLateral({ account: "a.id", alias: "bal" }),
    );
    const aggregated = partitionSelect(sql);
    expect(aggregated).toContain("WHERE t.account_id = bp_acc.id");
    expect(aggregated.replace("t.account_id = bp_acc.id", "t.account_id IS NOT NULL")).toBe(
      perCurrency,
    );
  });

  it("emits one row per account, LEFT-joined so a row-less account survives", () => {
    // Callers whose rows ARE accounts (paging, one entry per account, a
    // population-size guard) break if an account fans out or disappears.
    expect(sql.trim().startsWith("LEFT JOIN (")).toBe(true);
    expect(sql).toContain("FROM accounts bp_acc");
    expect(sql).toContain(') "bp" ON "bp"."bp_account_id" = a.id');
    expect(sql).toContain("json_group_array(");
    // json_group_array over no rows is '[]'; PostgreSQL's jsonb_agg was NULL.
    expect(sql).toContain("CASE WHEN COUNT(*) = 0 THEN NULL");
    expect(sql).toContain("ORDER BY ccy.currency");
    expect(sql).toContain('AS "balance_parts"');
    expect(
      computedBalanceByCurrencyAggLateral({
        account: "a.id",
        alias: "x",
        column: "parts",
      }),
    ).toContain('AS "parts"');
  });

  it("carries each partition balance as decimal TEXT, never a JSON number", () => {
    // JSON numbers deserialize to IEEE doubles, so a NUMERIC would lose
    // precision before toDecimal ever saw it. The partition balance is
    // dec_add text, so json_object writes it as a JSON string.
    expect(sql).toContain(
      "json_object('balance', bp_part.balance, 'currency', bp_part.currency)",
    );
  });

  it("is selected with a ::json alias hint so the driver parses it", () => {
    expect(text(balancePartsColumn())).toBe('"bp"."balance_parts" AS "balance_parts::json"');
    expect(text(balancePartsColumn("x", "parts"))).toBe('"x"."parts" AS "parts::json"');
  });
});

describe("statementPartition", () => {
  // The shared rule behind the drift badge (hub + dashboard), the
  // `reconcilable_balance` the dialog previews against, and what reconcile
  // stamps — they agree by construction because all three read this one helper.
  it("picks the partition matching the account currency", () => {
    const parts = [
      { currency: asCurrencyCode("EUR"), balance: "100" },
      { currency: asCurrencyCode("USD"), balance: "100" },
    ];
    expect(statementPartition(parts, asCurrencyCode("EUR"))).toEqual({
      currency: "EUR",
      balance: "100",
    });
    expect(
      statementPartition(
        [
          { currency: asCurrencyCode("EUR"), balance: "100" },
          { currency: asCurrencyCode("USD"), balance: "250" },
        ],
        asCurrencyCode("USD"),
      ),
    ).toEqual({ currency: "USD", balance: "250" });
  });

  it("keeps the own-currency partition even when it is ZERO", () => {
    // A EUR account spent down to zero that also holds USD has a EUR statement
    // of 0. Falling through to the USD partition here would reconcile a EUR
    // statement against a USD balance.
    expect(
      statementPartition(
        [
          { currency: asCurrencyCode("EUR"), balance: "0" },
          { currency: asCurrencyCode("USD"), balance: "100" },
        ],
        asCurrencyCode("EUR"),
      ),
    ).toEqual({ currency: "EUR", balance: "0" });
  });

  it("reconciles a LONE funded partition whatever its currency (single-currency parity)", () => {
    // A mislabelled single-currency account (USD rows, EUR declared) is not an
    // account with an empty EUR statement — this is what keeps every
    // single-currency account byte-identical to the pre-partition behaviour.
    // The currency comes back so callers can label the figure (and so the
    // adjustment row lands in the partition the drift was measured against).
    expect(
      statementPartition([{ currency: asCurrencyCode("USD"), balance: "100" }], asCurrencyCode("EUR")),
    ).toEqual({ currency: "USD", balance: "100" });
  });

  it("is not knocked off that partition by a zero-sum foreign one", () => {
    // The discontinuity this rule had: a cancelled/offsetting transfer pair nets
    // to 0 but still creates a partition, which flipped the base off the real
    // ledger and onto 0 — turning a reconciled account into one drifting by its
    // entire balance. A partition summing to 0 carries no reconciliation
    // information, so it is dropped before the lone-partition rule applies.
    const withNoise = [
      { currency: asCurrencyCode("GBP"), balance: "0" },
      { currency: asCurrencyCode("USD"), balance: "100" },
    ];
    expect(statementPartition(withNoise, asCurrencyCode("EUR"))).toEqual({
      currency: "USD",
      balance: "100",
    });
    // …i.e. exactly what it resolves to without the noise partition.
    expect(
      statementPartition([{ currency: asCurrencyCode("USD"), balance: "100" }], asCurrencyCode("EUR")),
    ).toEqual(statementPartition(withNoise, asCurrencyCode("EUR")));
  });

  it("drops a sub-cent residue partition exactly like a true zero", () => {
    // Partition sums are 4-dp NUMERIC strings, so cancelled noise can leave an
    // accumulated rounding residue (0.0001) instead of a clean 0. Every
    // consumer rounds the base to cents before using it, so a partition that
    // rounds to 0.00 carries no more reconciliation information than a true
    // zero — it must not knock the base off the lone funded partition.
    const withResidue = [
      { currency: asCurrencyCode("GBP"), balance: "0.0001" },
      { currency: asCurrencyCode("USD"), balance: "100" },
    ];
    expect(statementPartition(withResidue, asCurrencyCode("EUR"))).toEqual({
      currency: "USD",
      balance: "100",
    });
    // …byte-identical to the true-zero and no-noise resolutions.
    expect(statementPartition(withResidue, asCurrencyCode("EUR"))).toEqual(
      statementPartition(
        [
          { currency: asCurrencyCode("GBP"), balance: "0" },
          { currency: asCurrencyCode("USD"), balance: "100" },
        ],
        asCurrencyCode("EUR"),
      ),
    );
    expect(statementPartition(withResidue, asCurrencyCode("EUR"))).toEqual(
      statementPartition([{ currency: asCurrencyCode("USD"), balance: "100" }], asCurrencyCode("EUR")),
    );
    // A negative residue is the same noise.
    expect(
      statementPartition(
        [
          { currency: asCurrencyCode("GBP"), balance: "-0.0049" },
          { currency: asCurrencyCode("USD"), balance: "100" },
        ],
        asCurrencyCode("EUR"),
      ),
    ).toEqual({ currency: "USD", balance: "100" });
  });

  it("still counts a whole cent as funded — the residue rule stops at 0.00", () => {
    // 0.01 is a real (if tiny) balance: two funded foreign partitions means no
    // single one can claim the statement, exactly as before this rule.
    expect(
      statementPartition(
        [
          { currency: asCurrencyCode("GBP"), balance: "0.01" },
          { currency: asCurrencyCode("USD"), balance: "100" },
        ],
        asCurrencyCode("EUR"),
      ),
    ).toEqual({ currency: "EUR", balance: "0" });
    // …and a lone 0.01 partition is still elected, not dropped to the 0 fallback.
    expect(
      statementPartition([{ currency: asCurrencyCode("USD"), balance: "0.01" }], asCurrencyCode("EUR")),
    ).toEqual({ currency: "USD", balance: "0.01" });
  });

  it("returns 0 in the account currency when it holds no partition in it", () => {
    expect(statementPartition([], asCurrencyCode("EUR"))).toEqual({
      currency: "EUR",
      balance: "0",
    });
    expect(statementPartition(null, asCurrencyCode("GBP"))).toEqual({
      currency: "GBP",
      balance: "0",
    });
    // Two funded foreign partitions: no single one can claim the statement.
    expect(
      statementPartition(
        [
          { currency: asCurrencyCode("USD"), balance: "100" },
          { currency: asCurrencyCode("GBP"), balance: "50" },
        ],
        asCurrencyCode("EUR"),
      ),
    ).toEqual({ currency: "EUR", balance: "0" });
  });

  it("defaults a missing account currency to EUR and compares case-insensitively", () => {
    const parts = [
      { currency: asCurrencyCode("EUR"), balance: "7" },
      { currency: loose<CurrencyCode>("usd"), balance: "9" },
    ];
    expect(statementPartition(parts, null)).toEqual({
      currency: "EUR",
      balance: "7",
    });
    expect(statementPartition(parts, loose<CurrencyCode>("usd"))).toEqual({
      currency: "USD",
      balance: "9",
    });
  });
});

describe("computedBalanceSeriesCtes", () => {
  it("ends in a balance_series CTE over the caller-supplied grid CTEs", () => {
    const sql = computedBalanceSeriesCtes();
    expect(sql).toContain("balance_series AS (");
    expect(sql).toContain(
      'JOIN "account_list" bs_al ON bs_al.account_id = t.account_id',
    );
    expect(sql).toContain('FROM "days"');
    // Spliced into an existing WITH chain: no leading WITH, no trailing comma.
    expect(sql.trim().startsWith("WITH")).toBe(false);
    expect(sql.trim().endsWith(")")).toBe(true);
  });

  it("fills quiet days by expanding spans, never by joining a dense grid", () => {
    // A LEFT JOIN of the grid against the (statistics-less) day-end CTE is what
    // the planner turned into an O(days²) merge join with the day demoted to a
    // filter. Expanding each span (a recursive CTE, generate_series in
    // PostgreSQL) has no join to mis-plan.
    const sql = computedBalanceSeriesCtes();
    expect(sql).toContain("bs_fill AS (");
    expect(sql).toContain("SELECT account_id, currency, add_days(day, 1), balance, row_currency, thru_day");
    expect(sql).toContain("FROM bs_fill\n    WHERE day < thru_day");
    expect(sql).toContain(
      "add_days(LEAD(day) OVER (PARTITION BY account_id ORDER BY day), -1)",
    );
    expect(sql).not.toContain("generate_series(");
    expect(sql).not.toContain("LEFT JOIN bs_day_end");
    expect(sql).not.toContain("JOIN days d");
  });

  it("reads balance as a stamp, never as a population gate — that gate WAS the bug", () => {
    // Manual-only accounts must reach the series. `balance IS NOT NULL` may
    // appear ONLY in the pre-window anchor probe (picking a stamp); the emitted
    // rows are filtered on day boundaries alone.
    const sql = computedBalanceSeriesCtes();
    // Exactly two readings of `balance`, both of them "is this row a stamp?":
    // the pre-window anchor probe, and the carry-forward CASE.
    expect(sql.match(/balance IS NOT NULL/g)?.length).toBe(2);
    expect(sql).toMatch(
      /AND t\.balance IS NOT NULL\s+AND t\.date < \(SELECT first_day FROM bs_span\)/,
    );
    expect(sql).toContain(
      "dec_sum(CASE WHEN balance IS NOT NULL THEN dec_sub(balance, cum) END)",
    );
    // The only filter on the emitted rows is a day boundary.
    expect(sql).toContain("WHERE next_day IS NOT day");
  });

  it("bounds the walk at the grid and folds earlier activity into one opening row", () => {
    const sql = computedBalanceSeriesCtes();
    expect(sql).toContain("AND t.date >= (SELECT first_day FROM bs_span)");
    expect(sql).toContain("AND t.date <= (SELECT last_day FROM bs_span)");
    // The opening row is dated the day before the grid and carries the
    // anchor+delta balance as of then, in the `balance` column (i.e. as a
    // stamp), so the window pass never has to read pre-window rows.
    expect(sql).toContain("add_days((SELECT first_day FROM bs_span), -1) AS date");
    expect(sql).toContain("dec_add(COALESCE(anch.balance, '0'), (");
    expect(sql).toContain("'0' AS amount");
    expect(sql).toContain(
      "greatest(date, (SELECT first_day FROM bs_span)) AS day",
    );
    // Exact decimal running sums; never a float SUM.
    expect(sql).toContain("dec_sum(amount) OVER bs_w AS cum");
    expect(sql).not.toMatch(/\bSUM\(/);
  });

  it("partitions by currency only when asked, and only over active rows", () => {
    const cross = computedBalanceSeriesCtes();
    const perCcy = computedBalanceSeriesCtes({ byCurrency: true });
    expect(cross).toContain(`'' AS currency`);
    expect(perCcy).toContain(`COALESCE(t.currency, 'EUR') AS currency`);
    // The partition follows the mode; the cross-currency form carries no
    // constant column in its sort keys.
    expect(perCcy).toContain(
      "WINDOW bs_w AS (PARTITION BY account_id, currency ORDER BY date, chronology, id)",
    );
    expect(cross).toContain(
      "WINDOW bs_w AS (PARTITION BY account_id ORDER BY date, chronology, id)",
    );
    // …and only the per-currency form confines a partition to one currency.
    expect(perCcy).toContain(`AND t.currency = "p".currency`);
    expect(perCcy).toContain(`AND t.currency = "p0".currency`);
    expect(cross).not.toContain(`= "p".currency`);
    for (const sql of [cross, perCcy]) {
      expect(sql).toContain("WHERE t.is_active = 1");
      expect(sql.match(/t\.is_active = 1/g)?.length).toBeGreaterThanOrEqual(4);
    }
  });
});

describe("computed balance SQL (real DB)", () => {
  let recipientId: number;
  let accountId: number;

  beforeAll(async () => {
    await resetTestDatabase();
  });
  beforeEach(async () => {
    const pool = getTestPool();
    await pool.query("DELETE FROM transactions");
    await pool.query("DELETE FROM accounts");
    await pool.query("DELETE FROM recipients");
    recipientId = firstRow(
      await pool.query<{ id: number }>(
        "INSERT INTO recipients (name, normalized_name) VALUES ('Balance fixture', 'balance fixture') RETURNING id",
      ),
    ).id;
    accountId = firstRow(
      await pool.query<{ id: number }>(
        "INSERT INTO accounts (name, currency) VALUES ('Balance account', 'EUR') RETURNING id",
      ),
    ).id;
  });
  afterAll(async () => {
    await closeTestPool();
    await closePool();
  });

  async function row(
    date: string,
    amount: string,
    {
      balance = null,
      currency = "EUR",
      sequence = null,
      active = true,
    }: {
      balance?: string | null;
      currency?: string;
      sequence?: string | null;
      active?: boolean;
    } = {},
  ): Promise<number> {
    return firstRow(
      await getTestPool().query<{ id: number }>(
        `INSERT INTO transactions (date, amount, balance, currency, bank_sequence, account_id, recipient_id, is_active)
         VALUES ($1, vision_numeric($2, 18, 4), vision_numeric($3, 18, 4), $4, vision_numeric($5, 18, 0), $6, $7, $8)
         RETURNING id`,
        [date, amount, balance, currency, sequence, accountId, recipientId, active],
      ),
    ).id;
  }

  async function partitions(asOf: string) {
    const q = compileQuery(
      kyselySql`SELECT bal.currency, bal.balance FROM accounts a
        ${byCurrencyFragment({ account: kyselySql`a.id`, asOfDate: kyselySql`${asOf}` })}
        WHERE a.id = ${accountId} ORDER BY bal.currency`,
    );
    return (await getTestPool().query<{ currency: string; balance: string }>(q.sql, [...q.parameters])).rows;
  }

  async function parts(asOf: string) {
    const q = compileQuery(
      kyselySql`SELECT ${balancePartsColumn()} FROM accounts a
        ${aggFragment({ account: kyselySql`a.id`, asOfDate: kyselySql`${asOf}` })}
        WHERE a.id = ${accountId}`,
    );
    return firstRow(await getTestPool().query<{ balance_parts: unknown }>(q.sql, [...q.parameters]))
      .balance_parts;
  }

  async function provenance(asOf: string) {
    const q = compileQuery(
      kyselySql`SELECT lb.anchor_date, lb.post_anchor_count FROM accounts a
        ${provenanceFragment({ asOfDate: kyselySql`${asOf}` })}
        WHERE a.id = ${accountId}`,
    );
    return firstRow(
      await getTestPool().query<{ anchor_date: string | null; post_anchor_count: string }>(
        q.sql,
        [...q.parameters],
      ),
    );
  }

  async function series(from: string, thru: string, byCurrency = false) {
    const q = compileQuery(
      kyselySql`WITH RECURSIVE account_list AS (SELECT ${accountId} AS account_id),
        days(day) AS (SELECT ${from} UNION ALL SELECT add_days(day, 1) FROM days WHERE day < ${thru}),
        ${seriesFragment({ byCurrency })}
        SELECT currency, day, balance, row_currency FROM balance_series ORDER BY currency, day`,
    );
    return (
      await getTestPool().query<{ currency: string; day: string; balance: string; row_currency: string }>(
        q.sql,
        [...q.parameters],
      )
    ).rows;
  }

  it("anchors on the latest stamp and adds the later rows exactly", async () => {
    await row("2026-01-30", "0.1", { balance: "1000.1000", sequence: "1" });
    await row("2026-01-31", "0.2");
    await row("2026-01-31", "0.0001");
    // Inactive and future rows never count.
    await row("2026-01-31", "5", { active: false });
    await row("2026-02-01", "7");
    // 1000.1 + 0.2 + 0.0001 exactly — a float sum would give 1000.3000999…
    expect(await partitions("2026-01-31")).toEqual([
      { currency: "EUR", balance: "1000.3001" },
    ]);
    expect(await provenance("2026-01-31")).toEqual({
      anchor_date: "2026-01-30",
      post_anchor_count: "2",
    });
  });

  it("falls back to the full sum when nothing is stamped", async () => {
    await row("2026-03-01", "-0.0001");
    await row("2026-03-02", "-12.3456");
    expect(await partitions("2026-03-31")).toEqual([
      { currency: "EUR", balance: "-12.3457" },
    ]);
    expect(await provenance("2026-03-31")).toEqual({
      anchor_date: null,
      post_anchor_count: "2",
    });
  });

  it("anchors each currency partition on its own stamps only", async () => {
    await row("2026-01-02", "100", { balance: "500", sequence: "1" });
    await row("2026-01-03", "-20");
    await row("2026-01-04", "30", { currency: "USD" });
    await row("2026-01-05", "0.5", { currency: "USD" });
    expect(await partitions("2026-01-31")).toEqual([
      { currency: "EUR", balance: "480.0000" },
      { currency: "USD", balance: "30.5000" },
    ]);
    // Folded per account, ordered by currency, balances as decimal strings.
    expect(await parts("2026-01-31")).toEqual([
      { balance: "480.0000", currency: "EUR" },
      { balance: "30.5000", currency: "USD" },
    ]);
  });

  it("keeps a row-less account with NULL parts", async () => {
    expect(await parts("2026-01-31")).toBeNull();
    expect(await partitions("2026-01-31")).toEqual([]);
    expect(await provenance("2026-01-31")).toEqual({
      anchor_date: null,
      post_anchor_count: "0",
    });
  });

  it("fills every day across a month end and carries pre-grid activity in", async () => {
    await row("2026-01-15", "10", { balance: "110", sequence: "1" });
    await row("2026-01-20", "0.25");
    await row("2026-01-31", "-0.05");
    await row("2026-02-02", "1", { balance: "200", sequence: "2" });
    // A future row after the grid must not leak backwards.
    await row("2026-02-10", "999");
    const rows = await series("2026-01-30", "2026-02-03");
    expect(rows.map((r) => [r.day, r.balance])).toEqual([
      // Opening row: 110 + 0.25, carried onto the grid's first day.
      ["2026-01-30", "110.2500"],
      ["2026-01-31", "110.2000"],
      ["2026-02-01", "110.2000"],
      // The new stamp replaces the running sum.
      ["2026-02-02", "200.0000"],
      ["2026-02-03", "200.0000"],
    ]);
    expect(new Set(rows.map((r) => r.row_currency))).toEqual(new Set(["EUR"]));
  });

  it("walks February in a leap year day by day and starts at the first active row", async () => {
    await row("2028-02-28", "1");
    await row("2028-03-01", "2");
    const rows = await series("2028-02-27", "2028-03-01");
    // No row before the account's first active row; 29 Feb exists in 2028.
    expect(rows.map((r) => [r.day, r.balance])).toEqual([
      ["2028-02-28", "1.0000"],
      ["2028-02-29", "1.0000"],
      ["2028-03-01", "3.0000"],
    ]);
  });

  it("partitions the series by currency when asked", async () => {
    await row("2026-05-01", "5", { balance: "50", sequence: "1" });
    await row("2026-05-01", "3", { currency: "USD" });
    await row("2026-05-02", "-1", { currency: "USD" });
    const rows = await series("2026-05-01", "2026-05-02", true);
    expect(rows.map((r) => [r.currency, r.day, r.balance])).toEqual([
      ["EUR", "2026-05-01", "50.0000"],
      ["EUR", "2026-05-02", "50.0000"],
      ["USD", "2026-05-01", "3.0000"],
      ["USD", "2026-05-02", "2.0000"],
    ]);
    // Cross-currency: one partition, the FX currency is the latest row's.
    const cross = await series("2026-05-01", "2026-05-02");
    expect(cross.map((r) => [r.day, r.balance, r.row_currency])).toEqual([
      ["2026-05-01", "53.0000", "USD"],
      ["2026-05-02", "52.0000", "USD"],
    ]);
  });
});
