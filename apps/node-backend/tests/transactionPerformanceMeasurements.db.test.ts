/**
 * Opt-in SQLite measurement harness for two performance acceptance items
 * (ADR-263; this replaced the PostgreSQL 18 EXPLAIN (ANALYZE, BUFFERS) harness).
 *
 * Run it on this file's own disposable test database (tests/setup/db.ts):
 *
 *   VISION_RUN_PERFORMANCE_PROBES=1 bunx vitest run \
 *     tests/transactionPerformanceMeasurements.db.test.ts --reporter=verbose
 *
 * The corpus is seeded in one write transaction on that database, which is
 * discarded after the run. The stamped-balance comparison drops the production
 * index only inside a rolled-back transaction (SQLite DDL is transactional),
 * so the schema is restored even if an assertion fails. SQLite has no EXPLAIN
 * ANALYZE: each run times the statement on the driver, and the plan is the
 * EXPLAIN QUERY PLAN tree, which is logged as JSON and can be retained when a
 * fresh hardware-specific plan is needed.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTransaction } from "../src/database/connection.ts";
import {
  closeTestPool,
  getTestPool,
  inRollbackTransaction,
  type TestPool,
} from "./setup/db.ts";
import { must } from "./helpers/must.ts";

interface IdRow {
  id: number;
}

/** One row of EXPLAIN QUERY PLAN: a plan step and the step it nests under. */
interface PlanStep {
  id: number;
  parent: number;
  detail: string;
}

/** One timed execution of a statement plus its query plan. */
interface ExplainedPlan {
  steps: PlanStep[];
  executionMs: number;
  actualRows: number;
}

type Runner = Pick<TestPool, "query">;

const ROW_COUNT = 120_000;
const ACCOUNT_COUNT = 20;
const RECIPIENT_COUNT = 1_000;
const CATEGORY_COUNT = 100;
const REPETITIONS = 20;

const shouldRun = process.env.VISION_RUN_PERFORMANCE_PROBES === "1";

const transactionJoins = `
  LEFT JOIN recipients r ON t.recipient_id = r.id
  LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
  LEFT JOIN categories c ON t.category_id = c.id
  LEFT JOIN categories rc ON r.default_category_id = rc.id
  LEFT JOIN categories pc ON pr.default_category_id = pc.id
  LEFT JOIN accounts acct ON t.account_id = acct.id`;

const sortExpressions = {
  memo: "t.memo",
  recipient: "COALESCE(pr.name, r.name)",
  category: `CASE
    WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail
    WHEN rc.id IS NOT NULL THEN rc.general || ':' || rc.detail
    WHEN pc.id IS NOT NULL THEN pc.general || ':' || pc.detail
    ELSE NULL
  END`,
  currency: "t.currency",
};

const transactionProjection = `
  SELECT t.*,
         acct.name AS bank_account,
         COALESCE(pr.name, r.name) AS recipient_name,
         COALESCE(t.category_id, r.default_category_id, pr.default_category_id)
           AS effective_category_id,
         CASE
           WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail
           WHEN rc.id IS NOT NULL THEN rc.general || ':' || rc.detail
           WHEN pc.id IS NOT NULL THEN pc.general || ':' || pc.detail
           ELSE NULL
         END AS category_name
  FROM transactions t
  ${transactionJoins}
  WHERE t.is_active = 1`;

/** 1..n as rows of `g` (PostgreSQL's generate_series). */
const series = (n: number) =>
  `g(g) AS (SELECT 1 UNION ALL SELECT g + 1 FROM g WHERE g < ${n})`;

/** A temp table numbering `select`'s ids 1..n in id order. */
async function numbered(client: Runner, table: string, select: string) {
  await client.query(`CREATE TEMP TABLE ${table} (seq INTEGER PRIMARY KEY, id INTEGER NOT NULL)`);
  await client.query(
    `INSERT INTO ${table} (seq, id) SELECT row_number() OVER (ORDER BY id), id FROM (${select})`,
  );
}

