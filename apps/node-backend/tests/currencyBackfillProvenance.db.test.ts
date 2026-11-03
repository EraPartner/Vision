import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  closeTestPool,
  getTestPool,
  hasTestDatabase,
} from "./setup/db.ts";
import type { TestPool } from "./setup/db.ts";
import {
  closePool,
  getPoolStats,
  withTransaction,
} from "../src/database/connection.ts";
import {
  backfillPortfolioHistoricalRates,
  clearMemoryCache,
  convertRowsToEur,
} from "../src/services/currency/currencyConversionService.ts";
import { clearHistoricalCache } from "../src/services/currency/rateFetcher.ts";
import { PORTFOLIO_TRANSACTION_SNAPSHOT_SQL } from "../src/repositories/portfolioImportReconciliationRepository.ts";
import { firstRow, must } from "./helpers/must.ts";

// Isolate stamping and cache filling from the separate one-time repair job.
vi.mock("../src/repositories/settingsRepository.ts", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../src/repositories/settingsRepository.ts")
    >();
  return {
    ...original,
    settingsRepository: {
      ...original.settingsRepository,
      get: vi.fn().mockResolvedValue(true),
    },
  };
});

// Resolved in beforeAll, with the rest of the suite's database setup.
let pool: TestPool;
const day = "1950-02-03";
const hash = "a".repeat(64);
let investmentId: number;
let batchId: number;
let accountId: number;

