/** Complete primary yield facts identify one unclaimed zero-basis receipt on its payment date. */
import { toDecimal } from "../lib/money.ts";
import { UNIT_BASED_ASSET_CLASSES } from "@vision/types/assetClasses";
import { proveKinesisCorrectionSources } from "./portfolioKinesisAdoptionScope.js";

const zeroBasis = (row) =>
  ["amount", "price_per_unit", "fees", "taxes"].every((field) =>
    toDecimal(row[field] ?? 0).eq(0),
  );

export function proveKinesisFullYieldCandidates(rows, batches, history) {
  const evidence = proveKinesisCorrectionSources(rows, batches);
  const candidates = new Map();
  for (const row of rows) {
    const proof = evidence.proofs.get(Number(row.id));
    if (
      !proof ||
      evidence.issues.some((issue) => issue.batchId === Number(row.batch_id)) ||
      proof.parsed.assetAdjustment?.kind !== "yield_acquisition" ||
      proof.parsed.assetAdjustment?.basisPolicy !== "zero" ||
      row.type !== "gift" ||
      row.route !== "portfolio" ||
      !UNIT_BASED_ASSET_CLASSES.includes(row.asset_class)
    )
      continue;
    const sameDaySources = rows.filter(
      (other) =>
        other.type === "gift" &&
        other.tx_date === row.tx_date &&
        Number(other.investment_id) === Number(row.investment_id) &&
        Number(other.account_id) === Number(row.account_id),
    );
    const unclaimed = sameDaySources.filter(
      (other) =>
        !history.some(
          (current) =>
            current.dedup_fingerprint === other.dedup_fingerprint &&
            current.dedup_fingerprint_version ===
              other.dedup_fingerprint_version,
        ),
    );
    if (!unclaimed.some((item) => Number(item.id) === Number(row.id))) continue;
    const manual = history.filter(
      (current) =>
        current.type === "gift" &&
        current.date === row.tx_date &&
        Number(current.investment_id) === Number(row.investment_id) &&
        current.account_id == null &&
        current.import_batch_id == null &&
        current.dedup_fingerprint == null &&
        current.source_record_hash == null &&
        !current.is_recurring &&
        current.recurrence_interval == null &&
        current.recurrence_end_date == null &&
        zeroBasis(current) &&
        toDecimal(current.units ?? 0).gt(0),
    );
    if (manual.length) candidates.set(Number(row.id), manual);
  }
  return { candidates, evidence };
}