async function seedRepresentativeCorpus(client: Runner) {
  await client.query(`
    WITH RECURSIVE ${series(ACCOUNT_COUNT)}
    INSERT INTO accounts (name, display_name)
    SELECT 'PERF ACCOUNT ' || g, 'Performance account ' || g FROM g`);
  await numbered(client, "perf_accounts", "SELECT id FROM accounts WHERE name LIKE 'PERF ACCOUNT %'");

  await client.query(`
    WITH RECURSIVE ${series(CATEGORY_COUNT)}
    INSERT INTO categories (general, detail)
    SELECT 'PERF GROUP ' || ((g - 1) / 10), 'Performance category ' || g FROM g`);
  await numbered(client, "perf_categories", "SELECT id FROM categories WHERE general LIKE 'PERF GROUP %'");

  await client.query(`
    WITH RECURSIVE ${series(RECIPIENT_COUNT / 2)}
    INSERT INTO recipients (name, normalized_name, default_category_id)
    SELECT 'PERF RECIPIENT ' || g, 'perf recipient ' || g, c.id
    FROM g JOIN perf_categories c ON c.seq = 1 + ((g - 1) % ${CATEGORY_COUNT})`);
  await numbered(
    client,
    "perf_primary_recipients",
    "SELECT id FROM recipients WHERE name LIKE 'PERF RECIPIENT %'",
  );
  await client.query(`
    INSERT INTO recipients (name, normalized_name, primary_recipient_id)
    SELECT 'PERF ALIAS ' || p.seq, 'perf alias ' || p.seq, p.id
    FROM perf_primary_recipients p`);
  await numbered(
    client,
    "perf_recipients",
    "SELECT id FROM recipients WHERE name LIKE 'PERF RECIPIENT %' OR name LIKE 'PERF ALIAS %'",
  );

  // The fixture supplies canonical account IDs. Dropping the transactions
  // triggers for the bulk insert (PostgreSQL: DISABLE TRIGGER USER) avoids
  // measuring seed-maintenance work; indexes, CHECKs and foreign keys stay
  // active, and the triggers are recreated in this same transaction.
  const { rows: triggers } = await client.query<{ name: string; sql: string }>(
    "SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'transactions' ORDER BY name",
  );
  for (const trigger of triggers) await client.query(`DROP TRIGGER "${trigger.name}"`);
  try {
    await client.query(`
      WITH RECURSIVE ${series(ROW_COUNT)}
      INSERT INTO transactions (
        date, amount, currency, balance, memo,
        recipient_id, category_id, is_active, account_id
      )
      SELECT add_days('2000-01-01', (g - 1) / ${ACCOUNT_COUNT}),
             vision_numeric(dec_div((g % 20001) - 10000, 100), 18, 4),
             CASE (g - 1) % 4 WHEN 0 THEN 'EUR' WHEN 1 THEN 'USD' WHEN 2 THEN 'GBP' ELSE 'CHF' END,
             CASE
               WHEN a.seq = 1 AND g <= ${ROW_COUNT / 2} AND g % 2000 = 1
                 THEN vision_numeric(dec_div(g, 100), 18, 4)
               ELSE NULL
             END,
             'PERF MEMO ' || printf('%05d', g % 10000),
             r.id,
             CASE WHEN g % 3 = 0 THEN c.id ELSE NULL END,
             g % 50 <> 0,
             a.id
      FROM g
      JOIN perf_accounts a ON a.seq = 1 + ((g - 1) % ${ACCOUNT_COUNT})
      JOIN perf_recipients r ON r.seq = 1 + ((g - 1) % ${RECIPIENT_COUNT})
      JOIN perf_categories c ON c.seq = 1 + ((g - 1) % ${CATEGORY_COUNT})`);
  } finally {
    for (const trigger of triggers) await client.query(trigger.sql);
  }
  for (const table of ["perf_accounts", "perf_categories", "perf_primary_recipients", "perf_recipients"]) {
    await client.query(`DROP TABLE temp.${table}`);
  }
  await client.query("ANALYZE transactions");
  await client.query("ANALYZE recipients");
  await client.query("ANALYZE categories");
  await client.query("ANALYZE accounts");
}

