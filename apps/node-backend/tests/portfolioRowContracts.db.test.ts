/**
 * Real-Postgres coverage for the checked reads (ADR-193) of the portfolio
 * (non-import), investment, price and currency paths. Every call below goes
 * through its row schema in strict mode, so a schema that is wrong for what
 * node-postgres really returns fails here with a RowContractError.
 *
 * Requires a migrated disposable database with DATABASE_URL=TEST_DATABASE_URL.
 * Fixtures are synthetic and removed afterwards; no real data is read.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.ts";

// The quote paths would otherwise ask a live provider for history.
vi.mock("../src/services/priceProviderService.ts", async () => ({
  ...(await vi.importActual<
    typeof import("../src/services/priceProviderService.ts")
  >("../src/services/priceProviderService.ts")),
  fetchHistoricalPrices: vi.fn(async () => []),
}));

import { closePool, withTransaction } from "../src/database/connection.ts";
import investmentRepository from "../src/repositories/investmentRepository.ts";
import watchlistRepository from "../src/repositories/watchlistRepository.ts";
import * as instrumentProviderMap from "../src/repositories/instrumentProviderMapRepository.ts";
import providerHealthRepository from "../src/repositories/providerHealthRepository.ts";
import * as providerQuota from "../src/repositories/providerQuotaRepository.ts";
import * as providerApiKeys from "../src/repositories/providerApiKeyRepository.ts";
import portfolioTransactionRepository from "../src/repositories/portfolioTransactionRepository.ts";
import {
  getAccountLabel,
  getAssetClassByInvestmentId,
  getUnitEventIdsForImportBatch,
  getUnitEventsForInvestment,
} from "../src/repositories/portfolioTxRepo.reads.ts";
import {
  __resetPortfolioTransactionSchemaCache,
  hasPortfolioTransactionImportBatchIdColumn,
} from "../src/repositories/portfolioTxRepo.common.ts";
import portfolioTransactionService from "../src/services/portfolio/portfolioTransactionService.ts";
import * as assetAdjustments from "../src/repositories/portfolioAssetAdjustmentRepository.ts";
import * as assetTransfers from "../src/repositories/portfolioAssetTransferRepository.ts";
import {
  readIncomeRecognitionContext,
  readPairedIncomeRollbackBatchIds,
  recordPairedPortfolioIncome,
  restorePairedPortfolioIncomeForBatch,
} from "../src/repositories/portfolioIncomeRecognitionRepository.ts";
import {
  listExposureSources,
  listExposureTargets,
  upsertExposureBundle,
} from "../src/repositories/portfolioExposureRepository.ts";
import type { FundHoldingsDocument } from "@vision/types/fund-holdings";
import {
  loadHistoricalPointsFromDatabase,
  loadLatestHistoricalPointByInvestmentIds,
  saveHistoricalPointsToDatabase,
} from "../src/services/prices/priceCache.ts";
import {
  backfillHoldingGaps,
  __getInvestmentsWithHoldingWindows as getInvestmentsWithHoldingWindows,
  refreshQuotesForInvestment,
} from "../src/services/quoteBackfillService.ts";
import {
  __getPriorRateFromDatabase as getPriorRateFromDatabase,
  getRateToEurForDate,
  getStoredRateToEurOnOrBefore,
  loadFromDatabase,
} from "../src/services/currency/rateFetcher.ts";
import {
  backfillPortfolioHistoricalRates,
  clearMemoryCache,
  getHistoricalRateIndex,
  listLatestStoredRates,
} from "../src/services/currency/currencyConversionService.ts";
import { getPortfolioSummary } from "../src/services/portfolio/portfolioSummaryService.ts";
import {
  __getLatestSnapshot as getLatestSnapshot,
  __storeCurrentBrokerSnapshot as storeCurrentBrokerSnapshot,
  computeAndStoreSnapshots,
  getBrokerSnapshots,
  getSnapshots,
} from "../src/services/portfolioPerformanceSnapshotService.ts";
import { todayAppDateString } from "../src/lib/timezone.ts";

const pool = getTestPool()!;
const cleanup: { sql: string; params: unknown[] }[] = [];
function onCleanup(sql: string, ...params: unknown[]) {
  cleanup.unshift({ sql, params });
}
let sequence = 0;
const tag = (prefix: string) =>
  `${prefix} ${randomUUID().slice(0, 8)} ${++sequence}`;
const hex = (value: unknown) =>
  createHash("sha256").update(String(value)).digest("hex");

async function account(): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    "INSERT INTO accounts(name,type,currency) VALUES($1,'brokerage','EUR') RETURNING id",
    [tag("Row contract broker")],
  );
  const id = rows[0]!.id;
  onCleanup("DELETE FROM accounts WHERE id=$1", id);
  onCleanup("DELETE FROM portfolio_transactions WHERE account_id=$1", id);
  return id;
}

async function investment(
  assetClass = "stock",
  currency = "EUR",
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO investments(name,symbol,asset_class,currency,current_price,interest_rate)
     VALUES($1,$2,$3,$4,10,2) RETURNING id`,
    [tag("Row contract asset"), null, assetClass, currency],
  );
  const id = rows[0]!.id;
  onCleanup("DELETE FROM asset_price_history WHERE investment_id=$1", id);
  onCleanup("DELETE FROM portfolio_transactions WHERE investment_id=$1", id);
  onCleanup("DELETE FROM investments WHERE id=$1", id);
  return id;
}

async function batch(accountId: number): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO portfolio_import_batches(adapter_name,custom_config,status,rows_total,account_id,is_brokerage)
     VALUES('kinesis_transaction_history',$1,'complete',2,$2,true) RETURNING id`,
    [JSON.stringify({ format: "kinesis_transaction_history" }), accountId],
  );
  const id = rows[0]!.id;
  onCleanup("DELETE FROM portfolio_import_staging_rows WHERE batch_id=$1", id);
  onCleanup("DELETE FROM portfolio_import_batches WHERE id=$1", id);
  return id;
}

async function stagingRow(
  batchId: string,
  rowIndex: number,
  fields: Record<string, unknown> = {},
): Promise<string> {
  const columns = ["batch_id", "row_index", ...Object.keys(fields)];
  const values = [batchId, rowIndex, ...Object.values(fields)];
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO portfolio_import_staging_rows(${columns.join(",")})
     VALUES(${columns.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id`,
    values,
  );
  return rows[0]!.id;
}

describe.skipIf(!hasTestDatabase())(
  "portfolio, investment, price and currency row contracts (real Postgres)",
  () => {
    const realFetch = globalThis.fetch;

    beforeAll(async () => {
      expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
      await acquireDbSuiteLock();
      // No live FX or quote provider is ever asked.
      globalThis.fetch = vi.fn(async () => {
        throw new Error("network disabled in this suite");
      }) as typeof fetch;
    }, 180_000);

    afterEach(async () => {
      for (const { sql, params } of cleanup.splice(0))
        await pool.query(sql, params);
      clearMemoryCache();
    });

    afterAll(async () => {
      globalThis.fetch = realFetch;
      await releaseDbSuiteLock();
      await closeTestPool();
      await closePool();
    });

    it("reads investments and the watchlist through their checked rows", async () => {
      const created = await investmentRepository.create({
        name: tag("Row contract created"),
        asset_class: "etf",
        currency: "EUR",
        current_price: 12.5,
      });
      expect(created).not.toBeNull();
      const id = Number(created!.id);
      onCleanup(
        "DELETE FROM investment_ticker_prefs WHERE investment_id=$1",
        id,
      );
      onCleanup("DELETE FROM investments WHERE id=$1", id);

      expect(await investmentRepository.getById(id)).toMatchObject({ id });
      expect(
        (await investmentRepository.getAll({ limit: 500, offset: 0 })).map(
          (row) => row.id,
        ),
      ).toContain(id);
      expect(await investmentRepository.getCount({})).toBeGreaterThanOrEqual(1);
      const page = await investmentRepository.getAllWithCount({
        limit: 500,
        offset: 0,
      });
      expect(page.total).toBeGreaterThanOrEqual(1);
      expect(
        await investmentRepository.update(id, { notes: "synthetic" }),
      ).toMatchObject({ id });
      expect(
        await investmentRepository.updatePrice(id, {
          current_price: 13,
          price_updated_at: new Date(),
        }),
      ).toMatchObject({ id });
      const latest = await investmentRepository.getLatestPriceUpdatedAt();
      expect(latest === null || latest instanceof Date).toBe(true);

      const watched = await watchlistRepository.create({
        name: tag("Row contract watch"),
        asset_class: "stock",
        target_price: 5,
      });
      onCleanup("DELETE FROM watchlist WHERE id=$1", watched.id);
      expect(await watchlistRepository.getById(watched.id)).toMatchObject({
        id: watched.id,
      });
      expect(
        (await watchlistRepository.getAll()).map((row) => row.id),
      ).toContain(watched.id);
      expect(
        (await watchlistRepository.getAllWithCount()).total,
      ).toBeGreaterThanOrEqual(1);
      expect(await watchlistRepository.getCount()).toBeGreaterThanOrEqual(1);
      expect(
        await watchlistRepository.update(watched.id, { notes: "synthetic" }),
      ).toMatchObject({ id: watched.id });
    });

    it("reads the research provider tables", async () => {
      const key = `ROWCONTRACT${sequence++}`;
      const provider = `row-contract-${randomUUID().slice(0, 8)}`;
      onCleanup(
        "DELETE FROM instrument_provider_map WHERE instrument_key=$1",
        key,
      );
      onCleanup("DELETE FROM provider_health WHERE provider=$1", provider);
      onCleanup("DELETE FROM provider_quota WHERE provider=$1", provider);
      onCleanup("DELETE FROM provider_api_keys WHERE provider=$1", provider);

      const mapped = await instrumentProviderMap.upsert({
        instrumentKey: key,
        keyType: "internal",
        provider,
        providerSymbol: "SYN",
        status: "auto",
      });
      expect(mapped.instrument_key).toBe(key);
      expect(
        await instrumentProviderMap.listByInstrument(key, "internal"),
      ).toHaveLength(1);

      await providerHealthRepository.recordSuccess(provider, "quote");
      await providerHealthRepository.recordError(
        provider,
        "quote",
        "synthetic",
      );
      expect(
        await providerHealthRepository.findByProvider(provider),
      ).toMatchObject({ provider });
      expect(
        (await providerHealthRepository.listAll()).map((row) => row.provider),
      ).toContain(provider);

      const day = "2026-01-15";
      expect(
        await providerQuota.createDbQuotaStore().getDayCount(provider, day),
      ).toBe(0);
      await providerQuota.createDbQuotaStore().addDayCount(provider, day, 2);
      expect(
        await providerQuota.createDbQuotaStore().getDayCount(provider, day),
      ).toBe(2);
      expect(await providerQuota.tryReserveDay(provider, day, 5)).toBe(3);

      await providerApiKeys.upsert(provider, "synthetic-key");
      expect(
        (await providerApiKeys.listAll()).map((row) => row.provider),
      ).toContain(provider);
    });

    it("reads portfolio transactions, unit events and the math rows", async () => {
      const broker = await account();
      const inv = await investment("stock");
      __resetPortfolioTransactionSchemaCache();
      expect(await hasPortfolioTransactionImportBatchIdColumn()).toBe(true);

      const buy = await portfolioTransactionService.create({
        investment_id: inv,
        type: "buy",
        date: "2025-01-02",
        amount: 100,
        units: 10,
        currency: "EUR",
        account_id: broker,
      });
      const sell = await portfolioTransactionService.create({
        investment_id: inv,
        type: "sell",
        date: "2025-02-03",
        amount: 40,
        units: 4,
        currency: "USD",
        fx_rate_to_eur: 0.9,
        account_id: broker,
      });
      const buyId = Number(buy?.id);
      const sellId = Number(sell?.id);

      expect(await portfolioTransactionRepository.getById(buyId)).toMatchObject(
        { id: buyId, date: "2025-01-02" },
      );
      expect(
        (
          await portfolioTransactionRepository.getAll({
            investmentId: inv,
          })
        ).map((row) => row.id),
      ).toEqual([sellId, buyId]);
      expect(
        (
          await portfolioTransactionRepository.getAllWithCount({
            investmentId: inv,
          })
        ).total,
      ).toBe(2);
      expect(
        await portfolioTransactionRepository.getAllByInvestmentIds({
          investmentIds: [inv],
        }),
      ).toHaveLength(2);
      expect(
        await portfolioTransactionRepository.getCount({ investmentId: inv }),
      ).toBe(2);
      expect(await portfolioTransactionRepository.getSummary(inv)).toHaveLength(
        2,
      );
      expect(
        (await portfolioTransactionRepository.getRowsForPortfolioMath()).filter(
          (row) => row.investment_id === inv,
        ),
      ).toHaveLength(2);
      expect(await getUnitEventsForInvestment(inv)).toHaveLength(2);
      expect(await getAssetClassByInvestmentId(inv)).toBe("stock");
      expect(await getAccountLabel(broker)).toMatch(/^Row contract broker/);

      expect(
        await portfolioTransactionService.update(sellId, { note: "synthetic" }),
      ).toMatchObject({ id: sellId });
      await expect(portfolioTransactionService.remove(sellId)).resolves.toBe(
        true,
      );
    });

    it("reads custody adjustments, transfers and the income journal", async () => {
      const source = await account();
      const destination = await account();
      const inv = await investment("metals");
      const importBatch = await batch(source);
      const yieldRow = await stagingRow(importBatch, 1, {
        type: "gift",
        status: "committed",
        resolved_investment_id: inv,
        source_record_hash: hex("yield"),
        asset_adjustment_details: JSON.stringify({
          kind: "yield_acquisition",
          basisPolicy: "zero",
        }),
      });
      const feeRow = await stagingRow(importBatch, 2);
      const transferRow = await stagingRow(importBatch, 3);
      onCleanup(
        "DELETE FROM portfolio_asset_adjustment_sources WHERE staging_row_id=$1",
        yieldRow,
      );
      onCleanup(
        "DELETE FROM portfolio_asset_adjustments WHERE import_batch_id=$1",
        importBatch,
      );
      onCleanup(
        "DELETE FROM portfolio_asset_transfers WHERE import_batch_id=$1",
        importBatch,
      );

      const sources = await assetAdjustments.getEligibleYieldSources(
        inv,
        source,
      );
      expect(sources.map((row) => row.staging_row_id)).toEqual([yieldRow]);
      const adjustment = await assetAdjustments.insertAssetAdjustment({
        investment_id: inv,
        account_id: source,
        date: "2025-03-01",
        units: "0.5",
        adjustment_kind: "asset_fee",
        basis_policy: "carried",
        basis_allocations: {},
        eligible_source_record_hashes: [],
        import_batch_id: Number(importBatch),
        staging_row_id: Number(feeRow),
        source_record_hash: hex("fee"),
        dedup_fingerprint: hex("fee fingerprint"),
        dedup_fingerprint_version: 1,
      });
      await assetAdjustments.retainAssetAdjustmentSources(
        adjustment.id,
        sources,
      );
      expect(
        await assetAdjustments.findAssetAdjustmentFingerprint(
          hex("fee fingerprint"),
          1,
        ),
      ).toMatchObject({ id: adjustment.id, date: "2025-03-01" });
      expect(
        await assetAdjustments.getAssetAdjustmentsForBatch(importBatch),
      ).toHaveLength(1);

      const transfer = await assetTransfers.insertAssetTransfer({
        investment_id: inv,
        source_account_id: source,
        destination_account_id: destination,
        date: "2025-03-02",
        units: "1",
        fee_units: "0",
        fee_basis_allocations: {},
        import_batch_id: Number(importBatch),
        staging_row_id: Number(transferRow),
        source_record_hash: hex("transfer"),
        dedup_fingerprint: hex("transfer fingerprint"),
        dedup_fingerprint_version: 1,
      });
      expect(
        await assetTransfers.findAssetTransferFingerprint(
          hex("transfer fingerprint"),
          1,
        ),
      ).toMatchObject({ id: transfer.id, date: "2025-03-02" });
      expect(
        await assetTransfers.getAssetTransfersForBatch(importBatch),
      ).toHaveLength(1);
      expect(await assetTransfers.hasAssetTransfersForInvestment(inv)).toBe(
        true,
      );
      expect(await getUnitEventsForInvestment(inv)).toHaveLength(2);
      expect(
        (await portfolioTransactionRepository.getRowsForPortfolioMath()).filter(
          (row) => row.investment_id === inv,
        ),
      ).toHaveLength(2);

      // Paired in-kind income: a proved zero-cost unit lot plus its matched
      // income staging row, in a batch carrying the primary-source proof.
      const sourceFileHash = hex("source file");
      await pool.query(
        "UPDATE portfolio_import_batches SET custom_config=$2 WHERE id=$1",
        [
          importBatch,
          JSON.stringify({
            format: "kinesis_transaction_history",
            yield_basis_policy: "zero",
            kinesis_source_context: { source_file_hash: sourceFileHash },
          }),
        ],
      );
      const { rows: unitRows } = await pool.query<{ id: number }>(
        `INSERT INTO portfolio_transactions(investment_id,type,date,amount,units,price_per_unit,fees,taxes,currency,account_id,source_record_hash,import_batch_id)
         VALUES($1,'gift','2025-03-03',0,0.1,0,0,0,'EUR',$2,$3,$4) RETURNING id`,
        [inv, source, hex("income"), importBatch],
      );
      const unitId = unitRows[0]!.id;
      const { rows: unitImages } = await pool.query<{
        snapshot: Record<string, unknown>;
      }>(
        "SELECT portfolio_income_transaction_snapshot(t) AS snapshot FROM portfolio_transactions t WHERE id=$1",
        [unitId],
      );
      const incomeRow = await stagingRow(importBatch, 4, {
        status: "matched",
        type: "dividend",
        route: "portfolio",
      });
      const unitSource = await stagingRow(importBatch, 5);
      // The journal is immutable; only this suite's rows are removed.
      onCleanup(
        "ALTER TABLE portfolio_import_income_recognition_journal ENABLE TRIGGER portfolio_income_journal_immutable",
      );
      onCleanup(
        "DELETE FROM portfolio_import_income_recognition_journal WHERE batch_id=$1",
        importBatch,
      );
      onCleanup(
        "ALTER TABLE portfolio_import_income_recognition_journal DISABLE TRIGGER portfolio_income_journal_immutable",
      );
      onCleanup(
        "DELETE FROM portfolio_transactions WHERE import_batch_id=$1",
        importBatch,
      );
      // The pair-receipt trigger is checked at commit, as in production.
      const income = await withTransaction(() =>
        recordPairedPortfolioIncome({
          row: {
            id: incomeRow,
            batch_id: importBatch,
            investment_id: inv,
            tx_date: "2025-03-03",
            amount: "1.50",
            currency: "EUR",
            note: null,
            account_id: source,
            source_record_hash: hex("income"),
            dedup_fingerprint: hex("income fingerprint"),
            dedup_fingerprint_version: 1,
          },
          unit: { ...unitImages[0]!.snapshot, id: unitId },
          unitSource: { id: unitSource },
          proof: { sourceFileHash },
        }),
      );
      expect(income.investment_id).toBe(inv);
      const context = await readIncomeRecognitionContext([
        { id: unitId, type: "gift" },
      ]);
      expect(context.receipts).toHaveLength(1);
      expect(await readPairedIncomeRollbackBatchIds(importBatch)).toEqual([
        Number(importBatch),
      ]);
      expect(
        await restorePairedPortfolioIncomeForBatch(importBatch),
      ).toHaveLength(1);
      expect(await getUnitEventIdsForImportBatch(Number(importBatch))).toEqual([
        expect.objectContaining({ investment_id: inv }),
      ]);
    });

    it("reads exposure sources and targets", async () => {
      const inv = await investment("etf");
      onCleanup(
        "DELETE FROM portfolio_exposure_classifications WHERE investment_id=$1",
        inv,
      );
      onCleanup(
        "DELETE FROM portfolio_fund_holdings_documents WHERE investment_id=$1",
        inv,
      );
      const document = {
        contractVersion: 1,
        fund: {
          name: "Synthetic fund",
          identifiers: [{ type: "proprietary", value: "synthetic-fund" }],
        },
        shareClass: {
          name: "Synthetic EUR",
          identifiers: [{ type: "isin", value: "IE00B4L5Y983" }],
          currency: "EUR",
        },
        source: {
          kind: "user-supplied-file",
          fileName: "synthetic.csv",
          asOfDate: "2026-09-01",
          retrievedAt: "2026-09-02T00:00:00Z",
          license: { status: "user-provided", redistribution: "forbidden" },
        },
        holdings: [],
        coverage: {
          status: "complete",
          reportedWeightPercent: "100",
          supportedWeightPercent: "100",
          unsupportedWeightPercent: "0",
          missingWeightPercent: "0",
        },
        staleness: {
          evaluatedAt: "2026-09-14",
          maximumAgeDays: 30,
          ageDays: 13,
          status: "current",
        },
      } as unknown as FundHoldingsDocument;

      const bundle = await upsertExposureBundle({
        classifications: [
          {
            investmentId: inv,
            issuerId: "synthetic-issuer",
            issuerName: "Synthetic issuer",
            sourceLabel: "synthetic",
          },
        ],
        fundDocuments: [
          {
            investmentId: inv,
            shareClassIdentifier: { type: "isin", value: "IE00B4L5Y983" },
            document,
            sourceSha256: hex("document"),
          },
        ],
      });
      expect(
        bundle.classifications.find((row) => row.investmentId === inv)?.id,
      ).toEqual(expect.any(String));
      expect(
        bundle.documents.find((row) => row.investmentId === inv)
          ?.sourceAsOfDate,
      ).toBeInstanceOf(Date);
      expect(
        (await listExposureSources()).documents.length,
      ).toBeGreaterThanOrEqual(1);
      expect(await listExposureTargets([inv])).toEqual([
        { id: inv, assetClass: "etf" },
      ]);
    });

    it("reads stored prices and quote holding windows", async () => {
      const broker = await account();
      const inv = await investment("crypto");
      await portfolioTransactionService.create({
        investment_id: inv,
        type: "buy",
        date: "2025-01-02",
        amount: 100,
        units: 1,
        currency: "EUR",
        account_id: broker,
      });
      await saveHistoricalPointsToDatabase(
        inv,
        [
          { timestampMs: Date.UTC(2025, 0, 2, 12), price: 100 },
          { timestampMs: Date.UTC(2025, 0, 3, 12), price: 101 },
        ],
        "manual",
      );
      expect(await loadHistoricalPointsFromDatabase(inv)).toHaveLength(2);
      expect(
        (await loadLatestHistoricalPointByInvestmentIds([inv])).get(inv),
      ).toMatchObject({ price: 101 });

      expect((await getInvestmentsWithHoldingWindows()).has(inv)).toBe(true);
      await expect(refreshQuotesForInvestment(inv)).resolves.toBeUndefined();
      await expect(backfillHoldingGaps()).resolves.toMatchObject({
        failed: 0,
      });
    });

    it("reads stored exchange rates for every FX path", async () => {
      const currency = "ZZX";
      onCleanup("DELETE FROM exchange_rates WHERE currency_code=$1", currency);
      await pool.query(
        `INSERT INTO exchange_rates(currency_code,rate_to_eur,rate_date,is_latest)
         VALUES($1,0.5,'2025-01-02',false),($1,0.25,$2::date,true)`,
        [currency, todayAppDateString()],
      );

      expect((await loadFromDatabase())?.[currency]).toBe(0.25);
      expect(await getStoredRateToEurOnOrBefore(currency, "2025-01-05")).toBe(
        0.5,
      );
      expect(await getPriorRateFromDatabase(currency, "2025-01-05")).toBe(0.5);
      expect(await getRateToEurForDate(currency, "2025-01-02")).toBe(0.5);
      expect(
        (await getHistoricalRateIndex([currency])).get(currency)?.length,
      ).toBeGreaterThanOrEqual(1);
      expect(
        (await listLatestStoredRates()).rows.map((row) => row.currency_code),
      ).toContain(currency);
    });

    it("reads portfolio summary, snapshots and broker snapshots", async () => {
      const broker = await account();
      const unitInv = await investment("stock");
      const savings = await investment("savings");
      const usd = "USD";
      onCleanup(
        "DELETE FROM exchange_rates WHERE currency_code=$1 AND rate_date='2025-01-02'",
        usd,
      );
      await pool.query(
        `INSERT INTO exchange_rates(currency_code,rate_to_eur,rate_date,is_latest)
         VALUES($1,0.9,'2025-01-02',false) ON CONFLICT DO NOTHING`,
        [usd],
      );
      await portfolioTransactionService.create({
        investment_id: unitInv,
        type: "buy",
        date: "2025-01-02",
        amount: 100,
        units: 10,
        currency: "USD",
        account_id: broker,
      });
      await portfolioTransactionService.create({
        investment_id: savings,
        type: "buy",
        date: "2025-01-02",
        amount: 1000,
        currency: "EUR",
        account_id: broker,
      });
      await pool.query(
        `INSERT INTO portfolio_transactions(investment_id,type,date,amount,currency,account_id)
         VALUES($1,'dividend','2025-01-03',2,'EUR',$2)`,
        [unitInv, broker],
      );
      await pool.query("UPDATE investments SET is_active=false WHERE id=$1", [
        unitInv,
      ]);
      await saveHistoricalPointsToDatabase(
        unitInv,
        [{ timestampMs: Date.UTC(2025, 0, 2, 12), price: 10 }],
        "manual",
      );

      const summary = await getPortfolioSummary("EUR", {
        includeBrokerSnapshotParity: true,
      });
      expect(summary).toBeTruthy();

      onCleanup(
        "DELETE FROM portfolio_broker_snapshots WHERE account_id=$1",
        broker,
      );
      onCleanup(
        "DELETE FROM portfolio_broker_snapshots WHERE account_key='unassigned' AND currency='EUR'",
      );
      await storeCurrentBrokerSnapshot("EUR", summary);
      const today = todayAppDateString();
      await expect(
        getBrokerSnapshots("2000-01-01", today, "EUR"),
      ).resolves.toEqual(expect.any(Array));

      const snapshots = await computeAndStoreSnapshots("EUR");
      expect(snapshots.length).toBeGreaterThan(0);
      expect(await getSnapshots("2025-01-01", today, "EUR")).not.toHaveLength(
        0,
      );
      expect(await getLatestSnapshot("EUR")).toBeTruthy();
    });

    it("runs the historical FX backfill over stored pairs without fetching", async () => {
      const inv = await investment("stock", "USD");
      const broker = await account();
      onCleanup(
        "DELETE FROM exchange_rates WHERE currency_code='USD' AND rate_date='2025-01-06'",
      );
      await pool.query(
        `INSERT INTO exchange_rates(currency_code,rate_to_eur,rate_date,is_latest)
         VALUES('USD',0.9,'2025-01-06',false) ON CONFLICT DO NOTHING`,
      );
      await portfolioTransactionService.create({
        investment_id: inv,
        type: "buy",
        date: "2025-01-06",
        amount: 10,
        units: 1,
        currency: "USD",
        fx_rate_to_eur: 0.9,
        account_id: broker,
      });
      // Only the one-time full-history repair feed answers, so the repair's
      // stored-rate read runs too; every other fetch still fails.
      const previousFlag = await pool.query(
        "SELECT value FROM user_settings WHERE key='fx_full_history_repair_done'",
      );
      onCleanup(
        "DELETE FROM user_settings WHERE key='fx_full_history_repair_done' AND $1::boolean",
        previousFlag.rows.length === 0,
      );
      await pool.query(
        "DELETE FROM user_settings WHERE key='fx_full_history_repair_done'",
      );
      vi.mocked(globalThis.fetch).mockImplementation(async (url) => {
        if (String(url).includes("eurofxref-hist.xml"))
          return new Response(
            "<Cube><Cube time='2025-01-06'><Cube currency='USD' rate='1.1111'/></Cube></Cube>",
          );
        throw new Error("network disabled in this suite");
      });
      await expect(backfillPortfolioHistoricalRates()).resolves.toEqual(
        expect.objectContaining({ missing: expect.any(Number) }),
      );
      if (previousFlag.rows.length > 0)
        await pool.query(
          "UPDATE user_settings SET value=$1 WHERE key='fx_full_history_repair_done'",
          [previousFlag.rows[0].value],
        );
    });
  },
);
