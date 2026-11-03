/**
 * Transaction atomicity for the repo-composed write services (ADR-006/ADR-067).
 *
 * These services do not thread a client through their statements — they call
 * repository methods, which issue module-level query() and rely on the ambient
 * transaction context to land on the open transaction's connection. That is
 * exactly the property worth pinning: if any repo call silently ran outside
 * the transaction instead, it would survive the ROLLBACK and leave a
 * half-repointed ledger (an account merge that moved transactions but never
 * deleted the source, a recipient merge that moved money rows but never
 * flagged the alias).
 *
 * So these tests drive the real services against the real SQLite database
 * (ADR-263) and force a late failure inside the transaction with a TEMP
 * trigger on the writer connection. Each trigger's WHEN clause only fires once
 * every earlier write of the service is visible on that connection, so the
 * failure proves those writes ran inside the same transaction; the assertions
 * afterwards prove the ROLLBACK undid every one of them.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  closePool,
  getPoolStats,
  withTransaction,
} from "../../src/database/connection.ts";
import {
  closeTestPool,
  getTestPool,
  inRollbackTransaction,
  resetTestDatabase,
} from "../setup/db.ts";
import {
  asAccountId,
  asRecipientId,
  asTransactionId,
} from "@vision/types/brands";
import { must } from "../helpers/must.ts";

interface IdRow {
  id: number;
}

/**
 * Make the next matching row write fail. TEMP objects live on the connection
 * that created them, and every write runs on the single writer connection, so
 * creating the trigger in a write transaction arms it for the code under test.
 * resetTestDatabase() (beforeEach) closes the connections, which drops it.
 */
async function failLate(
  name: string,
  event: string,
  when: string,
  message: string,
): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `CREATE TEMP TRIGGER ${name} ${event} FOR EACH ROW WHEN ${when}
       BEGIN SELECT RAISE(ABORT, '${message}'); END`,
    );
  });
}

async function insertAccount(
  name: string,
  fundingAccountId: number | null = null,
): Promise<number> {
  const { rows } = await getTestPool().query<IdRow>(
    `INSERT INTO accounts (name, display_name, funding_account_id)
     VALUES ($1, $1, $2) RETURNING id`,
    [name, fundingAccountId],
  );
  return must(rows[0], "account row").id;
}

async function insertRecipient(
  name: string,
  primaryRecipientId: number | null = null,
): Promise<number> {
  const { rows } = await getTestPool().query<IdRow>(
    `INSERT INTO recipients (name, normalized_name, primary_recipient_id)
     VALUES (upper($1), lower($1), $2) RETURNING id`,
    [name, primaryRecipientId],
  );
  return must(rows[0], "recipient row").id;
}

async function insertTransaction(
  accountId: number,
  recipientId: number,
  amount: string,
): Promise<number> {
  const { rows } = await getTestPool().query<IdRow>(
    `INSERT INTO transactions (date, amount, currency, account_id, recipient_id)
     VALUES ('2026-03-31', vision_numeric($1, 18, 4), 'EUR', $2, $3) RETURNING id`,
    [amount, accountId, recipientId],
  );
  return must(rows[0], "transaction row").id;
}

async function one<R>(sql: string, params: readonly unknown[]): Promise<R> {
  const { rows } = await getTestPool().query<R>(sql, params);
  return must(rows[0], sql);
}

