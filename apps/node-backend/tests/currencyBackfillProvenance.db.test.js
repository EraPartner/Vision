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
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.js";
import { closePool } from "../src/database/connection.ts";
import {
  backfillPortfolioHistoricalRates,
  clearMemoryCache,
  convertRowsToEur,
} from "../src/services/currency/currencyConversionService.js";
import { clearHistoricalCache } from "../src/services/currency/rateFetcher.js";
import { PORTFOLIO_TRANSACTION_SNAPSHOT_SQL } from "../src/repositories/portfolioImportReconciliationRepository.ts";

// Isolate stamping and cache filling from the separate one-time repair job.
vi.mock("../src/repositories/settingsRepository.ts", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    settingsRepository: {
      ...original.settingsRepository,
      get: vi.fn().mockResolvedValue(true),
    },
  };
});

const pool = getTestPool();
const day = "1950-02-03";
const hash = "a".repeat(64);
let investmentId;
let batchId;
let accountId;

async function transaction(fields = {}) {
  const { rows } = await pool.query(
    `INSERT INTO portfolio_transactions
       (investment_id,type,date,amount,units,price_per_unit,currency,
        fx_rate_to_eur,import_batch_id,source_record_hash,dedup_fingerprint,dedup_fingerprint_version,account_id)
     VALUES ($1,'gift',$2,20,2,10,'USD',$3,$4,$5,$6,$7,$8) RETURNING id`,
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
  return rows[0].id;
}

async function snapshot(id) {
  return (
    await pool.query(
      `SELECT ${PORTFOLIO_TRANSACTION_SNAPSHOT_SQL} AS snapshot
       FROM portfolio_transactions pt WHERE pt.id=$1`,
      [id],
    )
  ).rows[0].snapshot;
}

describe.skipIf(!hasTestDatabase())("historical FX backfill provenance", () => {
  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
    await acquireDbSuiteLock();
  }, 180_000);

  beforeEach(async () => {
    clearMemoryCache();
    clearHistoricalCache();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503 }),
    );
    accountId = (
      await pool.query(
        "INSERT INTO accounts(name,type,currency) VALUES ('Synthetic FX broker','brokerage','EUR') RETURNING id",
      )
    ).rows[0].id;
    investmentId = (
      await pool.query(
        "INSERT INTO investments(name,symbol,asset_class,currency) VALUES ('Synthetic FX asset','FXPROOF','stock','EUR') RETURNING id",
      )
    ).rows[0].id;
    batchId = (
      await pool.query(
        "INSERT INTO portfolio_import_batches(adapter_name,status,rows_total,account_id,is_brokerage) VALUES ('synthetic_fx','awaiting_review',1,$1,true) RETURNING id",
        [accountId],
      )
    ).rows[0].id;
    await pool.query(
      "INSERT INTO exchange_rates(currency_code,rate_to_eur,rate_date,is_latest) VALUES ('USD',0.5,$1,false)",
      [day],
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    clearMemoryCache();
    clearHistoricalCache();
    // The immutable receipt table can only be reset in this disposable suite.
    await pool.query("TRUNCATE portfolio_import_reconciliation_journal");
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
    await releaseDbSuiteLock();
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
    const stagingId = (
      await pool.query(
        "INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,raw_data) VALUES ($1,0,'duplicate','Synthetic FX source') RETURNING id",
        [batchId],
      )
    ).rows[0].id;
    await pool.query(
      "INSERT INTO portfolio_import_reconciliation_journal(batch_id,staging_row_id,transaction_id,action,policy,before_data,after_data) VALUES ($1,$2,$3,'adopt','prefer_source',$4::jsonb,$5::jsonb)",
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
      (
        await pool.query(
          "SELECT after_data FROM portfolio_import_reconciliation_journal WHERE transaction_id=$1",
          [adopted],
        )
      ).rows[0].after_data,
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
        text: async () =>
          `<Cube><Cube time='${day}'><Cube currency='USD' rate='2'/></Cube></Cube>`,
      }),
    );
    expect(await backfillPortfolioHistoricalRates()).toMatchObject({
      inserted: 1,
      stamped: 0,
    });
    expect((await snapshot(id)).fx_rate_to_eur).toBeNull();
    expect(
      (
        await pool.query(
          "SELECT rate_to_eur::text AS rate FROM exchange_rates WHERE currency_code='USD' AND rate_date=$1",
          [day],
        )
      ).rows[0].rate,
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
    expect(converted[0].amount_eur).toBe(10);
    expect(converted[0].used_fallback_rate).not.toBe(true);
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
      const holder = await pool.connect();
      let backfill;
      try {
        await holder.query("BEGIN");
        const pid = (await holder.query("SELECT pg_backend_pid() AS pid"))
          .rows[0].pid;
        await holder.query(
          "SELECT id FROM portfolio_transactions WHERE id=$1 FOR UPDATE",
          [id],
        );
        backfill = backfillPortfolioHistoricalRates();
        await vi.waitFor(
          async () => {
            const blocked = await pool.query(
              "SELECT count(*)::int AS count FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))",
              [pid],
            );
            expect(blocked.rows[0].count).toBeGreaterThan(0);
          },
          { interval: 10, timeout: 3000 },
        );
        const assignment =
          field === "dedup_fingerprint"
            ? "dedup_fingerprint=$2,dedup_fingerprint_version=1"
            : `${field}=$2`;
        const value =
          field === "import_batch_id"
            ? batchId
            : field === "fx_rate_to_eur"
              ? "0.75"
              : hash;
        await holder.query(
          `UPDATE portfolio_transactions SET ${assignment} WHERE id=$1`,
          [id, value],
        );
        await holder.query("COMMIT");
        expect(await backfill).toMatchObject({ stamped: 0 });
        expect((await snapshot(id)).fx_rate_to_eur).toBe(
          field === "fx_rate_to_eur" ? "0.7500000000" : null,
        );
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
        await backfill;
      }
    },
  );
});