async function transaction(
  fields: {
    fx?: string;
    importBatchId?: number;
    sourceHash?: string;
    fingerprint?: string;
    accountId?: number;
  } = {},
) {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO portfolio_transactions
       (investment_id,type,date,amount,units,price_per_unit,currency,
        fx_rate_to_eur,import_batch_id,source_record_hash,dedup_fingerprint,dedup_fingerprint_version,account_id)
     VALUES ($1,'gift',$2,'20.0000','2.00000000','10.000000','USD',vision_numeric($3, 20, 10),$4,$5,$6,$7,$8) RETURNING id`,
    [
      investmentId,
      day,
      fields.fx ?? null,
      fields.importBatchId ?? null,
      fields.sourceHash ?? null,
      fields.fingerprint ?? null,
      fields.fingerprint ? 1 : null,
      fields.accountId ?? null,
    ],
  );
  return firstRow(result).id;
}

/** The audit snapshot of a transaction row (jsonb). */
type Snapshot = Record<string, unknown> & { fx_rate_to_eur: string | null };

async function snapshot(id: number): Promise<Snapshot> {
  return firstRow(
    await pool.query<{ snapshot: Snapshot }>(
      `SELECT ${PORTFOLIO_TRANSACTION_SNAPSHOT_SQL} AS "snapshot::json"
       FROM portfolio_transactions pt WHERE pt.id=$1`,
      [id],
    ),
  ).snapshot;
}

describe.skipIf(!hasTestDatabase())("historical FX backfill provenance", () => {
  beforeAll(() => {
    pool = must(getTestPool(), "getTestPool()");
  });

  beforeEach(async () => {
    clearMemoryCache();
    clearHistoricalCache();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503 }),
    );
    accountId = firstRow(
      await pool.query<{ id: number }>(
        "INSERT INTO accounts(name,type,currency) VALUES ('Synthetic FX broker','brokerage','EUR') RETURNING id",
      ),
    ).id;
    investmentId = firstRow(
      await pool.query<{ id: number }>(
        "INSERT INTO investments(name,symbol,asset_class,currency) VALUES ('Synthetic FX asset','FXPROOF','stock','EUR') RETURNING id",
      ),
    ).id;
    batchId = firstRow(
      await pool.query<{ id: number }>(
        "INSERT INTO portfolio_import_batches(adapter_name,status,rows_total,account_id,is_brokerage) VALUES ('synthetic_fx','awaiting_review',1,$1,true) RETURNING id",
        [accountId],
      ),
    ).id;
    await pool.query(
      "INSERT INTO exchange_rates(currency_code,rate_to_eur,rate_date,is_latest) VALUES ('USD',vision_numeric('0.5', 20, 10),$1,0)",
      [day],
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    clearMemoryCache();
    clearHistoricalCache();
    // The immutable receipt table can only be reset in this disposable suite.
    await pool.query("DELETE FROM portfolio_import_reconciliation_journal");
    await pool.query(
      "DELETE FROM portfolio_transactions WHERE investment_id=$1",
      [investmentId],
    );
    await pool.query("DELETE FROM portfolio_import_batches WHERE id=$1", [
      batchId,
    ]);
    await pool.query("DELETE FROM investments WHERE id=$1", [investmentId]);
    await pool.query("DELETE FROM accounts WHERE id=$1", [accountId]);
    await pool.query(
      "DELETE FROM exchange_rates WHERE currency_code='USD' AND rate_date=$1",
      [day],
    );
  });

  afterAll(async () => {
    await closeTestPool();
    await closePool();
  });

  it("stamps manual missing FX while preserving imported, adopted and literal evidence", async () => {
    const manual = await transaction();
    const imported = await transaction({ importBatchId: batchId });
    const hashed = await transaction({ sourceHash: hash });
    const fingerprinted = await transaction({ fingerprint: "b".repeat(64) });
    const literal = await transaction({ fx: "0.7500000000" });
    const adopted = await transaction();
    const before = await snapshot(adopted);
    await pool.query(
      "UPDATE portfolio_transactions SET account_id=$2,source_record_hash=$3,dedup_fingerprint=$3,dedup_fingerprint_version=1 WHERE id=$1",
      [adopted, accountId, hash],
    );
    const after = await snapshot(adopted);
    const stagingId = firstRow(
      await pool.query<{ id: number }>(
        "INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,raw_data) VALUES ($1,0,'duplicate','Synthetic FX source') RETURNING id",
        [batchId],
      ),
    ).id;
    await pool.query(
      "INSERT INTO portfolio_import_reconciliation_journal(batch_id,staging_row_id,transaction_id,action,policy,before_data,after_data) VALUES ($1,$2,$3,'adopt','prefer_source',vision_jsonb($4),vision_jsonb($5))",
      [
        batchId,
        stagingId,
        adopted,
        JSON.stringify(before),
        JSON.stringify(after),
      ],
    );

    expect(await backfillPortfolioHistoricalRates()).toMatchObject({
      stamped: 1,
    });
    expect((await snapshot(manual)).fx_rate_to_eur).toBe("0.5000000000");
    expect((await snapshot(literal)).fx_rate_to_eur).toBe("0.7500000000");
    for (const id of [imported, hashed, fingerprinted, adopted])
      expect((await snapshot(id)).fx_rate_to_eur).toBeNull();
    expect(await snapshot(adopted)).toEqual(after);
    expect(
      firstRow(
        await pool.query<{ after_data: unknown }>(
          "SELECT after_data FROM portfolio_import_reconciliation_journal WHERE transaction_id=$1",
          [adopted],
        ),
      ).after_data,
    ).toEqual(after);
  });

  it("fills and uses dated rate cache even when every source row must retain null FX", async () => {
    const id = await transaction({
      sourceHash: hash,
      fingerprint: hash,
      accountId,
    });
    await pool.query(
      "DELETE FROM exchange_rates WHERE currency_code='USD' AND rate_date=$1",
      [day],
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: () =>
          Promise.resolve(`<Cube><Cube time='${day}'><Cube currency='USD' rate='2'/></Cube></Cube>`),
      }),
    );
    expect(await backfillPortfolioHistoricalRates()).toMatchObject({
      inserted: 1,
      stamped: 0,
    });
    expect((await snapshot(id)).fx_rate_to_eur).toBeNull();
    expect(
      firstRow(
        await pool.query<{ rate: string }>(
          "SELECT rate_to_eur AS rate FROM exchange_rates WHERE currency_code='USD' AND rate_date=$1",
          [day],
        ),
      ).rate,
    ).toBe("0.5000000000");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503 }),
    );
    const converted = await convertRowsToEur(
      [{ amount: 20, currency: "USD", date: day }],
      "EUR",
      {
        useHistoricalRatesByDate: true,
        dateField: "date",
      },
    );
    expect(must(converted[0], "converted[0]").amount_eur).toBe(10);
    expect(must(converted[0], "converted[0]").used_fallback_rate).not.toBe(true);
    expect((await snapshot(id)).fx_rate_to_eur).toBeNull();
  });

  it.each([
    "import_batch_id",
    "source_record_hash",
    "dedup_fingerprint",
    "fx_rate_to_eur",
  ])(
    "rechecks %s after waiting for a concurrent transaction update",
    async (field) => {
      const id = await transaction();
      const assignment =
        field === "dedup_fingerprint"
          ? "dedup_fingerprint=$2,dedup_fingerprint_version=1"
          : field === "fx_rate_to_eur"
            ? "fx_rate_to_eur=vision_numeric($2, 20, 10)"
            : `${field}=$2`;
      const value =
        field === "import_batch_id"
          ? batchId
          : field === "fx_rate_to_eur"
            ? "0.75"
            : hash;
      // The holder's open write transaction (BEGIN IMMEDIATE) stands where the
      // PostgreSQL suite held the row with FOR UPDATE: the backfill's stamping
      // UPDATE queues behind it and must re-check the row once it runs.
      let held!: () => void;
      let proceed: () => void = () => {};
      const isHeld = new Promise<void>((resolve) => {
        held = resolve;
      });
      const holder = withTransaction(async (client) => {
        held();
        await new Promise<void>((resolve) => {
          proceed = resolve;
        });
        await client.query(
          `UPDATE portfolio_transactions SET ${assignment} WHERE id=$1`,
          [id, value],
        );
      });
      await isHeld;
      let backfill: ReturnType<typeof backfillPortfolioHistoricalRates> | undefined;
      try {
        backfill = backfillPortfolioHistoricalRates();
        await vi.waitFor(
          () => {
            expect(getPoolStats().waitingCount).toBeGreaterThan(0);
          },
          { interval: 10, timeout: 3000 },
        );
        proceed();
        await holder;
        expect(await backfill).toMatchObject({ stamped: 0 });
        expect((await snapshot(id)).fx_rate_to_eur).toBe(
          field === "fx_rate_to_eur" ? "0.7500000000" : null,
        );
      } finally {
        proceed();
        await holder.catch(() => undefined);
        await backfill?.catch(() => undefined);
      }
    },
  );
});