/** Hold the write lock in an open transaction until the returned release runs. */
async function holdWriteLock(): Promise<() => Promise<void>> {
  let signalHeld!: () => void;
  const held = new Promise<void>((resolve) => {
    signalHeld = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gate = withTransaction(async () => {
    signalHeld();
    await released;
  });
  await Promise.race([held, gate]);
  return async () => {
    release();
    await gate;
  };
}

async function waitForWriteWaiters(expected: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (getPoolStats().waitingCount >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${expected} write-lock waiter(s)`);
}

/** The ROLLBACK released the writer: nothing is held or queued afterwards. */
function expectWriterReleased(): void {
  expect(getPoolStats()).toMatchObject({ idleCount: 1, waitingCount: 0 });
}

beforeEach(async () => {
  await resetTestDatabase();
});

afterAll(async () => {
  await closeTestPool();
  await closePool();
});

describe("account merge atomicity (ADR-088)", () => {
  it("keeps hard-delete funding-edge cascades behind the write lock", async () => {
    const parent = await insertAccount("Delete parent");
    const dependent = await insertAccount("Delete dependent", parent);
    const { accountService } = await import("../../src/services/accountService.ts");

    const release = await holdWriteLock();
    let removing: Promise<number> | undefined;
    try {
      removing = accountService.remove(asAccountId(parent));
      await waitForWriteWaiters(1);
      // Queued, not run: the committed graph is untouched while the lock is held.
      expect(
        await one<{ funding_account_id: number | null }>(
          "SELECT funding_account_id FROM accounts WHERE id = $1",
          [dependent],
        ),
      ).toEqual({ funding_account_id: parent });
    } finally {
      await release();
    }
    await expect(removing).resolves.toBe(parent);
    // The ON DELETE SET NULL cascade committed with the delete.
    expect(
      await one<{ funding_account_id: number | null }>(
        "SELECT funding_account_id FROM accounts WHERE id = $1",
        [dependent],
      ),
    ).toEqual({ funding_account_id: null });
    expectWriterReleased();
  });

  it("keeps a funding PATCH validation and write inside one transaction", async () => {
    const a = await insertAccount("Funding A");
    const b = await insertAccount("Funding B");
    const { accountService } = await import("../../src/services/accountService.ts");

    // An uncommitted B → A edge is visible only on the transaction's own
    // connection: a validation read that escaped to the reader would miss it
    // and accept the A → B cycle.
    await inRollbackTransaction(async (client) => {
      await client.query("UPDATE accounts SET funding_account_id = $1 WHERE id = $2", [a, b]);
      await expect(
        accountService.update(asAccountId(a), { funding_account_id: b }),
      ).rejects.toThrow(/funding cycle/);
    });

    await failLate(
      "late_account_update",
      "BEFORE UPDATE OF funding_account_id ON accounts",
      `new.id = ${a} AND new.funding_account_id = ${b}`,
      "late account update failure",
    );
    await expect(
      accountService.update(asAccountId(a), { funding_account_id: b }),
    ).rejects.toThrow("late account update failure");

    const { rows } = await getTestPool().query<{ id: number; funding_account_id: number | null }>(
      "SELECT id, funding_account_id FROM accounts ORDER BY id",
      [],
    );
    expect(rows).toEqual([
      { id: a, funding_account_id: null },
      { id: b, funding_account_id: null },
    ]);
    expectWriterReleased();
  });

  it("rolls back every repoint when the source DELETE fails", async () => {
    const recipient = await insertRecipient("Merge payee");
    const target = await insertAccount("Merge target");
    const source = await insertAccount("Merge source");
    const dependent = await insertAccount("Merge dependent", source);
    const transaction = await insertTransaction(source, recipient, "-12.3400");
    const planned = await one<IdRow>(
      `INSERT INTO planned_transactions (planned_date, amount, currency, account_id, recipient_id)
       VALUES ('2026-04-30', vision_numeric('-50.5', 18, 4), 'EUR', $1, $2) RETURNING id`,
      [source, recipient],
    );
    const investment = await one<IdRow>(
      `INSERT INTO investments (name, asset_class) VALUES ('Merge fund', 'etf') RETURNING id`,
      [],
    );
    const lot = await one<IdRow>(
      `INSERT INTO portfolio_transactions (investment_id, type, date, amount, currency, account_id)
       VALUES ($1, 'buy', '2026-03-31', vision_numeric('100', 18, 4), 'EUR', $2) RETURNING id`,
      [investment.id, source],
    );

    // The realistic late failure: account_id FKs are ON DELETE RESTRICT, so a
    // missed reference makes the final DELETE raise after every repoint ran.
    // The WHEN clause fires only once every repoint is visible in the merge's
    // own transaction.
    await failLate(
      "late_source_delete",
      "BEFORE DELETE ON accounts",
      `old.id = ${source}
        AND EXISTS (SELECT 1 FROM transactions WHERE id = ${transaction} AND account_id = ${target})
        AND EXISTS (SELECT 1 FROM planned_transactions WHERE id = ${planned.id} AND account_id = ${target})
        AND EXISTS (SELECT 1 FROM portfolio_transactions WHERE id = ${lot.id} AND account_id = ${target})
        AND EXISTS (SELECT 1 FROM accounts WHERE id = ${dependent} AND funding_account_id = ${target})`,
      "late source delete failure",
    );

    const { mergeAccounts } = await import("../../src/services/accountMergeService.ts");
    await expect(
      mergeAccounts(asAccountId(target), [asAccountId(source)]),
    ).rejects.toThrow("late source delete failure");

    // The ROLLBACK undid every repoint, and the source survives.
    expect(
      await one("SELECT account_id, amount FROM transactions WHERE id = $1", [transaction]),
    ).toEqual({ account_id: source, amount: "-12.3400" });
    expect(
      await one("SELECT account_id, amount FROM planned_transactions WHERE id = $1", [planned.id]),
    ).toEqual({ account_id: source, amount: "-50.5000" });
    expect(
      await one("SELECT account_id FROM portfolio_transactions WHERE id = $1", [lot.id]),
    ).toEqual({ account_id: source });
    const { rows: accounts } = await getTestPool().query<{ id: number; funding_account_id: number | null }>(
      "SELECT id, funding_account_id FROM accounts ORDER BY id",
      [],
    );
    expect(accounts).toEqual([
      { id: target, funding_account_id: null },
      { id: source, funding_account_id: null },
      { id: dependent, funding_account_id: source },
    ]);
    expectWriterReleased();
  });
});

describe("recipient merge atomicity (ADR-014)", () => {
  it("rolls back the FK reassignments when the grandchild re-point fails", async () => {
    const primary = await insertRecipient("Merge primary");
    const source = await insertRecipient("Merge source");
    const grandchild = await insertRecipient("Merge grandchild", source);
    const account = await insertAccount("Recipient merge account");
    const transaction = await insertTransaction(account, source, "-40.0000");
    const split = await one<IdRow>(
      `INSERT INTO transaction_splits (transaction_id, recipient_id, amount)
       VALUES ($1, $2, vision_numeric('10.25', 18, 4)) RETURNING id`,
      [transaction, source],
    );
    const bankAccount = await one<IdRow>(
      `INSERT INTO recipient_bank_accounts (recipient_id, account_number)
       VALUES ($1, 'BE68539007547034') RETURNING id`,
      [source],
    );

    // Last statement of the merge — fails after every FK has been reassigned.
    await failLate(
      "late_grandchild_repoint",
      "BEFORE UPDATE OF primary_recipient_id ON recipients",
      `old.id = ${grandchild}
        AND EXISTS (SELECT 1 FROM transactions WHERE id = ${transaction} AND recipient_id = ${primary})
        AND EXISTS (SELECT 1 FROM transaction_splits WHERE id = ${split.id} AND recipient_id = ${primary})
        AND EXISTS (SELECT 1 FROM recipient_bank_accounts WHERE id = ${bankAccount.id} AND recipient_id = ${primary})
        AND EXISTS (SELECT 1 FROM recipients WHERE id = ${source} AND primary_recipient_id = ${primary})`,
      "late grandchild repoint failure",
    );

    const { mergeRecipients } = await import("../../src/services/recipientMergeService.ts");
    await expect(
      mergeRecipients(asRecipientId(primary), [asRecipientId(source)]),
    ).rejects.toThrow("late grandchild repoint failure");

    // Every money-bearing reassignment was undone with the alias flags.
    expect(
      await one("SELECT recipient_id, amount FROM transactions WHERE id = $1", [transaction]),
    ).toEqual({ recipient_id: source, amount: "-40.0000" });
    expect(
      await one("SELECT recipient_id, amount FROM transaction_splits WHERE id = $1", [split.id]),
    ).toEqual({ recipient_id: source, amount: "10.2500" });
    expect(
      await one("SELECT recipient_id FROM recipient_bank_accounts WHERE id = $1", [bankAccount.id]),
    ).toEqual({ recipient_id: source });
    const { rows: recipients } = await getTestPool().query<{ id: number; primary_recipient_id: number | null }>(
      "SELECT id, primary_recipient_id FROM recipients ORDER BY id",
      [],
    );
    expect(recipients).toEqual([
      { id: primary, primary_recipient_id: null },
      { id: source, primary_recipient_id: null },
      { id: grandchild, primary_recipient_id: source },
    ]);
    expectWriterReleased();
  });
});

describe("transfer mark atomicity (ADR-083)", () => {
  it("rolls back the released peers and the first leg when the second leg fails", async () => {
    const recipient = await insertRecipient("Transfer payee");
    const accountA = await insertAccount("Transfer A");
    const accountB = await insertAccount("Transfer B");
    const accountC = await insertAccount("Transfer C");
    const outflow = await insertTransaction(accountA, recipient, "-100.0000");
    const inflow = await insertTransaction(accountB, recipient, "100.0000");
    const priorPeer = await insertTransaction(accountC, recipient, "100.0000");
    // outflow ↔ priorPeer is an existing auto pair; markTransfer re-pairs
    // outflow with inflow and must release priorPeer.
    await getTestPool().query(
      `UPDATE transactions SET is_transfer = true, transfer_source = 'auto',
              transfer_peer_id = CASE id WHEN $1 THEN $2 ELSE $1 END
        WHERE id IN ($1, $2)`,
      [outflow, priorPeer],
    );

    // The SECOND manual leg fails, after the peer release and the first leg.
    await failLate(
      "late_second_leg",
      "BEFORE UPDATE ON transactions",
      `new.id = ${inflow} AND new.transfer_source = 'manual'
        AND EXISTS (SELECT 1 FROM transactions WHERE id = ${outflow}
                     AND transfer_source = 'manual' AND transfer_peer_id = ${inflow})
        AND EXISTS (SELECT 1 FROM transactions WHERE id = ${priorPeer} AND transfer_peer_id IS NULL)`,
      "late second leg failure",
    );

    const { markTransfer } = await import("../../src/services/transferReconciliationService.ts");
    await expect(
      markTransfer(asTransactionId(outflow), asTransactionId(inflow)),
    ).rejects.toThrow("late second leg failure");

    // The peer release and the first leg are undone together — without one
    // transaction, the outflow would stay marked against an unmarked peer, and
    // the prior counterpart released above would never come back.
    const { rows } = await getTestPool().query(
      `SELECT id, is_transfer, transfer_source, transfer_peer_id
         FROM transactions ORDER BY id`,
      [],
    );
    expect(rows).toEqual([
      { id: outflow, is_transfer: true, transfer_source: "auto", transfer_peer_id: priorPeer },
      { id: inflow, is_transfer: false, transfer_source: null, transfer_peer_id: null },
      { id: priorPeer, is_transfer: true, transfer_source: "auto", transfer_peer_id: outflow },
    ]);
    expectWriterReleased();
  });
});
