/**
 * Real-Postgres tests for the ADR-088 account_id contract across planned
 * transactions, split owed views, and transaction export. Both the fresh
 * compatibility schema and the manually contracted schema must work: the
 * canonical tables are written through account_id only, while API-facing
 * bank_account labels are projected from accounts.name.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.js";
import { transactionRepository } from "../src/repositories/transactionRepository.js";
import plannedTransactionPersistence from "../src/repositories/plannedTransactionRepository.js";
import plannedTransactionService from "../src/services/plannedTransactionService.js";
import splitPersistence from "../src/repositories/splitRepository.js";
import splitService from "../src/services/splitService.js";
import { streamCsvExport } from "../src/services/transactionExport.js";
import { buildTransactionWhere } from "../src/lib/filterBuilder.js";
import { closePool } from "../src/database/connection.js";

const describeDb = hasTestDatabase() ? describe : describe.skip;
const plannedTransactionRepository = {
  ...plannedTransactionPersistence,
  ...plannedTransactionService,
};
const splitRepository = { ...splitPersistence, ...splitService };

const fx = {};

async function seedCorpus() {
  const pool = getTestPool();
  const { rows: rec } = await pool.query(
    `INSERT INTO recipients (name, normalized_name) VALUES ('Landlord', 'landlord') RETURNING id`,
  );
  fx.recipientId = rec[0].id;

  // Two accounts with mixed-case display names and stable IDs.
  for (const name of ["KBC Current", "Wise USD"]) {
    await pool.query(
      `INSERT INTO accounts (name, display_name) VALUES ($1, $1)
       ON CONFLICT (lower(btrim(name))) DO NOTHING`,
      [name],
    );
  }
  const { rows: accounts } = await pool.query("SELECT id, name FROM accounts");
  for (const row of accounts) fx[row.name] = row.id;

  // Transactions on both accounts + currencies. Canonical writes do not
  // require the retired compatibility column or its trigger.
  const t = await pool.query(
    `INSERT INTO transactions (date, amount, currency, recipient_id, account_id, memo)
     VALUES ('2026-01-10', '-750.00', 'EUR', $1, $2, 'RENT JANUARY'),
            ('2026-01-12', '-45.10', 'USD', $1, $3, 'US SUBSCRIPTION')
     RETURNING id`,
    [fx.recipientId, fx["KBC Current"], fx["Wise USD"]],
  );
  fx.txnKbc = t.rows[0].id;
  fx.txnWise = t.rows[1].id;

  // Planned rows on both accounts.
  const p = await pool.query(
    `INSERT INTO planned_transactions (planned_date, amount, currency, recipient_id, account_id, memo, is_executed, is_active)
     VALUES ('2026-02-01', '-750.00', 'EUR', $1, $2, 'RENT FEBRUARY', false, true),
            ('2026-02-05', '-45.10', 'USD', $1, $3, 'US SUB FEBRUARY', false, true)
     RETURNING id`,
    [fx.recipientId, fx["KBC Current"], fx["Wise USD"]],
  );
  fx.plannedKbc = p.rows[0].id;
  fx.plannedWise = p.rows[1].id;

  // One unsettled split on the KBC transaction, owed by the recipient.
  const s = await pool.query(
    `INSERT INTO transaction_splits (transaction_id, recipient_id, amount, is_settled)
     VALUES ($1, $2, '100.00', false) RETURNING id`,
    [fx.txnKbc, fx.recipientId],
  );
  fx.splitId = s.rows[0].id;
}

async function renameKbc(name) {
  await getTestPool().query(
    "UPDATE accounts SET name = $1, display_name = $1 WHERE id = $2",
    [name, fx["KBC Current"]],
  );
}

/** Minimal Express-response stand-in capturing the streamed body. */
function captureRes() {
  const chunks = [];
  return {
    body: () => chunks.join(""),
    setHeader() {},
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    end() {},
  };
}

