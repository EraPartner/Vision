/**
 * Real-Postgres tests for the ADR-088 contract-phase READ decouple outside
 * transactionRepository (which pins its own flip in
 * transactionRepository.db.test.js): plannedTransactionRepository,
 * splitRepository's owed views, the CSV/NDJSON export SQL, and the recurring
 * detection feed must all bind to `account_id` + `accounts.name`, never to the
 * retired `bank_account` string.
 *
 * The falsification pattern mirrors transactionRepository.db.test.js: a
 * raw-SQL UPDATE stamps a stale label with NO matching account onto a row —
 * the 0062 lookup-only trigger leaves account_id untouched — so any read that
 * still consults the string is betrayed by 'STALE LABEL' surfacing (or by the
 * real account failing to match).
 *
 * Also pins the runbook's parity/soak invariant on the corpus these suites
 * write: no row may carry a label string without a resolved account_id
 * (alembic/manual/contract_drop_bank_account/README.md §"Do NOT run until").
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

  // Two accounts with mixed-case display names, pre-created so the sync
  // trigger resolves rather than mints (0066 normalized identity).
  for (const name of ["KBC Current", "Wise USD"]) {
    await pool.query(
      `INSERT INTO accounts (name, display_name) VALUES ($1, $1)
       ON CONFLICT (lower(btrim(name))) DO NOTHING`,
      [name],
    );
  }
  const { rows: accounts } = await pool.query("SELECT id, name FROM accounts");
  for (const row of accounts) fx[row.name] = row.id;

  // Transactions on both accounts + currencies (the trigger resolves the FK
  // from the label case-insensitively, as production inserts do).
  const t = await pool.query(
    `INSERT INTO transactions (date, amount, currency, recipient_id, bank_account, memo)
     VALUES ('2026-01-10', '-750.00', 'EUR', $1, 'KBC CURRENT', 'RENT JANUARY'),
            ('2026-01-12', '-45.10', 'USD', $1, 'WISE USD', 'US SUBSCRIPTION')
     RETURNING id`,
    [fx.recipientId],
  );
  fx.txnKbc = t.rows[0].id;
  fx.txnWise = t.rows[1].id;

  // Planned rows on both accounts.
  const p = await pool.query(
    `INSERT INTO planned_transactions (planned_date, amount, currency, recipient_id, bank_account, memo, is_executed, is_active)
     VALUES ('2026-02-01', '-750.00', 'EUR', $1, 'KBC CURRENT', 'RENT FEBRUARY', false, true),
            ('2026-02-05', '-45.10', 'USD', $1, 'WISE USD', 'US SUB FEBRUARY', false, true)
     RETURNING id`,
    [fx.recipientId],
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

/**
 * Desynchronize a row's string from its FK: the stale label matches no
 * account, and the lookup-only UPDATE trigger leaves account_id alone.
 */
