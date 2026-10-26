/** Immutable source-backed unit corrections, with no cash or disposal legs. */
import { sql } from "kysely";
import { checkedRow, checkedRows, db } from "../database/db.ts";
import {
  eligibleYieldSourceRowSchema,
  portfolioAssetAdjustmentRowSchema,
  portfolioBigintIdRowSchema,
} from "../database/rows/portfolio.ts";
import type {
  EligibleYieldSourceDbRow,
  PortfolioAssetAdjustmentDbRow,
} from "../database/rows/portfolio.ts";
import { asAccountId, asInvestmentId } from "@vision/types/brands";
import type { AccountId, InvestmentId } from "@vision/types/brands";

/**
 * BIGINT ids and NUMERIC units arrive from pg as strings. Derived from the
 * checked row schema.
 */
export type PortfolioAssetAdjustmentRow = PortfolioAssetAdjustmentDbRow;

export type EligibleYieldSourceRow = EligibleYieldSourceDbRow;

export type PortfolioAssetAdjustmentInsert = {
  investment_id: InvestmentId;
  account_id: AccountId;
  date: string;
  units: string;
  adjustment_kind: string;
  basis_policy: string;
  basis_allocations?: unknown;
  eligible_source_record_hashes: string[];
  import_batch_id: number;
  staging_row_id: number;
  source_record_hash: string;
  dedup_fingerprint: string;
  dedup_fingerprint_version: number;
};

export async function getEligibleYieldSources(
  investmentId: number,
  accountId: number,
): Promise<EligibleYieldSourceRow[]> {
  return checkedRows(
    eligibleYieldSourceRowSchema,
    db
      .selectFrom("portfolio_import_staging_rows as s")
      .innerJoin("portfolio_import_batches as b", "b.id", "s.batch_id")
      .select((eb) => [
        "s.source_record_hash",
        eb.fn.min("s.id").as("staging_row_id"),
      ])
      .where(
        (eb) =>
          eb.fn.coalesce(
            "s.user_override_investment_id",
            "s.resolved_investment_id",
          ),
        "=",
        asInvestmentId(investmentId),
      )
      .where("b.account_id", "=", asAccountId(accountId))
      .where("s.type", "=", "gift")
      .where(sql<string>`s.asset_adjustment_details->>'kind'`, "=", "yield_acquisition")
      .where(sql<string>`s.asset_adjustment_details->>'basisPolicy'`, "=", "zero")
      .where("s.status", "in", ["matched", "committed", "duplicate"])
      .where("s.source_record_hash", "is not", null)
      .groupBy("s.source_record_hash")
      .orderBy("s.source_record_hash"),
  );
}

export async function getEligibleYieldSourceHashes(
  investmentId: number,
  accountId: number,
): Promise<string[]> {
  return (await getEligibleYieldSources(investmentId, accountId)).map(
    (row) => row.source_record_hash,
  );
}

export async function retainAssetAdjustmentSources(
  adjustmentId: string | number,
  sources: readonly EligibleYieldSourceRow[],
): Promise<void> {
  for (const source of sources)
    await db
      .insertInto("portfolio_asset_adjustment_sources")
      .values({
        adjustment_id: adjustmentId,
        staging_row_id: source.staging_row_id,
        source_record_hash: source.source_record_hash,
      })
      .execute();
}

function selectAdjustments() {
  return db
    .selectFrom("portfolio_asset_adjustments as a")
    .selectAll("a")
    .select(sql<string>`to_char(a.date,'YYYY-MM-DD')`.as("date"));
}

export async function findAssetAdjustmentFingerprint(
  fingerprint: string,
  version: number,
): Promise<PortfolioAssetAdjustmentRow | undefined> {
  return checkedRow(
    portfolioAssetAdjustmentRowSchema,
    selectAdjustments()
      .where("a.dedup_fingerprint", "=", fingerprint)
      .where("a.dedup_fingerprint_version", "=", version),
  );
}

export async function insertAssetAdjustment(
  event: PortfolioAssetAdjustmentInsert,
): Promise<{ id: string }> {
  const row = await checkedRow(
    portfolioBigintIdRowSchema,
    db
      .insertInto("portfolio_asset_adjustments")
      .values({
        investment_id: event.investment_id,
        account_id: event.account_id,
        date: event.date,
        units: event.units,
        adjustment_kind: event.adjustment_kind,
        basis_policy: event.basis_policy,
        basis_allocations: sql`${JSON.stringify(event.basis_allocations)}::jsonb`,
        eligible_source_record_hashes: sql`${event.eligible_source_record_hashes}::text[]`,
        import_batch_id: event.import_batch_id,
        staging_row_id: event.staging_row_id,
        source_record_hash: event.source_record_hash,
        dedup_fingerprint: event.dedup_fingerprint,
        dedup_fingerprint_version: event.dedup_fingerprint_version,
      })
      .returning("id"),
  );
  // An INSERT ... RETURNING without ON CONFLICT returns its row or throws.
  if (!row) throw new Error("Asset adjustment insert returned no row");
  return row;
}

export async function getAssetAdjustmentsForBatch(
  batchId: string | number,
): Promise<PortfolioAssetAdjustmentRow[]> {
  return checkedRows(
    portfolioAssetAdjustmentRowSchema,
    selectAdjustments()
      .where("a.import_batch_id", "=", String(batchId))
      .orderBy("a.investment_id").orderBy("a.date").orderBy("a.id"),
  );
}

export async function deleteAssetAdjustmentsForBatch(
  batchId: string | number,
): Promise<number | null> {
  const result = await db
    .deleteFrom("portfolio_asset_adjustments")
    .where("import_batch_id", "=", String(batchId))
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}