async function explain(
  client: Runner,
  sql: string,
  params: unknown[] = [],
): Promise<ExplainedPlan> {
  const { rows: steps } = await client.query<PlanStep>(
    `EXPLAIN QUERY PLAN ${sql}`,
    params,
  );
  const started = performance.now();
  const { rows } = await client.query(sql, params);
  const executionMs = performance.now() - started;
  return {
    steps: steps.map(({ id, parent, detail }) => ({ id, parent, detail })),
    executionMs,
    actualRows: rows.length,
  };
}

function findPlanStep(
  plan: ExplainedPlan,
  predicate: (detail: string) => boolean,
): string | undefined {
  return plan.steps.find((step) => predicate(step.detail))?.detail;
}

/** The step that reads `transactions t`, and the index it uses if any. */
function transactionScan(plan: ExplainedPlan) {
  const detail = findPlanStep(plan, (step) => /^(SCAN|SEARCH) t\b/.test(step));
  return {
    detail,
    index: detail ? /USING (?:COVERING )?INDEX (\S+)/.exec(detail)?.[1] : undefined,
  };
}

function median(values: number[]): number {
  const ordered = [...values].sort((a, b) => a - b);
  const value = ordered[Math.floor(ordered.length / 2)];
  if (value === undefined) throw new Error("median of an empty sample");
  return value;
}

function nearestRank(values: number[], percentile: number): number {
  const ordered = [...values].sort((a, b) => a - b);
  const value = ordered[Math.ceil((percentile / 100) * ordered.length) - 1];
  if (value === undefined) throw new Error("percentile of an empty sample");
  return value;
}

function summarizePlan(plan: ExplainedPlan) {
  const scan = transactionScan(plan);
  return {
    executionMs: plan.executionMs,
    transactionScanStep: scan.detail,
    transactionScanIndex: scan.index,
    actualRows: plan.actualRows,
    sortStep: findPlanStep(plan, (step) => step.startsWith("USE TEMP B-TREE FOR")),
  };
}

interface SortMeasurement {
  medianExecutionMs: number;
  p95ExecutionMs: number;
  maxExecutionMs: number;
  runsMs: number[];
  sortStep: string | undefined;
  representativePlan: ReturnType<typeof summarizePlan>;
  fullPlan: ExplainedPlan;
}

