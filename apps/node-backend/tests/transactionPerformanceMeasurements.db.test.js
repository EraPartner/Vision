/**
 * Opt-in PostgreSQL 18 measurement harness for two performance acceptance items.
 *
 * Run only on the disposable database provisioned by scripts/with-test-db.sh:
 *
 *   VISION_RUN_PERFORMANCE_PROBES=1 bun run test:db \
 *     tests/transactionPerformanceMeasurements.db.test.js --reporter=verbose
 *
 * The corpus and every DDL change live in one transaction which is rolled back.
 * The stamped-balance comparison drops the existing production index only
 * inside that transaction, so the database is restored even if an assertion
 * fails. The logged JSON is the original EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
 * response and can be retained when a fresh hardware-specific plan is needed.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.js";

const ROW_COUNT = 120_000;
const ACCOUNT_COUNT = 20;
const RECIPIENT_COUNT = 1_000;
const CATEGORY_COUNT = 100;
const REPETITIONS = 20;

const shouldRun =
  hasTestDatabase() && process.env.VISION_RUN_PERFORMANCE_PROBES === "1";

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
  WHERE t.is_active = true`;

/** @param {import('pg').PoolClient} client */
async function seedRepresentativeCorpus(client) {
  await client.query(`
    CREATE TEMP TABLE perf_accounts AS
    WITH inserted AS (
      INSERT INTO accounts (name, display_name)
      SELECT 'PERF ACCOUNT ' || g, 'Performance account ' || g
      FROM generate_series(1, ${ACCOUNT_COUNT}) g
      RETURNING id, name
    )
    SELECT row_number() OVER (ORDER BY id)::int AS seq, id, name FROM inserted`);

  await client.query(`
    CREATE TEMP TABLE perf_categories AS
    WITH inserted AS (
      INSERT INTO categories (general, detail)
      SELECT 'PERF GROUP ' || ((g - 1) / 10), 'Performance category ' || g
      FROM generate_series(1, ${CATEGORY_COUNT}) g
      RETURNING id
    )
    SELECT row_number() OVER (ORDER BY id)::int AS seq, id FROM inserted`);

  await client.query(`
    CREATE TEMP TABLE perf_primary_recipients AS
    WITH inserted AS (
      INSERT INTO recipients (name, normalized_name, default_category_id)
      SELECT 'PERF RECIPIENT ' || g,
             'perf recipient ' || g,
             c.id
      FROM generate_series(1, ${RECIPIENT_COUNT / 2}) g
      JOIN perf_categories c ON c.seq = 1 + ((g - 1) % ${CATEGORY_COUNT})
      RETURNING id
    )
    SELECT row_number() OVER (ORDER BY id)::int AS seq, id FROM inserted`);

  await client.query(`
    CREATE TEMP TABLE perf_recipients AS
    WITH aliases AS (
      INSERT INTO recipients (name, normalized_name, primary_recipient_id)
      SELECT 'PERF ALIAS ' || p.seq,
             'perf alias ' || p.seq,
             p.id
      FROM perf_primary_recipients p
      RETURNING id
    ), all_recipients AS (
      SELECT id FROM perf_primary_recipients
      UNION ALL
      SELECT id FROM aliases
    )
    SELECT row_number() OVER (ORDER BY id)::int AS seq, id FROM all_recipients`);

  // The fixture explicitly supplies matching account_id/name pairs. Disabling
  // user triggers avoids measuring seed-maintenance work; query indexes and
  // foreign-key constraints remain active, and ROLLBACK restores trigger state.
  await client.query("ALTER TABLE transactions DISABLE TRIGGER USER");
  await client.query(`
    INSERT INTO transactions (
      date, amount, currency, balance, memo, bank_account,
      recipient_id, category_id, is_active, account_id
    )
    SELECT DATE '2000-01-01' + ((g - 1) / ${ACCOUNT_COUNT})::int,
           (((g % 20_001) - 10_000)::numeric / 100)::numeric(18, 4),
           (ARRAY['EUR', 'USD', 'GBP', 'CHF'])[1 + ((g - 1) % 4)],
           CASE
             WHEN a.seq = 1 AND g <= ${ROW_COUNT / 2} AND g % 2_000 = 1
               THEN (g::numeric / 100)::numeric(18, 4)
             ELSE NULL
           END,
           'PERF MEMO ' || lpad((g % 10_000)::text, 5, '0'),
           a.name,
           r.id,
           CASE WHEN g % 3 = 0 THEN c.id ELSE NULL END,
           g % 50 <> 0,
           a.id
    FROM generate_series(1, ${ROW_COUNT}) g
    JOIN perf_accounts a ON a.seq = 1 + ((g - 1) % ${ACCOUNT_COUNT})
    JOIN perf_recipients r ON r.seq = 1 + ((g - 1) % ${RECIPIENT_COUNT})
    JOIN perf_categories c ON c.seq = 1 + ((g - 1) % ${CATEGORY_COUNT})`);
  await client.query("ANALYZE transactions");
  await client.query("ANALYZE recipients");
  await client.query("ANALYZE categories");
  await client.query("ANALYZE accounts");
}