async function desync(table, id) {
  const pool = getTestPool();
  await pool.query(
    `UPDATE ${table} SET bank_account = 'STALE LABEL' WHERE id = $1`,
    [id],
  );
  const { rows } = await pool.query(
    `SELECT account_id, bank_account FROM ${table} WHERE id = $1`,
    [id],
  );
  expect(rows[0].bank_account).toBe("STALE LABEL");
  expect(rows[0].account_id).toBe(fx["KBC Current"]);
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
      it("bankAccount filter matches via accounts.name, not the row string", async () => {
        await desync("planned_transactions", fx.plannedKbc);
        const kbc = await plannedTransactionRepository.getAll({
          bankAccount: "kbc",
        });
        expect(kbc.items.map((r) => r.id)).toEqual([fx.plannedKbc]);
        expect(kbc.total).toBe(1);
        const stale = await plannedTransactionRepository.getAll({
          bankAccount: "stale",
        });
        expect(stale.items).toHaveLength(0);
        expect(stale.total).toBe(0);
      });

      it("search matches the canonical account name, not the stale string", async () => {
        await desync("planned_transactions", fx.plannedKbc);
        const byName = await plannedTransactionRepository.getAll({
          search: "kbc curr",
        });
        expect(byName.items.map((r) => r.id)).toEqual([fx.plannedKbc]);
        const byStale = await plannedTransactionRepository.getAll({
          search: "stale lab",
        });
        expect(byStale.items).toHaveLength(0);
      });

      it("getAll/getById/getDueSoon project bank_account from accounts.name", async () => {
        await desync("planned_transactions", fx.plannedKbc);
        const { items } = await plannedTransactionRepository.getAll({});
        const byId = Object.fromEntries(items.map((r) => [r.id, r]));
        expect(byId[fx.plannedKbc].bank_account).toBe("KBC Current");
        expect(byId[fx.plannedWise].bank_account).toBe("Wise USD");
        expect(
          (await plannedTransactionRepository.getById(fx.plannedKbc))
            .bank_account,
        ).toBe("KBC Current");
        // Both rows are in the future relative to 2026-02 fixtures only when
        // CURRENT_DATE precedes them; getDueSoon is exercised for projection
        // shape only when it returns rows, so guard on that.
        const due = await plannedTransactionRepository.getDueSoon(365);
        for (const row of due) {
          expect(["KBC Current", "Wise USD"]).toContain(row.bank_account);
        }
      });

      it("update() returns the canonical label, and creating against an existing account reuses it", async () => {
        const updated = await plannedTransactionRepository.update(
          fx.plannedKbc,
          { memo: "RENT FEB (EDITED)" },
        );
        expect(updated.bank_account).toBe("KBC Current");

        // create() still dual-writes the (uppercased) string; the trigger
        // resolves it case-insensitively onto the existing account and the READ
        // surfaces the canonical casing.
        const created = await plannedTransactionRepository.create({
          planned_date: "2026-03-01",
          bank_account: "kbc current",
          recipient_id: fx.recipientId,
          amount: "-750.00",
          memo: "rent march",
          currency: "EUR",
        });
        expect(created.account_id).toBe(fx["KBC Current"]);
        expect(created.bank_account).toBe("KBC Current");
        const { rows } = await getTestPool().query(
          "SELECT bank_account FROM planned_transactions WHERE id = $1",
          [created.id],
        );
        expect(rows[0].bank_account).toBe("KBC CURRENT"); // dual-write string, pre-drop
      });
    });

    describe("UPDATE-path FK resolution (ghost-row fix)", () => {
      // The 0062 sync trigger is lookup-only on UPDATE (never creates), so a
      // PATCH that renames a row to a FIRST-SEEN label used to leave the FK
      // stale/NULL — the edit "took" in the string but every flipped read kept
      // showing the old account, and no filter could find the typed label.
      // update()/updateWithLoanSchedule now resolve-or-create and stamp
      // account_id in the same SET (stampAccountIdForUpdate).

      it("transaction PATCH to a first-seen label mints the account, moves the FK, and is visible on read", async () => {
        const updated = await transactionRepository.update(fx.txnKbc, {
          bank_account: "Brand New Label",
        });
        expect(updated.bank_account).toBe("Brand New Label"); // the PATCH response itself

        const { rows } = await getTestPool().query(
          `SELECT t.bank_account, t.account_id, a.name
           FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE t.id = $1`,
          [fx.txnKbc],
        );
        expect(rows[0].bank_account).toBe("Brand New Label"); // dual-write string
        expect(rows[0].name).toBe("Brand New Label"); // FK moved to the minted account

        // Reads see the edit — and the label is findable.
        expect(
          (await transactionRepository.getById(fx.txnKbc)).bank_account,
        ).toBe("Brand New Label");
        const filtered = await transactionRepository.getAll({
          bankAccount: "brand new",
        });
        expect(filtered.map((r) => r.id)).toEqual([fx.txnKbc]);
        // Exactly one account minted for the label.
        const { rows: n } = await getTestPool().query(
          `SELECT count(*)::int AS n FROM accounts WHERE lower(btrim(name)) = 'brand new label'`,
        );
        expect(n[0].n).toBe(1);
      });

      it("transaction PATCH to an existing label (case variant) reuses the account", async () => {
        const updated = await transactionRepository.update(fx.txnKbc, {
          bank_account: "wise usd",
        });
        expect(updated.account_id).toBe(fx["Wise USD"]);
        expect(updated.bank_account).toBe("Wise USD"); // canonical casing on read
      });

      it("transaction PATCH blanking the label detaches the FK", async () => {
        const updated = await transactionRepository.update(fx.txnKbc, {
          bank_account: null,
        });
        expect(updated.account_id).toBeNull();
        expect(updated.bank_account).toBeNull();
      });

      it("planned PATCH (update and updateWithLoanSchedule) resolves first-seen labels onto the FK", async () => {
        const updated = await plannedTransactionRepository.update(
          fx.plannedKbc,
          { bank_account: "Planned Fresh Label" },
        );
        const { rows } = await getTestPool().query(
          `SELECT p.account_id, a.name FROM planned_transactions p
           JOIN accounts a ON a.id = p.account_id WHERE p.id = $1`,
          [fx.plannedKbc],
        );
        expect(rows[0].name).toBe("Planned Fresh Label");
        expect(updated.bank_account).toBe("Planned Fresh Label");
        const filtered = await plannedTransactionRepository.getAll({
          bankAccount: "planned fresh",
        });
        expect(filtered.items.map((r) => r.id)).toEqual([fx.plannedKbc]);

        const viaSchedule =
          await plannedTransactionRepository.updateWithLoanSchedule(
            fx.plannedWise,
            { bank_account: "Sched Fresh Label" },
            [],
          );
        expect(viaSchedule.bank_account).toBe("Sched Fresh Label");
        const { rows: sched } = await getTestPool().query(
          `SELECT a.name FROM planned_transactions p JOIN accounts a ON a.id = p.account_id WHERE p.id = $1`,
          [fx.plannedWise],
        );
        expect(sched[0].name).toBe("Sched Fresh Label");
      });

      it("a PATCH label edit keeps the parity invariant (no string-without-FK ghosts)", async () => {
        await transactionRepository.update(fx.txnKbc, {
          bank_account: "Parity Probe Label",
        });
        await plannedTransactionRepository.update(fx.plannedKbc, {
          bank_account: "Parity Probe Label",
        });
        const { rows } = await getTestPool().query(
          `SELECT (SELECT count(*) FROM transactions WHERE bank_account IS NOT NULL AND account_id IS NULL)::int
              + (SELECT count(*) FROM planned_transactions WHERE bank_account IS NOT NULL AND account_id IS NULL)::int AS n`,
        );
        expect(rows[0].n).toBe(0);
        // And both rows share ONE account.
        const { rows: n } = await getTestPool().query(
          `SELECT count(*)::int AS n FROM accounts WHERE lower(btrim(name)) = 'parity probe label'`,
        );
        expect(n[0].n).toBe(1);
      });
    });

    describe("splitRepository owed views", () => {
      it("getOwedByRecipient / export rows read the label via the FK", async () => {
        await desync("transactions", fx.txnKbc);
        const owed = await splitRepository.getOwedByRecipient(fx.recipientId);
        expect(owed).toHaveLength(1);
        expect(owed[0].bank_account).toBe("KBC Current");

        const exportRows = await splitRepository.getOwedExportRowsByRecipient(
          fx.recipientId,
        );
        expect(exportRows).toHaveLength(1);
        expect(exportRows[0].bank_account).toBe("KBC Current");
      });
    });

    describe("transaction CSV export", () => {
      it("streams the canonical account label and filters bank_accounts via the FK", async () => {
        await desync("transactions", fx.txnKbc);

        // Unfiltered: both rows, labels from accounts.name.
        const resAll = captureRes();
        const whereAll = buildTransactionWhere({});
        await streamCsvExport(resAll, {
          whereSql: whereAll.sql,
          params: whereAll.params,
          nextParamIdx: whereAll.nextParamIdx,
        });
        expect(resAll.body()).toContain("KBC Current");
        expect(resAll.body()).toContain("Wise USD");
        expect(resAll.body()).not.toContain("STALE LABEL");

        // Plural exact filter (legacy escape hatch) resolves names → ids: the
        // desynced KBC row still matches its account's canonical name.
        const resKbc = captureRes();
        const whereKbc = buildTransactionWhere({
          bankAccounts: ["KBC Current"],
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

    describe("runbook parity invariant", () => {
      it("the soak queries return zero on everything these fixtures wrote", async () => {
        const pool = getTestPool();
        const { rows: a } = await pool.query(
          `SELECT count(*)::int AS n FROM transactions WHERE bank_account IS NOT NULL AND account_id IS NULL`,
        );
        const { rows: b } = await pool.query(
          `SELECT count(*)::int AS n FROM planned_transactions WHERE bank_account IS NOT NULL AND account_id IS NULL`,
        );
        expect(a[0].n).toBe(0);
        expect(b[0].n).toBe(0);
      });
    });
  },
);