describeDb(
  "ADR-088 string decouple across planned/splits/export (real DB)",
  () => {
    beforeAll(async () => {
      expect(
        process.env.DATABASE_URL,
        "DATABASE_URL must equal TEST_DATABASE_URL for this suite (see scripts/with-test-db.sh)",
      ).toBe(process.env.TEST_DATABASE_URL);
      await acquireDbSuiteLock();
    }, 180_000);

    beforeEach(seedCorpus);

    afterEach(async () => {
      const pool = getTestPool();
      await pool.query("DELETE FROM split_payments");
      await pool.query("DELETE FROM transaction_splits");
      await pool.query("DELETE FROM planned_transactions");
      await pool.query("DELETE FROM transactions");
      await pool.query("DELETE FROM accounts");
      await pool.query("DELETE FROM recipients");
      for (const k of Object.keys(fx)) delete fx[k];
    });

    afterAll(async () => {
      await releaseDbSuiteLock();
      await closeTestPool();
      await closePool();
    });

    describe("plannedTransactionRepository", () => {
      it("bankAccount filter follows accounts.name after a rename", async () => {
        await renameKbc("KBC Renamed");
        const kbc = await plannedTransactionRepository.getAll({
          bankAccount: "renamed",
        });
        expect(kbc.items.map((r) => r.id)).toEqual([fx.plannedKbc]);
        expect(kbc.total).toBe(1);
        const oldName = await plannedTransactionRepository.getAll({
          bankAccount: "current",
        });
        expect(oldName.items).toHaveLength(0);
        expect(oldName.total).toBe(0);
      });

      it("search follows the canonical account name after a rename", async () => {
        await renameKbc("KBC Renamed");
        const byName = await plannedTransactionRepository.getAll({
          search: "kbc renamed",
        });
        expect(byName.items.map((r) => r.id)).toEqual([fx.plannedKbc]);
        const byOldName = await plannedTransactionRepository.getAll({
          search: "kbc current",
        });
        expect(byOldName.items).toHaveLength(0);
      });

      it("getAll/getById/getDueSoon project bank_account from accounts.name", async () => {
        await renameKbc("KBC Renamed");
        const { items } = await plannedTransactionRepository.getAll({});
        const byId = Object.fromEntries(items.map((r) => [r.id, r]));
        expect(byId[fx.plannedKbc].bank_account).toBe("KBC Renamed");
        expect(byId[fx.plannedWise].bank_account).toBe("Wise USD");
        expect(
          (await plannedTransactionRepository.getById(fx.plannedKbc))
            .bank_account,
        ).toBe("KBC Renamed");
        // Both rows are in the future relative to 2026-02 fixtures only when
        // CURRENT_DATE precedes them; getDueSoon is exercised for projection
        // shape only when it returns rows, so guard on that.
        const due = await plannedTransactionRepository.getDueSoon(365);
        for (const row of due) {
          expect(["KBC Renamed", "Wise USD"]).toContain(row.bank_account);
        }
      });

      it("update() and create() project the selected account's name", async () => {
        const updated = await plannedTransactionRepository.update(
          fx.plannedKbc,
          { memo: "RENT FEB (EDITED)" },
        );
        expect(updated.bank_account).toBe("KBC Current");

        const created = await plannedTransactionRepository.create({
          planned_date: "2026-03-01",
          account_id: fx["KBC Current"],
          recipient_id: fx.recipientId,
          amount: "-750.00",
          memo: "rent march",
          currency: "EUR",
        });
        expect(created.account_id).toBe(fx["KBC Current"]);
        expect(created.bank_account).toBe("KBC Current");
        const { rows } = await getTestPool().query(
          "SELECT account_id FROM planned_transactions WHERE id = $1",
          [created.id],
        );
        expect(rows[0].account_id).toBe(fx["KBC Current"]);
      });
    });

    describe("UPDATE-path FK integrity", () => {
      it("transaction update repoints the FK and exposes the target account's label", async () => {
        const updated = await transactionRepository.update(fx.txnKbc, {
          account_id: fx["Wise USD"],
        });
        expect(updated.account_id).toBe(fx["Wise USD"]);
        expect(updated.bank_account).toBe("Wise USD");

        const { rows } = await getTestPool().query(
          `SELECT t.account_id, a.name
           FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE t.id = $1`,
          [fx.txnKbc],
        );
        expect(rows[0].account_id).toBe(fx["Wise USD"]);
        expect(rows[0].name).toBe("Wise USD");
        expect(
          (await transactionRepository.getById(fx.txnKbc)).bank_account,
        ).toBe("Wise USD");
        const filtered = await transactionRepository.getAll({
          bankAccount: "wise usd",
        });
        expect(filtered.map((r) => r.id).sort()).toEqual(
          [fx.txnKbc, fx.txnWise].sort(),
        );
      });

      it("transaction update to an existing account_id does not mint an account", async () => {
        const { rows: before } = await getTestPool().query(
          "SELECT count(*)::int AS n FROM accounts",
        );
        const updated = await transactionRepository.update(fx.txnKbc, {
          account_id: fx["Wise USD"],
        });
        expect(updated.account_id).toBe(fx["Wise USD"]);
        expect(updated.bank_account).toBe("Wise USD");
        const { rows: after } = await getTestPool().query(
          "SELECT count(*)::int AS n FROM accounts",
        );
        expect(after[0].n).toBe(before[0].n);
      });

      it("planned update and updateWithLoanSchedule repoint by account_id", async () => {
        const updated = await plannedTransactionRepository.update(
          fx.plannedKbc,
          { account_id: fx["Wise USD"] },
        );
        const { rows } = await getTestPool().query(
          `SELECT p.account_id, a.name FROM planned_transactions p
           JOIN accounts a ON a.id = p.account_id WHERE p.id = $1`,
          [fx.plannedKbc],
        );
        expect(rows[0].account_id).toBe(fx["Wise USD"]);
        expect(rows[0].name).toBe("Wise USD");
        expect(updated.bank_account).toBe("Wise USD");
        const filtered = await plannedTransactionRepository.getAll({
          bankAccount: "wise usd",
        });
        expect(filtered.items.map((r) => r.id).sort()).toEqual(
          [fx.plannedKbc, fx.plannedWise].sort(),
        );

        const viaSchedule =
          await plannedTransactionRepository.updateWithLoanSchedule(
            fx.plannedWise,
            { account_id: fx["KBC Current"] },
            [],
          );
        expect(viaSchedule.account_id).toBe(fx["KBC Current"]);
        expect(viaSchedule.bank_account).toBe("KBC Current");
        const { rows: sched } = await getTestPool().query(
          `SELECT p.account_id, a.name FROM planned_transactions p JOIN accounts a ON a.id = p.account_id WHERE p.id = $1`,
          [fx.plannedWise],
        );
        expect(sched[0].account_id).toBe(fx["KBC Current"]);
        expect(sched[0].name).toBe("KBC Current");
      });

      it("a legacy label-only repository update cannot change canonical identity", async () => {
        await transactionRepository.update(fx.txnKbc, {
          bank_account: "Ignored Label",
        });
        await plannedTransactionRepository.update(fx.plannedKbc, {
          bank_account: "Ignored Label",
        });
        const { rows } = await getTestPool().query(
          `SELECT (SELECT account_id FROM transactions WHERE id = $1) AS transaction_account_id,
                  (SELECT account_id FROM planned_transactions WHERE id = $2) AS planned_account_id`,
          [fx.txnKbc, fx.plannedKbc],
        );
        expect(rows[0].transaction_account_id).toBe(fx["KBC Current"]);
        expect(rows[0].planned_account_id).toBe(fx["KBC Current"]);
        const { rows: n } = await getTestPool().query(
          `SELECT count(*)::int AS n FROM accounts WHERE lower(btrim(name)) = 'ignored label'`,
        );
        expect(n[0].n).toBe(0);
      });
    });

    describe("splitRepository owed views", () => {
      it("getOwedByRecipient / export rows read the label via the FK", async () => {
        await renameKbc("KBC Renamed");
        const owed = await splitRepository.getOwedByRecipient(fx.recipientId);
        expect(owed).toHaveLength(1);
        expect(owed[0].bank_account).toBe("KBC Renamed");

        const exportRows = await splitRepository.getOwedExportRowsByRecipient(
          fx.recipientId,
        );
        expect(exportRows).toHaveLength(1);
        expect(exportRows[0].bank_account).toBe("KBC Renamed");
      });
    });

    describe("transaction CSV export", () => {
      it("streams the canonical account label and filters bank_accounts via the FK", async () => {
        await renameKbc("KBC Renamed");

        // Unfiltered: both rows, labels from accounts.name.
        const resAll = captureRes();
        const whereAll = buildTransactionWhere({});
        await streamCsvExport(resAll, {
          whereSql: whereAll.sql,
          params: whereAll.params,
          nextParamIdx: whereAll.nextParamIdx,
        });
        expect(resAll.body()).toContain("KBC Renamed");
        expect(resAll.body()).toContain("Wise USD");
        expect(resAll.body()).not.toContain("KBC Current");

        // The label filter resolves names to canonical account IDs.
        const resKbc = captureRes();
        const whereKbc = buildTransactionWhere({
          bankAccounts: ["KBC Renamed"],
        });
        await streamCsvExport(resKbc, {
          whereSql: whereKbc.sql,
          params: whereKbc.params,
          nextParamIdx: whereKbc.nextParamIdx,
        });
        expect(resKbc.body()).toContain("RENT JANUARY");
        expect(resKbc.body()).not.toContain("US SUBSCRIPTION");
      });
    });

    describe("canonical identity invariant", () => {
      it("all fixture transactions and plans have valid account foreign keys", async () => {
        const pool = getTestPool();
        const { rows: a } = await pool.query(
          `SELECT count(*)::int AS n FROM transactions t
           LEFT JOIN accounts a ON a.id = t.account_id
           WHERE t.id = ANY($1::bigint[])
             AND (t.account_id IS NULL OR a.id IS NULL)`,
          [[fx.txnKbc, fx.txnWise]],
        );
        const { rows: b } = await pool.query(
          `SELECT count(*)::int AS n FROM planned_transactions p
           LEFT JOIN accounts a ON a.id = p.account_id
           WHERE p.id = ANY($1::bigint[])
             AND (p.account_id IS NULL OR a.id IS NULL)`,
          [[fx.plannedKbc, fx.plannedWise]],
        );
        expect(a[0].n).toBe(0);
        expect(b[0].n).toBe(0);
      });
    });
  },
);
