import { queryOne, queryRows } from "../database/rowContracts.ts";
import {
  computedAtRowSchema,
  existsRowSchema,
  insightDigestStateRowSchema,
  insightDismissalListRowSchema,
  insightOutlierDismissalRowSchema,
  insightSubscriptionDismissalRowSchema,
} from "../database/rows/info.ts";
import type {
  InsightDigestStateRow,
  InsightDismissalRow,
} from "../database/rows/info.ts";

export type { InsightDigestStateRow, InsightDismissalRow };

export async function listDismissals(): Promise<
  Omit<InsightDismissalRow, "id">[]
> {
  return queryRows(
    insightDismissalListRowSchema,
    `SELECT kind, recipient_id, category_id,
            to_char(month_start, 'YYYY-MM') AS month_key,
            dismissed_at, deviation_at_dismiss
       FROM insight_dismissals
      ORDER BY id`,
  );
}

export async function recipientExists(recipientId: number): Promise<boolean> {
  const row = await queryOne(
    existsRowSchema,
    "SELECT EXISTS (SELECT 1 FROM recipients WHERE id = $1) AS exists",
    [recipientId],
  );
  return row?.exists === true;
}

export async function upsertSubscription(
  kind: string,
  recipientId: number,
): Promise<
  | Pick<InsightDismissalRow, "id" | "kind" | "recipient_id" | "dismissed_at">
  | undefined
> {
  return queryOne(
    insightSubscriptionDismissalRowSchema,
    `INSERT INTO insight_dismissals (kind, recipient_id)
     VALUES ($1, $2)
     ON CONFLICT (kind, recipient_id)
       WHERE kind IN ('subscription_new', 'subscription_price_change')
     DO UPDATE SET dismissed_at = insight_dismissals.dismissed_at
     RETURNING id, kind, recipient_id, dismissed_at`,
    [kind, recipientId],
  );
}

type OutlierDismissalRow = Omit<InsightDismissalRow, "recipient_id">;

/** @param monthKey YYYY-MM */
export async function upsertOutlier(
  categoryId: number,
  monthKey: string,
  deviation: number,
): Promise<OutlierDismissalRow | undefined> {
  return queryOne(
    insightOutlierDismissalRowSchema,
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
}

export async function getCountState(): Promise<
  InsightDigestStateRow | undefined
> {
  return queryOne(
    insightDigestStateRowSchema,
    `SELECT undismissed_count, dirty_version, computed_version,
            computed_at, expires_at
       FROM insight_digest_state WHERE singleton_id = 1`,
  );
}

export async function saveCountIfVersion(
  count: number,
  version: number,
): Promise<{ computed_at: Date } | undefined> {
  return queryOne(
    computedAtRowSchema,
    `UPDATE insight_digest_state
        SET undismissed_count = $1,
            computed_version = $2,
            computed_at = NOW(),
            expires_at = NOW() + INTERVAL '3 minutes'
      WHERE singleton_id = 1 AND dirty_version = $2
      RETURNING computed_at`,
    [count, version],
  );
}

export default {
  listDismissals,
  recipientExists,
  upsertSubscription,
  upsertOutlier,
  getCountState,
  saveCountIfVersion,
};
