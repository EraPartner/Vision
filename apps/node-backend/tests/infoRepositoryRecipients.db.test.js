/**
 * Real-Postgres tests for infoRepositoryRecipients — `getRecipientInsights`,
 * `getRecipientByYear` and `getRecipientPivot`.
 *
 * DB-backed complement to infoRepositoryRecipients.test.js (which stays: it runs
 * without a DB). That mock suite stubs `convertRowsToEur` and hand-feeds the
 * per-currency rows it wants, so it exercises the JS reducers and the SQL text
 * only. Every behaviour below instead comes out of the real schema: the alias
 * roll-up `COALESCE(pr.id, r.id)` against real `recipients.primary_recipient_id`
 * links, the expense/active/transfer predicates, the month-over-month
 * like-for-like window arithmetic done in Postgres, `EXTRACT(YEAR …)` bucketing,
 * `TO_CHAR` period keys, the alias-member narrowing round-trip, and FX resolved
 * from seeded `exchange_rates` rows.
 *
 * `getRecipientInsights`'s MoM window is anchored on `CURRENT_DATE`, so those
 * fixtures are dated by SQL expressions relative to it; the by-year and pivot
 * queries have no date window, so those use literal calendar dates.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.js";
import { recipientInsightsRepository } from "../src/repositories/infoRepositoryRecipients.js";
import { clearMvCache } from "../src/repositories/infoRepositoryHelpers.js";
import { clearMemoryCache } from "../src/services/currency/currencyConversionService.js";
import { closePool } from "../src/database/connection.js";

const cat = {};
const rec = {};

/**
 * Categories plus the alias topology:
 *   Delhaize        — PRIMARY
 *   Delhaize Wilrijk — ALIAS of Delhaize (spend rolls up to the primary)
 *   Colruyt         — plain recipient, default category Food
 *   Electrabel      — plain recipient, default category Bills
 */