describe.skipIf(!shouldRun)(
  "transaction performance measurements (disposable SQLite)",
  () => {
    const pool = getTestPool();

    beforeAll(async () => {
      await withTransaction((client) => seedRepresentativeCorpus(client));
    }, 180_000);

    afterAll(async () => {
      await closeTestPool();
    });

    it("measures the four production transaction-list sort keys", async () => {
      const measurements: Record<string, SortMeasurement> = {};

      for (const [sortBy, expression] of Object.entries(sortExpressions)) {
        const sql = `${transactionProjection}
        ORDER BY ${expression} ASC, t.date DESC, t.id DESC
        LIMIT 50 OFFSET 0`;
        await explain(pool, sql);
        const plans: ExplainedPlan[] = [];
        for (let run = 0; run < REPETITIONS; run += 1) {
          plans.push(await explain(pool, sql));
        }
        const times = plans.map((plan) => plan.executionMs);
        const medianExecutionMs = median(times);
        const representative = plans.reduce((closest, candidate) =>
          Math.abs(candidate.executionMs - medianExecutionMs) <
          Math.abs(closest.executionMs - medianExecutionMs)
            ? candidate
            : closest,
        );
        const representativePlan = summarizePlan(representative);
        measurements[sortBy] = {
          medianExecutionMs,
          p95ExecutionMs: nearestRank(times, 95),
          maxExecutionMs: Math.max(...times),
          runsMs: times,
          sortStep: representativePlan.sortStep,
          representativePlan,
          fullPlan: representative,
        };
      }

      const printableMeasurements = Object.fromEntries(
        Object.entries(measurements).map(([sortBy, result]) => [
          sortBy,
          {
            medianExecutionMs: result.medianExecutionMs,
            p95ExecutionMs: result.p95ExecutionMs,
            maxExecutionMs: result.maxExecutionMs,
            runsMs: result.runsMs,
            ...result.representativePlan,
          },
        ]),
      );
      process.stdout.write(
        `\nTRANSACTION_SORT_EXPLAIN_SUMMARY=${JSON.stringify({
          scale: {
            transactions: ROW_COUNT,
            accounts: ACCOUNT_COUNT,
            recipients: RECIPIENT_COUNT,
            categories: CATEGORY_COUNT,
            repetitions: REPETITIONS,
          },
          measurements: printableMeasurements,
        })}\n`,
      );
      if (process.env.VISION_LOG_FULL_EXPLAIN === "1") {
        process.stdout.write(
          `TRANSACTION_SORT_EXPLAIN_JSON=${JSON.stringify(measurements)}\n`,
        );
      }

      for (const result of Object.values(measurements)) {
        expect(Number.isFinite(result.medianExecutionMs)).toBe(true);
        expect(result.representativePlan.actualRows).toBe(50);
        // No index serves these sort keys, so SQLite sorts in a temp B-tree
        // (its sorter keeps only the LIMIT rows, as PostgreSQL's top-N
        // heapsort did) after one pass over the active transactions.
        expect(result.sortStep).toBe("USE TEMP B-TREE FOR ORDER BY");
        expect(result.representativePlan.transactionScanStep).toBeDefined();
      }
    }, 180_000);

    it("compares the exact latest stamped-balance probe with and without its partial index", async () => {
      const target = await pool.query<IdRow>(
        "SELECT id FROM accounts WHERE name = 'PERF ACCOUNT 1'",
      );
      const targetId = must(target.rows[0], "target.rows[0]").id;
      const sql = `
      SELECT t.date, t.id
      FROM transactions t
      WHERE t.account_id = $1 AND t.is_active = 1
        AND t.date <= today()
        AND t.balance IS NOT NULL
      ORDER BY t.date DESC, t.id DESC
      LIMIT 1`;

      await explain(pool, sql, [targetId]);
      const withIndex = await explain(pool, sql, [targetId]);
      const withoutIndex = await inRollbackTransaction(async (client) => {
        await client.query("DROP INDEX idx_transactions_account_stamped");
        return explain(client, sql, [targetId]);
      });

      process.stdout.write(
        `\nSTAMPED_BALANCE_EXPLAIN_SUMMARY=${JSON.stringify({
          scale: {
            transactions: ROW_COUNT,
            targetAccountRows: ROW_COUNT / ACCOUNT_COUNT,
            targetStampedRows: ROW_COUNT / 2 / 2_000,
          },
          withIndex: summarizePlan(withIndex),
          withoutIndex: summarizePlan(withoutIndex),
        })}\n`,
      );
      if (process.env.VISION_LOG_FULL_EXPLAIN === "1") {
        process.stdout.write(
          `STAMPED_BALANCE_EXPLAIN_JSON=${JSON.stringify({
            withIndex,
            withoutIndex,
          })}\n`,
        );
      }

      expect(transactionScan(withIndex).index).toBe("idx_transactions_account_stamped");
      expect(transactionScan(withoutIndex).index).not.toBe("idx_transactions_account_stamped");
      expect(withIndex.actualRows).toBe(1);
      expect(withoutIndex.actualRows).toBe(1);
      expect(Number.isFinite(withIndex.executionMs)).toBe(true);
      expect(Number.isFinite(withoutIndex.executionMs)).toBe(true);
      // The rollback restored the production index.
      const { rows } = await pool.query(
        "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'idx_transactions_account_stamped'",
      );
      expect(rows).toHaveLength(1);
    });
  },
);
