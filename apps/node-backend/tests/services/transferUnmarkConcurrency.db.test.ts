import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  closeTestPool,
  getTestPool,
} from "../setup/db.ts";
import { closePool, withTransaction } from "../../src/database/connection.ts";
import {
  markTransfer,
  unmarkTransfer,
} from "../../src/services/transferReconciliationService.ts";

import { transactionRepository } from "../../src/repositories/transactionRepository.ts";
import {
  asTransactionId,
} from "@vision/types/brands";
import { firstRow, must } from "../helpers/must.ts";

/**
 * Hold the single writer in an open write transaction until `release()`.
 *
 * PostgreSQL held one endpoint FOR UPDATE on a blocker connection and polled
 * pg_stat_activity until the concurrent calls queued on the row lock. Under
 * SQLite every withTransaction() is BEGIN IMMEDIATE on the one writer, so the
 * calls under test (started outside this callback, so they do not join it)
 * queue behind the writer instead, and each one runs its discovery, re-read and
 * writes as one serialized unit after the gate commits.
 */
async function holdWriter() {
  let release!: () => void;
  let held!: () => void;
  const isHeld = new Promise<void>((resolve) => {
    held = resolve;
  });
  const done = withTransaction(async () => {
    held();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  await isHeld;
  return { release, done };
}

/** Track how many of `work` have settled, for "still queued" assertions. */
function tracked<T>(work: Promise<T>[]) {
  const state = { settled: 0 };
  const outcomes = Promise.allSettled(
    work.map((promise) =>
      promise.finally(() => {
        state.settled += 1;
      }),
    ),
  );
  return { state, outcomes };
}

const QUEUED_MS = 100;

// Each test file runs on its own disposable SQLite database (tests/setup/db.ts);
// never the native personal data directory.
describe(
  "opposite-end transfer unmark concurrency",
  () => {
    const accounts: number[] = [];
    let recipientId: number;
    beforeAll(async () => {
      const name = `unmark-recipient-${crypto.randomUUID()}`;
      recipientId = firstRow(
        await must(getTestPool(), "getTestPool()").query<{ id: number }>(
          "INSERT INTO recipients(name,normalized_name) VALUES ($1,$1) RETURNING id",
          [name],
        ),
      ).id;
    }, 180_000);
    afterEach(async () => {
      await must(getTestPool(), "getTestPool()").query(
        "DELETE FROM transactions WHERE account_id IN (SELECT value FROM json_each($1))",
        [JSON.stringify(accounts)],
      );
      await must(getTestPool(), "getTestPool()").query(
        "DELETE FROM accounts WHERE id IN (SELECT value FROM json_each($1))",
        [JSON.stringify(accounts.splice(0))],
      );
    });
    afterAll(async () => {
      await must(getTestPool(), "getTestPool()").query("DELETE FROM recipients WHERE id = $1", [
        recipientId,
      ]);
      await closeTestPool();
      await closePool();
    });
    it("serializes opposite-end unmarks so the second sees the first's result", async () => {
      const pool = must(getTestPool(), "getTestPool()");
      for (let index = 0; index < 2; index++) {
        const result = await pool.query<{ id: number }>(
          "INSERT INTO accounts (name) VALUES ($1) RETURNING id",
          [`unmark-${crypto.randomUUID()}`],
        );
        accounts.push(must(result.rows[0], "row").id);
      }
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO transactions (date, amount, currency, account_id, recipient_id)
      VALUES ('2026-01-01', vision_numeric('-50', 18, 4), 'EUR', $1, $3),
             ('2026-01-01', vision_numeric('50', 18, 4), 'EUR', $2, $3) RETURNING id`,
        [...accounts, recipientId],
      );
      const a = must(rows[0], "row").id;
      const b = must(rows[1], "row").id;
      await markTransfer(asTransactionId(a), asTransactionId(b));
      const gate = await holdWriter();
      const { state, outcomes } = tracked([
        unmarkTransfer(asTransactionId(a)),
        unmarkTransfer(asTransactionId(b)),
      ]);
      try {
        await new Promise((done) => setTimeout(done, QUEUED_MS));
        // Both unmarks are queued behind the open write transaction; neither
        // has read (let alone changed) the pair yet.
        expect(state.settled).toBe(0);
        const pair = await pool.query(
          "SELECT is_transfer, transfer_source FROM transactions WHERE id IN (SELECT value FROM json_each($1)) ORDER BY id",
          [JSON.stringify([a, b])],
        );
        expect(pair.rows).toEqual([
          { is_transfer: true, transfer_source: "manual" },
          { is_transfer: true, transfer_source: "manual" },
        ]);
      } finally {
        gate.release();
        await gate.done;
      }
      const results = await outcomes;
      // Discovery now runs inside each unmark's write transaction, so it can
      // never be stale: the second unmark finds its leg already open and has
      // nothing left to release (PostgreSQL's stale-discovery 409 cannot occur).
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
      const final = await pool.query(
        "SELECT is_transfer, transfer_peer_id FROM transactions WHERE id IN (SELECT value FROM json_each($1)) ORDER BY id",
        [JSON.stringify([a, b])],
      );
      expect(final.rows).toEqual([
        { is_transfer: false, transfer_peer_id: null },
        { is_transfer: false, transfer_peer_id: null },
      ]);
      // Exactly one dismissal for the pair: the second unmark found no peer.
      const dismissals = await pool.query(
        "SELECT txn_a_id, txn_b_id FROM transfer_dismissals WHERE txn_a_id IN (SELECT value FROM json_each($1))",
        [JSON.stringify([a, b])],
      );
      expect(dismissals.rows).toEqual([
        { txn_a_id: Math.min(a, b), txn_b_id: Math.max(a, b) },
      ]);
    }, 15_000);
    it("preserves a valid manual repair committed while invalid-pair cleanup waits", async () => {
      const pool = must(getTestPool(), "getTestPool()");
      for (let index = 0; index < 2; index++) {
        const result = await pool.query<{ id: number }>("INSERT INTO accounts (name) VALUES ($1) RETURNING id", [`cleanup-${crypto.randomUUID()}`]);
        accounts.push(must(result.rows[0], "row").id);
      }
      const { rows } = await pool.query<{ id: number }>(`INSERT INTO transactions (date, amount, currency, account_id, recipient_id)
        VALUES ('2026-01-01', vision_numeric('-50', 18, 4), 'EUR', $1, $3),
               ('2026-01-01', vision_numeric('60', 18, 4), 'EUR', $2, $3) RETURNING id`, [...accounts, recipientId]);
      const a = must(rows[0], "row").id;
      const b = must(rows[1], "row").id;
      await pool.query(`UPDATE transactions SET is_transfer=true, transfer_source='auto',
        transfer_peer_id=CASE WHEN id=$1 THEN $2 ELSE $1 END WHERE id IN (SELECT value FROM json_each($3))`, [a, b, JSON.stringify([a, b])]);
      let release!: () => void;
      let ready!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const prepared = new Promise<void>((resolve) => { ready = resolve; });
      const repair = withTransaction(async () => {
        await markTransfer(asTransactionId(a), asTransactionId(b));
        ready();
        await gate;
      });
      await Promise.race([prepared, repair]);
      // Started outside the repair's callback: its own write transaction, which
      // waits for the writer (PostgreSQL: a row lock on the invalid pair).
      const { state, outcomes } = tracked([
        transactionRepository.releaseInvalidAutoTransferPairs(3),
      ]);
      try {
        await new Promise((done) => setTimeout(done, QUEUED_MS));
        expect(state.settled).toBe(0);
      } finally {
        release();
        await repair;
      }
      expect((await outcomes).map((result) => result.status)).toEqual(["fulfilled"]);
      const final = await pool.query(`SELECT id, is_transfer, transfer_source, transfer_peer_id
        FROM transactions WHERE id IN (SELECT value FROM json_each($1)) ORDER BY id`, [JSON.stringify([a, b])]);
      expect(final.rows).toEqual([
        { id: a, is_transfer: true, transfer_source: "manual", transfer_peer_id: b },
        { id: b, is_transfer: true, transfer_source: "manual", transfer_peer_id: a },
      ]);
    }, 15_000);
    it("serializes crossed repairs so no endpoint is left as a one-way transfer", async () => {
      const pool = must(getTestPool(), "getTestPool()");
      for (let index = 0; index < 4; index++) {
        const result = await pool.query<{ id: number }>(
          "INSERT INTO accounts (name) VALUES ($1) RETURNING id",
          [`repair-${crypto.randomUUID()}`],
        );
        accounts.push(must(result.rows[0], "row").id);
      }
      const inserted = await pool.query<{ id: number }>(
        `INSERT INTO transactions (date, amount, currency, account_id, recipient_id)
      VALUES ('2026-01-01', vision_numeric('-50', 18, 4), 'EUR', $1, $5),
             ('2026-01-01', vision_numeric('50', 18, 4), 'EUR', $2, $5),
             ('2026-01-01', vision_numeric('50', 18, 4), 'EUR', $3, $5),
             ('2026-01-01', vision_numeric('-50', 18, 4), 'EUR', $4, $5) RETURNING id`,
        [...accounts, recipientId],
      );
      const [a, x, b, y] = inserted.rows.map((row) => row.id) as [
        number,
        number,
        number,
        number,
      ];
      await markTransfer(asTransactionId(a), asTransactionId(x));
      await markTransfer(asTransactionId(b), asTransactionId(y));
      const gate = await holdWriter();
      const { state, outcomes } = tracked([
        markTransfer(asTransactionId(a), asTransactionId(b)),
        markTransfer(asTransactionId(x), asTransactionId(y)),
      ]);
      try {
        await new Promise((done) => setTimeout(done, QUEUED_MS));
        expect(state.settled).toBe(0);
      } finally {
        gate.release();
        await gate.done;
      }
      const results = await outcomes;
      // Each re-pair discovers, re-reads and releases all four endpoints inside
      // one serialized write transaction, so the second one sees the first's
      // released legs as open and pairs them: both succeed (PostgreSQL's
      // stale-discovery 409 cannot occur), and the crossed graph ends as A-B and
      // X-Y with reciprocal pointers.
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
      const remaining = await pool.query(
        `SELECT t.id FROM transactions t WHERE t.account_id IN (SELECT value FROM json_each($1))
      AND t.is_transfer AND NOT EXISTS (SELECT 1 FROM transactions p WHERE p.id=t.transfer_peer_id AND p.transfer_peer_id=t.id)`,
        [JSON.stringify(accounts)],
      );
      expect(remaining.rows).toEqual([]);
      const paired = await pool.query<{ id: number; transfer_peer_id: number | null; transfer_source: string | null }>(
        "SELECT id, transfer_peer_id, transfer_source FROM transactions WHERE account_id IN (SELECT value FROM json_each($1)) AND is_transfer ORDER BY id",
        [JSON.stringify(accounts)],
      );
      expect(paired.rows).toEqual(
        [
          { id: a, transfer_peer_id: b, transfer_source: "manual" },
          { id: x, transfer_peer_id: y, transfer_source: "manual" },
          { id: b, transfer_peer_id: a, transfer_source: "manual" },
          { id: y, transfer_peer_id: x, transfer_source: "manual" },
        ].sort((left, right) => left.id - right.id),
      );
    }, 15_000);
  },
);
