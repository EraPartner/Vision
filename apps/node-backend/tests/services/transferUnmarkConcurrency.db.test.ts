import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
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

// Synthetic disposable TEST_DATABASE_URL only; never the native personal stack.
describe.skipIf(!hasTestDatabase())(
  "opposite-end transfer unmark concurrency",
  () => {
    const accounts: number[] = [];
    let recipientId: number;
    beforeAll(async () => {
      expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
      await acquireDbSuiteLock();
      const name = `unmark-recipient-${crypto.randomUUID()}`;
      recipientId = (
        await getTestPool()!.query(
          "INSERT INTO recipients(name,normalized_name) VALUES ($1,$1) RETURNING id",
          [name],
        )
      ).rows[0].id as number;
    }, 180_000);
    afterEach(async () => {
      await getTestPool()!.query(
        "DELETE FROM transactions WHERE account_id = ANY($1::int[])",
        [accounts],
      );
      await getTestPool()!.query(
        "DELETE FROM accounts WHERE id = ANY($1::int[])",
        [accounts.splice(0)],
      );
    });
    afterAll(async () => {
      await getTestPool()!.query("DELETE FROM recipients WHERE id = $1", [
        recipientId,
      ]);
      await releaseDbSuiteLock();
      await closeTestPool();
      await closePool();
    });
    it("locks both endpoints in one order and returns a retry conflict for stale discovery", async () => {
      const pool = getTestPool()!;
      for (let index = 0; index < 2; index++) {
        const result = await pool.query(
          "INSERT INTO accounts (name) VALUES ($1) RETURNING id",
          [`unmark-${crypto.randomUUID()}`],
        );
        accounts.push(result.rows[0].id as number);
      }
      const { rows } = await pool.query(
        `INSERT INTO transactions (date, amount, currency, account_id, recipient_id)
      VALUES ('2026-01-01', -50, 'EUR', $1, $3), ('2026-01-01', 50, 'EUR', $2, $3) RETURNING id`,
        [...accounts, recipientId],
      );
      const a = rows[0].id as number;
      const b = rows[1].id as number;
      await markTransfer(asTransactionId(a), asTransactionId(b));
      const blocker = await pool.connect();
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT id FROM transactions WHERE id=$1 FOR UPDATE",
        [Math.min(a, b)],
      );
      const outcomes = Promise.allSettled([
        unmarkTransfer(asTransactionId(a)),
        unmarkTransfer(asTransactionId(b)),
      ]);
      try {
        const deadline = Date.now() + 5000;
        let blocked = false;
        while (Date.now() < deadline) {
          const waiting =
            await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock'
            AND query ~* '^\\s*select.*transfer_peer_id.*for update'`);
          if (waiting.rows[0].n >= 2) {
            blocked = true;
            break;
          }
          await new Promise((done) => setTimeout(done, 10));
        }
        expect(blocked).toBe(true);
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
      }
      const results = await outcomes;
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const failure = results.find((result) => result.status === "rejected");
      expect(
        failure?.status === "rejected" ? failure.reason : undefined,
      ).toMatchObject({ status: 409 });
      const final = await pool.query(
        "SELECT is_transfer, transfer_peer_id FROM transactions WHERE id=ANY($1::int[])",
        [[a, b]],
      );
      expect(final.rows).toEqual([
        { is_transfer: false, transfer_peer_id: null },
        { is_transfer: false, transfer_peer_id: null },
      ]);
    }, 15_000);
    it("preserves a valid manual repair committed while invalid-pair cleanup waits", async () => {
      const pool = getTestPool()!;
      for (let index = 0; index < 2; index++) {
        const result = await pool.query("INSERT INTO accounts (name) VALUES ($1) RETURNING id", [`cleanup-${crypto.randomUUID()}`]);
        accounts.push(result.rows[0].id as number);
      }
      const { rows } = await pool.query(`INSERT INTO transactions (date, amount, currency, account_id, recipient_id)
        VALUES ('2026-01-01', -50, 'EUR', $1, $3), ('2026-01-01', 60, 'EUR', $2, $3) RETURNING id`, [...accounts, recipientId]);
      const a = rows[0].id as number;
      const b = rows[1].id as number;
      await pool.query(`UPDATE transactions SET is_transfer=true, transfer_source='auto',
        transfer_peer_id=CASE WHEN id=$1 THEN $2 ELSE $1 END WHERE id=ANY($3::int[])`, [a, b, [a, b]]);
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
      const cleanup = transactionRepository.releaseInvalidAutoTransferPairs(3);
      try {
        let blocked = false;
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const waiting = await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname=current_database() AND wait_event_type='Lock'
              AND query ~* '^\\s*select "?id"? from "?transactions"?.*for update'`);
          if (waiting.rows[0].n > 0) { blocked = true; break; }
          await new Promise((done) => setTimeout(done, 10));
        }
        expect(blocked).toBe(true);
      } finally {
        release();
        await Promise.all([repair, cleanup]);
      }
      const final = await pool.query(`SELECT id, is_transfer, transfer_source, transfer_peer_id
        FROM transactions WHERE id=ANY($1::int[]) ORDER BY id`, [[a, b]]);
      expect(final.rows).toEqual([
        { id: a, is_transfer: true, transfer_source: "manual", transfer_peer_id: b },
        { id: b, is_transfer: true, transfer_source: "manual", transfer_peer_id: a },
      ]);
    }, 15_000);
    it("serializes crossed repairs by locking all four affected endpoints before release", async () => {
      const pool = getTestPool()!;
      for (let index = 0; index < 4; index++) {
        const result = await pool.query(
          "INSERT INTO accounts (name) VALUES ($1) RETURNING id",
          [`repair-${crypto.randomUUID()}`],
        );
        accounts.push(result.rows[0].id as number);
      }
      const inserted = await pool.query(
        `INSERT INTO transactions (date, amount, currency, account_id, recipient_id)
      VALUES ('2026-01-01', -50, 'EUR', $1, $5), ('2026-01-01', 50, 'EUR', $2, $5),
             ('2026-01-01', 50, 'EUR', $3, $5), ('2026-01-01', -50, 'EUR', $4, $5) RETURNING id`,
        [...accounts, recipientId],
      );
      const [a, x, b, y] = inserted.rows.map((row) => row.id as number) as [
        number,
        number,
        number,
        number,
      ];
      await markTransfer(asTransactionId(a), asTransactionId(x));
      await markTransfer(asTransactionId(b), asTransactionId(y));
      const blocker = await pool.connect();
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT id FROM transactions WHERE id=$1 FOR UPDATE",
        [Math.min(a, x, b, y)],
      );
      const outcomes = Promise.allSettled([
        markTransfer(asTransactionId(a), asTransactionId(b)),
        markTransfer(asTransactionId(x), asTransactionId(y)),
      ]);
      try {
        const deadline = Date.now() + 5000;
        let blocked = false;
        while (Date.now() < deadline) {
          const waiting =
            await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock'
            AND query ~* '^\\s*select.*transfer_peer_id.*for update'`);
          if (waiting.rows[0].n >= 2) {
            blocked = true;
            break;
          }
          await new Promise((done) => setTimeout(done, 10));
        }
        expect(blocked).toBe(true);
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
      }
      const results = await outcomes;
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const failure = results.find((result) => result.status === "rejected");
      expect(
        failure?.status === "rejected" ? failure.reason : undefined,
      ).toMatchObject({ status: 409 });
      const remaining = await pool.query(
        `SELECT t.id FROM transactions t WHERE t.account_id=ANY($1::int[])
      AND t.is_transfer AND NOT EXISTS (SELECT 1 FROM transactions p WHERE p.id=t.transfer_peer_id AND p.transfer_peer_id=t.id)`,
        [accounts],
      );
      expect(remaining.rows).toEqual([]);
      const paired = await pool.query(
        "SELECT id FROM transactions WHERE account_id=ANY($1::int[]) AND is_transfer",
        [accounts],
      );
      expect(paired.rows).toHaveLength(2);
    }, 15_000);
  },
);
