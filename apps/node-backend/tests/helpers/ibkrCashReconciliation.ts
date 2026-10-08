import { createHash } from "node:crypto";
import { syntheticIbkrPlannerSource } from "./ibkrReconciliation.ts";
import { assignImportIdentities, portfolioIdentityBase } from "../../src/services/importIdentity.ts";
import type { PortfolioIdentityRow } from "../../src/services/importIdentity.ts";

export interface IbkrCashCorrectionOptions {
  sourceAccount?: string;
  nativeAccount?: string;
  baseAmount?: string;
  rate?: string;
  kind?: "deposit" | "withdrawal";
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const depositColumns = ["Request Date", "Reference Number", "Method", "Account ID", "Account Title", "Delivering Institution", "From Account Number",
  "Routing Number", "Date Received", "Date Available for Trading", "Date Available for Withdrawal - Original Bank",
  "Date Available for Withdrawal - Other Bank", "Amount", "Status"];
function identity<R extends PortfolioIdentityRow & { raw_data?: unknown }>(row: R) {
  const value = assignImportIdentities([row], (source) => portfolioIdentityBase(source, { accountIdentity: "UNASSIGNED" }))[0];
  return { ...row, dedup_fingerprint: value.fingerprint, dedup_fingerprint_version: value.version, dedup_occurrence: value.occurrence };
}
export function syntheticIbkrCashCorrection({ sourceAccount = "U12345678", nativeAccount = sourceAccount, baseAmount = "80", rate = "0.8", kind = "deposit" }: IbkrCashCorrectionOptions = {}) {
  const typeRaw = kind === "withdrawal" ? "Withdrawal" : "Deposit";
  const signedBase = kind === "withdrawal" ? `-${baseAmount}` : baseAmount;
  const columns = kind === "withdrawal" ? ["Request Date", "Reference Number", "Method", "Account ID", "Account Title", "Receiving Institution", "Date Processed", "Amount", "Status"] : depositColumns;
  const original = identity(syntheticIbkrPlannerSource({ id: 10, batch_id: 1, status: "committed", route: "cash", type: null, type_raw: typeRaw,
    investment_id: null, symbol_raw: "", name_raw: "", units: null, price_per_unit: null, amount: baseAmount,
    fees: null, taxes: null, currency: "EUR", fx_rate_to_eur: null, committed_txn_id: 40, source_transaction_id: null,
    literal: { Account: sourceAccount, "Transaction Type": typeRaw, Symbol: "-", Quantity: "-", Price: "-", "Price Currency": "-",
      "Gross Amount": signedBase, Commission: "-", "Net Amount": signedBase, "Exchange Rate": rate, "Transaction Fees": "-" } }));
  const values = kind === "withdrawal" ? ["2026-01-01", "REFERENCE1", "Wire", nativeAccount, "Synthetic Owner", "Synthetic bank", "2026-01-01", "USD 100.00", "Sent"]
    : ["2026-01-01", "REFERENCE1", "Wire", nativeAccount, "Synthetic Owner", "Synthetic bank", "", "", "2026-01-01", "", "", "", "USD 100.00", "Available"];
  const fileHash = hash("Synthetic funding workbook");
  const envelope = { schema: "ibkr_funding_workbook_row", version: 1, source_file_hash: fileHash, source_format: "xls",
    sheet: typeRaw, header_row: 1, row_number: 2, columns, cells: values.map((value) => ({ type: "text", value })) };
  const raw = JSON.stringify(envelope);
  const context = { version: 1, source_file_hash: fileHash, source_format: "xls", source_account_identities: [nativeAccount],
    sheets: [{ sheet: typeRaw, header_row: 1, source_columns: columns, records: [{ row_number: 2, record_hash: hash(raw), source_id: "REFERENCE1", source_account_identity: nativeAccount }] }],
    record_hashes: [hash(raw)] };
  const native = identity({ id: 20, batch_id: 2, row_index: 0, status: "matched", route: "cash", type: null, type_raw: typeRaw,
    tx_date: "2026-01-01", account_id: 7, investment_id: null, symbol_raw: "", name_raw: "", units: null, price_per_unit: null,
    amount: "100.0000", fees: null, taxes: null, currency: "USD", fx_rate_to_eur: null, note: "Native deposit",
    source_transaction_id: "REFERENCE1", source_account_identity: nativeAccount, raw_data: raw, source_record_hash: hash(raw),
    custom_config: { format: "ibkr_funding_history", ibkr_funding_source_context: context } });
  const ledger = { id: 40, date: "2026-01-01", amount: Number(signedBase).toFixed(4), currency: "EUR", memo: original.note,
    comment: "Keep user comment", balance: null, account_id: 7, recipient_id: 3, recipient_bank_account_id: null,
    category_id: 58, is_active: true, import_batch_id: null, source_record_hash: original.source_record_hash,
    dedup_fingerprint: original.dedup_fingerprint, dedup_fingerprint_version: 1, is_transfer: false, transfer_source: null, transfer_peer_id: null };
  return { original, native, nativeBatches: [{ id: 2, account_id: 7, status: "awaiting_review", custom_config: native.custom_config }],
    context: { ledger: [ledger], sources: [original], batches: [{ id: 1, account_id: 7, status: "complete", custom_config: original.custom_config }], receipts: [] } };
}
