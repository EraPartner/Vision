/** Reviewed custody writes share one transaction and one approved source scope. */
import { AsyncLocalStorage } from "node:async_hooks";
import { withTransaction } from "../../database/connection.ts";
import type { PgPoolClient } from "../../database/connection.ts";
import { ConflictError } from "../../middleware/errorHandler.ts";
import { toDecimal } from "../../lib/money.ts";
import type { DecimalInput } from "../../lib/money.ts";
import { getUnitEventsForInvestment } from "../../repositories/portfolioTxRepo.reads.ts";
import type { PortfolioUnitEventRow } from "../../repositories/portfolioTxRepo.reads.ts";
import { findAssetTransferFingerprint } from "../../repositories/portfolioAssetTransferRepository.ts";
import { findAssetAdjustmentFingerprint } from "../../repositories/portfolioAssetAdjustmentRepository.ts";

/**
 * A custody event (asset transfer or asset adjustment) as previewed for
 * writing, or as persisted: the fields its approval signature covers.
 */
export type CustodyEventLike = {
  type: string;
  investment_id: number | string;
  account_id?: number | string | null;
  source_account_id?: number | string | null;
  destination_account_id?: number | string | null;
  /** 'YYYY-MM-DD' */
  date: string;
  units: DecimalInput;
  fee_units?: DecimalInput;
  adjustment_kind?: string | null;
  basis_policy?: string | null;
  eligible_source_record_hashes?: string[] | null;
  import_batch_id?: number | string | null;
  staging_row_id?: number | string | null;
  source_record_hash: string;
  dedup_fingerprint: string;
  dedup_fingerprint_version: number;
};

type CustodyScope = {
  client: PgPoolClient;
  /** eventKey → approved signature */
  approved: Map<string, string>;
  active: boolean;
};

const scopes = new AsyncLocalStorage<CustodyScope>();
const eventKey = (event: CustodyEventLike) =>
  `${Number(event.import_batch_id)}:${Number(event.staging_row_id)}`;
const signature = (event: CustodyEventLike) =>
  JSON.stringify({
    type: event.type,
    investment: Number(event.investment_id),
    account: event.account_id == null ? undefined : Number(event.account_id),
    source:
      event.source_account_id == null
        ? undefined
        : Number(event.source_account_id),
    destination:
      event.destination_account_id == null
        ? undefined
        : Number(event.destination_account_id),
    date: event.date,
    units: toDecimal(event.units).toFixed(),
    feeUnits:
      event.type === "asset_transfer"
        ? toDecimal(event.fee_units).toFixed()
        : undefined,
    adjustmentKind: event.adjustment_kind,
    basisPolicy: event.basis_policy,
    eligibleSourceHashes:
      event.type === "asset_adjustment"
        ? [...new Set(event.eligible_source_record_hashes || [])].sort()
        : undefined,
    sourceRecordHash: event.source_record_hash,
    fingerprint: event.dedup_fingerprint,
    fingerprintVersion: Number(event.dedup_fingerprint_version),
  });

/**
 * Only the reviewed writer enters this after locked full-projection validation.
 * Complete persisted history is checked again before this transaction can end.
 */
export async function withPortfolioCustodyImportScope<T>(
  {
    events,
    validateHistory,
  }: {
    events: readonly CustodyEventLike[];
    validateHistory: (history: PortfolioUnitEventRow[]) => unknown;
  },
  work: () => Promise<T>,
): Promise<T> {
  if (typeof validateHistory !== "function")
    throw new ConflictError(
      "Reviewed custody scope requires final history validation",
    );
  return withTransaction(async (client) => {
    const approved = new Map<string, string>();
    for (const event of events) {
      if (
        !event ||
        !Number.isSafeInteger(Number(event.investment_id)) ||
        Number(event.investment_id) <= 0 ||
        !/^\d{4}-\d{2}-\d{2}$/.test(event.date || "") ||
        !toDecimal(event.units).gt(0) ||
        !/^[a-f0-9]{64}$/.test(event.source_record_hash || "") ||
        !/^[a-f0-9]{64}$/.test(event.dedup_fingerprint || "") ||
        !Number.isSafeInteger(Number(event.dedup_fingerprint_version)) ||
        Number(event.dedup_fingerprint_version) <= 0 ||
        (event.type === "asset_adjustment" &&
          (!Array.isArray(event.eligible_source_record_hashes) ||
            event.eligible_source_record_hashes.some(
              (hash) => !/^[a-f0-9]{64}$/.test(hash),
            )))
      )
        throw new ConflictError(
          "Reviewed custody scope contains an invalid source event",
        );
      const key = eventKey(event);
      if (
        !["asset_transfer", "asset_adjustment"].includes(event.type) ||
        !Number.isSafeInteger(Number(event.import_batch_id)) ||
        Number(event.import_batch_id) <= 0 ||
        !Number.isSafeInteger(Number(event.staging_row_id)) ||
        Number(event.staging_row_id) <= 0 ||
        approved.has(key)
      )
        throw new ConflictError(
          "Reviewed custody scope contains an invalid source event",
        );
      approved.set(key, signature(event));
    }
    const scope: CustodyScope = { client, approved, active: true };
    return scopes.run(scope, async () => {
      try {
        const result = await work();
        for (const investmentId of new Set(
          events.map((event) => Number(event.investment_id)),
        ))
          await validateHistory(await getUnitEventsForInvestment(investmentId));
        for (const event of events) {
          const persisted = await (
            event.type === "asset_transfer"
              ? findAssetTransferFingerprint
              : findAssetAdjustmentFingerprint
          )(event.dedup_fingerprint, event.dedup_fingerprint_version);
          if (
            !persisted ||
            signature({ ...persisted, type: event.type }) !== signature(event)
          )
            throw new ConflictError(
              "Reviewed custody scope did not retain every approved event",
            );
        }
        return result;
      } finally {
        scope.active = false;
      }
    });
  });
}

/** Ordinary writes validate full history; approved atomic writes allocate at their date. */
export function portfolioCustodyWriteHistory<H extends { date: string }>(
  history: H[],
  event: CustodyEventLike,
  client: PgPoolClient,
): H[] {
  const scope = scopes.getStore();
  if (!scope) return history;
  if (
    !scope.active ||
    scope.client !== client ||
    scope.approved.get(eventKey(event)) !== signature(event)
  )
    throw new ConflictError(
      "Custody write is outside its reviewed transaction scope",
    );
  // Persisted same-day events retain actual sequence order. The candidate's
  // preview ID follows them, while not-yet-written source events are absent.
  return history.filter((existing) => existing.date <= event.date);
}
