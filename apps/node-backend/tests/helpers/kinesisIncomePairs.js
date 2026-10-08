/** Complete synthetic paired source and immutable adopted acquisition. */
import {
  syntheticKinesisScope,
  syntheticKinesisManual,
} from "./kinesisAdoptionScope.js";
export async function syntheticKinesisIncomePair() {
  const source = await syntheticKinesisScope();
  const prior = await syntheticKinesisScope({ batchId: 1, rowStart: 100 });
  const unit = source.rows.find(
    (row) => row.source_transaction_id === "TX-YIELD:units",
  );
  const income = source.rows.find(
    (row) => row.source_transaction_id === "TX-YIELD:income",
  );
  const before = syntheticKinesisManual(unit);
  const current = {
    ...before,
    account_id: unit.account_id,
    source_record_hash: unit.source_record_hash,
    dedup_fingerprint: unit.dedup_fingerprint,
    dedup_fingerprint_version: 1,
  };
  const retained = prior.rows.find(
    (row) => row.source_transaction_id === unit.source_transaction_id,
  );
  retained.status = "duplicate";
  const receipt = {
    id: "1",
    batch_id: 1,
    staging_row_id: retained.id,
    transaction_id: current.id,
    action: "adopt",
    policy: "preserve_existing",
    before_data: before,
    after_data: structuredClone(current),
  };
  source.history = [current];
  return {
    ...source,
    unit,
    income,
    historicalFxContext: [
      { currency: income.currency, date: income.tx_date, rate: "0.8" },
    ],
    kinesisAdoptionContext: {
      receipts: [receipt],
      sources: prior.rows,
      batches: prior.batches,
    },
  };
}
