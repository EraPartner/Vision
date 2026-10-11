/**
 * Runs the row-checked bank-import, info, forecast-cache, insight and report
 * queries that no other DB suite reaches against a migrated PostgreSQL
 * database, so a schema in src/database/rows/{imports,info}.ts that disagrees
 * with what pg really returns fails here (tests run the contracts in throw
 * mode).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.ts";
import { closePool } from "../src/database/connection.ts";
import {
  commitImport,
  createBatch,
  prepareImport,
} from "../src/services/importPipeline/index.ts";
import {
  getBatch,
  getPreviewRows,
  listBatches,
  rollbackBatch,
} from "../src/repositories/importBatchRepository.ts";
import customParserConfigRepository from "../src/repositories/customParserConfigRepository.ts";
import accuracyRepo from "../src/repositories/cashflowForecastAccuracyRepository.ts";
import mcRepo from "../src/repositories/cashflowForecastMcRepository.ts";
import mcRollingRepo from "../src/repositories/cashflowForecastMcRollingRepository.ts";
import insightDismissalRepository from "../src/repositories/insightDismissalRepository.ts";
import { tagInsightsRepository } from "../src/repositories/infoRepositoryTags.ts";
import { getSankeyAggregates } from "../src/repositories/infoRepositorySankey.ts";
import { getInflationRates } from "../src/services/belgianInflationService.ts";
import { assembleRebalanceInputs } from "../src/services/crossWorkspaceDataService.ts";
import { fetchTaxData } from "../src/services/reports/dataFetcherTax.ts";
import { fetchPortfolioData } from "../src/services/reports/dataFetcherPortfolio.ts";
import { clearMvCache } from "../src/repositories/infoRepositoryHelpers.ts";
import { getMonthlyFinancialSummary } from "../src/repositories/infoRepositoryMonthly.ts";
import { statisticsRepository } from "../src/repositories/infoRepositoryStatistics.ts";
import { addDaysYmd, todayAppDateString } from "../src/lib/timezone.ts";

// Neither the MV refresh nor planned-payment auto-linking is under test here.
vi.mock("../src/services/aggregationRefresh.ts", () => ({
  clearForecastMcCaches: vi.fn().mockResolvedValue(undefined),
  scheduleMaterializedViewRefresh: vi.fn(),
}));
vi.mock("../src/services/materializedViewService.ts", () => ({
  scheduleRefresh: vi.fn(),
  refreshMaterializedViews: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/services/plannedMatchService.ts", () => ({
  autoLinkTransactions: vi.fn().mockResolvedValue({ autoLinkedCount: 0 }),
}));

const pool = getTestPool();
const SUFFIX = `IIRC${process.pid}`;
const USER = `vision_test_${SUFFIX}`;

const owned = {
  batchIds: [] as number[],
  parserConfigIds: [] as number[],
  accountIds: [] as number[],
  recipientIds: [] as number[],
  transactionIds: [] as number[],
  tagIds: [] as number[],
  investmentIds: [] as number[],
};
const tempDirs: string[] = [];

const REVOLUT_CSV = `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
Card Payment,Current,2026-03-01 10:00:00,2026-03-01 10:00:00,IIRC Contract Shop ${SUFFIX},-25.00,0.00,EUR,COMPLETED,175.00
Transfer,Current,2026-03-02 10:00:00,2026-03-02 10:00:00,IIRC Contract Payer ${SUFFIX},50.00,0.00,EUR,COMPLETED,225.00
`;

function writeCsv(csv: string): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "import-info-row-contracts-"),
  );
  tempDirs.push(dir);
  const file = path.join(dir, "revolut.csv");
  fs.writeFileSync(file, csv, "utf-8");
  return file;
}

async function insertAccount(name: string, type = "checking"): Promise<number> {
  const { rows } = await pool!.query(
    `INSERT INTO accounts (name, display_name, type, currency)
     VALUES ($1, $1, $2::account_type, 'EUR') RETURNING id`,
    [name, type],
  );
  owned.accountIds.push(rows[0].id);
  return rows[0].id;
}

async function insertRecipient(name: string): Promise<number> {
  const { rows } = await pool!.query(
    `INSERT INTO recipients (name, normalized_name) VALUES ($1, lower($1)) RETURNING id`,
    [name],
  );
  owned.recipientIds.push(rows[0].id);
  return rows[0].id;
}

async function insertTransaction(
  accountId: number,
  recipientId: number,
  date: string,
  amount: string,
): Promise<number> {
  const { rows } = await pool!.query(
    `INSERT INTO transactions (date, amount, currency, recipient_id, account_id, is_active)
     VALUES ($1, $2, 'EUR', $3, $4, true) RETURNING id`,
    [date, amount, recipientId, accountId],
  );
  owned.transactionIds.push(rows[0].id);
  return rows[0].id;
}

describe.skipIf(!hasTestDatabase())(
  "import, info, forecast and report row contracts against PostgreSQL",
  () => {
    beforeAll(async () => {
      expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
      await acquireDbSuiteLock();
    }, 180000);

    afterAll(async () => {
      try {
        const db = pool!;
        await db.query(
          "DELETE FROM transactions WHERE id = ANY($1) OR import_batch_id = ANY($2)",
          [owned.transactionIds, owned.batchIds],
        );
        await db.query("DELETE FROM import_batches WHERE id = ANY($1)", [
          owned.batchIds,
        ]);
        await db.query("DELETE FROM custom_parser_configs WHERE id = ANY($1)", [
          owned.parserConfigIds,
        ]);
        await db.query(
          "DELETE FROM portfolio_transactions WHERE investment_id = ANY($1)",
          [owned.investmentIds],
        );
        await db.query("DELETE FROM investments WHERE id = ANY($1)", [
          owned.investmentIds,
        ]);
        await db.query("DELETE FROM tags WHERE id = ANY($1)", [owned.tagIds]);
        await db.query(
          "DELETE FROM recipients WHERE id = ANY($1) OR name LIKE $2",
          [owned.recipientIds, `%${SUFFIX}%`],
        );
        await db.query(
          "DELETE FROM accounts WHERE id = ANY($1) OR name LIKE $2",
          [owned.accountIds, `%${SUFFIX}%`],
        );
        await db.query(
          "DELETE FROM cashflow_forecast_accuracy WHERE user_id = $1",
          [USER],
        );
        await db.query("DELETE FROM cashflow_forecast_mc WHERE user_id = $1", [
          USER,
        ]);
        await db.query(
          "DELETE FROM cashflow_forecast_mc_rolling WHERE user_id = $1",
          [USER],
        );
        await db.query(
          "DELETE FROM belgian_inflation_rates WHERE source = $1",
          [SUFFIX],
        );
        for (const dir of tempDirs)
          fs.rmSync(dir, { recursive: true, force: true });
      } finally {
        await releaseDbSuiteLock();
        await closePool();
        await closeTestPool();
      }
    });

    it("reads a staged bank import batch: list, detail, preview and rollback", async () => {
      const batchId = await createBatch({
        adapterName: "revolut",
        filename: "import-info.csv",
        sizeBytes: REVOLUT_CSV.length,
      });
      owned.batchIds.push(batchId);
      const prepared = await prepareImport({
        batchId,
        filePath: writeCsv(REVOLUT_CSV),
        adapterName: "revolut",
      });
      expect(prepared.requiresReview).toBe(true);

      const batch = await getBatch(batchId);
      expect(batch).toMatchObject({
        id: String(batchId),
        status: "awaiting_review",
        custom_config: null,
      });
      const { batches, total } = await listBatches({ limit: 200 });
      expect(total).toBeGreaterThan(0);
      expect(batches.some((b) => b.id === String(batchId))).toBe(true);

      const preview = await getPreviewRows(batchId);
      expect(preview).toHaveLength(2);
      expect(preview.every((row) => typeof row.id === "string")).toBe(true);

      expect(await commitImport({ batchId })).toMatchObject({ imported: 2 });
      const rolledBack = await rollbackBatch(batchId);
      expect(rolledBack.deleted).toBe(2);
    });

    it("round-trips saved parser configs", async () => {
      const config = {
        dateColumn: "Date",
        recipientColumn: "Name",
        amountColumn: "Amount",
        memoColumn: "",
        dateFormat: "%Y-%m-%d",
        separator: ",",
        encoding: "utf-8",
        skipRows: 0,
      };
      const created = await customParserConfigRepository.create({
        name: `IIRC parser ${SUFFIX}`,
        config,
      });
      owned.parserConfigIds.push(created.id);
      expect(created.config).toEqual(config);
      expect(
        (await customParserConfigRepository.getAll()).some(
          (c) => c.id === created.id,
        ),
      ).toBe(true);
      expect(
        await customParserConfigRepository.getById(created.id),
      ).toBeDefined();
      expect(
        await customParserConfigRepository.getByName(`IIRC parser ${SUFFIX}`),
      ).toBeDefined();
      const updated = await customParserConfigRepository.update(created.id, {
        name: `IIRC parser renamed ${SUFFIX}`,
      });
      expect(updated?.name).toBe(`IIRC parser renamed ${SUFFIX}`);
      expect(await customParserConfigRepository.delete(created.id)).toBe(true);
    });

    it("reads forecast accuracy rows, including the nullable metric columns", async () => {
      const thisMonth = new Date().toISOString().slice(0, 7);
      await accuracyRepo.upsert({
        userId: USER,
        methodId: "naive",
        asOfMonth: thisMonth,
        mae: 1.5,
        rmse: 2.25,
        mape: null,
        sampleDays: 30,
      });
      // The metric columns are nullable (migration 0012); a row written
      // outside `upsert` must still pass the read contract.
      await pool!.query(
        `INSERT INTO cashflow_forecast_accuracy
           (user_id, method_id, as_of_month, mae, rmse, mape, sample_days)
         VALUES ($1, 'null-metrics', date_trunc('month', CURRENT_DATE)::date,
                 NULL, NULL, NULL, NULL)`,
        [USER],
      );

      const history = await accuracyRepo.getHistory({
        userId: USER,
        methodId: "naive",
      });
      expect(history).toEqual([
        expect.objectContaining({
          as_of_month: thisMonth,
          mae: 1.5,
          mape: null,
          sample_days: 30,
        }),
      ]);
      const latest = await accuracyRepo.getLatestByMethod({ userId: USER });
      expect(latest.map((r) => r.method_id).sort()).toEqual([
        "naive",
        "null-metrics",
      ]);
      expect(latest.find((r) => r.method_id === "null-metrics")).toMatchObject({
        mae: null,
        rmse: null,
        sample_days: null,
      });
      expect(await accuracyRepo.getAllHistory({ userId: USER })).toHaveLength(
        2,
      );
      expect(await mcRepo.getActiveUserIds({ strict: true })).toContain(USER);
    });

    it("reads the Monte Carlo forecast caches", async () => {
      const payload = { p50: [1, 2, 3], note: "synthetic" };
      await mcRepo.upsert({
        userId: USER,
        month: "2026-03",
        filterHash: "h",
        mcPaths: 10,
        payload,
      });
      const monthly = await mcRepo.get({
        userId: USER,
        month: "2026-03",
        filterHash: "h",
      });
      expect(monthly?.payload).toEqual(payload);
      expect(monthly?.computed_at).toBeInstanceOf(Date);

      const key = {
        userId: USER,
        todayIso: "2026-03-15",
        daysBack: 30,
        daysForward: 30,
        filterHash: "h",
      };
      await mcRollingRepo.upsert({ ...key, mcPaths: 10, payload });
      expect((await mcRollingRepo.get(key))?.payload).toEqual(payload);
    });

    it("checks recipient existence for insight dismissals", async () => {
      const id = await insertRecipient(`IIRC Exists ${SUFFIX}`);
      expect(await insightDismissalRepository.recipientExists(id)).toBe(true);
    });

    it("reads Belgian inflation rates from the database", async () => {
      await pool!.query(
        `INSERT INTO belgian_inflation_rates (month_date, monthly_rate, source)
         VALUES ('1990-01-01', 0.0031, $1), ('1990-02-01', 0.0012, $1)`,
        [SUFFIX],
      );
      const result = await getInflationRates({
        startMonth: "1990-01",
        endMonth: "1990-02",
        dbOnly: true,
      });
      expect(result.rates).toEqual([
        { month: "1990-01", monthly_rate: 0.0031 },
        { month: "1990-02", monthly_rate: 0.0012 },
      ]);
    });

    it("reads tag pivots, Sankey aggregates and rebalance cash accounts", async () => {
      const accountId = await insertAccount(`IIRC Cash ${SUFFIX}`);
      await pool!.query("UPDATE accounts SET spendable = true WHERE id = $1", [
        accountId,
      ]);
      const recipientId = await insertRecipient(`IIRC Tagged ${SUFFIX}`);
      const txId = await insertTransaction(
        accountId,
        recipientId,
        "2025-06-10",
        "-12.5000",
      );
      await insertTransaction(accountId, recipientId, "2025-06-11", "40.0000");
      const { rows: tagRows } = await pool!.query(
        "INSERT INTO tags (slug) VALUES ($1) RETURNING id",
        [`iirc-${SUFFIX.toLowerCase()}`],
      );
      const tagId = tagRows[0].id;
      owned.tagIds.push(tagId);
      await pool!.query(
        "INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ($1, $2)",
        [txId, tagId],
      );

      const { tagPivot } = await tagInsightsRepository.getTagPivot({
        tagIds: [tagId],
        startDate: "2025-06-01",
        endDate: "2025-06-30",
      });
      expect(tagPivot["2025-06"]).toEqual([
        expect.objectContaining({ total: 12.5 }),
      ]);

      const sankey = await getSankeyAggregates({
        yearStart: "2025-06-01",
        yearEnd: "2025-06-30",
      });
      expect(sankey.length).toBeGreaterThan(0);

      const rebalance = await assembleRebalanceInputs({
        currency: "EUR",
        rates: { EUR: 1 },
      });
      expect(
        rebalance.cashAccounts.some((a) => a.name === `IIRC Cash ${SUFFIX}`),
      ).toBe(true);
    });

    it("reads the materialized-view fast paths", async () => {
      // The pipeline stubs above replace the module; the real builder is
      // needed here to create the views this case reads.
      const mv = await vi.importActual<
        typeof import("../src/services/materializedViewService.ts")
      >("../src/services/materializedViewService.ts");
      const accountId = await insertAccount(`IIRC MV ${SUFFIX}`);
      const recipientId = await insertRecipient(`IIRC MV Payee ${SUFFIX}`);
      const { rows: catRows } = await pool!.query(
        "INSERT INTO categories (general, detail) VALUES ($1, 'MV') RETURNING id",
        [`IIRC_${SUFFIX}`],
      );
      const categoryId = catRows[0].id;
      const txId = await insertTransaction(
        accountId,
        recipientId,
        addDaysYmd(todayAppDateString(), -3),
        "-7.2500",
      );
      await pool!.query(
        "UPDATE transactions SET category_id = $1 WHERE id = $2",
        [categoryId, txId],
      );
      try {
        await mv.createMaterializedViews();
        await mv.refreshMaterializedViews();
        clearMvCache();

        const monthly = await getMonthlyFinancialSummary([], "EUR");
        expect(monthly.months.length).toBeGreaterThan(0);
        const categories =
          await statisticsRepository.getCategoryBreakdown("EUR");
        expect(categories.some((c) => c.id === categoryId)).toBe(true);
      } finally {
        await pool!.query(
          "DROP MATERIALIZED VIEW IF EXISTS mv_monthly_summary, mv_category_totals CASCADE",
        );
        clearMvCache();
        await pool!.query("DELETE FROM transactions WHERE id = $1", [txId]);
        await pool!.query("DELETE FROM categories WHERE id = $1", [categoryId]);
      }
    });

    it("reads report tax and dividend rows", async () => {
      const accountId = await insertAccount(
        `IIRC Broker ${SUFFIX}`,
        "brokerage",
      );
      const { rows } = await pool!.query(
        `INSERT INTO investments (name, symbol, asset_class, currency, current_price)
         VALUES ($1, 'IIRC', 'stock', 'EUR', 12) RETURNING id`,
        [`IIRC Asset ${SUFFIX}`],
      );
      const investmentId = rows[0].id;
      owned.investmentIds.push(investmentId);
      await pool!.query(
        `INSERT INTO portfolio_transactions
           (investment_id, type, date, units, amount, price_per_unit, fees, taxes, currency, account_id)
         VALUES ($1, 'dividend', '2019-05-10', NULL, 10, NULL, 0, 3, 'EUR', $2)`,
        [investmentId, accountId],
      );

      const tax = await fetchTaxData("EUR", { kind: "year", year: 2019 }, {});
      expect(tax).toMatchObject({ taxYear: 2019 });
      expect(tax.dividendWHTTotal).toBeGreaterThan(0);

      const portfolio = await fetchPortfolioData("EUR", {
        kind: "year",
        year: 2019,
      });
      expect(portfolio.dividends?.byInvestment).toEqual([
        expect.objectContaining({ investmentId, total: 10 }),
      ]);
    });
  },
);
