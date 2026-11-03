#!/usr/bin/env bun
/**
 * Print the indexes of the transactions table with their columns and size.
 *
 * Feeds the "drop unused composites" follow-up. SQLite keeps no per-index
 * scan counters (PostgreSQL's pg_stat_user_indexes has no equivalent), so
 * check whether a query uses an index with `EXPLAIN QUERY PLAN` instead.
 * Sizes come from the dbstat virtual table when the SQLite build has it.
 *
 * Usage: bun run db:index-stats
 */

import { query, closePool } from "../src/database/connection.ts";

interface IndexRow {
  index_name: string;
  is_unique: number;
  is_partial: number;
  columns: string | null;
}

async function main() {
  const { rows } = await query<IndexRow>(
    `SELECT il.name AS index_name, il."unique" AS is_unique, il.partial AS is_partial,
            (SELECT group_concat(coalesce(ii.name, '<expr>'), ', ')
               FROM pragma_index_info(il.name) ii) AS columns
       FROM pragma_index_list('transactions') il
      ORDER BY il.name`,
  );

  if (rows.length === 0) {
    console.log("No indexes found on transactions table.");
    return;
  }

  let sizes = new Map<string, number>();
  try {
    const stat = await query<{ name: string; bytes: number }>(
      `SELECT name, sum(pgsize) AS bytes FROM dbstat GROUP BY name`,
    );
    sizes = new Map(stat.rows.map((r) => [r.name, r.bytes]));
  } catch {
    // This SQLite build has no dbstat table; sizes stay blank.
  }

  console.log("transactions indexes:");
  console.log("");
  console.table(
    rows.map((r) => ({
      index_name: r.index_name,
      unique: r.is_unique === 1,
      partial: r.is_partial === 1,
      columns: r.columns,
      size_kb: sizes.has(r.index_name) ? Math.round((sizes.get(r.index_name) ?? 0) / 1024) : "",
    })),
  );
  console.log("");
  console.log("Hint: SQLite has no index usage counters. Run the hot queries with");
  console.log("EXPLAIN QUERY PLAN to see which index each one uses before dropping one.");
}

main()
  .catch((err: unknown) => {
    console.error(
      "index-stats failed:",
      typeof err === "object" && err !== null && "message" in err
        ? err.message
        : undefined,
    );
    process.exitCode = 1;
  })
  .finally(() => closePool());
