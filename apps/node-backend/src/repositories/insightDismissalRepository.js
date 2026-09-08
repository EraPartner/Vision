import { query } from "../database/connection.js";

export async function listDismissals() {
  const result = await query(
    `SELECT kind, recipient_id, category_id,
            to_char(month_start, 'YYYY-MM') AS month_key,
            dismissed_at, deviation_at_dismiss
       FROM insight_dismissals
      ORDER BY id`,
  );
  return result.rows;
}

export async function recipientExists(recipientId) {
  const result = await query(
    "SELECT EXISTS (SELECT 1 FROM recipients WHERE id = $1) AS exists",
    [recipientId],
  );
  return result.rows[0]?.exists === true;
}

export async function upsertSubscription(kind, recipientId) {
  const result = await query(
    `INSERT INTO insight_dismissals (kind, recipient_id)
     VALUES ($1, $2)
     ON CONFLICT (kind, recipient_id)
       WHERE kind IN ('subscription_new', 'subscription_price_change')
     DO UPDATE SET dismissed_at = insight_dismissals.dismissed_at
     RETURNING id, kind, recipient_id, dismissed_at`,
    [kind, recipientId],
  );
  return result.rows[0];
}

export async function upsertOutlier(categoryId, monthKey, deviation) {
  const result = await query(
    `INSERT INTO insight_dismissals
       (kind, category_id, month_start, deviation_at_dismiss)
     VALUES ('category_outlier', $1, ($2 || '-01')::date, $3)
     ON CONFLICT (category_id, month_start)
       WHERE kind = 'category_outlier'
     DO UPDATE SET dismissed_at = NOW(),
                   deviation_at_dismiss = EXCLUDED.deviation_at_dismiss
     RETURNING id, kind, category_id,
               to_char(month_start, 'YYYY-MM') AS month_key,
               dismissed_at, deviation_at_dismiss`,
    [categoryId, monthKey, deviation],
  );
  return result.rows[0];
}

export async function getCountState() {
  const result = await query(
    `SELECT undismissed_count, dirty_version, computed_version,
            computed_at, expires_at
       FROM insight_digest_state WHERE singleton_id = 1`,
  );
  return result.rows[0];
}

export async function saveCountIfVersion(count, version) {
  const result = await query(
    `UPDATE insight_digest_state
        SET undismissed_count = $1,
            computed_version = $2,
            computed_at = NOW(),
            expires_at = NOW() + INTERVAL '3 minutes'
      WHERE singleton_id = 1 AND dirty_version = $2
      RETURNING computed_at`,
    [count, version],
  );
  return result.rows[0];
}

export default {
  listDismissals,
  recipientExists,
  upsertSubscription,
  upsertOutlier,
  getCountState,
  saveCountIfVersion,
};
