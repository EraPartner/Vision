/** Import-batch service — repository access plus review view-model assembly. */
import { getPreviewRows } from '../repositories/importBatchRepository.js';

export {
  listBatches,
  getBatch,
  rollbackBatch,
  overrideRecipient,
  overrideCategory,
  categoryExists,
} from '../repositories/importBatchRepository.js';

/** @param {string|null} [general] @param {string|null} [detail] */
function formatCategoryLabel(general, detail) {
  if (!general && !detail) return null;
  return [general, detail].filter(Boolean).join(': ');
}

/**
 * Build the transaction-import preview consumed by the review page.
 * @param {any[]} rows
 */
function buildImportBatchPreview(rows) {
  /** @type {Map<string|number, any>} */
  const groupMap = new Map();
  for (const row of rows) {
    const key = row.effective_recipient_id ?? '__unresolved__';
    if (!groupMap.has(key)) {
      const defaultLabel = formatCategoryLabel(
        row.recipient_default_category_general,
        row.recipient_default_category_detail,
      );
      const overrideLabel = formatCategoryLabel(
        row.override_category_general,
        row.override_category_detail,
      );
      groupMap.set(key, {
        recipient_id: row.effective_recipient_id,
        recipient_name: row.recipient_name,
        recipient_default_category_id: row.recipient_default_category_id ?? null,
        recipient_default_category_label: defaultLabel,
        override_category_id: row.override_category_id ?? null,
        current_category_id: row.override_category_id ?? row.recipient_default_category_id ?? null,
        current_category_label: overrideLabel ?? defaultLabel ?? null,
        matched_pattern_id: row.matched_pattern_id,
        matched_pattern_text: row.matched_pattern_text,
        matched_pattern_kind: row.matched_pattern_kind,
        rows: [],
      });
    }
    groupMap.get(key).rows.push({
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
  /** @type {Record<string, number>} */
  const totals = { exact: 0, fuzzy: 0, pattern: 0, new: 0, unresolved: 0 };
  for (const row of rows) {
    const source = row.match_source ?? 'unresolved';
    totals[source] = (totals[source] || 0) + 1;
  }
  return { groups, totals };
}

/** @param {number} batchId */
export async function getImportBatchPreview(batchId) {
  return buildImportBatchPreview(await getPreviewRows(batchId));
}
