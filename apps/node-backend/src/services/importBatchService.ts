/** Import-batch service — repository access plus review view-model assembly. */
import { getPreviewRows } from "../repositories/importBatchRepository.ts";

export {
  listBatches,
  getBatch,
  rollbackBatch,
  overrideRecipient,
  overrideCategory,
  categoryExists,
} from "../repositories/importBatchRepository.ts";

/**
 * A row as selected by `getPreviewRows` (import_staging_rows joined with the
 * effective recipient, its default category, the override category and the
 * matched pattern).
 */
type ImportPreviewRow = {
  /** BIGSERIAL — string. */
  id: string;
  row_index: number;
  recipient_raw: string | null;
  /** NUMERIC — string. */
  amount: string | null;
  currency: string | null;
  tx_date: string | null;
  memo: string | null;
  bank_account: string | null;
  match_source: string | null;
  match_similarity: number | null;
  matched_pattern_id: number | null;
  resolved_recipient_id: number | null;
  user_override_recipient_id: number | null;
  override_category_id: number | null;
  effective_recipient_id: number | null;
  recipient_name: string | null;
  recipient_default_category_id: number | null;
  recipient_default_category_general: string | null;
  recipient_default_category_detail: string | null;
  recipient_default_category_path: string | null;
  override_category_general: string | null;
  override_category_detail: string | null;
  override_category_path: string | null;
  matched_pattern_text: string | null;
  matched_pattern_kind: string | null;
};

type ImportPreviewGroupRow = Pick<
  ImportPreviewRow,
  | "id"
  | "row_index"
  | "recipient_raw"
  | "amount"
  | "currency"
  | "tx_date"
  | "memo"
  | "bank_account"
  | "match_source"
  | "match_similarity"
  | "matched_pattern_id"
  | "user_override_recipient_id"
  | "override_category_id"
>;

export interface ImportPreviewGroup {
  recipient_id: number | null;
  recipient_name: string | null;
  recipient_default_category_id: number | null;
  recipient_default_category_label: string | null;
  override_category_id: number | null;
  current_category_id: number | null;
  current_category_label: string | null;
  matched_pattern_id: number | null;
  matched_pattern_text: string | null;
  matched_pattern_kind: string | null;
  rows: ImportPreviewGroupRow[];
}

function formatCategoryLabel(
  general?: string | null,
  detail?: string | null,
): string | null {
  if (!general && !detail) return null;
  return [general, detail].filter(Boolean).join(": ");
}

/**
 * Build the transaction-import preview consumed by the review page.
 */
function buildImportBatchPreview(rows: ImportPreviewRow[]) {
  const groupMap = new Map<string | number, ImportPreviewGroup>();
  for (const row of rows) {
    const key = row.effective_recipient_id ?? "__unresolved__";
    let group = groupMap.get(key);
    if (!group) {
      const defaultLabel =
        row.recipient_default_category_path ??
        formatCategoryLabel(
          row.recipient_default_category_general,
          row.recipient_default_category_detail,
        );
      const overrideLabel =
        row.override_category_path ??
        formatCategoryLabel(
          row.override_category_general,
          row.override_category_detail,
        );
      group = {
        recipient_id: row.effective_recipient_id,
        recipient_name: row.recipient_name,
        recipient_default_category_id:
          row.recipient_default_category_id ?? null,
        recipient_default_category_label: defaultLabel,
        override_category_id: row.override_category_id ?? null,
        current_category_id:
          row.override_category_id ?? row.recipient_default_category_id ?? null,
        current_category_label: overrideLabel ?? defaultLabel ?? null,
        matched_pattern_id: row.matched_pattern_id,
        matched_pattern_text: row.matched_pattern_text,
        matched_pattern_kind: row.matched_pattern_kind,
        rows: [],
      };
      groupMap.set(key, group);
    }
    group.rows.push({
      id: row.id,
      row_index: row.row_index,
      recipient_raw: row.recipient_raw,
      amount: row.amount,
      currency: row.currency,
      tx_date: row.tx_date,
      memo: row.memo,
      bank_account: row.bank_account ?? null,
      match_source: row.match_source,
      match_similarity: row.match_similarity,
      matched_pattern_id: row.matched_pattern_id,
      user_override_recipient_id: row.user_override_recipient_id,
      override_category_id: row.override_category_id ?? null,
    });
  }

  const groups = [...groupMap.values()].map((group) => ({
    ...group,
    row_count: group.rows.length,
  }));
  const totals: Record<string, number> = {
    exact: 0,
    fuzzy: 0,
    pattern: 0,
    new: 0,
    unresolved: 0,
  };
  for (const row of rows) {
    const source = row.match_source ?? "unresolved";
    totals[source] = (totals[source] || 0) + 1;
  }
  return { groups, totals };
}

export async function getImportBatchPreview(batchId: number) {
  return buildImportBatchPreview(
    (await getPreviewRows(batchId)) as ImportPreviewRow[],
  );
}
