import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
} from "./setup/db.js";
import { closePool } from "../src/database/connection.ts";
import { toDecimal } from "../src/lib/money.ts";
import { PORTFOLIO_TRANSACTION_SNAPSHOT_SQL } from "../src/repositories/portfolioImportReconciliationRepository.ts";
import {
  applyPortfolioImportReconciliation,
  getPortfolioImportRepairBatchIds,
  previewPortfolioImportReconciliation,
} from "../src/services/portfolioImportReconciliationService.js";
import {
  syntheticSaxoStaging,
  syntheticSaxoPrimaryRawData,
  saxoHash,
} from "./helpers/saxoReconciliation.js";
import { syntheticIbkrPlannerSource } from "./helpers/ibkrReconciliation.js";
import { mockCurrencyConversion } from "./helpers/mockCurrencyConversion.js";
import {
  syntheticKinesisScope,
  syntheticKinesisManual,
} from "./helpers/kinesisAdoptionScope.js";
import {
  syntheticKinesisYieldGroup,
  attachKinesisYieldReference,
  retainedKinesisYieldEvidence,
} from "./helpers/kinesisYieldGroups.js";
import { readReconciliationSources } from "../src/repositories/portfolioImportReconciliationRepository.ts";
import { portfolioReferenceStagingBinding } from "../src/services/portfolioPerformanceReferenceEvidence.js";
import { commitReviewedPortfolioImports } from "../src/services/portfolioImportCommitService.js";
import { rollbackBatch } from "../src/services/portfolioImportBatchService.js";
import portfolioTransactionService from "../src/services/portfolio/portfolioTransactionService.js";
import {
  getSaxoCsvCompanionEvidence,
  getSaxoWorkbookReconciliationEvidence,
} from "../src/services/portfolioImportPipeline/saxoTransactionHistoryAdapter.js";
import { pruneOldImportBatches } from "../src/startup/warmup.ts";
import {
  retainedEvent,
  retainedReference,
  retainedEvidenceRow,
  retainedReferenceConfiguration,
} from "./fixtures/retainedPortfolioEvidence.js";

const historicalWarm = vi.hoisted(() => vi.fn());
vi.mock(
  "../src/services/currency/currencyConversionService.js",
  async (importOriginal) =>
    mockCurrencyConversion({
      ...(await importOriginal()),
      convertRowsToEur: (...args) => historicalWarm(...args),
    }),
);

const pool = getTestPool();
const describeDb = hasTestDatabase() ? describe : describe.skip;
const owned = { accounts: [], investments: [], batches: [], directories: [] };
const hash = (value) => createHash("sha256").update(value).digest("hex");
let sequence = 0;

async function fixture() {
  const account = (
    await pool.query(
      "INSERT INTO accounts(name,type,currency) VALUES ($1,'brokerage','EUR') RETURNING id",
      [`Reconciliation test broker ${++sequence}`],
    )
  ).rows[0].id;
  const investment = (
    await pool.query(
      "INSERT INTO investments(name,symbol,asset_class,currency) VALUES ('Reconciliation test asset','RECONTEST','stock','EUR') RETURNING id",
    )
  ).rows[0].id;
  owned.accounts.push(account);
  owned.investments.push(investment);
  return { account, investment };
}
async function legacy(
  fx,
  {
    date = "2026-01-01",
    amount = 500,
    units = 5,
    price = 100,
    fees = 0,
    note = "Original manual note",
  } = {},
) {
  return (
    await pool.query(
      `INSERT INTO portfolio_transactions(investment_id,type,date,amount,units,price_per_unit,fees,currency,note)
    VALUES ($1,'buy',$2,$3,$4,$5,$6,'EUR',$7) RETURNING id`,
      [fx.investment, date, amount, units, price, fees, note],
    )
  ).rows[0].id;
}
async function batch(
  fx,
  rows = [{}],
  { identityPrefix = `receipt-${++sequence}` } = {},
) {
  const id = Number(
    (
      await pool.query(
        `INSERT INTO portfolio_import_batches(adapter_name,custom_config,status,rows_total,account_id,is_brokerage)
    VALUES ('saxo_transaction_history','{"format":"saxo_transaction_history"}','awaiting_review',$1,$2,true) RETURNING id`,
        [rows.length, fx.account],
      )
    ).rows[0].id,
  );
  owned.batches.push(id);
  for (const [index, row] of rows.entries()) {
    const identity = `${identityPrefix}-${index}`;
    await pool.query(
      `INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,tx_date,type_raw,type,route,units,price_per_unit,amount,fees,taxes,currency,resolved_investment_id,raw_data,source_record_hash,dedup_fingerprint,dedup_fingerprint_version,dedup_occurrence)
      VALUES ($1,$2,$3,$4,$5::text,$5::text::portfolio_txn_type,'portfolio',$6,$7,$8,$9,0,'EUR',$10,$11,$12,$13,1,1)`,
      [
        id,
        index,
        row.status ?? "matched",
        row.date ?? "2026-01-01",
        row.type ?? "buy",
        row.units === undefined ? 5 : row.units,
        row.price === undefined ? 100 : row.price,
        row.amount ?? 500,
        row.fees ?? 0,
        fx.investment,
        `Synthetic source ${identity}`,
        hash(`raw-${identity}`),
        hash(identity),
      ],
    );
  }
  return id;
}
async function cleanup() {
  historicalWarm.mockReset();
  await pool.query(
    "DELETE FROM exchange_rates WHERE currency_code='USD' AND rate_date='2026-01-05'",
  );
  for (const directory of owned.directories)
    await rm(directory, { recursive: true, force: true });
  owned.directories.length = 0;
  // Suite-wide advisory lock makes these receipts solely this fixture corpus.
  await pool.query(
    "TRUNCATE portfolio_import_reconciliation_journal RESTART IDENTITY",
  );
  await pool.query(
    "TRUNCATE portfolio_import_duplicate_repair_journal RESTART IDENTITY",
  );
  if (owned.investments.length)
    await pool.query(
      "DELETE FROM portfolio_asset_transfers WHERE investment_id = ANY($1::integer[])",
      [owned.investments],
    );
  if (owned.investments.length)
    await pool.query(
      "DELETE FROM portfolio_transactions WHERE investment_id = ANY($1::integer[])",
      [owned.investments],
    );
  if (owned.batches.length)
    await pool.query(
      "DELETE FROM portfolio_import_batches WHERE id = ANY($1::bigint[])",
      [owned.batches],
    );
  if (owned.accounts.length)
    await pool.query(
      "DELETE FROM transactions WHERE account_id = ANY($1::integer[])",
      [owned.accounts],
    );
  if (owned.investments.length)
    await pool.query("DELETE FROM investments WHERE id = ANY($1::integer[])", [
      owned.investments,
    ]);
  if (owned.accounts.length)
    await pool.query("DELETE FROM accounts WHERE id = ANY($1::integer[])", [
      owned.accounts,
    ]);
  owned.accounts.length = 0;
  owned.investments.length = 0;
  owned.batches.length = 0;
}

async function stagedKinesisScope(fx, options = {}) {
  const source =
    options.source ??
    (await syntheticKinesisScope({
      account: fx.account,
      investment: fx.investment,
      ...options,
    }));
  const id = Number(
    (
      await pool.query(
        `INSERT INTO portfolio_import_batches(adapter_name,custom_config,status,rows_total,rows_error,account_id,is_brokerage)
     VALUES ('kinesis_transaction_history',$1,'awaiting_review',$2,$3,$4,true) RETURNING id`,
        [
          JSON.stringify(source.batches[0].custom_config),
          source.rows.length,
          source.rows.filter((row) => row.status === "error").length,
          fx.account,
        ],
      )
    ).rows[0].id,
  );
  owned.batches.push(id);
  for (const row of source.rows)
    await pool.query(
      `INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,tx_date,type_raw,type,route,symbol_raw,name_raw,units,price_per_unit,amount,fees,taxes,currency,resolved_investment_id,raw_data,source_record_hash,source_transaction_id,source_account_identity,dedup_fingerprint,dedup_fingerprint_version,dedup_occurrence,error_message,asset_transfer_details,asset_adjustment_details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
      [
        id,
        row.row_index,
        row.status,
        row.tx_date,
        row.type_raw,
        row.type,
        row.route,
        row.symbol_raw,
        row.name_raw,
        row.units,
        row.price_per_unit,
        row.amount,
        row.fees,
        row.taxes,
        row.currency,
        row.investment_id,
        row.raw_data,
        row.source_record_hash,
        row.source_transaction_id,
        row.source_account_identity,
        row.dedup_fingerprint,
        row.dedup_fingerprint_version,
        row.dedup_occurrence,
        row.error_message ?? null,
        row.asset_transfer_details,
        row.asset_adjustment_details,
      ],
    );
  return { id, source };
}

async function kinesisClosedGroupFixture() {
  const fx = await fixture();
  await pool.query(
    "UPDATE investments SET symbol='ETH-EUR',asset_class='crypto' WHERE id=$1",
    [fx.investment],
  );
  const fixtureGroup = await syntheticKinesisYieldGroup({
    account: fx.account,
    investment: fx.investment,
    withReference: false,
  });
  const prior = await stagedKinesisScope(fx, { source: fixtureGroup.prior });
  const fresh = await stagedKinesisScope(fx, { source: fixtureGroup.source });
  const priorRows = await readReconciliationSources([prior.id]);
  const cache = {
    sourceHash: fixtureGroup.reference.sourceHash,
    reconciliationScope: "correct_existing_only",
    originalBatchIds: [prior.id],
    effectiveBatchIds: [prior.id],
    routing: [
      {
        batchId: prior.id,
        accountId: fx.account,
        originAccountId: null,
        destinationAccountId: null,
      },
    ],
    stagingBinding: portfolioReferenceStagingBinding(priorRows),
    originalStagingBinding: portfolioReferenceStagingBinding(priorRows),
  };
  await pool.query(
    "UPDATE portfolio_import_batches SET custom_config=$2,rows_duplicate=3 WHERE id=$1",
    [
      prior.id,
      JSON.stringify({
        ...fixtureGroup.prior.batches[0].custom_config,
        portfolio_performance_reference: cache,
      }),
    ],
  );
  const ids = [];
  for (const current of fixtureGroup.source.history) {
    const id = (
      await pool.query(
        `INSERT INTO portfolio_transactions(investment_id,type,date,amount,units,price_per_unit,fees,taxes,currency,fx_rate_to_eur,note,account_id,source_record_hash,dedup_fingerprint,dedup_fingerprint_version)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [
          fx.investment,
          current.type,
          current.date,
          current.amount,
          current.units,
          current.price_per_unit,
          current.fees,
          current.taxes,
          current.currency,
          current.fx_rate_to_eur,
          current.note,
          current.account_id,
          current.source_record_hash,
          current.dedup_fingerprint,
          current.dedup_fingerprint_version,
        ],
      )
    ).rows[0].id;
    ids.push(id);
    const old = fixtureGroup.source.kinesisAdoptionContext.receipts.find(
      (receipt) => receipt.transaction_id === current.id,
    );
    if (!old) continue;
    const retainedRow = fixtureGroup.prior.rows.find(
      (row) => row.id === old.staging_row_id,
    );
    const staging = priorRows.find(
      (row) => row.row_index === retainedRow.row_index,
    );
    const after = (
      await pool.query(
        `SELECT ${PORTFOLIO_TRANSACTION_SNAPSHOT_SQL} AS snapshot FROM portfolio_transactions pt WHERE id=$1`,
        [id],
      )
    ).rows[0].snapshot;
    const before = {
      ...after,
      ...old.before_data,
      id,
      investment_id: fx.investment,
    };
    await pool.query(
      "INSERT INTO portfolio_import_reconciliation_journal(batch_id,staging_row_id,transaction_id,action,policy,before_data,after_data) VALUES($1,$2,$3,'adopt',$4,$5,$6)",
      [
        prior.id,
        staging.id,
        id,
        old.policy,
        JSON.stringify(before),
        JSON.stringify(after),
      ],
    );
  }
  const request = {
    batchIds: [fresh.id],
    adoptPolicy: "prefer_source",
    reconciliationScope: "correct_existing_only",
  };
  return {
    ...fx,
    id: fresh.id,
    priorId: prior.id,
    request,
    reference: fixtureGroup.reference,
    ids,
    source: fixtureGroup.source,
  };
}
async function installStoredGroup(fx, batchId = fx.id) {
  const rows = await readReconciliationSources([batchId]);
  const sourceIds = [...new Set([fx.priorId, fx.id, batchId])];
  const history = (
    await pool.query(
      `SELECT ${PORTFOLIO_TRANSACTION_SNAPSHOT_SQL} AS snapshot FROM portfolio_transactions pt WHERE id=ANY($1::integer[]) ORDER BY id`,
      [fx.ids],
    )
  ).rows.map((item) => item.snapshot);
  const source = {
    rows,
    batches: (
      await pool.query("SELECT * FROM portfolio_import_batches WHERE id=$1", [
        batchId,
      ])
    ).rows,
    history,
    kinesisAdoptionContext: {
      sources: await readReconciliationSources(sourceIds),
      batches: (
        await pool.query(
          "SELECT * FROM portfolio_import_batches WHERE id=ANY($1::bigint[])",
          [sourceIds],
        )
      ).rows,
      receipts: (
        await pool.query(
          "SELECT * FROM portfolio_import_reconciliation_journal j WHERE transaction_id=ANY($1::integer[]) AND action='adopt' AND NOT EXISTS(SELECT 1 FROM portfolio_import_reconciliation_journal r WHERE r.previous_entry_id=j.id AND r.action='restore') ORDER BY id",
          [fx.ids],
        )
      ).rows,
    },
  };
  attachKinesisYieldReference(
    source,
    fx.reference,
    {
      blockers: [],
      yieldGroupEvidence: retainedKinesisYieldEvidence(source, fx.reference),
    },
    "correct_existing_only",
  );
  await pool.query(
    "UPDATE portfolio_import_batches SET custom_config=$2 WHERE id=$1",
    [batchId, JSON.stringify(source.batches[0].custom_config)],
  );
}

async function installStoredCorrection(fx) {
  const rows = await readReconciliationSources(fx.request.batchIds);
  const row = rows[6];
  const event = retainedEvent({
    date: row.tx_date,
    shares: row.units,
    amount: "200",
    currency: "USD",
  });
  const reference = retainedReference([event]);
  const after = retainedEvidenceRow(row, reference, event, "recorded_native", {
    amount: "200",
    price_per_unit: toDecimal(200).div(row.units).toFixed(6),
    currency: "USD",
    fx_rate_to_eur: undefined,
    asset_transfer_details: {
      ...row.asset_transfer_details,
      basisStatus: "recorded_reference",
    },
  });
  await pool.query(
    "UPDATE portfolio_import_staging_rows SET raw_data=$2,amount=$3,price_per_unit=$4,currency=$5,fx_rate_to_eur=NULL,asset_transfer_details=$6::jsonb WHERE id=$1",
    [
      row.id,
      after.raw_data,
      after.amount,
      after.price_per_unit,
      after.currency,
      JSON.stringify(after.asset_transfer_details),
    ],
  );
  const current = await readReconciliationSources(fx.request.batchIds);
  const config = {
    ...current[0].custom_config,
    portfolio_performance_reference: retainedReferenceConfiguration(
      current,
      "correct_existing_only",
      reference,
    ),
  };
  await pool.query(
    "UPDATE portfolio_import_batches SET custom_config=$2 WHERE id=$1",
    [fx.id, JSON.stringify(config)],
  );
}

