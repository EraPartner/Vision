/**
 * Rollback support for records that the removed reconciliation workflows
 * applied before ADR-236: IBKR native funding cash corrections and Kinesis
 * cash-only fee components. Vision no longer creates these records, but a
 * batch that owns them must still undo them exactly.
 */
import { isDeepStrictEqual } from "node:util";
import { ConflictError } from "../middleware/errorHandler.ts";
import {
  readActiveIbkrCashReceipts,
  readIbkrCashImagesForUpdate,
  writeIbkrCashRestoration,
} from "../repositories/portfolioImportCashRepository.ts";
import type {
  IbkrCashEnvelope,
  IbkrCashFinancialImage,
} from "../repositories/portfolioImportCashRepository.ts";

export {
  guardOriginalIbkrCashRollback,
  readOwnedKinesisCashFeeIds,
} from "../repositories/portfolioImportCashRepository.ts";

type CashReceiptLike = { before_data: unknown; after_data: unknown };
type IbkrCashReceiptOf<T> = T & {
  id: string | number;
  batch_id: string | number;
  staging_row_id: string | number;
  transaction_id: number;
  action: string;
  policy: string;
  previous_entry_id: string | number | null;
  created_at: Date;
  before_data: IbkrCashEnvelope;
  after_data: IbkrCashEnvelope;
};

const stale = () =>
  new ConflictError("IBKR cash source or ledger image changed", {
    details: { reason: "cash_receipt_changed" },
  });

const FINANCIAL_KEYS = [
  "id",
  "date",
  "amount",
  "currency",
  "memo",
  "comment",
  "balance",
  "account_id",
  "recipient_id",
  "recipient_bank_account_id",
  "is_active",
  "import_batch_id",
  "source_record_hash",
  "dedup_fingerprint",
  "dedup_fingerprint_version",
] as const satisfies readonly (keyof IbkrCashFinancialImage)[];

function financialImage(
  snapshot: Partial<Record<keyof IbkrCashFinancialImage, unknown>> | undefined,
): Record<string, unknown> {
  return Object.fromEntries(
    FINANCIAL_KEYS.map((key) => [key, snapshot?.[key] ?? null]),
  );
}

/** Journal rows hold portfolio and cash receipts; this narrows to the cash kind. */
export function isIbkrCashReceipt<T extends CashReceiptLike>(
  receipt: T,
): receipt is IbkrCashReceiptOf<T> {
  const before = receipt?.before_data as Partial<IbkrCashEnvelope> | undefined;
  const after = receipt?.after_data as Partial<IbkrCashEnvelope> | undefined;
  return (
    before?.ledgerKind === "cash" &&
    after?.ledgerKind === "cash" &&
    before.version === 1 &&
    after.version === 1 &&
    (after.proof?.kind === "ibkr_native_funding" ||
      after.proof?.kind === "cash_adoption")
  );
}

/** Every corrected cash row must still match its recorded after-image. */
export async function validateIbkrCashCorrectionRollback<
  T extends CashReceiptLike,
>(receipts: readonly T[]): Promise<IbkrCashReceiptOf<T>[]> {
  const cash = receipts.filter((receipt): receipt is IbkrCashReceiptOf<T> =>
    isIbkrCashReceipt(receipt),
  );
  const ids = cash.map((receipt) => Number(receipt.transaction_id));
  if (new Set(ids).size !== ids.length) throw stale();
  const current = await readIbkrCashImagesForUpdate(ids);
  for (const receipt of cash) {
    const row = current.find(
      (item) => Number(item.id) === Number(receipt.transaction_id),
    );
    if (
      receipt.action !== "adopt" ||
      !row ||
      !isDeepStrictEqual(
        financialImage(receipt.after_data.snapshot),
        financialImage(row),
      )
    )
      throw stale();
  }
  return cash;
}

export function restoreIbkrCashCorrection(
  receipt: Parameters<typeof writeIbkrCashRestoration>[0],
): ReturnType<typeof writeIbkrCashRestoration> {
  return writeIbkrCashRestoration(receipt);
}

/**
 * A native funding correction replaced the original CSV row's fingerprint. A
 * repeat of that original CSV row is the corrected record, not new cash.
 *
 * @returns the corrected transaction id, or undefined for ordinary cash
 */
export async function findCorrectedIbkrCashAlias(row: {
  dedup_fingerprint: string | null;
  dedup_fingerprint_version: number | null;
}): Promise<number | undefined> {
  if (!row.dedup_fingerprint || row.dedup_fingerprint_version == null)
    return undefined;
  const receipt = (await readActiveIbkrCashReceipts()).find(
    (item) =>
      item.before_data.snapshot?.dedup_fingerprint === row.dedup_fingerprint &&
      Number(item.before_data.snapshot?.dedup_fingerprint_version) ===
        Number(row.dedup_fingerprint_version),
  );
  return receipt ? Number(receipt.transaction_id) : undefined;
}