async function seedBase() {
  const pool = getTestPool();
  for (const [key, [general, detail]] of Object.entries({
    Food: ["Food", "Groceries"],
    Bills: ["Bills", "Utilities"],
  })) {
    const { rows } = await pool.query(
      "INSERT INTO categories (general, detail) VALUES ($1, $2) RETURNING id",
      [general, detail],
    );
    cat[key] = rows[0].id;
  }
  const addRecipient = async (
    name,
    { defaultCategoryId = null, primaryId = null } = {},
  ) => {
    const { rows } = await pool.query(
      `INSERT INTO recipients (name, normalized_name, default_category_id, primary_recipient_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [name, name.toLowerCase(), defaultCategoryId, primaryId],
    );
    return rows[0].id;
  };
  rec.delhaize = await addRecipient("Delhaize");
  rec.delhaizeAlias = await addRecipient("Delhaize Wilrijk", {
    primaryId: rec.delhaize,
  });
  rec.colruyt = await addRecipient("Colruyt", { defaultCategoryId: cat.Food });
  rec.electrabel = await addRecipient("Electrabel", {
    defaultCategoryId: cat.Bills,
  });
}

async function ensureAccount(name) {
  await getTestPool().query(
    `INSERT INTO accounts (name, display_name) VALUES ($1, $1)
     ON CONFLICT (lower(btrim(name))) DO NOTHING`,
    [name],
  );
}

/**
 * Insert one transaction. Exactly one of `date` (literal 'YYYY-MM-DD') or
 * `dateExpr` (a SQL expression, for the CURRENT_DATE-anchored MoM window) is
 * given. `recipientId: null` writes a recipient-less row on purpose.
 */
async function insertTxn({
  date = null,
  dateExpr = null,
  amount,
  currency = "EUR",
  recipientId,
  categoryId = null,
  bank = "MAIN BANK",
  isActive = true,
  isTransfer = false,
}) {
  if (bank) await ensureAccount(bank);
  const dateSql = dateExpr ? `(${dateExpr})::date` : "$6::date";
  const params = [
    amount,
    currency,
    recipientId,
    categoryId,
    bank,
    ...(dateExpr ? [] : [date]),
    isActive,
    isTransfer,
  ];
  const n = dateExpr ? 6 : 7;
  const { rows } = await getTestPool().query(
    `INSERT INTO transactions (amount, currency, recipient_id, category_id, bank_account, date, is_active, is_transfer)
     VALUES ($1, $2, $3, $4, $5, ${dateSql}, $${n}, $${n + 1}) RETURNING id`,
    params,
  );
  return rows[0].id;
}

/** Seed one exchange_rates row so conversion resolves from the DB, never the network. */
async function insertRate(code, date, rate, isLatest = false) {
  await getTestPool().query(
    `INSERT INTO exchange_rates (currency_code, rate_date, rate_to_eur, is_latest)
     VALUES ($1, $2::date, $3, $4)`,
    [code, date, rate, isLatest],
  );
}

const merchant = (result, name) =>
  result.topMerchants.find((m) => m.name === name);
const mom = (result, name) =>
  result.monthOverMonth.find((m) => m.name === name);

describe.skipIf(!hasTestDatabase())(
  "repositories/infoRepositoryRecipients (real DB)",
  () => {
    beforeAll(async () => {
      expect(
        process.env.DATABASE_URL,
        "DATABASE_URL must equal TEST_DATABASE_URL for this suite (see scripts/with-test-db.sh)",
      ).toBe(process.env.TEST_DATABASE_URL);
      // DB suites share one database across parallel vitest workers — serialize.
      await acquireDbSuiteLock();
    }, 180_000);

    afterEach(async () => {
      const pool = getTestPool();
      await pool.query("DELETE FROM transactions");
      await pool.query("DELETE FROM accounts");
      await pool.query("DELETE FROM recipients");
      await pool.query("DELETE FROM categories");
      await pool.query("DELETE FROM exchange_rates");
      await pool.query(
        `DELETE FROM user_settings WHERE key = 'includeTransfers'`,
      );
      for (const bag of [cat, rec])
        for (const k of Object.keys(bag)) delete bag[k];
      clearMemoryCache();
      clearMvCache();
    });

    afterAll(async () => {
      await releaseDbSuiteLock();
      await closeTestPool();
      await closePool();
    });

    // ───────────────────────────────────────────────────────────────────────────
    // getRecipientInsights — top merchants
    // ───────────────────────────────────────────────────────────────────────────
    describe("getRecipientInsights / topMerchants", () => {
      it("rolls alias spend up to the primary and reports count, average and seen-dates", async () => {
        await seedBase();
        await insertTxn({
          date: "2024-01-15",
          amount: "-100.00",
          recipientId: rec.delhaize,
        });
        await insertTxn({
          date: "2024-03-20",
          amount: "-50.00",
          recipientId: rec.delhaizeAlias,
        });
        await insertTxn({
          date: "2024-02-01",
          amount: "-40.00",
          recipientId: rec.colruyt,
        });

        const r = await recipientInsightsRepository.getRecipientInsights("EUR");
        expect(r.topMerchants.map((m) => m.name)).toEqual([
          "Delhaize",
          "Colruyt",
        ]); // desc by spend
        expect(merchant(r, "Delhaize")).toMatchObject({
          recipientId: rec.delhaize, // the alias id never surfaces
          totalSpend: 150,
          transactionCount: 2,
          avgAmount: 75,
          firstSeen: "2024-01-15",
          lastSeen: "2024-03-20", // widened by the alias row
        });
        expect(typeof merchant(r, "Delhaize").firstSeen).toBe("string"); // wire dates, not pg Dates
      });

      it("counts only active negative-amount rows and never internal transfers", async () => {
        await seedBase();
        await insertTxn({
          date: "2024-01-10",
          amount: "-30.00",
          recipientId: rec.colruyt,
        });
        await insertTxn({
          date: "2024-01-11",
          amount: "1000.00",
          recipientId: rec.colruyt,
        }); // income
        await insertTxn({
          date: "2024-01-12",
          amount: "-999.00",
          recipientId: rec.colruyt,
          isActive: false,
        });
        await insertTxn({
          date: "2024-01-13",
          amount: "-500.00",
          recipientId: rec.colruyt,
          isTransfer: true,
        });
        // ADR-083's includeTransfers toggle governs cash-flow aggregates, NOT this
        // merchant lens — turning it on must not pull the transfer leg in.
        await getTestPool().query(
          `INSERT INTO user_settings (key, value) VALUES ('includeTransfers', 'true'::jsonb)`,
        );

        const r = await recipientInsightsRepository.getRecipientInsights("EUR");
        expect(merchant(r, "Colruyt")).toMatchObject({
          totalSpend: 30,
          transactionCount: 1,
        });
      });

      it("merges a recipient spanning two currencies into one row", async () => {
        await seedBase();
        await insertRate("USD", "2024-01-15", "0.5", true);
        await insertTxn({
          date: "2024-01-15",
          amount: "-100.00",
          recipientId: rec.colruyt,
        });
        await insertTxn({
          date: "2024-01-15",
          amount: "-100.00",
          currency: "USD",
          recipientId: rec.colruyt,
        });

        const r = await recipientInsightsRepository.getRecipientInsights("EUR");
        expect(r.topMerchants).toHaveLength(1);
        expect(merchant(r, "Colruyt")).toMatchObject({
          totalSpend: 150,
          transactionCount: 2,
          avgAmount: 75,
        });
      });

      it("applies 3-level category exclusions and alias-aware recipient exclusions", async () => {
        await seedBase();
        // Categorised only via its recipient's default (2nd level).
        await insertTxn({
          date: "2024-01-10",
          amount: "-40.00",
          recipientId: rec.colruyt,
        });
        await insertTxn({
          date: "2024-01-10",
          amount: "-60.00",
          recipientId: rec.electrabel,
        });
        await insertTxn({
          date: "2024-01-10",
          amount: "-10.00",
          recipientId: rec.delhaizeAlias,
        });

        const exclFood = await recipientInsightsRepository.getRecipientInsights(
          "EUR",
          {
            excludedCategoryIds: [cat.Food],
          },
        );
        expect(exclFood.topMerchants.map((m) => m.name).sort()).toEqual([
          "Delhaize",
          "Electrabel",
        ]);

        // Excluding the PRIMARY also removes rows recorded under its alias.
        const exclPrimary =
          await recipientInsightsRepository.getRecipientInsights("EUR", {
            excludedRecipientIds: [rec.delhaize],
          });
        expect(exclPrimary.topMerchants.map((m) => m.name).sort()).toEqual([
          "Colruyt",
          "Electrabel",
        ]);
      });

      // Was PIN 1 — the three recipient surfaces disagreed on FX. getRecipientByYear
      // and getRecipientPivot both pass `{ useHistoricalRatesByDate: true,
      // dateField: 'date' }`, converting each row at the rate for ITS date;
      // top merchants passed no options at all and converted every row at the
      // CURRENT `is_latest` rate, so one USD purchase read 90 in "Top merchants"
      // and 25 in "Top recipients by year" / the recipient pivot on the same page.
      // The top-merchants query now carries `t.date` in its GROUP BY so it can be
      // converted per date like its siblings.
      it("converts top merchants at each row date historical rate, agreeing with by-year and pivot", async () => {
        await seedBase();
        await insertRate("USD", "2024-06-01", "0.25");
        await insertRate("USD", "2026-01-01", "0.90", true);
        await insertTxn({
          date: "2024-06-01",
          amount: "-100.00",
          currency: "USD",
          recipientId: rec.colruyt,
        });

        const insights =
          await recipientInsightsRepository.getRecipientInsights("EUR");
        const byYear = await recipientInsightsRepository.getRecipientByYear({
          targetCurrency: "EUR",
        });
        const pivot = await recipientInsightsRepository.getRecipientPivot({
          targetCurrency: "EUR",
        });

        expect(merchant(insights, "Colruyt").totalSpend).toBe(25); // 2024-06-01 rate, not the latest 0.90
        expect(byYear.recipientsByYear["2024"][0].totalSpend).toBe(25);
        expect(pivot.recipientPivot["2024-06"][0].total).toBe(25);
      });

      // Per-date conversion must not disturb the per-recipient reduction: two
      // purchases on DIFFERENT dates at different rates still collapse into one
      // merchant row whose count, average and first/last-seen bounds span both.
      it("sums a recipient across dates at each date own rate, keeping count and seen-dates", async () => {
        await seedBase();
        await insertRate("USD", "2024-06-01", "0.25");
        await insertRate("USD", "2024-09-01", "0.50");
        await insertRate("USD", "2026-01-01", "0.90", true);
        await insertTxn({
          date: "2024-06-01",
          amount: "-100.00",
          currency: "USD",
          recipientId: rec.colruyt,
        });
        await insertTxn({
          date: "2024-09-01",
          amount: "-100.00",
          currency: "USD",
          recipientId: rec.colruyt,
        });

        const r = await recipientInsightsRepository.getRecipientInsights("EUR");
        expect(r.topMerchants).toHaveLength(1);
        expect(merchant(r, "Colruyt")).toMatchObject({
          totalSpend: 75, // 25 + 50, not 2 x 90 at the latest rate
          transactionCount: 2,
          avgAmount: 37.5,
          firstSeen: "2024-06-01",
          lastSeen: "2024-09-01",
        });
      });
    });

    // ───────────────────────────────────────────────────────────────────────────
    // getRecipientInsights — month over month
    // ───────────────────────────────────────────────────────────────────────────
    describe("getRecipientInsights / monthOverMonth", () => {
      it("reports only recipients present in BOTH periods, with the percentage change", async () => {
        await seedBase();
        await insertTxn({
          dateExpr: `date_trunc('month', CURRENT_DATE)`,
          amount: "-60.00",
          recipientId: rec.colruyt,
        });
        await insertTxn({
          dateExpr: `date_trunc('month', CURRENT_DATE) - interval '1 month'`,
          amount: "-40.00",
          recipientId: rec.colruyt,
        });
        // Current month only → no comparison possible.
        await insertTxn({
          dateExpr: `date_trunc('month', CURRENT_DATE)`,
          amount: "-30.00",
          recipientId: rec.electrabel,
        });
        // Previous month only.
        await insertTxn({
          dateExpr: `date_trunc('month', CURRENT_DATE) - interval '1 month'`,
          amount: "-25.00",
          recipientId: rec.delhaize,
        });

        const r = await recipientInsightsRepository.getRecipientInsights("EUR");
        expect(r.monthOverMonth).toEqual([
          {
            recipientId: rec.colruyt,
            name: "Colruyt",
            currentSpend: 60,
            previousSpend: 40,
            changePercent: 50,
          },
        ]);
      });

      it("caps the previous month at the same day-of-month as today (like-for-like)", async () => {
        await seedBase();
        const pool = getTestPool();
        const { rows } = await pool.query(`
        SELECT to_char(
                 (date_trunc('month', CURRENT_DATE) - INTERVAL '1 month')::date
                 + (CURRENT_DATE - DATE_TRUNC('month', CURRENT_DATE)::date), 'YYYY-MM-DD') AS cap,
               ((date_trunc('month', CURRENT_DATE) - INTERVAL '1 month')::date
                 + (CURRENT_DATE - DATE_TRUNC('month', CURRENT_DATE)::date) + 1)
                 < date_trunc('month', CURRENT_DATE)::date AS beyond_cap_still_prev_month
      `);
        const { cap, beyond_cap_still_prev_month: beyondIsTestable } = rows[0];

        await insertTxn({
          dateExpr: `date_trunc('month', CURRENT_DATE)`,
          amount: "-10.00",
          recipientId: rec.colruyt,
        });
        await insertTxn({
          date: cap,
          amount: "-7.00",
          recipientId: rec.colruyt,
        }); // exactly on the cap → in
        if (beyondIsTestable) {
          // Only assertable when cap+1 is still inside the previous month: for a
          // short previous month and a late day-of-month the cap lands past its
          // end, and then the whole previous month is in-window by construction.
          await insertTxn({
            dateExpr: `(date_trunc('month', CURRENT_DATE) - INTERVAL '1 month')::date
                     + (CURRENT_DATE - DATE_TRUNC('month', CURRENT_DATE)::date) + 1`,
            amount: "-1000.00",
            recipientId: rec.colruyt,
          });
        }

        const r = await recipientInsightsRepository.getRecipientInsights("EUR");
        expect(mom(r, "Colruyt")).toMatchObject({
          currentSpend: 10,
          previousSpend: 7,
        });
      });

      it("ignores months outside the two-period window entirely", async () => {
        await seedBase();
        await insertTxn({
          dateExpr: `date_trunc('month', CURRENT_DATE)`,
          amount: "-10.00",
          recipientId: rec.colruyt,
        });
        await insertTxn({
          dateExpr: `date_trunc('month', CURRENT_DATE) - interval '1 month'`,
          amount: "-10.00",
          recipientId: rec.colruyt,
        });
        await insertTxn({
          dateExpr: `date_trunc('month', CURRENT_DATE) - interval '2 months'`,
          amount: "-9999.00",
          recipientId: rec.colruyt,
        });

        const r = await recipientInsightsRepository.getRecipientInsights("EUR");
        expect(mom(r, "Colruyt")).toMatchObject({
          currentSpend: 10,
          previousSpend: 10,
          changePercent: 0,
        });
      });

      // Same class as the top-merchants FX fix, one function away: `momConverted`
      // passed NO options, so both compared months were converted at the CURRENT
      // `is_latest` rate. A rate move between them was therefore invisible — an
      // identical 100 USD in each month read 90/90 (changePercent 0) instead of
      // 50/25 — and the EUR figures contradicted the historical-rate
      // top-merchants / by-year / pivot surfaces on the same page. The query now
      // carries `t.date` in its GROUP BY so it can be converted per date too.
      it("converts each month at ITS OWN date rate, agreeing with top merchants", async () => {
        await seedBase();
        const { rows } = await getTestPool().query(`
        SELECT to_char(date_trunc('month', CURRENT_DATE), 'YYYY-MM-DD') AS cur_day,
               to_char(date_trunc('month', CURRENT_DATE) - INTERVAL '1 month', 'YYYY-MM-DD') AS prev_day
      `);
        const { cur_day: curDay, prev_day: prevDay } = rows[0];

        await insertRate("USD", prevDay, "0.25");
        await insertRate("USD", curDay, "0.50");
        // The latest rate is what the old code used for BOTH months.
        await insertRate("USD", "2000-01-01", "0.90", true);

        await insertTxn({
          date: prevDay,
          amount: "-100.00",
          currency: "USD",
          recipientId: rec.colruyt,
        });
        await insertTxn({
          date: curDay,
          amount: "-100.00",
          currency: "USD",
          recipientId: rec.colruyt,
        });

        const r = await recipientInsightsRepository.getRecipientInsights("EUR");
        expect(mom(r, "Colruyt")).toMatchObject({
          currentSpend: 50, // curDay rate 0.50, not the latest 0.90
          previousSpend: 25, // prevDay rate 0.25 — the rate move is now visible
          changePercent: 100, // was 0: identical USD spend at one shared rate
        });
        // Cross-surface: MoM's two months must add up to what top merchants
        // reports for the same recipient over the same two transactions.
        expect(merchant(r, "Colruyt").totalSpend).toBe(75);
      });
    });

    // ───────────────────────────────────────────────────────────────────────────
    // getRecipientByYear
    // ───────────────────────────────────────────────────────────────────────────
    describe("getRecipientByYear", () => {
      it("buckets by calendar year, rolls aliases up and sorts each year by spend", async () => {
        await seedBase();
        await insertTxn({
          date: "2024-12-31",
          amount: "-100.00",
          recipientId: rec.delhaize,
        });
        await insertTxn({
          date: "2024-06-01",
          amount: "-25.00",
          recipientId: rec.delhaizeAlias,
        });
        await insertTxn({
          date: "2024-06-01",
          amount: "-50.00",
          recipientId: rec.colruyt,
        });
        await insertTxn({
          date: "2025-01-01",
          amount: "-10.00",
          recipientId: rec.delhaize,
        });

        const r = await recipientInsightsRepository.getRecipientByYear({
          targetCurrency: "EUR",
        });
        expect(r.recipientsByYear["2024"]).toEqual([
          {
            recipientId: rec.delhaize,
            name: "Delhaize",
            totalSpend: 125,
            transactionCount: 2,
          },
          {
            recipientId: rec.colruyt,
            name: "Colruyt",
            totalSpend: 50,
            transactionCount: 1,
          },
        ]);
        expect(r.recipientsByYear["2025"]).toEqual([
          {
            recipientId: rec.delhaize,
            name: "Delhaize",
            totalSpend: 10,
            transactionCount: 1,
          },
        ]);
        // 2024-12-31 lands in 2024, not 2025 — the DATE round-trip does not shift.
        expect(Object.keys(r.recipientsByYear).sort()).toEqual([
          "2024",
          "2025",
        ]);
      });

      it("converts at each row date historical rate, not the latest one", async () => {
        await seedBase();
        await insertRate("USD", "2024-06-01", "0.25");
        await insertRate("USD", "2026-01-01", "0.90", true);
        await insertTxn({
          date: "2024-06-01",
          amount: "-100.00",
          currency: "USD",
          recipientId: rec.colruyt,
        });

        const r = await recipientInsightsRepository.getRecipientByYear({
          targetCurrency: "EUR",
        });
        expect(r.recipientsByYear["2024"][0].totalSpend).toBe(25);
      });

      it("applies category and recipient exclusions together", async () => {
        await seedBase();
        await insertTxn({
          date: "2024-01-10",
          amount: "-40.00",
          recipientId: rec.colruyt,
        }); // Food via default
        await insertTxn({
          date: "2024-01-10",
          amount: "-60.00",
          recipientId: rec.electrabel,
        }); // Bills via default

        const excl = await recipientInsightsRepository.getRecipientByYear({
          targetCurrency: "EUR",
          excludedRecipientIds: [rec.electrabel],
          excludedCategoryIds: [cat.Food],
        });
        expect(excl.recipientsByYear["2024"]).toBeUndefined(); // both rows filtered out
      });

      // Previously this pinned the opposite: a malformed exclusion list had its
      // bad entries dropped and the query ran on what survived. That is the bug
      // 00f8281d closed — a dropped exclusion id does not 404, it silently stops
      // excluding, so the caller gets a wider answer than it asked for and
      // nothing surfaces. Rejecting is the contract now, matching the `:id`
      // params, body arrays and aggregation query params.
      it("rejects an exclusion list containing a malformed id rather than dropping it", async () => {
        await seedBase();
        await insertTxn({
          date: "2024-01-10",
          amount: "-40.00",
          recipientId: rec.colruyt,
        });
        await insertTxn({
          date: "2024-01-10",
          amount: "-60.00",
          recipientId: rec.electrabel,
        });

        for (const bad of [0, -1, 1.5, "evil", "12abc", "1e3"]) {
          await expect(
            recipientInsightsRepository.getRecipientByYear({
              targetCurrency: "EUR",
              excludedRecipientIds: [bad, rec.electrabel],
              excludedCategoryIds: [cat.Food],
            }),
          ).rejects.toThrow(/excludedRecipientIds contains invalid value/);
        }
      });
    });

    // ───────────────────────────────────────────────────────────────────────────
    // getRecipientPivot
    // ───────────────────────────────────────────────────────────────────────────
    describe("getRecipientPivot", () => {
      it("buckets monthly by default and yearly on request, ascending by total", async () => {
        await seedBase();
        await insertTxn({
          date: "2024-03-05",
          amount: "-100.00",
          recipientId: rec.delhaize,
        });
        await insertTxn({
          date: "2024-03-06",
          amount: "-25.00",
          recipientId: rec.delhaizeAlias,
        });
        await insertTxn({
          date: "2024-03-07",
          amount: "-50.00",
          recipientId: rec.colruyt,
        });
        await insertTxn({
          date: "2024-04-01",
          amount: "-10.00",
          recipientId: rec.colruyt,
        });

        const monthly = await recipientInsightsRepository.getRecipientPivot({
          targetCurrency: "EUR",
        });
        expect(Object.keys(monthly.recipientPivot).sort()).toEqual([
          "2024-03",
          "2024-04",
        ]);
        expect(monthly.recipientPivot["2024-03"]).toEqual([
          {
            recipientId: rec.colruyt,
            name: "Colruyt",
            total: 50,
            transactionCount: 1,
          },
          {
            recipientId: rec.delhaize,
            name: "Delhaize",
            total: 125,
            transactionCount: 2,
          },
        ]);

        const yearly = await recipientInsightsRepository.getRecipientPivot({
          targetCurrency: "EUR",
          bucket: "yearly",
        });
        expect(Object.keys(yearly.recipientPivot)).toEqual(["2024"]);
        expect(yearly.recipientPivot["2024"]).toEqual([
          {
            recipientId: rec.colruyt,
            name: "Colruyt",
            total: 60,
            transactionCount: 2,
          },
          {
            recipientId: rec.delhaize,
            name: "Delhaize",
            total: 125,
            transactionCount: 2,
          },
        ]);
      });

      it("narrows to the selected recipients, pulling in their alias members", async () => {
        await seedBase();
        await insertTxn({
          date: "2024-03-05",
          amount: "-100.00",
          recipientId: rec.delhaize,
        });
        await insertTxn({
          date: "2024-03-06",
          amount: "-25.00",
          recipientId: rec.delhaizeAlias,
        });
        await insertTxn({
          date: "2024-03-07",
          amount: "-50.00",
          recipientId: rec.colruyt,
        });

        // Selecting the PRIMARY resolves its alias members through the real
        // recipients table, so the alias row is included.
        const primaryOnly = await recipientInsightsRepository.getRecipientPivot(
          {
            targetCurrency: "EUR",
            recipientIds: [rec.delhaize],
          },
        );
        expect(primaryOnly.recipientPivot["2024-03"]).toEqual([
          {
            recipientId: rec.delhaize,
            name: "Delhaize",
            total: 125,
            transactionCount: 2,
          },
        ]);

        // An id nobody matches short-circuits to an empty pivot.
        const none = await recipientInsightsRepository.getRecipientPivot({
          targetCurrency: "EUR",
          recipientIds: [2147483646],
        });
        expect(none).toEqual({ recipientPivot: {} });
      });

      it("applies inclusive start/end date filters and recipient exclusions together", async () => {
        await seedBase();
        await insertTxn({
          date: "2024-02-28",
          amount: "-1.00",
          recipientId: rec.colruyt,
        });
        await insertTxn({
          date: "2024-03-01",
          amount: "-10.00",
          recipientId: rec.colruyt,
        });
        await insertTxn({
          date: "2024-03-31",
          amount: "-20.00",
          recipientId: rec.colruyt,
        });
        await insertTxn({
          date: "2024-04-01",
          amount: "-2.00",
          recipientId: rec.colruyt,
        });
        await insertTxn({
          date: "2024-03-15",
          amount: "-99.00",
          recipientId: rec.delhaizeAlias,
        });

        const r = await recipientInsightsRepository.getRecipientPivot({
          excludedRecipientIds: [rec.delhaize],
          targetCurrency: "EUR",
          startDate: "2024-03-01",
          endDate: "2024-03-31",
        });
        expect(r.recipientPivot).toEqual({
          "2024-03": [
            {
              recipientId: rec.colruyt,
              name: "Colruyt",
              total: 30,
              transactionCount: 2,
            },
          ],
        });
      });
    });

    describe("recipient pivot alias selection", () => {
      it("selecting an alias includes the full cluster under the primary label", async () => {
        await seedBase();
        await insertTxn({
          date: "2024-03-05",
          amount: "-100.00",
          recipientId: rec.delhaize,
        });
        await insertTxn({
          date: "2024-03-06",
          amount: "-25.00",
          recipientId: rec.delhaizeAlias,
        });

        const aliasPick = await recipientInsightsRepository.getRecipientPivot({
          targetCurrency: "EUR",
          recipientIds: [rec.delhaizeAlias],
        });
        expect(aliasPick.recipientPivot["2024-03"]).toEqual([
          {
            recipientId: rec.delhaize,
            name: "Delhaize",
            total: 125,
            transactionCount: 2,
          },
        ]);
      });

      it("deduplicates overlapping primary and alias selections", async () => {
        await seedBase();
        await insertTxn({
          date: "2024-03-05",
          amount: "-100.00",
          recipientId: rec.delhaize,
        });
        await insertTxn({
          date: "2024-03-06",
          amount: "-25.00",
          recipientId: rec.delhaizeAlias,
        });

        const overlap = await recipientInsightsRepository.getRecipientPivot({
          targetCurrency: "EUR",
          recipientIds: [rec.delhaize, rec.delhaizeAlias],
        });

        expect(overlap.recipientPivot["2024-03"]).toEqual([
          {
            recipientId: rec.delhaize,
            name: "Delhaize",
            total: 125,
            transactionCount: 2,
          },
        ]);
      });

      it("keeps distinct clusters separate when aliases and standalone recipients are mixed", async () => {
        await seedBase();
        await insertTxn({
          date: "2024-03-05",
          amount: "-100.00",
          recipientId: rec.delhaize,
        });
        await insertTxn({
          date: "2024-03-06",
          amount: "-25.00",
          recipientId: rec.delhaizeAlias,
        });
        await insertTxn({
          date: "2024-03-07",
          amount: "-40.00",
          recipientId: rec.colruyt,
        });

        const mixed = await recipientInsightsRepository.getRecipientPivot({
          targetCurrency: "EUR",
          recipientIds: [rec.delhaizeAlias, rec.colruyt],
        });

        expect(mixed.recipientPivot["2024-03"]).toEqual([
          {
            recipientId: rec.colruyt,
            name: "Colruyt",
            total: 40,
            transactionCount: 1,
          },
          {
            recipientId: rec.delhaize,
            name: "Delhaize",
            total: 125,
            transactionCount: 2,
          },
        ]);
      });
    });
  },
);