async function kinesisScopeFixture() {
  const fx = await fixture();
  const staged = await stagedKinesisScope(fx);
  const manual = [];
  for (const [index, row] of [
    staged.source.rows[0],
    staged.source.rows[5],
  ].entries()) {
    const before = syntheticKinesisManual(row);
    const id = (
      await pool.query(
        `INSERT INTO portfolio_transactions(investment_id,type,date,amount,units,price_per_unit,fees,taxes,currency,note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [
          fx.investment,
          before.type,
          before.date,
          before.amount,
          before.units,
          before.price_per_unit,
          before.fees,
          before.taxes,
          before.currency,
          `${before.note} ${index}`,
        ],
      )
    ).rows[0].id;
    manual.push(id);
  }
  const request = {
    batchIds: [staged.id],
    adoptPolicy: "preserve_existing",
    reconciliationScope: "adopt_existing_only",
  };
  return { ...fx, ...staged, manual, request };
}
async function kinesisState(fx) {
  const [financial, staging, batches, receipts, cash, custody] =
    await Promise.all([
      pool.query(
        "SELECT to_jsonb(t) AS data FROM portfolio_transactions t WHERE investment_id=$1 ORDER BY id",
        [fx.investment],
      ),
      pool.query(
        "SELECT to_jsonb(s) AS data FROM portfolio_import_staging_rows s WHERE batch_id=ANY($1::bigint[]) ORDER BY batch_id,row_index",
        [fx.request.batchIds],
      ),
      pool.query(
        "SELECT id,status,rows_imported,rows_duplicate,rows_error,completed_at FROM portfolio_import_batches WHERE id=ANY($1::bigint[]) ORDER BY id",
        [fx.request.batchIds],
      ),
      pool.query(
        "SELECT count(*)::integer AS n FROM portfolio_import_reconciliation_journal",
      ),
      pool.query(
        "SELECT count(*)::integer AS n FROM transactions WHERE account_id=$1",
        [fx.account],
      ),
      pool.query(
        "SELECT (SELECT count(*) FROM portfolio_asset_transfers WHERE investment_id=$1)+(SELECT count(*) FROM portfolio_asset_adjustments WHERE investment_id=$1) AS n",
        [fx.investment],
      ),
    ]);
  return {
    financial: financial.rows,
    staging: staging.rows,
    batches: batches.rows,
    receipts: receipts.rows[0].n,
    cash: cash.rows[0].n,
    custody: Number(custody.rows[0].n),
  };
}

async function kinesisCorrectionFixture({ warmRates = true } = {}) {
  const fx = await kinesisScopeFixture();
  await pool.query(
    "UPDATE portfolio_transactions SET fees=fees+1 WHERE id=$1",
    [fx.manual[0]],
  );
  const adopted = await previewPortfolioImportReconciliation(fx.request);
  await commitReviewedPortfolioImports({
    ...fx.request,
    expectedPlanFingerprint: adopted.planFingerprint,
  });
  const retained = { ...fx, request: fx.request };
  const oldState = await kinesisState(retained);
  const fresh = await stagedKinesisScope(fx);
  const gift = fresh.source.rows[6];
  const existingId = (
    await pool.query(
      `INSERT INTO portfolio_transactions(investment_id,type,date,amount,units,price_per_unit,fees,taxes,currency,fx_rate_to_eur,note)
       VALUES ($1,'gift',$2,200,$3,$4,0,0,'EUR',1,'Keep original native-basis gift note') RETURNING id`,
      [
        fx.investment,
        gift.tx_date,
        gift.units,
        toDecimal(200).div(gift.units).toFixed(6),
      ],
    )
  ).rows[0].id;
  if (warmRates)
    await pool.query(
      "INSERT INTO exchange_rates(currency_code,rate_to_eur,rate_date,is_latest) VALUES('USD',0.9,'2026-01-05',false) ON CONFLICT(currency_code,rate_date) DO UPDATE SET rate_to_eur=EXCLUDED.rate_to_eur",
    );
  historicalWarm.mockImplementation(async (rows) => {
    if (warmRates)
      await pool.query(
        "INSERT INTO exchange_rates(currency_code,rate_to_eur,rate_date,is_latest) VALUES('USD',0.9,'2026-01-05',false) ON CONFLICT(currency_code,rate_date) DO UPDATE SET rate_to_eur=EXCLUDED.rate_to_eur",
      );
    return rows.map((row) => ({
      ...row,
      amount_eur: 0,
      ...(warmRates ? {} : { used_fallback_rate: true }),
    }));
  });
  const request = {
    ...fx.request,
    batchIds: [fresh.id],
    adoptPolicy: "prefer_source",
    reconciliationScope: "correct_existing_only",
  };
  return {
    ...fx,
    id: fresh.id,
    source: fresh.source,
    request,
    existingId,
    retained,
    oldState,
  };
}

describeDb("real PostgreSQL reversible source adoption", () => {
  beforeAll(acquireDbSuiteLock, 180000);
  afterEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await releaseDbSuiteLock();
    await closeTestPool();
    await closePool();
  });

  it("corrects closed Kinesis group dates atomically, preserves all other facts and old receipts, repeats and rolls back only the new group", async () => {
    const fx = await kinesisClosedGroupFixture();
    const all = { ...fx, request: { batchIds: [fx.priorId, fx.id] } };
    const baseline = await kinesisState(all);
    const oldReceipts = (
      await pool.query(
        "SELECT to_jsonb(j) AS data FROM portfolio_import_reconciliation_journal j ORDER BY id",
      )
    ).rows;
    await installStoredGroup(fx);
    expect((await kinesisState(all)).staging).toEqual(baseline.staging);
    const preview = await previewPortfolioImportReconciliation(fx.request);
    expect(preview.blockers).toEqual([]);
    expect(preview).toMatchObject({
      ready: true,
      pending: 5,
      summary: { adopt: 2, duplicate: 2, insert: 0, repair_duplicate: 0 },
    });
    expect(
      preview.actions
        .filter((action) => action.action === "adopt")
        .every(
          (action) =>
            action.corrections.length === 1 &&
            action.corrections[0] === "date" &&
            action.dateProof.kind === "closed_kinesis_yield_group",
        ),
    ).toBe(true);
    const before = await kinesisState(all);
    const result = await commitReviewedPortfolioImports({
      ...fx.request,
      expectedPlanFingerprint: preview.planFingerprint,
    });
    expect(result).toMatchObject({
      imported: 0,
      adopted: 2,
      duplicates: 4,
      repaired: 0,
      pending: 5,
      complete: false,
    });
    const after = await kinesisState(all);
    expect(after.receipts).toBe(before.receipts + 2);
    expect(after.cash).toBe(before.cash);
    expect(after.custody).toBe(before.custody);
    expect(after.financial).toHaveLength(before.financial.length);
    const selected = new Set(preview.selectedRowIds);
    expect(
      after.staging.filter((row) => !selected.has(Number(row.data.id))),
    ).toEqual(
      before.staging.filter((row) => !selected.has(Number(row.data.id))),
    );
    const changed = new Set(
      preview.actions
        .filter((action) => action.action === "adopt")
        .map((action) => action.existingTransactionId),
    );
    for (const { data } of after.financial) {
      const original = before.financial.find(
        (row) => row.data.id === data.id,
      ).data;
      const withoutMutable = ({
        updated_at: _updated,
        date: _date,
        account_id: _account,
        source_record_hash: _hash,
        dedup_fingerprint: _fingerprint,
        dedup_fingerprint_version: _version,
        ...facts
      }) => facts;
      expect(withoutMutable(data)).toEqual(withoutMutable(original));
      expect(data.date).toBe(
        changed.has(data.id) ? "2024-04-15" : original.date,
      );
    }
    expect(
      (
        await pool.query(
          "SELECT to_jsonb(j) AS data FROM portfolio_import_reconciliation_journal j WHERE batch_id=$1 ORDER BY id",
          [fx.priorId],
        )
      ).rows,
    ).toEqual(oldReceipts);
    const repeated = await previewPortfolioImportReconciliation(fx.request);
    expect(repeated).toMatchObject({
      ready: true,
      pending: 5,
      summary: { adopt: 0, settled: 4 },
    });
    expect(
      await commitReviewedPortfolioImports({
        ...fx.request,
        expectedPlanFingerprint: repeated.planFingerprint,
      }),
    ).toMatchObject({ imported: 0, adopted: 0, duplicates: 0 });
    expect(await kinesisState(all)).toEqual(after);
    const cloned = structuredClone(fx.source);
    delete cloned.batches[0].custom_config.portfolio_performance_reference;
    const fresh = await stagedKinesisScope(fx, { source: cloned });
    const freshRequest = { ...fx.request, batchIds: [fresh.id] };
    await installStoredGroup(fx, fresh.id);
    expect(
      await previewPortfolioImportReconciliation(freshRequest),
    ).toMatchObject({ ready: true, summary: { adopt: 0, duplicate: 4 } });
    await rollbackBatch(fx.id);
    const restored = await kinesisState(all);
    const withoutUpdated = (rows) =>
      rows.map(({ data: { updated_at: _updated, ...data } }) => data);
    expect(withoutUpdated(restored.financial)).toEqual(
      withoutUpdated(before.financial),
    );
    expect(
      (
        await pool.query(
          "SELECT to_jsonb(j) AS data FROM portfolio_import_reconciliation_journal j WHERE batch_id=$1 ORDER BY id",
          [fx.priorId],
        )
      ).rows,
    ).toEqual(oldReceipts);
  });

  it.each(["source", "reference", "boundary", "anchor", "member"])(
    "rejects stale closed Kinesis group %s proof before selected writes",
    async (kind) => {
      const fx = await kinesisClosedGroupFixture();
      await installStoredGroup(fx);
      const preview = await previewPortfolioImportReconciliation(fx.request);
      expect(preview.blockers).toEqual([]);
      expect(preview.ready).toBe(true);
      if (kind === "source")
        await pool.query(
          "UPDATE portfolio_import_staging_rows SET raw_data=raw_data||'changed' WHERE batch_id=$1 AND row_index=1",
          [fx.id],
        );
      if (kind === "reference")
        await pool.query(
          "UPDATE portfolio_import_batches SET custom_config=jsonb_set(custom_config,'{portfolio_performance_reference,yieldGroupEvidence,referenceDigest}',to_jsonb('changed'::text)) WHERE id=$1",
          [fx.id],
        );
      if (["boundary", "anchor", "member"].includes(kind))
        await pool.query(
          "UPDATE portfolio_transactions SET note=note||'changed' WHERE id=$1",
          [fx.ids[kind === "boundary" ? 0 : kind === "anchor" ? 3 : 1]],
        );
      const before = await kinesisState(fx);
      await expect(
        commitReviewedPortfolioImports({
          ...fx.request,
          expectedPlanFingerprint: preview.planFingerprint,
        }),
      ).rejects.toThrow();
      expect(await kinesisState(fx)).toEqual(before);
    },
  );

  it("rolls back the entire closed Kinesis group if the second date receipt fails", async () => {
    const fx = await kinesisClosedGroupFixture();
    await installStoredGroup(fx);
    const preview = await previewPortfolioImportReconciliation(fx.request);
    const before = await kinesisState(fx);
    await pool.query(
      `CREATE FUNCTION reject_closed_group() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.transaction_id=${Number(fx.ids[2])} AND NEW.batch_id=${fx.id} THEN RAISE EXCEPTION 'Synthetic closed group failure'; END IF; RETURN NEW; END $$`,
    );
    await pool.query(
      "CREATE TRIGGER reject_closed_group BEFORE INSERT ON portfolio_import_reconciliation_journal FOR EACH ROW EXECUTE FUNCTION reject_closed_group()",
    );
    try {
      await expect(
        commitReviewedPortfolioImports({
          ...fx.request,
          expectedPlanFingerprint: preview.planFingerprint,
        }),
      ).rejects.toThrow("Synthetic closed group failure");
      expect(await kinesisState(fx)).toEqual(before);
    } finally {
      await pool.query(
        "DROP TRIGGER reject_closed_group ON portfolio_import_reconciliation_journal",
      );
      await pool.query("DROP FUNCTION reject_closed_group()");
    }
  });

  it("guards closed Kinesis group rollback against a changed date correction after-image", async () => {
    const fx = await kinesisClosedGroupFixture();
    await installStoredGroup(fx);
    const preview = await previewPortfolioImportReconciliation(fx.request);
    await commitReviewedPortfolioImports({
      ...fx.request,
      expectedPlanFingerprint: preview.planFingerprint,
    });
    await pool.query(
      "UPDATE portfolio_transactions SET date=date+1 WHERE id=$1",
      [fx.ids[1]],
    );
    const before = await kinesisState(fx);
    await expect(rollbackBatch(fx.id)).rejects.toThrow();
    expect(await kinesisState(fx)).toEqual(before);
  });

  it("corrects only proven existing Kinesis facts in a fresh complete batch and leaves earlier receipts, excluded rows and cash/custody unchanged", async () => {
    const fx = await kinesisCorrectionFixture();
    const originalIds = (await kinesisState(fx)).staging.map((row) => ({
      id: row.data.id,
      hash: row.data.source_record_hash,
      fingerprint: row.data.dedup_fingerprint,
    }));
    await installStoredCorrection(fx);
    expect(
      (await kinesisState(fx)).staging.map((row) => ({
        id: row.data.id,
        hash: row.data.source_record_hash,
        fingerprint: row.data.dedup_fingerprint,
      })),
    ).toEqual(originalIds);
    const before = await kinesisState(fx);
    const retainedBefore = await kinesisState(fx.retained);
    const preview = await previewPortfolioImportReconciliation(fx.request);
    expect(preview).toMatchObject({
      ready: true,
      pending: 10,
      complete: false,
      summary: { adopt: 2, insert: 0, repair_duplicate: 0 },
    });
    const result = await commitReviewedPortfolioImports({
      ...fx.request,
      expectedPlanFingerprint: preview.planFingerprint,
    });
    expect(result).toMatchObject({
      imported: 0,
      adopted: 2,
      duplicates: 2,
      repaired: 0,
      errors: 0,
      pending: 10,
      complete: false,
    });
    const after = await kinesisState(fx);
    expect(after.receipts).toBe(before.receipts + 2);
    expect(after.cash).toBe(before.cash);
    expect(after.custody).toBe(before.custody);
    const selected = new Set(preview.selectedRowIds);
    expect(
      after.staging.filter((row) => !selected.has(Number(row.data.id))),
    ).toEqual(
      before.staging.filter((row) => !selected.has(Number(row.data.id))),
    );
    for (const row of after.financial) {
      const original = before.financial.find(
        (item) => item.data.id === row.data.id,
      ).data;
      for (const key of ["id", "type", "date", "units", "note"])
        expect(row.data[key]).toEqual(original[key]);
    }
    expect(
      after.financial.find((row) => row.data.id === fx.existingId).data,
    ).toMatchObject({ currency: "USD", fx_rate_to_eur: null });
    const retainedAfter = await kinesisState(fx.retained);
    expect(retainedAfter.staging).toEqual(retainedBefore.staging);
    expect(retainedAfter.batches).toEqual(retainedBefore.batches);
    expect(
      retainedAfter.financial.find((row) => row.data.id === fx.manual[1]),
    ).toEqual(
      retainedBefore.financial.find((row) => row.data.id === fx.manual[1]),
    );
    const repeat = await previewPortfolioImportReconciliation(fx.request);
    expect(repeat).toMatchObject({
      ready: true,
      pending: 10,
      summary: { adopt: 0, settled: 2 },
    });
    expect(
      await commitReviewedPortfolioImports({
        ...fx.request,
        expectedPlanFingerprint: repeat.planFingerprint,
      }),
    ).toMatchObject({ imported: 0, adopted: 0, duplicates: 0 });
    expect(await kinesisState(fx)).toEqual(after);
    const fresh = await stagedKinesisScope(fx);
    const freshRequest = { ...fx.request, batchIds: [fresh.id] };
    const freshPreview =
      await previewPortfolioImportReconciliation(freshRequest);
    expect(freshPreview).toMatchObject({
      ready: true,
      pending: 10,
      summary: { adopt: 0, duplicate: 2 },
    });
    expect(
      await commitReviewedPortfolioImports({
        ...freshRequest,
        expectedPlanFingerprint: freshPreview.planFingerprint,
      }),
    ).toMatchObject({ imported: 0, adopted: 0, duplicates: 2 });
    expect((await kinesisState(fx)).financial).toEqual(after.financial);
    expect((await kinesisState(fx)).receipts).toBe(after.receipts);
    await rollbackBatch(fresh.id);
    await rollbackBatch(fx.id);
    const restored = (await kinesisState(fx)).financial;
    const snapshot = (rows) =>
      rows.map(({ data: { updated_at: _updatedAt, ...data } }) => ({ data }));
    expect(snapshot(restored)).toEqual(snapshot(before.financial));
    expect((await kinesisState(fx.retained)).staging).toEqual(
      retainedBefore.staging,
    );
  });

  it("defers Kinesis native currency corrections when historical cache is unavailable while literal fees still commit", async () => {
    const fx = await kinesisCorrectionFixture({ warmRates: false });
    await installStoredCorrection(fx);
    const before = await kinesisState(fx);
    const preview = await previewPortfolioImportReconciliation(fx.request);
    expect(preview).toMatchObject({
      ready: true,
      pending: 11,
      summary: { adopt: 1 },
    });
    expect(
      await commitReviewedPortfolioImports({
        ...fx.request,
        expectedPlanFingerprint: preview.planFingerprint,
      }),
    ).toMatchObject({ adopted: 1, imported: 0, pending: 11 });
    const after = await kinesisState(fx);
    expect(
      after.financial.find((row) => row.data.id === fx.existingId),
    ).toEqual(before.financial.find((row) => row.data.id === fx.existingId));
  });

  it.each(["historical_rate", "excluded_source", "note"])(
    "rejects stale Kinesis correction %s evidence atomically",
    async (kind) => {
      const fx = await kinesisCorrectionFixture();
      await installStoredCorrection(fx);
      const preview = await previewPortfolioImportReconciliation(fx.request);
      if (kind === "historical_rate")
        await pool.query(
          "UPDATE exchange_rates SET rate_to_eur=0.8 WHERE currency_code='USD' AND rate_date='2026-01-05'",
        );
      if (kind === "excluded_source")
        await pool.query(
          "UPDATE portfolio_import_staging_rows SET note='Changed excluded source note' WHERE batch_id=$1 AND row_index=10",
          [fx.id],
        );
      if (kind === "note")
        await pool.query(
          "UPDATE portfolio_transactions SET note='Changed manual note' WHERE id=$1",
          [fx.existingId],
        );
      const before = await kinesisState(fx);
      await expect(
        commitReviewedPortfolioImports({
          ...fx.request,
          expectedPlanFingerprint: preview.planFingerprint,
        }),
      ).rejects.toMatchObject({
        details: { reason: "stale_reconciliation_plan" },
      });
      expect(await kinesisState(fx)).toEqual(before);
    },
  );

  it("rolls back Kinesis corrections, receipts and counters together if the second correction writer fails", async () => {
    const fx = await kinesisCorrectionFixture();
    await installStoredCorrection(fx);
    const preview = await previewPortfolioImportReconciliation(fx.request);
    const before = await kinesisState(fx);
    await pool.query(
      `CREATE FUNCTION reject_kinesis_correction() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.transaction_id=${Number(fx.existingId)} AND NEW.policy='prefer_source' THEN RAISE EXCEPTION 'Synthetic correction failure'; END IF; RETURN NEW; END $$`,
    );
    await pool.query(
      "CREATE TRIGGER reject_kinesis_correction BEFORE INSERT ON portfolio_import_reconciliation_journal FOR EACH ROW EXECUTE FUNCTION reject_kinesis_correction()",
    );
    try {
      await expect(
        commitReviewedPortfolioImports({
          ...fx.request,
          expectedPlanFingerprint: preview.planFingerprint,
        }),
      ).rejects.toThrow("Synthetic correction failure");
      expect(await kinesisState(fx)).toEqual(before);
    } finally {
      await pool.query(
        "DROP TRIGGER reject_kinesis_correction ON portfolio_import_reconciliation_journal",
      );
      await pool.query("DROP FUNCTION reject_kinesis_correction()");
    }
  });

  it("guards Kinesis correction rollback against a changed immutable after-image", async () => {
    const fx = await kinesisCorrectionFixture();
    await installStoredCorrection(fx);
    const preview = await previewPortfolioImportReconciliation(fx.request);
    await commitReviewedPortfolioImports({
      ...fx.request,
      expectedPlanFingerprint: preview.planFingerprint,
    });
    await pool.query(
      "UPDATE portfolio_transactions SET note='Changed corrected note' WHERE id=$1",
      [fx.existingId],
    );
    const before = await kinesisState(fx);
    await expect(rollbackBatch(fx.id)).rejects.toMatchObject({
      details: { reason: "adopted_transaction_changed" },
    });
    expect(await kinesisState(fx)).toEqual(before);
  });

  it("commits only proved existing Kinesis adoptions and keeps every excluded row and cash/custody table unchanged", async () => {
    const fx = await kinesisScopeFixture();
    const before = await kinesisState(fx);
    const preview = await previewPortfolioImportReconciliation(fx.request);
    expect(preview).toMatchObject({
      ready: true,
      pending: 10,
      complete: false,
      summary: { adopt: 2, insert: 0, repair_duplicate: 0 },
    });
    const selected = new Set(preview.selectedRowIds);
    const result = await commitReviewedPortfolioImports({
      ...fx.request,
      expectedPlanFingerprint: preview.planFingerprint,
    });
    expect(result).toMatchObject({
      imported: 0,
      adopted: 2,
      duplicates: 2,
      errors: 0,
      repaired: 0,
      reconciliationScope: "adopt_existing_only",
      pending: 10,
      complete: false,
      selectedRowIds: preview.selectedRowIds,
    });
    expect(result.batches[0]).toMatchObject({
      batch_id: fx.id,
      pending: 10,
      complete: false,
      deferredCounts: preview.deferredCounts,
    });
    const after = await kinesisState(fx);
    expect(after.receipts).toBe(2);
    expect(after.cash).toBe(before.cash);
    expect(after.custody).toBe(before.custody);
    expect(
      after.staging.filter((row) => !selected.has(Number(row.data.id))),
    ).toEqual(
      before.staging.filter((row) => !selected.has(Number(row.data.id))),
    );
    expect(after.batches[0]).toMatchObject({
      status: "awaiting_review",
      rows_imported: 0,
      rows_duplicate: 2,
      rows_error: 1,
      completed_at: null,
    });
    for (const [index, row] of after.financial.entries()) {
      for (const key of [
        "id",
        "date",
        "type",
        "investment_id",
        "amount",
        "units",
        "price_per_unit",
        "fees",
        "taxes",
        "currency",
        "fx_rate_to_eur",
        "note",
      ])
        expect(row.data[key]).toEqual(before.financial[index].data[key]);
      expect(row.data.account_id).toBe(fx.account);
    }
    const repeat = await previewPortfolioImportReconciliation(fx.request);
    expect(repeat).toMatchObject({
      ready: true,
      summary: { adopt: 0, settled: 2 },
      pending: 10,
    });
    const retried = await commitReviewedPortfolioImports({
      ...fx.request,
      expectedPlanFingerprint: repeat.planFingerprint,
    });
    expect(retried).toMatchObject({
      adopted: 0,
      duplicates: 0,
      imported: 0,
      pending: 10,
      complete: false,
    });
    expect(await kinesisState(fx)).toEqual(after);
  });

  it("defers Kinesis source-fee errors and unknown positive gift basis before any provenance or receipt can lock them", async () => {
    const fx = await kinesisScopeFixture();
    await pool.query(
      "UPDATE portfolio_transactions SET fees=fees+1 WHERE id=$1",
      [fx.manual[0]],
    );
    const gift = fx.source.rows[6];
    await pool.query(
      "INSERT INTO portfolio_transactions(investment_id,type,date,amount,units,price_per_unit,fees,taxes,currency,note) VALUES ($1,'gift',$2,100,$3,12743.09,0,0,'EUR','Original meaningful gift')",
      [fx.investment, gift.tx_date, gift.units],
    );
    const before = await kinesisState(fx);
    const preview = await previewPortfolioImportReconciliation(fx.request);
    expect(preview).toMatchObject({
      ready: true,
      summary: { adopt: 1 },
      pending: 11,
    });
    const giftRow = before.staging.find((row) => row.data.row_index === 5).data
      .id;
    expect(preview.selectedRowIds).toEqual([Number(giftRow)]);
    const result = await commitReviewedPortfolioImports({
      ...fx.request,
      expectedPlanFingerprint: preview.planFingerprint,
    });
    expect(result).toMatchObject({
      adopted: 1,
      duplicates: 1,
      imported: 0,
      pending: 11,
      complete: false,
    });
    const after = await kinesisState(fx);
    expect(
      after.financial.filter((row) => row.data.id !== fx.manual[1]),
    ).toEqual(before.financial.filter((row) => row.data.id !== fx.manual[1]));
    expect(after.staging.filter((row) => row.data.id !== giftRow)).toEqual(
      before.staging.filter((row) => row.data.id !== giftRow),
    );
    expect(after.receipts).toBe(1);
    expect(after.cash).toBe(before.cash);
    expect(after.custody).toBe(before.custody);
  });

  it("defers an unqualified Kinesis canonical gift from an older incomplete receipt while committing only eligible adoptions", async () => {
    const fx = await kinesisScopeFixture();
    const gift = fx.source.rows[6];
    const prior = await stagedKinesisScope(fx);
    await pool.query(
      "DELETE FROM portfolio_import_staging_rows WHERE batch_id=$1 AND row_index<>6",
      [prior.id],
    );
    const oldSource = (
      await pool.query(
        "UPDATE portfolio_import_staging_rows SET row_index=0,status='duplicate' WHERE batch_id=$1 RETURNING id",
        [prior.id],
      )
    ).rows[0].id;
    await pool.query(
      `UPDATE portfolio_import_batches SET status='complete',rows_total=1,rows_duplicate=1,rows_error=0,
        custom_config=custom_config-'kinesis_source_context' WHERE id=$1`,
      [prior.id],
    );
    const existingId = (
      await pool.query(
        `INSERT INTO portfolio_transactions(investment_id,type,date,amount,units,price_per_unit,fees,taxes,currency,note,
          account_id,source_record_hash,dedup_fingerprint,dedup_fingerprint_version)
         VALUES ($1,'gift',$2,100,$3,12743.09,0,0,'EUR','Keep the older positive gift note',$4,$5,$6,1) RETURNING id`,
        [
          fx.investment,
          gift.tx_date,
          gift.units,
          fx.account,
          gift.source_record_hash,
          gift.dedup_fingerprint,
        ],
      )
    ).rows[0].id;
    const afterImage = (
      await pool.query(
        `SELECT ${PORTFOLIO_TRANSACTION_SNAPSHOT_SQL} AS snapshot FROM portfolio_transactions pt WHERE id=$1`,
        [existingId],
      )
    ).rows[0].snapshot;
    const beforeImage = {
      ...afterImage,
      account_id: null,
      source_record_hash: null,
      dedup_fingerprint: null,
      dedup_fingerprint_version: null,
    };
    await pool.query(
      `INSERT INTO portfolio_import_reconciliation_journal(batch_id,staging_row_id,transaction_id,action,policy,before_data,after_data)
       VALUES ($1,$2,$3,'adopt','preserve_existing',$4::jsonb,$5::jsonb)`,
      [
        prior.id,
        oldSource,
        existingId,
        JSON.stringify(beforeImage),
        JSON.stringify(afterImage),
      ],
    );
    const readPrior = async () =>
      (
        await pool.query(
          `SELECT to_jsonb(b) AS batch,to_jsonb(s) AS source,to_jsonb(j) AS receipt
         FROM portfolio_import_batches b JOIN portfolio_import_staging_rows s ON s.batch_id=b.id
         JOIN portfolio_import_reconciliation_journal j ON j.staging_row_id=s.id WHERE b.id=$1`,
          [prior.id],
        )
      ).rows;
    const priorBefore = await readPrior();
    const before = await kinesisState(fx);
    expect(await getPortfolioImportRepairBatchIds(fx.request)).toContain(
      prior.id,
    );
    const preview = await previewPortfolioImportReconciliation(fx.request);
    expect(preview).toMatchObject({
      ready: true,
      blockers: [],
      summary: { adopt: 2, duplicate: 0, insert: 0, repair_duplicate: 0 },
      pending: 10,
      complete: false,
    });
    const deferredRow = before.staging.find((row) => row.data.row_index === 6)
      .data.id;
    expect(preview.selectedRowIds).not.toContain(Number(deferredRow));
    const result = await commitReviewedPortfolioImports({
      ...fx.request,
      expectedPlanFingerprint: preview.planFingerprint,
    });
    expect(result).toMatchObject({
      adopted: 2,
      duplicates: 2,
      imported: 0,
      repaired: 0,
      errors: 0,
      pending: 10,
      complete: false,
    });
    const after = await kinesisState(fx);
    const selected = new Set(preview.selectedRowIds);
    expect(after.financial.find((row) => row.data.id === existingId)).toEqual(
      before.financial.find((row) => row.data.id === existingId),
    );
    expect(
      after.staging.filter((row) => !selected.has(Number(row.data.id))),
    ).toEqual(
      before.staging.filter((row) => !selected.has(Number(row.data.id))),
    );
    expect(await readPrior()).toEqual(priorBefore);
    expect(after.receipts).toBe(3);
    expect(after.cash).toBe(before.cash);
    expect(after.custody).toBe(before.custody);
    const repeat = await previewPortfolioImportReconciliation(fx.request);
    expect(repeat).toMatchObject({
      ready: true,
      pending: 10,
      summary: { adopt: 0, duplicate: 0, settled: 2 },
    });
    const retried = await commitReviewedPortfolioImports({
      ...fx.request,
      expectedPlanFingerprint: repeat.planFingerprint,
    });
    expect(retried).toMatchObject({
      adopted: 0,
      duplicates: 0,
      imported: 0,
      repaired: 0,
      pending: 10,
    });
    expect(await kinesisState(fx)).toEqual(after);
    expect(await readPrior()).toEqual(priorBefore);
  });

  it("settles a fresh complete Kinesis repeat from its active receipt and makes no additional financial rows or receipts", async () => {
    const fx = await kinesisScopeFixture();
    const first = await previewPortfolioImportReconciliation(fx.request);
    await commitReviewedPortfolioImports({
      ...fx.request,
      expectedPlanFingerprint: first.planFingerprint,
    });
    const before = await kinesisState(fx);
    const fresh = await stagedKinesisScope(fx);
    const request = { ...fx.request, batchIds: [fresh.id] };
    expect(await getPortfolioImportRepairBatchIds(request)).toContain(fx.id);
    const preview = await previewPortfolioImportReconciliation(request);
    expect(preview).toMatchObject({
      ready: true,
      summary: { adopt: 0, duplicate: 2 },
      pending: 10,
    });
    const result = await commitReviewedPortfolioImports({
      ...request,
      expectedPlanFingerprint: preview.planFingerprint,
    });
    expect(result).toMatchObject({
      adopted: 0,
      duplicates: 2,
      imported: 0,
      pending: 10,
      complete: false,
    });
    const after = await kinesisState(fx);
    expect(after.financial).toEqual(before.financial);
    expect(after.receipts).toBe(before.receipts);
    expect(after.cash).toBe(before.cash);
    expect(after.custody).toBe(before.custody);
    await rollbackBatch(fresh.id);
    expect((await kinesisState(fx)).financial).toEqual(before.financial);
  });

  it("reports a fully settled sibling batch truthfully while the whole partial Kinesis session stays reviewable on retry", async () => {
    const fx = await kinesisScopeFixture();
    const sibling = await stagedKinesisScope(fx, { singleGift: true });
    const manual = syntheticKinesisManual(sibling.source.rows[0]);
    await pool.query(
      "INSERT INTO portfolio_transactions(investment_id,type,date,amount,units,price_per_unit,fees,taxes,currency,note) VALUES ($1,'gift',$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        fx.investment,
        manual.date,
        manual.amount,
        manual.units,
        manual.price_per_unit,
        manual.fees,
        manual.taxes,
        manual.currency,
        manual.note,
      ],
    );
    fx.request.batchIds.push(sibling.id);
    const preview = await previewPortfolioImportReconciliation(fx.request);
    expect(preview).toMatchObject({
      ready: true,
      pending: 10,
      complete: false,
      summary: { adopt: 3 },
    });
    expect(
      preview.batchProgress.find((batch) => batch.batchId === sibling.id),
    ).toMatchObject({ pending: 0, complete: true, deferredCounts: {} });
    const result = await commitReviewedPortfolioImports({
      ...fx.request,
      expectedPlanFingerprint: preview.planFingerprint,
    });
    expect(
      result.batches.find((batch) => batch.batch_id === sibling.id),
    ).toMatchObject({ pending: 0, complete: true, adopted: 1 });
    const before = await kinesisState(fx);
    expect(
      before.batches.every(
        (batch) =>
          batch.status === "awaiting_review" && batch.completed_at === null,
      ),
    ).toBe(true);
    const retry = await previewPortfolioImportReconciliation(fx.request);
    const repeated = await commitReviewedPortfolioImports({
      ...fx.request,
      expectedPlanFingerprint: retry.planFingerprint,
    });
    expect(repeated).toMatchObject({
      pending: 10,
      complete: false,
      adopted: 0,
      duplicates: 0,
    });
    expect(
      repeated.batches.find((batch) => batch.batch_id === sibling.id),
    ).toMatchObject({ pending: 0, complete: true, adopted: 0, duplicates: 0 });
    expect(await kinesisState(fx)).toEqual(before);
  });

  it.each(["excluded_source", "history"])(
    "rejects stale Kinesis %s binding atomically",
    async (kind) => {
      const fx = await kinesisScopeFixture();
      const preview = await previewPortfolioImportReconciliation(fx.request);
      if (kind === "excluded_source")
        await pool.query(
          "UPDATE portfolio_import_staging_rows SET raw_data=raw_data||' ' WHERE batch_id=$1 AND row_index=10",
          [fx.id],
        );
      else
        await pool.query(
          "UPDATE portfolio_transactions SET note='Changed manual note' WHERE id=$1",
          [fx.manual[0]],
        );
      const before = await kinesisState(fx);
      await expect(
        commitReviewedPortfolioImports({
          ...fx.request,
          expectedPlanFingerprint: preview.planFingerprint,
        }),
      ).rejects.toMatchObject({
        details: { reason: "stale_reconciliation_plan" },
      });
      expect(await kinesisState(fx)).toEqual(before);
    },
  );

  it("cannot hide a second existing Kinesis candidate behind the adoption selection", async () => {
    const fx = await kinesisScopeFixture();
    await pool.query(
      "INSERT INTO portfolio_transactions(investment_id,type,date,amount,units,price_per_unit,fees,taxes,currency,note) SELECT investment_id,type,date,amount,units,price_per_unit,fees,taxes,currency,'Second manual candidate' FROM portfolio_transactions WHERE id=$1",
      [fx.manual[0]],
    );
    const before = await kinesisState(fx);
    const preview = await previewPortfolioImportReconciliation(fx.request);
    expect(preview.ready).toBe(false);
    expect(
      preview.blockers.some((issue) => issue.reason === "ambiguous_history"),
    ).toBe(true);
    await expect(
      commitReviewedPortfolioImports({
        ...fx.request,
        expectedPlanFingerprint: preview.planFingerprint,
      }),
    ).rejects.toMatchObject({ details: { reason: "reconciliation_required" } });
    expect(await kinesisState(fx)).toEqual(before);
  });

  it("rolls back the first Kinesis adoption, receipt and counter when the second writer fails", async () => {
    const fx = await kinesisScopeFixture();
    const preview = await previewPortfolioImportReconciliation(fx.request);
    const before = await kinesisState(fx);
    await pool.query(
      `CREATE FUNCTION kinesis_scope_test_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id=${Number(fx.manual[1])} THEN RAISE EXCEPTION 'Synthetic second adoption failure'; END IF; RETURN NEW; END $$`,
    );
    await pool.query(
      "CREATE TRIGGER kinesis_scope_test_reject BEFORE UPDATE ON portfolio_transactions FOR EACH ROW EXECUTE FUNCTION kinesis_scope_test_reject()",
    );
    try {
      await expect(
        commitReviewedPortfolioImports({
          ...fx.request,
          expectedPlanFingerprint: preview.planFingerprint,
        }),
      ).rejects.toThrow(/Synthetic second adoption failure/);
    } finally {
      await pool.query(
        "DROP TRIGGER kinesis_scope_test_reject ON portfolio_transactions",
      );
      await pool.query("DROP FUNCTION kinesis_scope_test_reject()");
    }
    expect(await kinesisState(fx)).toEqual(before);
  });

  it("partial Kinesis rollback restores only adopted metadata and refuses a changed after-image", async () => {
    const fx = await kinesisScopeFixture();
    const before = await kinesisState(fx);
    const preview = await previewPortfolioImportReconciliation(fx.request);
    await commitReviewedPortfolioImports({
      ...fx.request,
      expectedPlanFingerprint: preview.planFingerprint,
    });
    await pool.query(
      "UPDATE portfolio_transactions SET note='Changed after adoption' WHERE id=$1",
      [fx.manual[0]],
    );
    const changed = await kinesisState(fx);
    await expect(rollbackBatch(fx.id)).rejects.toMatchObject({
      status: 409,
      details: { reason: "adopted_transaction_changed" },
    });
    expect(await kinesisState(fx)).toEqual(changed);
    await pool.query("UPDATE portfolio_transactions SET note=$2 WHERE id=$1", [
      fx.manual[0],
      before.financial[0].data.note,
    ]);
    expect(await rollbackBatch(fx.id)).toMatchObject({ deleted: 0 });
    const restored = await kinesisState(fx);
    for (const [index, row] of restored.financial.entries())
      for (const key of [
        "id",
        "date",
        "amount",
        "units",
        "price_per_unit",
        "fees",
        "taxes",
        "currency",
        "fx_rate_to_eur",
        "account_id",
        "note",
        "source_record_hash",
        "dedup_fingerprint",
      ])
        expect(row.data[key]).toEqual(before.financial[index].data[key]);
    const selected = new Set(preview.selectedRowIds);
    expect(
      restored.staging.filter((row) => !selected.has(Number(row.data.id))),
    ).toEqual(
      before.staging.filter((row) => !selected.has(Number(row.data.id))),
    );
    expect(restored.cash).toBe(before.cash);
    expect(restored.custody).toBe(before.custody);
    expect(restored.receipts).toBe(4);
  });

  it("adopts a base-fee execution whose literal amount PostgreSQL rounds at an exact half", async () => {
    const fx = await fixture();
    const old = await legacy(fx, { amount: 20, units: 10, price: 2 });
    const id = await batch(fx, [
      { units: "9.999925", price: 2, amount: "19.99985", fees: "0.00015" },
    ]);
    await pool.query(
      `UPDATE portfolio_import_batches SET adapter_name='nexo_pro_spot_history',
        custom_config='{"format":"nexo_pro_spot_history"}' WHERE id=$1`,
      [id],
    );
    await pool.query(
      `UPDATE portfolio_import_staging_rows SET symbol_raw='SYN',
        source_transaction_id='nexo-pro:spot:order:PRO-HALF-DECIMAL',raw_data=$2
        WHERE batch_id=$1`,
      [
        id,
        "203,2026-01-01 12:00:00,SYN/EUR,buy,limit,2,2,,10,10,0.000075,SYN,completed,PRO-HALF-DECIMAL",
      ],
    );
    const preview = await previewPortfolioImportReconciliation({
      batchIds: [id],
      adoptPolicy: "prefer_source",
    });
    expect(preview).toMatchObject({
      ready: true,
      summary: { adopt: 1, insert: 0 },
    });
    expect(preview.actions[0].existingTransactionId).toBe(old);
    const result = await commitReviewedPortfolioImports({
      batchIds: [id],
      adoptPolicy: "prefer_source",
      expectedPlanFingerprint: preview.planFingerprint,
    });
    expect(result).toMatchObject({ adopted: 1, imported: 0, errors: 0 });
    const saved = (
      await pool.query(
        "SELECT id,amount,units,fees FROM portfolio_transactions WHERE investment_id=$1",
        [fx.investment],
      )
    ).rows;
    expect(saved).toEqual([
      { id: old, amount: "19.9999", units: "9.99992500", fees: "0.0002" },
    ]);
  });

  it.each(["dividend", "interest"])(
    "corrects gross %s and withholding from a proven net manual amount",
    async (type) => {
      const fx = await fixture();
      const old = (
        await pool.query(
          `INSERT INTO portfolio_transactions(investment_id,type,date,amount,currency,note,dividend_amount_convention)
      VALUES($1,$2::portfolio_txn_type,'2026-01-01',85,'EUR','Original income note',$3) RETURNING id`,
          [fx.investment, type, type === "dividend" ? "net" : "unknown"],
        )
      ).rows[0].id;
      const id = await batch(fx, [
        { type, amount: 100, units: null, price: null },
      ]);
      await pool.query(
        "UPDATE portfolio_import_staging_rows SET taxes=15 WHERE batch_id=$1",
        [id],
      );
      const plan = await previewPortfolioImportReconciliation({
        batchIds: [id],
        adoptPolicy: "prefer_source",
      });
      expect(plan.ready).toBe(true);
      expect(plan.actions[0].economicsProven).toBe(true);
      await commitReviewedPortfolioImports({
        batchIds: [id],
        adoptPolicy: "prefer_source",
        expectedPlanFingerprint: plan.planFingerprint,
      });
      expect(
        (
          await pool.query(
            "SELECT amount,taxes,dividend_amount_convention FROM portfolio_transactions WHERE id=$1",
            [old],
          )
        ).rows[0],
      ).toEqual({
        amount: "100.0000",
        taxes: "15.0000",
        dividend_amount_convention: type === "dividend" ? "gross" : "unknown",
      });
      await rollbackBatch(id);
      expect(
        (
          await pool.query(
            "SELECT amount,taxes,dividend_amount_convention FROM portfolio_transactions WHERE id=$1",
            [old],
          )
        ).rows[0],
      ).toEqual({
        amount: "85.0000",
        taxes: "0.0000",
        dividend_amount_convention: type === "dividend" ? "net" : "unknown",
      });
    },
  );

  it("proves cross-currency net income only with the supplied source FX", async () => {
    const fx = await fixture();
    const old = (
      await pool.query(
        "INSERT INTO portfolio_transactions(investment_id,type,date,amount,currency,dividend_amount_convention) VALUES($1,'dividend','2026-01-01',68,'EUR','net') RETURNING id",
        [fx.investment],
      )
    ).rows[0].id;
    const id = await batch(fx, [
      { type: "dividend", amount: 100, units: null, price: null },
    ]);
    await pool.query(
      "UPDATE portfolio_import_staging_rows SET taxes=15,currency='USD',fx_rate_to_eur=0.8 WHERE batch_id=$1",
      [id],
    );
    const plan = await previewPortfolioImportReconciliation({
      batchIds: [id],
      adoptPolicy: "prefer_source",
    });
    expect(plan.ready).toBe(true);
    await commitReviewedPortfolioImports({
      batchIds: [id],
      adoptPolicy: "prefer_source",
      expectedPlanFingerprint: plan.planFingerprint,
    });
    expect(
      (
        await pool.query(
          "SELECT amount,taxes,currency,fx_rate_to_eur FROM portfolio_transactions WHERE id=$1",
          [old],
        )
      ).rows[0],
    ).toEqual({
      amount: "100.0000",
      taxes: "15.0000",
      currency: "USD",
      fx_rate_to_eur: "0.8000000000",
    });
    await rollbackBatch(id);
    expect(
      (
        await pool.query(
          "SELECT amount,currency,dividend_amount_convention FROM portfolio_transactions WHERE id=$1",
          [old],
        )
      ).rows[0],
    ).toEqual({
      amount: "68.0000",
      currency: "EUR",
      dividend_amount_convention: "net",
    });
  });

  it.each(["close", "type"])(
    "rechecks account eligibility after waiting for a concurrent %s",
    async (change) => {
      const fx = await fixture();
      const id = await batch(fx);
      const writer = await pool.connect();
      let pending;
      try {
        await writer.query("BEGIN");
        await writer.query(
          change === "close"
            ? "UPDATE accounts SET is_active=false WHERE id=$1"
            : "UPDATE accounts SET type='checking' WHERE id=$1",
          [fx.account],
        );
        pending = commitReviewedPortfolioImports({ batchIds: [id] }).then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        let waiting = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          waiting =
            (
              await pool.query(
                "SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%SELECT id FROM accounts WHERE id = ANY%'",
              )
            ).rows.length > 0;
          if (waiting) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(waiting).toBe(true);
        await writer.query("COMMIT");
        expect(await pending).toMatchObject({
          error: {
            status: 400,
            message: expect.stringContaining("active portfolio account"),
          },
        });
        expect(
          (
            await pool.query(
              "SELECT COUNT(*)::integer AS n FROM portfolio_transactions WHERE investment_id=$1",
              [fx.investment],
            )
          ).rows[0].n,
        ).toBe(0);
        expect(
          (
            await pool.query(
              "SELECT status FROM portfolio_import_batches WHERE id=$1",
              [id],
            )
          ).rows[0].status,
        ).toBe("awaiting_review");
      } finally {
        await writer.query("ROLLBACK");
        writer.release();
        if (pending) await pending;
      }
    },
  );

  it("keeps the original ID, notes and units, journals adoption, and restores them on rollback", async () => {
    const fx = await fixture();
    const old = await legacy(fx);
    const id = await batch(fx);
    const before = (
      await pool.query(
        "SELECT to_jsonb(pt) - 'updated_at' AS row FROM portfolio_transactions pt WHERE id=$1",
        [old],
      )
    ).rows[0].row;
    const result = await commitReviewedPortfolioImports({ batchIds: [id] });
    expect(result).toMatchObject({
      imported: 0,
      adopted: 1,
      duplicates: 1,
      errors: 0,
    });
    const current = (
      await pool.query("SELECT * FROM portfolio_transactions WHERE id=$1", [
        old,
      ])
    ).rows[0];
    expect(current.account_id).toBe(fx.account);
    expect(current.note).toBe("Original manual note");
    expect(current.import_batch_id).toBeNull();
    expect(
      (
        await pool.query(
          "SELECT committed_txn_id FROM portfolio_import_staging_rows WHERE batch_id=$1",
          [id],
        )
      ).rows[0].committed_txn_id,
    ).toBeNull();
    await expect(rollbackBatch(id)).resolves.toMatchObject({ deleted: 0 });
    expect(
      (
        await pool.query(
          "SELECT to_jsonb(pt) - 'updated_at' AS row FROM portfolio_transactions pt WHERE id=$1",
          [old],
        )
      ).rows[0].row,
    ).toEqual(before);
    expect(
      (
        await pool.query(
          "SELECT action FROM portfolio_import_reconciliation_journal ORDER BY id",
        )
      ).rows.map((row) => row.action),
    ).toEqual(["adopt", "restore"]);
  });

  it("requires a reviewed source policy, applies date/fee correction, and restores the original", async () => {
    const fx = await fixture();
    const old = await legacy(fx);
    const id = await batch(fx, [{ date: "2026-01-03", fees: 2 }]);
    await expect(
      commitReviewedPortfolioImports({ batchIds: [id] }),
    ).rejects.toMatchObject({ details: { reason: "reconciliation_required" } });
    const plan = await previewPortfolioImportReconciliation({
      batchIds: [id],
      adoptPolicy: "prefer_source",
    });
    await expect(
      commitReviewedPortfolioImports({
        batchIds: [id],
        adoptPolicy: "prefer_source",
      }),
    ).rejects.toThrow("expected_plan_fingerprint");
    await commitReviewedPortfolioImports({
      batchIds: [id],
      adoptPolicy: "prefer_source",
      expectedPlanFingerprint: plan.planFingerprint,
    });
    expect(
      (
        await pool.query(
          "SELECT fees, to_char(date,'YYYY-MM-DD') AS date FROM portfolio_transactions WHERE id=$1",
          [old],
        )
      ).rows[0],
    ).toEqual({ fees: "2.0000", date: "2026-01-03" });
    await rollbackBatch(id);
    expect(
      (
        await pool.query(
          "SELECT fees, to_char(date,'YYYY-MM-DD') AS date FROM portfolio_transactions WHERE id=$1",
          [old],
        )
      ).rows[0],
    ).toEqual({ fees: "0.0000", date: "2026-01-01" });
  });

  it("commits a reviewed mixed source policy and rejects stale or unreviewed overrides", async () => {
    const preserved = await fixture();
    const corrected = await fixture();
    const oldPreserved = await legacy(preserved);
    const oldCorrected = await legacy(corrected);
    const one = await batch(preserved, [{ date: "2026-01-03", fees: 2 }]);
    const two = await batch(corrected, [{ date: "2026-01-03", fees: 2 }]);
    const batchPolicies = [{ batchId: one, adoptPolicy: "preserve_existing" }];
    const plan = await previewPortfolioImportReconciliation({
      batchIds: [two, one],
      adoptPolicy: "prefer_source",
      batchPolicies,
    });
    expect(plan).toMatchObject({ ready: true, batchPolicies });
    await expect(
      commitReviewedPortfolioImports({ batchIds: [one, two], batchPolicies }),
    ).rejects.toThrow("expected_plan_fingerprint");
    await expect(
      commitReviewedPortfolioImports({
        batchIds: [one, two],
        adoptPolicy: "prefer_source",
        batchPolicies: [],
        expectedPlanFingerprint: plan.planFingerprint,
      }),
    ).rejects.toMatchObject({
      details: { reason: "stale_reconciliation_plan" },
    });
    await commitReviewedPortfolioImports({
      batchIds: [one, two],
      adoptPolicy: "prefer_source",
      batchPolicies,
      expectedPlanFingerprint: plan.planFingerprint,
    });
    expect(
      (
        await pool.query(
          "SELECT fees,to_char(date,'YYYY-MM-DD') AS date FROM portfolio_transactions WHERE id=$1",
          [oldPreserved],
        )
      ).rows[0],
    ).toEqual({ fees: "0.0000", date: "2026-01-01" });
    expect(
      (
        await pool.query(
          "SELECT fees,to_char(date,'YYYY-MM-DD') AS date FROM portfolio_transactions WHERE id=$1",
          [oldCorrected],
        )
      ).rows[0],
    ).toEqual({ fees: "2.0000", date: "2026-01-03" });
    await rollbackBatch(one);
    await rollbackBatch(two);
  });

  it("rejects stale plans and preserves all state", async () => {
    const fx = await fixture();
    const old = await legacy(fx);
    const id = await batch(fx);
    const plan = await previewPortfolioImportReconciliation({
      batchIds: [id],
      adoptPolicy: "preserve_existing",
    });
    await pool.query(
      "UPDATE portfolio_transactions SET note='Concurrent manual edit' WHERE id=$1",
      [old],
    );
    await expect(
      commitReviewedPortfolioImports({
        batchIds: [id],
        adoptPolicy: "preserve_existing",
        expectedPlanFingerprint: plan.planFingerprint,
      }),
    ).rejects.toMatchObject({
      details: { reason: "stale_reconciliation_plan" },
    });
    expect(
      (
        await pool.query(
          "SELECT COUNT(*)::integer AS n FROM portfolio_import_reconciliation_journal",
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("refuses rollback after an adopted transaction was edited, including deleting new rows", async () => {
    const fx = await fixture();
    const old = await legacy(fx);
    const id = await batch(fx, [
      {},
      { date: "2026-02-01", units: 2, amount: 200 },
    ]);
    await commitReviewedPortfolioImports({ batchIds: [id] });
    await pool.query(
      "UPDATE portfolio_transactions SET note='User edit after import' WHERE id=$1",
      [old],
    );
    await expect(rollbackBatch(id)).rejects.toMatchObject({
      details: { reason: "adopted_transaction_changed" },
    });
    expect(
      (
        await pool.query(
          "SELECT COUNT(*)::integer AS n FROM portfolio_transactions WHERE investment_id=$1",
          [fx.investment],
        )
      ).rows[0].n,
    ).toBe(2);
    expect(
      (
        await pool.query(
          "SELECT status FROM portfolio_import_batches WHERE id=$1",
          [id],
        )
      ).rows[0].status,
    ).toBe("complete");
  });

  it("dedups duplicate source exports globally before one adoption", async () => {
    const fx = await fixture();
    await legacy(fx);
    const one = await batch(fx, [{}], { identityPrefix: "same-export" });
    const two = await batch(fx, [{}], { identityPrefix: "same-export" });
    const result = await commitReviewedPortfolioImports({
      batchIds: [two, one],
    });
    expect(result).toMatchObject({ adopted: 1, imported: 0, duplicates: 2 });
    expect(
      (
        await pool.query(
          "SELECT COUNT(*)::integer AS n FROM portfolio_transactions WHERE investment_id=$1",
          [fx.investment],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it("blocks partial unsupported input and rolls back another batch's valid changes", async () => {
    const fx = await fixture();
    const old = await legacy(fx);
    const one = await batch(fx);
    const two = await batch(fx, [{ status: "error", date: "2026-02-01" }]);
    await expect(
      commitReviewedPortfolioImports({ batchIds: [one, two] }),
    ).rejects.toMatchObject({ details: { reason: "incomplete_source" } });
    expect(
      (
        await pool.query(
          "SELECT account_id FROM portfolio_transactions WHERE id=$1",
          [old],
        )
      ).rows[0].account_id,
    ).toBeNull();
  });

  it("commits older funding buys before a sell from an earlier-selected batch", async () => {
    const fx = await fixture();
    const sell = await batch(fx, [
      { type: "sell", date: "2026-01-03", units: 4, amount: 400 },
    ]);
    const buy = await batch(fx);
    await expect(
      commitReviewedPortfolioImports({ batchIds: [sell, buy] }),
    ).resolves.toMatchObject({ imported: 2, errors: 0 });
    const history = (
      await pool.query(
        "SELECT type FROM portfolio_transactions WHERE investment_id=$1 ORDER BY id",
        [fx.investment],
      )
    ).rows;
    expect(history.map((row) => row.type)).toEqual(["buy", "sell"]);
  });

  it("rolls back adopted rows, receipts and prior sibling inserts after a runtime failure", async () => {
    const fx = await fixture();
    const old = await legacy(fx);
    const id = await batch(fx, [
      {},
      { date: "2026-02-01", units: 2, amount: 200 },
      { date: "2026-03-01", units: 3, amount: 300 },
    ]);
    const original = portfolioTransactionService.create;
    let writes = 0;
    const spy = vi
      .spyOn(portfolioTransactionService, "create")
      .mockImplementation(async (...args) => {
        if (++writes === 2) throw new Error("Synthetic row write failure");
        return original(...args);
      });
    try {
      await expect(
        commitReviewedPortfolioImports({ batchIds: [id] }),
      ).rejects.toMatchObject({ details: { reason: "atomic_import_failed" } });
    } finally {
      spy.mockRestore();
    }
    expect(
      (
        await pool.query(
          "SELECT account_id FROM portfolio_transactions WHERE id=$1",
          [old],
        )
      ).rows[0].account_id,
    ).toBeNull();
    expect(
      (
        await pool.query(
          "SELECT COUNT(*)::integer AS n FROM portfolio_transactions WHERE investment_id=$1",
          [fx.investment],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT COUNT(*)::integer AS n FROM portfolio_import_reconciliation_journal",
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT status FROM portfolio_import_batches WHERE id=$1",
          [id],
        )
      ).rows[0].status,
    ).toBe("awaiting_review");
    expect(
      (
        await pool.query(
          "SELECT status FROM portfolio_import_staging_rows WHERE batch_id=$1",
          [id],
        )
      ).rows.every((row) => row.status === "matched"),
    ).toBe(true);
  });

  it("atomically adopts the original acquisition and carries its dated custody without extra units", async () => {
    const fx = await fixture();
    const old = await legacy(fx);
    const destination = (
      await pool.query(
        "INSERT INTO accounts(name,type,currency) VALUES ('Reconciliation custody','brokerage','EUR') RETURNING id",
      )
    ).rows[0].id;
    owned.accounts.push(destination);
    const id = await batch(fx);
    await pool.query(
      "UPDATE portfolio_import_batches SET custom_config=custom_config || jsonb_build_object('transfer_destination_account_id',$2::integer),rows_total=2 WHERE id=$1",
      [id, destination],
    );
    await pool.query(
      `INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,tx_date,type_raw,route,units,amount,fees,taxes,currency,resolved_investment_id,raw_data,source_record_hash,dedup_fingerprint,dedup_fingerprint_version,asset_transfer_details)
      VALUES ($1,1,'matched','2026-01-05','AssetTransfer','asset_transfer',5,0,0,0,'EUR',$2,'Synthetic custody transfer',$3,$4,1,'{"direction":"out","basisStatus":"carried","feeUnits":"0","receivedUnits":"5"}')`,
      [id, fx.investment, hash(`transfer-raw-${id}`), hash(`transfer-${id}`)],
    );
    const preview = await previewPortfolioImportReconciliation({
      batchIds: [id],
    });
    expect(preview).toMatchObject({
      ready: true,
      summary: { adopt: 1, transfer: 1 },
    });
    await expect(
      commitReviewedPortfolioImports({
        batchIds: [id],
        expectedPlanFingerprint: preview.planFingerprint,
      }),
    ).resolves.toMatchObject({ adopted: 1, imported: 1 });
    expect(
      (
        await pool.query(
          "SELECT COUNT(*)::integer AS n FROM portfolio_transactions WHERE investment_id=$1",
          [fx.investment],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT source_account_id,destination_account_id,units FROM portfolio_asset_transfers WHERE import_batch_id=$1",
          [id],
        )
      ).rows[0],
    ).toMatchObject({
      source_account_id: fx.account,
      destination_account_id: destination,
      units: "5.00000000",
    });
    expect(
      (
        await pool.query(
          "SELECT committed_txn_id FROM portfolio_import_staging_rows WHERE batch_id=$1 AND route='asset_transfer'",
          [id],
        )
      ).rows[0].committed_txn_id,
    ).toBeNull();
    await expect(rollbackBatch(id)).resolves.toMatchObject({ deleted: 1 });
    expect(
      (
        await pool.query(
          "SELECT account_id FROM portfolio_transactions WHERE id=$1",
          [old],
        )
      ).rows[0].account_id,
    ).toBeNull();
    expect(
      (
        await pool.query(
          "SELECT COUNT(*)::integer AS n FROM portfolio_asset_transfers WHERE import_batch_id=$1",
          [id],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("requires Pro companion history and retains same-account Wallet movements without canonical transactions", async () => {
    const fx = await fixture();
    const wallet = await batch(fx, []);
    await pool.query(
      "UPDATE portfolio_import_batches SET custom_config=$2::jsonb,rows_total=1 WHERE id=$1",
      [wallet, JSON.stringify({ format: "nexo_transaction_history" })],
    );
    await pool.query(
      `INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,tx_date,type_raw,route,units,amount,fees,taxes,currency,raw_data,source_record_hash,dedup_fingerprint,dedup_fingerprint_version,asset_transfer_details)
      VALUES ($1,0,'matched','2026-01-02','InternalMovement','account_internal',5,0,0,0,'EUR','Synthetic Wallet Pro movement',$2,$3,1,'{"direction":"internal","basisStatus":"not_applicable"}')`,
      [wallet, hash(`wallet-raw-${wallet}`), hash(`wallet-${wallet}`)],
    );
    expect(
      (await previewPortfolioImportReconciliation({ batchIds: [wallet] }))
        .blockers[0].reason,
    ).toBe("missing_companion_pro_history");
    const pro = await batch(fx);
    await pool.query(
      "UPDATE portfolio_import_batches SET custom_config=$2::jsonb WHERE id=$1",
      [pro, JSON.stringify({ format: "nexo_pro_spot_history" })],
    );
    const plan = await previewPortfolioImportReconciliation({
      batchIds: [wallet, pro],
    });
    expect(plan).toMatchObject({
      ready: true,
      summary: { internal_annotation: 1, insert: 1 },
    });
    await expect(
      commitReviewedPortfolioImports({
        batchIds: [wallet, pro],
        expectedPlanFingerprint: plan.planFingerprint,
      }),
    ).resolves.toMatchObject({ imported: 1, duplicates: 1, errors: 0 });
    expect(
      (
        await pool.query(
          "SELECT status,committed_txn_id FROM portfolio_import_staging_rows WHERE batch_id=$1",
          [wallet],
        )
      ).rows[0],
    ).toEqual({ status: "duplicate", committed_txn_id: null });
    expect(
      (
        await pool.query(
          "SELECT COUNT(*)::integer AS n FROM portfolio_transactions WHERE investment_id=$1",
          [fx.investment],
        )
      ).rows[0].n,
    ).toBe(1);
    await expect(rollbackBatch(wallet)).resolves.toMatchObject({ deleted: 0 });
  });

  it("makes receipts immutable and keeps their source batch/provenance", async () => {
    const fx = await fixture();
    await legacy(fx);
    const id = await batch(fx);
    await commitReviewedPortfolioImports({ batchIds: [id] });
    await expect(
      pool.query(
        "UPDATE portfolio_import_reconciliation_journal SET policy='prefer_source'",
      ),
    ).rejects.toThrow("immutable");
    await expect(
      pool.query(`INSERT INTO portfolio_import_reconciliation_journal(batch_id,staging_row_id,transaction_id,action,policy,before_data,after_data,previous_entry_id)
      SELECT batch_id,staging_row_id,transaction_id,'restore',policy,after_data,'{}',id FROM portfolio_import_reconciliation_journal WHERE action='adopt'`),
    ).rejects.toThrow("Invalid portfolio import restoration receipt");
    await expect(
      pool.query("DELETE FROM portfolio_import_batches WHERE id=$1", [id]),
    ).rejects.toThrow(/violates.*foreign key constraint/);
  });

  async function duplicatedHistory({ count = 1 } = {}) {
    const fx = await fixture();
    const rows = Array.from({ length: count }, (_, index) => ({
      date: `2026-01-${String(index + 1).padStart(2, "0")}`,
    }));
    const identityPrefix = `duplicate-repair-${++sequence}`;
    const originalBatch = await batch(fx, rows, { identityPrefix });
    await commitReviewedPortfolioImports({ batchIds: [originalBatch] });
    const imported = (
      await pool.query(
        "SELECT to_jsonb(pt) AS data FROM portfolio_transactions pt WHERE import_batch_id=$1 ORDER BY date,id",
        [originalBatch],
      )
    ).rows.map((row) => row.data);
    const legacyIds = [];
    for (const row of rows)
      legacyIds.push(await legacy(fx, { ...row, fees: 2 }));
    const reviewBatch = await batch(fx, rows, { identityPrefix });
    return { fx, originalBatch, reviewBatch, imported, legacyIds };
  }

  async function ibkrBatch(fx, sources) {
    const id = Number(
      (
        await pool.query(
          `INSERT INTO portfolio_import_batches(adapter_name,custom_config,status,rows_total,account_id,is_brokerage)
       VALUES ('ibkr_transaction_history',$1,'awaiting_review',$2,$3,true) RETURNING id`,
          [
            JSON.stringify(sources[0].custom_config),
            sources.length,
            fx.account,
          ],
        )
      ).rows[0].id,
    );
    owned.batches.push(id);
    for (const [index, row] of sources.entries())
      await pool.query(
        `INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,tx_date,type_raw,type,route,units,price_per_unit,amount,fees,taxes,currency,fx_rate_to_eur,resolved_investment_id,symbol_raw,source_account_identity,note,raw_data,source_record_hash,dedup_fingerprint,dedup_fingerprint_version,dedup_occurrence)
       VALUES ($1,$2,'matched',$3,$4,$5,'portfolio',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,1,1)`,
        [
          id,
          index,
          row.tx_date,
          row.type_raw,
          row.type,
          row.units,
          row.price_per_unit,
          row.amount,
          row.fees,
          row.taxes,
          row.currency,
          row.fx_rate_to_eur,
          fx.investment,
          row.symbol_raw,
          row.source_account_identity,
          row.note,
          row.raw_data,
          row.source_record_hash,
          row.dedup_fingerprint,
        ],
      );
    return id;
  }

  async function importedIbkrHistory({ income = false } = {}) {
    const fx = await fixture();
    const sources = income
      ? [
          syntheticIbkrPlannerSource({
            type: "dividend",
            amount: "3.3333",
            units: null,
            price_per_unit: null,
            fees: "0",
            currency: "EUR",
            fx_rate_to_eur: null,
            literal: {
              "Transaction Type": "Dividend",
              Quantity: "-",
              Price: "-",
              "Price Currency": "-",
              "Gross Amount": "3.3333333",
              Commission: "0",
              "Net Amount": "3.3333333",
            },
          }),
          syntheticIbkrPlannerSource({
            type: "tax",
            type_raw: "tax",
            amount: "0.3333",
            units: null,
            price_per_unit: null,
            fees: "0",
            currency: "EUR",
            fx_rate_to_eur: null,
            literal: {
              "Transaction Type": "Foreign Tax Withholding",
              Quantity: "-",
              Price: "-",
              "Price Currency": "-",
              "Gross Amount": "-0.3333333",
              Commission: "0",
              "Net Amount": "-0.3333333",
            },
          }),
        ]
      : [syntheticIbkrPlannerSource()];
    const context = sources[0].custom_config.ibkr_source_context;
    context.record_hashes = sources.map((row) => row.source_record_hash);
    const originalBatch = await ibkrBatch(fx, sources);
    await commitReviewedPortfolioImports({ batchIds: [originalBatch] });
    const imported = (
      await pool.query(
        "SELECT to_jsonb(pt) AS data FROM portfolio_transactions pt WHERE import_batch_id=$1 ORDER BY id",
        [originalBatch],
      )
    ).rows.map((row) => row.data);
    const legacyId = income
      ? Number(
          (
            await pool.query(
              `INSERT INTO portfolio_transactions(investment_id,type,date,amount,taxes,currency,note)
       VALUES ($1,'dividend','2026-01-01',3.33,0.33,'USD','Original manual income note') RETURNING id`,
              [fx.investment],
            )
          ).rows[0].id,
        )
      : await legacy(fx);
    const originalLegacy = (
      await pool.query(
        "SELECT to_jsonb(pt) AS data FROM portfolio_transactions pt WHERE id=$1",
        [legacyId],
      )
    ).rows[0].data;
    const reviewBatch = await ibkrBatch(fx, sources);
    return {
      fx,
      sources,
      originalBatch,
      reviewBatch,
      imported,
      legacyId,
      originalLegacy,
    };
  }

  it("repairs authenticated IBKR native currency facts atomically, preserves manual ID and note, and restores the deleted copy", async () => {
    const data = await importedIbkrHistory();
    const scope = {
      batchIds: [data.reviewBatch],
      adoptPolicy: "prefer_source",
    };
    const plan = await previewPortfolioImportReconciliation(scope);
    expect(plan).toMatchObject({
      ready: true,
      summary: { repair_duplicate: 1, insert: 0 },
    });
    expect(await getPortfolioImportRepairBatchIds(scope)).toContain(
      data.originalBatch,
    );
    await expect(
      commitReviewedPortfolioImports({
        ...scope,
        expectedPlanFingerprint: plan.planFingerprint,
      }),
    ).resolves.toMatchObject({
      repaired: 1,
      adopted: 0,
      imported: 0,
      duplicates: 1,
    });
    expect(
      (
        await pool.query(
          "SELECT id,note,type,currency,amount,units,price_per_unit,fees,fx_rate_to_eur,import_batch_id FROM portfolio_transactions WHERE investment_id=$1",
          [data.fx.investment],
        )
      ).rows,
    ).toEqual([
      {
        id: data.legacyId,
        note: "Original manual note",
        type: "buy",
        currency: "USD",
        amount: "500.0000",
        units: "5.00000000",
        price_per_unit: "100.000000",
        fees: "2.0000",
        fx_rate_to_eur: "0.8000000000",
        import_batch_id: null,
      },
    ]);
    expect(
      (
        await pool.query(
          "SELECT rows_imported,rows_duplicate FROM portfolio_import_batches WHERE id=$1",
          [data.originalBatch],
        )
      ).rows[0],
    ).toEqual({ rows_imported: 0, rows_duplicate: 1 });
    const repeatBatch = await ibkrBatch(data.fx, data.sources);
    const repeat = await previewPortfolioImportReconciliation({
      batchIds: [repeatBatch],
      adoptPolicy: "prefer_source",
    });
    expect(repeat).toMatchObject({
      ready: true,
      summary: { duplicate: 1, repair_duplicate: 0, insert: 0 },
    });
    await commitReviewedPortfolioImports({
      batchIds: [repeatBatch],
      adoptPolicy: "prefer_source",
      expectedPlanFingerprint: repeat.planFingerprint,
    });
    expect(
      (
        await pool.query(
          "SELECT COUNT(*)::integer AS n FROM portfolio_import_duplicate_repair_journal",
        )
      ).rows[0].n,
    ).toBe(1);
    await expect(rollbackBatch(data.reviewBatch)).resolves.toMatchObject({
      restored: 1,
      restored_imported: 1,
      deleted: 0,
    });
    expect(
      (
        await pool.query(
          "SELECT to_jsonb(pt) AS data FROM portfolio_transactions pt WHERE id=$1",
          [data.imported[0].id],
        )
      ).rows[0].data,
    ).toEqual(data.imported[0]);
    const restored = (
      await pool.query(
        "SELECT to_jsonb(pt) AS data FROM portfolio_transactions pt WHERE id=$1",
        [data.legacyId],
      )
    ).rows[0].data;
    expect({ ...restored, updated_at: data.originalLegacy.updated_at }).toEqual(
      data.originalLegacy,
    );
  });

  it("repairs IBKR income gross convention while retaining one separate proved withholding transaction", async () => {
    const data = await importedIbkrHistory({ income: true });
    const scope = {
      batchIds: [data.reviewBatch],
      adoptPolicy: "prefer_source",
    };
    const plan = await previewPortfolioImportReconciliation(scope);
    expect(plan).toMatchObject({
      ready: true,
      summary: { repair_duplicate: 1, duplicate: 1, insert: 0 },
    });
    await commitReviewedPortfolioImports({
      ...scope,
      expectedPlanFingerprint: plan.planFingerprint,
    });
    expect(
      (
        await pool.query(
          "SELECT id,type,amount,taxes,currency,dividend_amount_convention,note FROM portfolio_transactions WHERE investment_id=$1 ORDER BY type",
          [data.fx.investment],
        )
      ).rows,
    ).toEqual([
      {
        id: data.legacyId,
        type: "dividend",
        amount: "3.3333",
        taxes: "0.0000",
        currency: "EUR",
        dividend_amount_convention: "gross",
        note: "Original manual income note",
      },
      {
        id: data.imported[1].id,
        type: "tax",
        amount: "0.3333",
        taxes: "0.0000",
        currency: "EUR",
        dividend_amount_convention: "unknown",
        note: data.sources[1].note,
      },
    ]);
    await rollbackBatch(data.reviewBatch);
    expect(
      (
        await pool.query(
          "SELECT amount,taxes,currency FROM portfolio_transactions WHERE id=$1",
          [data.legacyId],
        )
      ).rows[0],
    ).toEqual({ amount: "3.3300", taxes: "0.3300", currency: "USD" });
  });

  it("adopts a failed IBKR sale from the exact original statement without inserting or changing its manual ID and note", async () => {
    const fx = await fixture();
    await legacy(fx, { date: "2025-12-01" });
    const sale = Number(
      (
        await pool.query(
          `INSERT INTO portfolio_transactions(investment_id,type,date,amount,units,price_per_unit,currency,note)
       VALUES ($1,'sell','2026-01-01',500,5,100,'EUR','Original manual sale note') RETURNING id`,
          [fx.investment],
        )
      ).rows[0].id,
    );
    const source = syntheticIbkrPlannerSource({
      type: "sell",
      literal: {
        "Transaction Type": "Sell",
        "Gross Amount": "400",
        "Net Amount": "398.4",
      },
    });
    const reviewBatch = await ibkrBatch(fx, [source]);
    const scope = { batchIds: [reviewBatch], adoptPolicy: "prefer_source" };
    const plan = await previewPortfolioImportReconciliation(scope);
    expect(plan).toMatchObject({
      ready: true,
      summary: { adopt: 1, repair_duplicate: 0, insert: 0 },
    });
    await expect(
      commitReviewedPortfolioImports({
        ...scope,
        expectedPlanFingerprint: plan.planFingerprint,
      }),
    ).resolves.toMatchObject({ adopted: 1, imported: 0, duplicates: 1 });
    expect(
      (
        await pool.query(
          "SELECT id,type,note,currency,fees,fx_rate_to_eur FROM portfolio_transactions WHERE id=$1",
          [sale],
        )
      ).rows[0],
    ).toEqual({
      id: sale,
      type: "sell",
      note: "Original manual sale note",
      currency: "USD",
      fees: "2.0000",
      fx_rate_to_eur: "0.8000000000",
    });
    await rollbackBatch(reviewBatch);
    expect(
      (
        await pool.query(
          "SELECT id,type,note,currency,fees,fx_rate_to_eur FROM portfolio_transactions WHERE id=$1",
          [sale],
        )
      ).rows[0],
    ).toEqual({
      id: sale,
      type: "sell",
      note: "Original manual sale note",
      currency: "EUR",
      fees: "0.0000",
      fx_rate_to_eur: null,
    });
  });

  it("rejects stale IBKR statement context and rolls back a later runtime failure without any partial repair", async () => {
    const data = await importedIbkrHistory();
    const scope = {
      batchIds: [data.reviewBatch],
      adoptPolicy: "prefer_source",
    };
    const plan = await previewPortfolioImportReconciliation(scope);
    const originalConfig = data.sources[0].custom_config;
    await pool.query(
      "UPDATE portfolio_import_batches SET custom_config=$2 WHERE id=$1",
      [
        data.reviewBatch,
        JSON.stringify({
          ...originalConfig,
          ibkr_source_context: {
            ...originalConfig.ibkr_source_context,
            source_file_hash: "d".repeat(64),
          },
        }),
      ],
    );
    await expect(
      commitReviewedPortfolioImports({
        ...scope,
        expectedPlanFingerprint: plan.planFingerprint,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await pool.query(
      "UPDATE portfolio_import_batches SET custom_config=$2 WHERE id=$1",
      [data.reviewBatch, JSON.stringify(originalConfig)],
    );
    const secondBatch = await batch(data.fx, [
      { date: "2026-03-01", units: 1, price: 2, amount: 2 },
    ]);
    const together = {
      batchIds: [data.reviewBatch, secondBatch],
      adoptPolicy: "prefer_source",
    };
    const current = await previewPortfolioImportReconciliation(together);
    const spy = vi
      .spyOn(portfolioTransactionService, "create")
      .mockRejectedValueOnce(new Error("Synthetic IBKR later failure"));
    try {
      await expect(
        commitReviewedPortfolioImports({
          ...together,
          expectedPlanFingerprint: current.planFingerprint,
        }),
      ).rejects.toMatchObject({ details: { reason: "atomic_import_failed" } });
    } finally {
      spy.mockRestore();
    }
    expect(
      (
        await pool.query(
          "SELECT to_jsonb(pt) AS data FROM portfolio_transactions pt WHERE id=$1",
          [data.imported[0].id],
        )
      ).rows[0].data,
    ).toEqual(data.imported[0]);
    expect(
      (
        await pool.query(
          "SELECT to_jsonb(pt) AS data FROM portfolio_transactions pt WHERE id=$1",
          [data.legacyId],
        )
      ).rows[0].data,
    ).toEqual(data.originalLegacy);
    expect(
      (
        await pool.query(
          "SELECT COUNT(*)::integer AS n FROM portfolio_import_duplicate_repair_journal",
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT rows_imported,rows_duplicate FROM portfolio_import_batches WHERE id=$1",
          [data.originalBatch],
        )
      ).rows[0],
    ).toEqual({ rows_imported: 1, rows_duplicate: 0 });
  });

  it("requires explicit reviewed duplicate repair and restores full original rows, pointers and counters", async () => {
    const data = await duplicatedHistory();
    await pool.query(
      "UPDATE portfolio_import_batches SET started_at=NOW()-INTERVAL '60 days' WHERE id=ANY($1::bigint[])",
      [[data.originalBatch, data.reviewBatch]],
    );
    const absent = await previewPortfolioImportReconciliation({
      batchIds: [data.reviewBatch],
    });
    expect(absent.blockers[0].reason).toBe("duplicate_repair_policy_required");
    const scope = {
      batchIds: [data.reviewBatch],
      adoptPolicy: "prefer_source",
    };
    const plan = await previewPortfolioImportReconciliation(scope);
    expect(plan).toMatchObject({
      ready: true,
      summary: { repair_duplicate: 1 },
    });
    expect(plan.actions[0]).toMatchObject({
      action: "repair_duplicate",
      existingTransactionId: data.legacyIds[0],
      importedTransactionId: data.imported[0].id,
      originalBatchId: data.originalBatch,
    });
    await expect(
      commitReviewedPortfolioImports({
        ...scope,
        expectedPlanFingerprint: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      commitReviewedPortfolioImports({
        ...scope,
        expectedPlanFingerprint: plan.planFingerprint,
      }),
    ).resolves.toMatchObject({
      repaired: 1,
      adopted: 0,
      imported: 0,
      duplicates: 1,
    });
    expect(
      (
        await pool.query(
          "SELECT id,note,fees,import_batch_id FROM portfolio_transactions WHERE investment_id=$1",
          [data.fx.investment],
        )
      ).rows,
    ).toEqual([
      {
        id: data.legacyIds[0],
        note: "Original manual note",
        fees: "0.0000",
        import_batch_id: null,
      },
    ]);
    expect(
      (
        await pool.query(
          "SELECT status,committed_txn_id FROM portfolio_import_staging_rows WHERE batch_id=$1",
          [data.originalBatch],
        )
      ).rows[0],
    ).toEqual({ status: "duplicate", committed_txn_id: null });
    expect(
      (
        await pool.query(
          "SELECT rows_imported,rows_duplicate FROM portfolio_import_batches WHERE id=$1",
          [data.originalBatch],
        )
      ).rows[0],
    ).toEqual({ rows_imported: 0, rows_duplicate: 1 });
    await expect(
      pool.query(
        "UPDATE portfolio_import_duplicate_repair_journal SET policy='preserve_existing'",
      ),
    ).rejects.toThrow("immutable");
    await expect(
      pool.query("DELETE FROM portfolio_import_batches WHERE id=$1", [
        data.originalBatch,
      ]),
    ).rejects.toThrow(/foreign key constraint/);
    await pruneOldImportBatches();
    expect(
      (
        await pool.query(
          "SELECT COUNT(*)::integer AS n FROM portfolio_import_batches WHERE id=ANY($1::bigint[])",
          [[data.originalBatch, data.reviewBatch]],
        )
      ).rows[0].n,
    ).toBe(2);
    await expect(rollbackBatch(data.reviewBatch)).resolves.toMatchObject({
      deleted: 0,
      restored: 1,
      restored_imported: 1,
    });
    expect(
      (
        await pool.query(
          "SELECT to_jsonb(pt) AS data FROM portfolio_transactions pt WHERE id=$1",
          [data.imported[0].id],
        )
      ).rows[0].data,
    ).toEqual(data.imported[0]);
    expect(
      (
        await pool.query(
          "SELECT account_id,fees,note FROM portfolio_transactions WHERE id=$1",
          [data.legacyIds[0]],
        )
      ).rows[0],
    ).toEqual({
      account_id: null,
      fees: "2.0000",
      note: "Original manual note",
    });
    expect(
      (
        await pool.query(
          "SELECT status,committed_txn_id FROM portfolio_import_staging_rows WHERE batch_id=$1",
          [data.originalBatch],
        )
      ).rows[0],
    ).toEqual({ status: "committed", committed_txn_id: data.imported[0].id });
    expect(
      (
        await pool.query(
          "SELECT rows_imported,rows_duplicate FROM portfolio_import_batches WHERE id=$1",
          [data.originalBatch],
        )
      ).rows[0],
    ).toEqual({ rows_imported: 1, rows_duplicate: 0 });
    expect(
      (
        await pool.query(
          "SELECT action FROM portfolio_import_duplicate_repair_journal ORDER BY id",
        )
      ).rows.map((row) => row.action),
    ).toEqual(["repair", "restore"]);
  });

  it("restores several repairs from one old batch in reverse receipt order", async () => {
    const data = await duplicatedHistory({ count: 2 });
    // Separate dates must have a unique counterpart within the overlap window.
    await pool.query(
      "UPDATE portfolio_transactions SET units=6,amount=600 WHERE id=ANY($1::integer[])",
      [[data.legacyIds[1], data.imported[1].id]],
    );
    await pool.query(
      "UPDATE portfolio_import_staging_rows SET units=6,amount=600 WHERE batch_id=ANY($1::bigint[]) AND row_index=1",
      [[data.originalBatch, data.reviewBatch]],
    );
    const scope = {
      batchIds: [data.reviewBatch],
      adoptPolicy: "preserve_existing",
    };
    const plan = await previewPortfolioImportReconciliation(scope);
    expect(plan.ready).toBe(true);
    await commitReviewedPortfolioImports({
      ...scope,
      expectedPlanFingerprint: plan.planFingerprint,
    });
    expect(
      (
        await pool.query(
          "SELECT rows_imported,rows_duplicate FROM portfolio_import_batches WHERE id=$1",
          [data.originalBatch],
        )
      ).rows[0],
    ).toEqual({ rows_imported: 0, rows_duplicate: 2 });
    await expect(rollbackBatch(data.reviewBatch)).resolves.toMatchObject({
      restored: 2,
      restored_imported: 2,
    });
    expect(
      (
        await pool.query(
          "SELECT rows_imported,rows_duplicate FROM portfolio_import_batches WHERE id=$1",
          [data.originalBatch],
        )
      ).rows[0],
    ).toEqual({ rows_imported: 2, rows_duplicate: 0 });
  });

  it.each([
    ["missing provenance", "duplicate_repair_provenance_missing"],
    ["ambiguous legacy", "ambiguous_history"],
    ["changed economics", "duplicate_repair_imported_changed"],
    ["edited imported note", "duplicate_repair_imported_annotations_changed"],
    ["unproven foreign legacy", "unproven_currency_conversion"],
  ])(
    "blocks duplicate repair with %s and preserves both financial records",
    async (target, reason) => {
      const data = await duplicatedHistory();
      if (target === "missing provenance")
        await pool.query(
          "UPDATE portfolio_import_staging_rows SET committed_txn_id=NULL WHERE batch_id=$1",
          [data.originalBatch],
        );
      if (target === "ambiguous legacy") await legacy(data.fx);
      if (target === "changed economics")
        await pool.query(
          "UPDATE portfolio_transactions SET fees=3 WHERE id=$1",
          [data.imported[0].id],
        );
      if (target === "edited imported note")
        await pool.query(
          "UPDATE portfolio_transactions SET note='Meaningful imported annotation' WHERE id=$1",
          [data.imported[0].id],
        );
      if (target === "unproven foreign legacy")
        await pool.query(
          "UPDATE portfolio_transactions SET currency='USD' WHERE id=$1",
          [data.legacyIds[0]],
        );
      const scope = {
        batchIds: [data.reviewBatch],
        adoptPolicy: "prefer_source",
      };
      const before = (
        await pool.query(
          "SELECT to_jsonb(pt) AS data FROM portfolio_transactions pt WHERE investment_id=$1 ORDER BY id",
          [data.fx.investment],
        )
      ).rows;
      const plan = await previewPortfolioImportReconciliation(scope);
      expect(plan.ready).toBe(false);
      expect(plan.blockers[0].reason).toBe(reason);
      await expect(
        commitReviewedPortfolioImports({
          ...scope,
          expectedPlanFingerprint: plan.planFingerprint,
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        (
          await pool.query(
            "SELECT to_jsonb(pt) AS data FROM portfolio_transactions pt WHERE investment_id=$1 ORDER BY id",
            [data.fx.investment],
          )
        ).rows,
      ).toEqual(before);
      expect(
        (
          await pool.query(
            "SELECT COUNT(*)::integer AS n FROM portfolio_import_duplicate_repair_journal",
          )
        ).rows[0].n,
      ).toBe(0);
    },
  );

  it.each(["legacy", "staging", "batch", "recreated_imported"])(
    "blocks repair rollback after hostile %s changes without deleting a new row",
    async (target) => {
      const data = await duplicatedHistory();
      await pool.query(
        "UPDATE portfolio_transactions SET date='2025-01-01' WHERE id=$1",
        [data.imported[0].id],
      );
      await pool.query(
        "UPDATE portfolio_transactions SET date='2025-01-01' WHERE id=$1",
        [data.legacyIds[0]],
      );
      await pool.query(
        "UPDATE portfolio_import_staging_rows SET tx_date='2025-01-01' WHERE batch_id=ANY($1::bigint[])",
        [[data.originalBatch, data.reviewBatch]],
      );
      await pool.query(
        "UPDATE portfolio_import_batches SET rows_total=2 WHERE id=$1",
        [data.reviewBatch],
      );
      await pool.query(
        `INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,tx_date,type_raw,type,route,units,price_per_unit,amount,fees,taxes,currency,resolved_investment_id,raw_data,source_record_hash,dedup_fingerprint,dedup_fingerprint_version,dedup_occurrence)
      VALUES($1,1,'matched','2026-01-01','buy','buy','portfolio',1,100,100,0,0,'EUR',$2,'Synthetic genuinely new acquisition',$3,$4,1,1)`,
        [
          data.reviewBatch,
          data.fx.investment,
          hash(`hostile-newraw-${data.reviewBatch}`),
          hash(`hostile-new-${data.reviewBatch}`),
        ],
      );
      const scope = {
        batchIds: [data.reviewBatch],
        adoptPolicy: "preserve_existing",
      };
      const plan = await previewPortfolioImportReconciliation(scope);
      expect(plan.ready).toBe(true);
      await commitReviewedPortfolioImports({
        ...scope,
        expectedPlanFingerprint: plan.planFingerprint,
      });
      if (target === "legacy")
        await pool.query(
          "UPDATE portfolio_transactions SET note='Edited after repair' WHERE id=$1",
          [data.legacyIds[0]],
        );
      if (target === "staging")
        await pool.query(
          "UPDATE portfolio_import_staging_rows SET note='Edited provenance' WHERE batch_id=$1",
          [data.originalBatch],
        );
      if (target === "batch")
        await pool.query(
          "UPDATE portfolio_import_batches SET rows_duplicate=rows_duplicate+1 WHERE id=$1",
          [data.originalBatch],
        );
      if (target === "recreated_imported")
        await pool.query(
          "INSERT INTO portfolio_transactions(id,investment_id,type,date,amount,units,currency) VALUES($1,$2,'buy','2025-01-01',500,5,'EUR')",
          [data.imported[0].id, data.fx.investment],
        );
      const before = (
        await pool.query(
          "SELECT to_jsonb(pt) AS data FROM portfolio_transactions pt WHERE investment_id=$1 ORDER BY id",
          [data.fx.investment],
        )
      ).rows;
      await expect(rollbackBatch(data.reviewBatch)).rejects.toMatchObject({
        status: 409,
        details: { reason: "duplicate_repair_changed" },
      });
      expect(
        (
          await pool.query(
            "SELECT to_jsonb(pt) AS data FROM portfolio_transactions pt WHERE investment_id=$1 ORDER BY id",
            [data.fx.investment],
          )
        ).rows,
      ).toEqual(before);
      expect(
        (
          await pool.query(
            "SELECT status FROM portfolio_import_batches WHERE id=$1",
            [data.reviewBatch],
          )
        ).rows[0].status,
      ).toBe("complete");
    },
  );
  async function stageSaxoCorrectionSource(
    fx,
    { cash = false, extra = false } = {},
  ) {
    const id = await batch(fx, [
      {},
      ...(cash ? [{}] : []),
      ...(extra
        ? [{ date: "2026-02-01", units: 2, price: 100, amount: 200 }]
        : []),
    ]);
    const source = syntheticSaxoStaging();
    await pool.query(
      `UPDATE portfolio_import_staging_rows SET tx_date=$2,units=$3,price_per_unit=$4,amount=$5,
      fees=$6,taxes=$7,currency=$8,fx_rate_to_eur=NULL,symbol_raw=$9,name_raw=$10,
      raw_data=$11,source_record_hash=$12,dedup_fingerprint=$13,source_transaction_id=$14,
      source_account_identity=$15 WHERE batch_id=$1 AND row_index=0`,
      [
        id,
        source.tx_date,
        source.units,
        source.price_per_unit,
        source.amount,
        source.fees,
        source.taxes,
        source.currency,
        source.symbol_raw,
        source.name_raw,
        source.raw_data,
        source.source_record_hash,
        source.dedup_fingerprint,
        source.source_transaction_id,
        source.source_account_identity,
      ],
    );
    if (cash) {
      const raw = syntheticSaxoPrimaryRawData(2);
      await pool.query(
        `UPDATE portfolio_import_staging_rows SET route='cash',type=NULL,type_raw='Deposit',
        tx_date='2025-01-10',amount=500,units=NULL,price_per_unit=NULL,fees=0,taxes=0,
        resolved_investment_id=NULL,raw_data=$2,source_record_hash=$3,dedup_fingerprint=$4,
        source_transaction_id='103',source_account_identity='ACC-1'
      WHERE batch_id=$1 AND row_index=1`,
        [id, raw, saxoHash(raw), saxoHash("synthetic-saxo-deposit")],
      );
    }
    if (extra) {
      const envelope = JSON.parse(source.raw_data);
      for (const record of envelope.records) {
        const normalize = (header) => header.trim().replaceAll("\u00a0", " ");
        record.cells[
          record.headers.findIndex(
            (header) => normalize(header) === "Bk Record Id",
          )
        ] = { type: "number", raw: "201" };
        record.cells[
          record.headers.findIndex(
            (header) => normalize(header) === "Transactiedatum",
          )
        ] = { type: "date", value: "2026-02-01T00:00:00.000Z" };
      }
      const raw = JSON.stringify(envelope);
      await pool.query(
        `UPDATE portfolio_import_staging_rows SET tx_date='2026-02-01',units=10,price_per_unit=18,amount=180,fees=1,taxes=0.63,
        symbol_raw='EXM',name_raw='Example Inc',raw_data=$2,source_record_hash=$3,source_transaction_id='201',source_account_identity='ACC-1'
        WHERE batch_id=$1 AND row_index=1`,
        [id, raw, saxoHash(raw)],
      );
    }
    return id;
  }

  async function preservedSaxoFixture() {
    const fx = await fixture();
    const transaction = await legacy(fx, {
      date: "2025-01-10",
      amount: 200,
      units: 10,
      price: 20,
      fees: 2,
    });
    await pool.query(
      "UPDATE portfolio_transactions SET currency='USD',fx_rate_to_eur=0.9 WHERE id=$1",
      [transaction],
    );
    const originalBatch = await stageSaxoCorrectionSource(fx, { cash: true });
    const review = await previewPortfolioImportReconciliation({
      batchIds: [originalBatch],
      adoptPolicy: "preserve_existing",
    });
    expect(review.ready).toBe(true);
    await commitReviewedPortfolioImports({
      batchIds: [originalBatch],
      adoptPolicy: "preserve_existing",
      expectedPlanFingerprint: review.planFingerprint,
    });
    const preserved = (
      await pool.query(
        "SELECT to_jsonb(pt)-'updated_at' AS data FROM portfolio_transactions pt WHERE id=$1",
        [transaction],
      )
    ).rows[0].data;
    const cash = (
      await pool.query(
        "SELECT to_jsonb(t) AS data FROM transactions t WHERE account_id=$1 ORDER BY id",
        [fx.account],
      )
    ).rows;
    const counters = (
      await pool.query(
        "SELECT rows_imported,rows_duplicate,rows_error,status FROM portfolio_import_batches WHERE id=$1",
        [originalBatch],
      )
    ).rows[0];
    return { fx, transaction, originalBatch, preserved, cash, counters };
  }

  it("corrects the same ID, keeps original cash and counters, repeats without receipts, and restores the adoption chain", async () => {
    const data = await preservedSaxoFixture();
    const reviewBatch = await stageSaxoCorrectionSource(data.fx);
    const review = await previewPortfolioImportReconciliation({
      batchIds: [reviewBatch],
      adoptPolicy: "prefer_source",
    });
    expect(review).toMatchObject({
      ready: true,
      summary: { adopt: 1, insert: 0, cash: 0 },
    });
    expect(
      await getPortfolioImportRepairBatchIds({
        batchIds: [reviewBatch],
        adoptPolicy: "prefer_source",
      }),
    ).toContain(data.originalBatch);
    await expect(
      applyPortfolioImportReconciliation({
        batchIds: [reviewBatch],
        adoptPolicy: "prefer_source",
        expectedPlanFingerprint: review.planFingerprint,
        lockedBatchIds: [reviewBatch],
      }),
    ).rejects.toMatchObject({
      details: { reason: "stale_reconciliation_plan" },
    });
    expect(
      await commitReviewedPortfolioImports({
        batchIds: [reviewBatch],
        adoptPolicy: "prefer_source",
        expectedPlanFingerprint: review.planFingerprint,
      }),
    ).toMatchObject({ imported: 0, adopted: 1, duplicates: 1, errors: 0 });
    expect(
      (
        await pool.query(
          "SELECT id,type,amount,units,price_per_unit,fees,taxes,currency,fx_rate_to_eur,note,import_batch_id FROM portfolio_transactions WHERE investment_id=$1",
          [data.fx.investment],
        )
      ).rows,
    ).toEqual([
      {
        id: data.transaction,
        type: "buy",
        amount: "180.0000",
        units: "10.00000000",
        price_per_unit: "18.000000",
        fees: "1.0000",
        taxes: "0.6300",
        currency: "EUR",
        fx_rate_to_eur: null,
        note: "Original manual note",
        import_batch_id: null,
      },
    ]);
    expect(
      (
        await pool.query(
          "SELECT to_jsonb(t) AS data FROM transactions t WHERE account_id=$1 ORDER BY id",
          [data.fx.account],
        )
      ).rows,
    ).toEqual(data.cash);
    expect(
      (
        await pool.query(
          "SELECT rows_imported,rows_duplicate,rows_error,status FROM portfolio_import_batches WHERE id=$1",
          [data.originalBatch],
        )
      ).rows[0],
    ).toEqual(data.counters);
    expect(
      (
        await pool.query(
          "SELECT batch_id,action,policy FROM portfolio_import_reconciliation_journal ORDER BY id",
        )
      ).rows,
    ).toEqual([
      {
        batch_id: String(data.originalBatch),
        action: "adopt",
        policy: "preserve_existing",
      },
      {
        batch_id: String(reviewBatch),
        action: "adopt",
        policy: "prefer_source",
      },
    ]);
    await expect(rollbackBatch(data.originalBatch)).rejects.toMatchObject({
      details: { reason: "adopted_transaction_changed" },
    });
    const repeat = await stageSaxoCorrectionSource(data.fx);
    const repeatedPlan = await previewPortfolioImportReconciliation({
      batchIds: [repeat],
      adoptPolicy: "prefer_source",
    });
    expect(repeatedPlan).toMatchObject({
      ready: true,
      summary: { adopt: 0, duplicate: 1 },
    });
    expect(
      await commitReviewedPortfolioImports({
        batchIds: [repeat],
        adoptPolicy: "prefer_source",
        expectedPlanFingerprint: repeatedPlan.planFingerprint,
      }),
    ).toMatchObject({ imported: 0, adopted: 0, duplicates: 1 });
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS n FROM portfolio_import_reconciliation_journal",
        )
      ).rows[0].n,
    ).toBe(2);
    await rollbackBatch(reviewBatch);
    expect(
      (
        await pool.query(
          "SELECT to_jsonb(pt)-'updated_at' AS data FROM portfolio_transactions pt WHERE id=$1",
          [data.transaction],
        )
      ).rows[0].data,
    ).toEqual(data.preserved);
    expect(
      (
        await pool.query(
          "SELECT to_jsonb(t) AS data FROM transactions t WHERE account_id=$1 ORDER BY id",
          [data.fx.account],
        )
      ).rows,
    ).toEqual(data.cash);
    await rollbackBatch(data.originalBatch);
    expect(
      (
        await pool.query(
          "SELECT account_id,source_record_hash FROM portfolio_transactions WHERE id=$1",
          [data.transaction],
        )
      ).rows[0],
    ).toEqual({ account_id: null, source_record_hash: null });
  });

  it("rejects changes to retained prior context after preview without changing any ledger or receipt", async () => {
    const data = await preservedSaxoFixture();
    const reviewBatch = await stageSaxoCorrectionSource(data.fx);
    const review = await previewPortfolioImportReconciliation({
      batchIds: [reviewBatch],
      adoptPolicy: "prefer_source",
    });
    await pool.query(
      "UPDATE portfolio_import_staging_rows SET note='Synthetic later source edit' WHERE batch_id=$1 AND row_index=0",
      [data.originalBatch],
    );
    await expect(
      commitReviewedPortfolioImports({
        batchIds: [reviewBatch],
        adoptPolicy: "prefer_source",
        expectedPlanFingerprint: review.planFingerprint,
      }),
    ).rejects.toMatchObject({
      details: { reason: "stale_reconciliation_plan" },
    });
    expect(
      (
        await pool.query(
          "SELECT to_jsonb(pt)-'updated_at' AS data FROM portfolio_transactions pt WHERE id=$1",
          [data.transaction],
        )
      ).rows[0].data,
    ).toEqual(data.preserved);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS n FROM portfolio_import_reconciliation_journal",
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT status,rows_duplicate FROM portfolio_import_batches WHERE id=$1",
          [reviewBatch],
        )
      ).rows[0],
    ).toEqual({ status: "awaiting_review", rows_duplicate: 0 });
  });

  it("rolls back correction, its receipt and counters if a sibling insert fails at runtime", async () => {
    const data = await preservedSaxoFixture();
    const reviewBatch = await stageSaxoCorrectionSource(data.fx, {
      extra: true,
    });
    const review = await previewPortfolioImportReconciliation({
      batchIds: [reviewBatch],
      adoptPolicy: "prefer_source",
    });
    expect(review).toMatchObject({
      ready: true,
      summary: { adopt: 1, insert: 1 },
    });
    const spy = vi
      .spyOn(portfolioTransactionService, "create")
      .mockRejectedValue(new Error("Synthetic sibling write failure"));
    try {
      await expect(
        commitReviewedPortfolioImports({
          batchIds: [reviewBatch],
          adoptPolicy: "prefer_source",
          expectedPlanFingerprint: review.planFingerprint,
        }),
      ).rejects.toMatchObject({ details: { reason: "atomic_import_failed" } });
    } finally {
      spy.mockRestore();
    }
    expect(
      (
        await pool.query(
          "SELECT to_jsonb(pt)-'updated_at' AS data FROM portfolio_transactions pt WHERE id=$1",
          [data.transaction],
        )
      ).rows[0].data,
    ).toEqual(data.preserved);
    expect(
      (
        await pool.query(
          "SELECT to_jsonb(t) AS data FROM transactions t WHERE account_id=$1 ORDER BY id",
          [data.fx.account],
        )
      ).rows,
    ).toEqual(data.cash);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS n FROM portfolio_import_reconciliation_journal",
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT status,rows_duplicate,rows_imported FROM portfolio_import_batches WHERE id=$1",
          [reviewBatch],
        )
      ).rows[0],
    ).toEqual({
      status: "awaiting_review",
      rows_duplicate: 0,
      rows_imported: 0,
    });
    expect(
      (
        await pool.query(
          "SELECT status FROM portfolio_import_staging_rows WHERE batch_id=$1 ORDER BY row_index",
          [reviewBatch],
        )
      ).rows.map((row) => row.status),
    ).toEqual(["matched", "matched"]);
  });
  async function stagedSaxoCompanions(fx, count = 17) {
    const bookBatch = await batch(fx, []);
    const csvBatch = await batch(fx, []);
    let errorCount = 0;
    for (let index = 0; index < count; index++) {
      const base = index < 3 ? 0 : index < 12 ? 1 : 2;
      const envelope = JSON.parse(syntheticSaxoPrimaryRawData(base));
      for (const record of envelope.records) {
        const column = record.headers.findIndex(
          (header) =>
            header.trim().replaceAll("\u00a0", " ") === "Bk Record Id",
        );
        record.cells[column] = { type: "number", raw: String(1000 + index) };
        const bookingColumn = record.headers.findIndex(
          (header) => header.trim().replaceAll("\u00a0", " ") === "Booking Id",
        );
        if (record.cells[bookingColumn])
          record.cells[bookingColumn] =
            `${record.cells[bookingColumn]}-${index}`;
      }
      const raw = JSON.stringify(envelope);
      const main = envelope.records[0];
      const csvRaw = main.cells
        .map((cell) => {
          const value =
            cell?.type === "date"
              ? cell.value.slice(0, 10).replaceAll("-", "/")
              : cell?.type === "number"
                ? cell.raw
                : (cell ?? "");
          return `"${String(value).replaceAll('"', '""')}"`;
        })
        .join(",");
      const proof = getSaxoWorkbookReconciliationEvidence(raw);
      const companion = getSaxoCsvCompanionEvidence(csvRaw, main.headers, raw);
      expect(companion).toBeDefined();
      await pool.query(
        "UPDATE portfolio_import_batches SET custom_config=jsonb_set(custom_config,'{source_columns}',$2::jsonb) WHERE id=$1",
        [csvBatch, JSON.stringify(main.headers)],
      );
      for (const [batchId, parsed, literal, isCsv] of [
        [bookBatch, proof, raw, false],
        [csvBatch, companion.csv, csvRaw, true],
      ]) {
        const cash = parsed.typeRaw === "Deposit";
        const error = isCsv && base === 1;
        if (error) errorCount++;
        await pool.query(
          `INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,tx_date,type_raw,type,route,
            symbol_raw,name_raw,units,price_per_unit,amount,fees,taxes,currency,fx_rate_to_eur,
            resolved_investment_id,raw_data,source_record_hash,dedup_fingerprint,dedup_fingerprint_version,
            source_transaction_id,source_account_identity,error_message,dedup_occurrence)
          VALUES($1,$2,$3,'2025-01-10',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,1)`,
          [
            batchId,
            index,
            error ? "error" : "matched",
            parsed.typeRaw,
            error || cash ? null : parsed.typeRaw.toLowerCase(),
            error ? null : cash ? "cash" : "portfolio",
            parsed.symbolRaw || null,
            parsed.nameRaw || null,
            parsed.units,
            parsed.pricePerUnit,
            parsed.amount,
            parsed.fees,
            parsed.taxes,
            parsed.currency,
            parsed.fxRateToEur,
            cash || error ? null : fx.investment,
            literal,
            saxoHash(literal),
            error
              ? null
              : saxoHash(
                  `companion-event-${index}-${cash || !isCsv ? "book" : "csv"}`,
                ),
            error ? null : 1,
            parsed.sourceId,
            parsed.sourceAccountIdentity,
            error
              ? 'unknown transaction type "Unsupported Saxo event: Cashdividend"'
              : null,
          ],
        );
      }
    }
    await pool.query(
      "UPDATE portfolio_import_batches SET rows_total=$2 WHERE id=ANY($1::bigint[])",
      [[bookBatch, csvBatch], count],
    );
    await pool.query(
      "UPDATE portfolio_import_batches SET rows_error=$2 WHERE id=$1",
      [csvBatch, errorCount],
    );
    return { bookBatch, csvBatch };
  }

  it("settles all 17 CSV companion records with nine cleared errors and no extra financial rows", async () => {
    const fx = await fixture();
    const { bookBatch, csvBatch } = await stagedSaxoCompanions(fx);
    await expect(
      commitReviewedPortfolioImports({ batchIds: [csvBatch] }),
    ).rejects.toMatchObject({ details: { reason: "incomplete_source" } });
    const preview = await previewPortfolioImportReconciliation({
      batchIds: [csvBatch, bookBatch],
    });
    expect(preview).toMatchObject({
      ready: true,
      summary: { insert: 12, cash: 5, duplicate_source: 17 },
    });
    const committed = await commitReviewedPortfolioImports({
      batchIds: [csvBatch, bookBatch],
      expectedPlanFingerprint: preview.planFingerprint,
    });
    expect(committed).toMatchObject({
      imported: 17,
      duplicates: 17,
      adopted: 0,
      errors: 0,
    });
    expect(
      committed.batches.find((row) => row.batch_id === csvBatch),
    ).toMatchObject({ imported: 0, duplicates: 17, errors: 0 });
    expect(
      (
        await pool.query(
          "SELECT status,rows_imported,rows_duplicate,rows_error FROM portfolio_import_batches WHERE id=$1",
          [csvBatch],
        )
      ).rows[0],
    ).toEqual({
      status: "complete",
      rows_imported: 0,
      rows_duplicate: 17,
      rows_error: 0,
    });
    expect(
      (
        await pool.query(
          "SELECT status,committed_txn_id,error_message FROM portfolio_import_staging_rows WHERE batch_id=$1",
          [csvBatch],
        )
      ).rows.every(
        (row) =>
          row.status === "duplicate" &&
          row.committed_txn_id == null &&
          row.error_message == null,
      ),
    ).toBe(true);
    const portfolio = (
      await pool.query(
        "SELECT to_jsonb(pt) AS data FROM portfolio_transactions pt WHERE investment_id=$1 ORDER BY id",
        [fx.investment],
      )
    ).rows;
    const cash = (
      await pool.query(
        "SELECT to_jsonb(t) AS data FROM transactions t WHERE account_id=$1 ORDER BY id",
        [fx.account],
      )
    ).rows;
    expect(portfolio).toHaveLength(12);
    expect(cash).toHaveLength(5);
    const freshRepeat = await stagedSaxoCompanions(fx);
    const freshPreview = await previewPortfolioImportReconciliation({
      batchIds: [freshRepeat.csvBatch, freshRepeat.bookBatch],
    });
    expect(freshPreview).toMatchObject({
      ready: true,
      summary: { insert: 0, duplicate: 12, duplicate_source: 17 },
    });
    expect(
      await commitReviewedPortfolioImports({
        batchIds: [freshRepeat.csvBatch, freshRepeat.bookBatch],
        expectedPlanFingerprint: freshPreview.planFingerprint,
      }),
    ).toMatchObject({ imported: 0, duplicates: 34, adopted: 0, errors: 0 });
    const repeated = await previewPortfolioImportReconciliation({
      batchIds: [csvBatch, bookBatch],
    });
    expect(repeated).toMatchObject({
      ready: true,
      summary: { settled: 34, insert: 0, duplicate_source: 0 },
    });
    await rollbackBatch(csvBatch);
    expect(
      (
        await pool.query(
          "SELECT to_jsonb(pt) AS data FROM portfolio_transactions pt WHERE investment_id=$1 ORDER BY id",
          [fx.investment],
        )
      ).rows,
    ).toEqual(portfolio);
    expect(
      (
        await pool.query(
          "SELECT to_jsonb(t) AS data FROM transactions t WHERE account_id=$1 ORDER BY id",
          [fx.account],
        )
      ).rows,
    ).toEqual(cash);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS n FROM portfolio_import_reconciliation_journal",
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("rejects a stale literal companion review before settling any source row", async () => {
    const fx = await fixture();
    const { bookBatch, csvBatch } = await stagedSaxoCompanions(fx, 1);
    const preview = await previewPortfolioImportReconciliation({
      batchIds: [csvBatch, bookBatch],
    });
    await pool.query(
      "UPDATE portfolio_import_staging_rows SET raw_data=raw_data||' ' WHERE batch_id=$1",
      [csvBatch],
    );
    await expect(
      commitReviewedPortfolioImports({
        batchIds: [csvBatch, bookBatch],
        expectedPlanFingerprint: preview.planFingerprint,
      }),
    ).rejects.toMatchObject({
      details: { reason: "stale_reconciliation_plan" },
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS n FROM portfolio_transactions WHERE investment_id=$1",
          [fx.investment],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT status FROM portfolio_import_staging_rows WHERE batch_id=$1",
          [csvBatch],
        )
      ).rows[0].status,
    ).toBe("matched");
  });

  it("restores all companion statuses and error counters when a workbook insert fails", async () => {
    const fx = await fixture();
    const { bookBatch, csvBatch } = await stagedSaxoCompanions(fx);
    const preview = await previewPortfolioImportReconciliation({
      batchIds: [csvBatch, bookBatch],
    });
    const before = (
      await pool.query(
        "SELECT to_jsonb(s) AS data FROM portfolio_import_staging_rows s WHERE batch_id=$1 ORDER BY row_index",
        [csvBatch],
      )
    ).rows;
    const spy = vi
      .spyOn(portfolioTransactionService, "create")
      .mockRejectedValue(new Error("Synthetic companion sibling failure"));
    try {
      await expect(
        commitReviewedPortfolioImports({
          batchIds: [csvBatch, bookBatch],
          expectedPlanFingerprint: preview.planFingerprint,
        }),
      ).rejects.toMatchObject({ details: { reason: "atomic_import_failed" } });
    } finally {
      spy.mockRestore();
    }
    expect(
      (
        await pool.query(
          "SELECT to_jsonb(s) AS data FROM portfolio_import_staging_rows s WHERE batch_id=$1 ORDER BY row_index",
          [csvBatch],
        )
      ).rows,
    ).toEqual(before);
    expect(
      (
        await pool.query(
          "SELECT status,rows_duplicate,rows_error FROM portfolio_import_batches WHERE id=$1",
          [csvBatch],
        )
      ).rows[0],
    ).toEqual({ status: "awaiting_review", rows_duplicate: 0, rows_error: 9 });
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS n FROM portfolio_transactions WHERE investment_id=$1",
          [fx.investment],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS n FROM transactions WHERE account_id=$1",
          [fx.account],
        )
      ).rows[0].n,
    ).toBe(0);
  });
});