/** @param {import('pg').PoolClient} client @param {string} sql @param {unknown[]} [params] */
async function explain(client, sql, params = []) {
  const { rows } = await client.query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
    params,
  );
  return rows[0]["QUERY PLAN"][0];
}

/** @param {Record<string, unknown>} plan @param {(node: Record<string, unknown>) => boolean} predicate */
function findPlanNode(plan, predicate) {
  const pending = [plan.Plan];
  while (pending.length > 0) {
    const node = pending.pop();
    if (predicate(node)) return node;
    pending.push(...(node.Plans ?? []));
  }
  return undefined;
}

/** @param {number[]} values */
function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)];
}

/** @param {number[]} values @param {number} percentile */
function nearestRank(values, percentile) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.ceil((percentile / 100) * ordered.length) - 1];
}

/** @param {Record<string, unknown>} plan */
function summarizePlan(plan) {
  const sortNode = findPlanNode(plan, (node) => node["Node Type"] === "Sort");
  const transactionScan = findPlanNode(
    plan,
    (node) => node["Relation Name"] === "transactions",
  );
  return {
    executionMs: plan["Execution Time"],
    planningMs: plan["Planning Time"],
    rootNode: plan.Plan["Node Type"],
    transactionScanNode: transactionScan?.["Node Type"],
    transactionScanIndex: transactionScan?.["Index Name"],
    actualRows: plan.Plan["Actual Rows"],
    sharedHitBlocks: plan.Plan["Shared Hit Blocks"],
    sharedReadBlocks: plan.Plan["Shared Read Blocks"],
    tempReadBlocks: plan.Plan["Temp Read Blocks"],
    tempWrittenBlocks: plan.Plan["Temp Written Blocks"],
    sortMethod: sortNode?.["Sort Method"],
    sortSpaceKb: sortNode?.["Sort Space Used"],
  };
}

describe.skipIf(!shouldRun)(
  "transaction performance measurements (disposable PostgreSQL)",
  () => {
    /** @type {import('pg').PoolClient} */
    let client;

    beforeAll(async () => {
      expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
      await acquireDbSuiteLock();
      client = await getTestPool().connect();
      await client.query("BEGIN");
      await seedRepresentativeCorpus(client);
    }, 180_000);

    afterAll(async () => {
      if (client) {
        await client.query("ROLLBACK");
        client.release();
      }
      await releaseDbSuiteLock();
      await closeTestPool();
    });

    it("measures the four production transaction-list sort keys", async () => {
      const measurements = {};

      for (const [sortBy, expression] of Object.entries(sortExpressions)) {
        const sql = `${transactionProjection}
        ORDER BY ${expression} ASC, t.date DESC, t.id DESC
        LIMIT 50 OFFSET 0`;
        await explain(client, sql);
        const plans = [];
        for (let run = 0; run < REPETITIONS; run += 1) {
          plans.push(await explain(client, sql));
        }
        const times = plans.map((plan) => plan["Execution Time"]);
        const medianExecutionMs = median(times);
        const representative = plans.reduce((closest, candidate) =>
          Math.abs(candidate["Execution Time"] - medianExecutionMs) <
          Math.abs(closest["Execution Time"] - medianExecutionMs)
            ? candidate
            : closest,
        );
        const sortNode = findPlanNode(
          representative,
          (node) => node["Node Type"] === "Sort",
        );
        measurements[sortBy] = {
          medianExecutionMs,
          p95ExecutionMs: nearestRank(times, 95),
          maxExecutionMs: Math.max(...times),
          runsMs: times,
          sortMethod: sortNode?.["Sort Method"],
          sortSpaceKb: sortNode?.["Sort Space Used"],
          representativePlan: summarizePlan(representative),
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
        expect(result.sortMethod).toBe("top-N heapsort");
      }
    }, 180_000);

    it("compares the exact latest stamped-balance probe with and without its partial index", async () => {
      const target = await client.query(
        "SELECT id FROM perf_accounts WHERE seq = 1",
      );
      const sql = `
      SELECT t.date, t.id
      FROM transactions t
      WHERE t.account_id = $1 AND t.is_active = true
        AND t.date <= CURRENT_DATE
        AND t.balance IS NOT NULL
      ORDER BY t.date DESC, t.id DESC
      LIMIT 1`;

      await explain(client, sql, [target.rows[0].id]);
      const withIndex = await explain(client, sql, [target.rows[0].id]);
      await client.query("DROP INDEX idx_transactions_account_stamped");
      const withoutIndex = await explain(client, sql, [target.rows[0].id]);

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

      const indexedNode = findPlanNode(
        withIndex,
        (node) => node["Index Name"] === "idx_transactions_account_stamped",
      );
      expect(indexedNode).toBeDefined();
      expect(withoutIndex["Execution Time"]).toBeGreaterThan(
        withIndex["Execution Time"],
      );
    });
  },
);
