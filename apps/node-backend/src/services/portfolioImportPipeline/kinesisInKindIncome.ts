/**
 * Kinesis yield distributions under the zero yield-basis policy (ADR-188,
 * ADR-236).
 *
 * The adapter stages one distribution as two rows that share a source record:
 * a `:income` dividend with the literal value and a `:units` gift of the
 * received metal at zero basis. The units already carry that value into
 * holdings and gains, so the dividend is recorded with the
 * `included_in_units` role, which keeps it out of ordinary income totals.
 */
import { batchConfigFields } from "../../database/rows/portfolioImport.ts";
import type { StoredPortfolioImportBatchConfig } from "../../database/rows/portfolioImport.ts";

/** The staging fields that identify a distribution's two rows. */
export interface KinesisDistributionRow {
  id: number | string;
  type: string | null;
  source_transaction_id: string | null;
  source_record_hash: string | null;
}

/** A Kinesis batch that stages yield units at zero basis. */
export function isZeroYieldKinesisBatch(
  config: StoredPortfolioImportBatchConfig | null | undefined,
): boolean {
  const fields = batchConfigFields(config);
  return (
    fields?.format === "kinesis_transaction_history" &&
    fields.yield_basis_policy === "zero"
  );
}

/**
 * Staging IDs of the `:income` dividends whose `:units` gift is staged in the
 * same batch. Call only for a zero yield-basis Kinesis batch.
 */
export function kinesisInKindIncomeRowIds(
  rows: readonly KinesisDistributionRow[],
): Set<number> {
  const units = new Set(
    rows
      .filter(
        (row) =>
          row.type === "gift" &&
          row.source_transaction_id?.endsWith(":units") === true &&
          row.source_record_hash !== null,
      )
      .map((row) => `${row.source_transaction_id}|${row.source_record_hash}`),
  );
  return new Set(
    rows
      .filter(
        (row) =>
          row.type === "dividend" &&
          row.source_transaction_id?.endsWith(":income") &&
          units.has(
            `${row.source_transaction_id.replace(/:income$/, ":units")}|${row.source_record_hash}`,
          ),
      )
      .map((row) => Number(row.id)),
  );
}
