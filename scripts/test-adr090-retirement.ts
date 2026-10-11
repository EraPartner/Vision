#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import type * as Pg from "../apps/node-backend/node_modules/@types/pg/index.d.ts";

type Row = Record<string, unknown>;

// pg is a backend dependency; resolve it (and its published types) from there.
const pg: typeof Pg = createRequire(
  path.join(import.meta.dirname, "..", "apps", "node-backend", "package.json"),
)("pg");
const { Client } = pg;
const RETIREMENT_REVISION = "0102_retire_adr090_transaction_schema";
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
const target = new URL(databaseUrl);
if (
  target.hostname !== "127.0.0.1" ||
  target.pathname.replace(/^\//, "") !== "vision_test"
) {
  throw new Error(
    "ADR-090 lifecycle test requires the disposable loopback vision_test database",
  );
}

function migrate(
  args: string[],
  { shouldPass }: { shouldPass: boolean },
): void {
  const result = spawnSync(
    "bun",
    ["run", "apps/node-backend/scripts/db-migrate.ts", ...args],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  if ((result.status === 0) !== shouldPass) {
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
      .replace(/postgres(?:ql)?:\/\/[^\s]+/g, "[REDACTED_DATABASE_URL]")
      .trim();
    throw new Error(
      `Migration ${args.join(" ")} ${shouldPass ? "failed" : "unexpectedly passed"}${
        output ? `:\n${output}` : ""
      }`,
    );
  }
}

/** The `id` an `INSERT … RETURNING id` produced. */
function insertedId(result: Pg.QueryResult<Row>): unknown {
  const row = result.rows[0];
  if (!row) throw new Error("INSERT … RETURNING id returned no row");
  return row.id;
}

const client = new Client({ connectionString: databaseUrl });
await client.connect();
let atRetirement = true;
try {
  migrate(["downgrade", "-1"], { shouldPass: true });
  atRetirement = false;

  const recipient = await client.query<Row>(
    `INSERT INTO recipients (name, normalized_name)
     VALUES ('ADR090 migration fixture', 'adr090 migration fixture')
     RETURNING id`,
  );
  const recipientId = insertedId(recipient);

  const trade = await client.query<Row>(
    `INSERT INTO transactions
       (date, amount, currency, recipient_id, is_transfer, transfer_source)
     VALUES (CURRENT_DATE, 1, 'EUR', $1, true, 'trade')
     RETURNING id`,
    [recipientId],
  );
  migrate(["upgrade", RETIREMENT_REVISION], { shouldPass: false });
  expectSingle(
    await client.query(
      "SELECT portfolio_transaction_id FROM transactions WHERE id = $1 AND transfer_source = 'trade'",
      [insertedId(trade)],
    ),
    "trade-source refusal must preserve the row and schema",
  );
  await client.query("DELETE FROM transactions WHERE id = $1", [
    insertedId(trade),
  ]);

  const linked = await client.query<Row>(
    `INSERT INTO transactions
       (date, amount, currency, recipient_id, portfolio_transaction_id)
     VALUES (CURRENT_DATE, 1, 'EUR', $1, 987654)
     RETURNING id`,
    [recipientId],
  );
  migrate(["upgrade", RETIREMENT_REVISION], { shouldPass: false });
  expectSingle(
    await client.query(
      "SELECT portfolio_transaction_id FROM transactions WHERE id = $1 AND portfolio_transaction_id = 987654",
      [insertedId(linked)],
    ),
    "linked-row refusal must preserve the row and schema",
  );
  await client.query("DELETE FROM transactions WHERE id = $1", [
    insertedId(linked),
  ]);
  await client.query("DELETE FROM recipients WHERE id = $1", [recipientId]);

  migrate(["upgrade", RETIREMENT_REVISION], { shouldPass: true });
  atRetirement = true;
  const removed = await client.query<Row>(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'transactions'
        AND column_name = 'portfolio_transaction_id'`,
  );
  if (removed.rowCount !== 0)
    throw new Error("Successful upgrade did not remove the link column");

  migrate(["downgrade", "-1"], { shouldPass: true });
  atRetirement = false;
  const restored = await client.query<Row>(
    `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE conrelid = 'public.transactions'::regclass
        AND conname = 'chk_transactions_transfer_source'`,
  );
  expectSingle(
    restored,
    "downgrade did not restore the transfer-source constraint",
  );
  const definition = restored.rows[0]?.definition;
  if (!(typeof definition === "string" && definition.includes("'trade'::text")))
    throw new Error("Downgrade did not restore the trade compatibility value");

  const restoredColumn = await client.query<Row>(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'transactions'
        AND column_name = 'portfolio_transaction_id'`,
  );
  expectSingle(restoredColumn, "downgrade did not restore the link column");
  const restoredIndex = await client.query<Row>(
    `SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'transactions'
        AND indexname = 'idx_transactions_portfolio_txn'`,
  );
  expectSingle(restoredIndex, "downgrade did not restore the partial index");
  const indexdef = restoredIndex.rows[0]?.indexdef;
  if (!(
    typeof indexdef === "string" &&
    indexdef.includes("portfolio_transaction_id IS NOT NULL")
  ))
    throw new Error(
      "Downgrade restored the link index without its partial predicate",
    );

  migrate(["upgrade", RETIREMENT_REVISION], { shouldPass: true });
  atRetirement = true;
  console.log(
    "ADR-090 migration refusal, rollback, and success lifecycle passed.",
  );
} finally {
  if (!atRetirement) {
    await client
      .query(
        "DELETE FROM transactions WHERE portfolio_transaction_id = 987654 OR transfer_source = 'trade'",
      )
      .catch(() => {});
    await client
      .query(
        "DELETE FROM recipients WHERE normalized_name = 'adr090 migration fixture'",
      )
      .catch(() => {});
    migrate(["upgrade", RETIREMENT_REVISION], { shouldPass: true });
  }
  await client.end();
}

function expectSingle(result: Pg.QueryResult<Row>, message: string): void {
  if (result.rowCount !== 1) throw new Error(message);
}
