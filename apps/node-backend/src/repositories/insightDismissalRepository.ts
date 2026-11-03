import { sql } from "kysely";
import { asCategoryId, asRecipientId } from "@vision/types/brands";
import { checkedRow, checkedRows, db } from "../database/db.ts";
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

/**
 * A column alias with a driver type hint for an expression column (ADR-263):
 * the driver reads the value as that type and drops the hint from the row key.
 */
function hinted<N extends string>(name: N, hint: "bool"): N {
  return `${name}::${hint}` as N;
}

const monthKey = sql<string | null>`to_char(month_start, 'YYYY-MM')`.as(
  "month_key",
);

export async function listDismissals(): Promise<
  Omit<InsightDismissalRow, "id">[]
> {
  return checkedRows(
    insightDismissalListRowSchema,
    db
      .selectFrom("insight_dismissals")
      .select([
        "kind",
        "recipient_id",
        "category_id",
        monthKey,
        "dismissed_at",
        "deviation_at_dismiss",
      ])
      .orderBy("id"),
  );
}

export async function recipientExists(recipientId: number): Promise<boolean> {
  const row = await checkedRow(
    existsRowSchema,
    db.selectNoFrom((eb) =>
      eb
        .exists(
          eb
            .selectFrom("recipients")
            .select(sql<number>`1`.as("one"))
            .where("id", "=", asRecipientId(recipientId)),
        )
        // EXISTS yields 0/1 in SQLite: read it back as a boolean.
        .as(hinted("exists", "bool")),
    ),
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
  return checkedRow(
    insightSubscriptionDismissalRowSchema,
    db
      .insertInto("insight_dismissals")
      .values({ kind, recipient_id: asRecipientId(recipientId) })
      .onConflict((oc) =>
        oc
          .columns(["kind", "recipient_id"])
          // Literal predicate matching the partial unique index's WHERE, so the
          // conflict target resolves to uq_insight_dismissals_subscription.
          .where(sql<boolean>`kind IN ('subscription_new', 'subscription_price_change')`)
          .doUpdateSet({
            dismissed_at: (eb) => eb.ref("insight_dismissals.dismissed_at"),
          }),
      )
      .returning(["id", "kind", "recipient_id", "dismissed_at"]),
  );
}

type OutlierDismissalRow = Omit<InsightDismissalRow, "recipient_id">;

/** @param month YYYY-MM */
export async function upsertOutlier(
  categoryId: number,
  month: string,
  deviation: number,
): Promise<OutlierDismissalRow | undefined> {
  return checkedRow(
    insightOutlierDismissalRowSchema,
    db
      .insertInto("insight_dismissals")
      .values({
        kind: "category_outlier",
        category_id: asCategoryId(categoryId),
        month_start: sql<Date>`ts_date(${month} || '-01')`,
        deviation_at_dismiss: deviation,
      })
      .onConflict((oc) =>
        oc
          .columns(["category_id", "month_start"])
          .where(sql<boolean>`kind = 'category_outlier'`)
          .doUpdateSet({
            dismissed_at: sql<Date>`now()`,
            deviation_at_dismiss: (eb) => eb.ref("excluded.deviation_at_dismiss"),
          }),
      )
      .returning([
        "id",
        "kind",
        "category_id",
        monthKey,
        "dismissed_at",
        "deviation_at_dismiss",
      ]),
  );
}

export async function getCountState(): Promise<
  InsightDigestStateRow | undefined
> {
  return checkedRow(
    insightDigestStateRowSchema,
    db
      .selectFrom("insight_digest_state")
      .select([
        "undismissed_count",
        "dirty_version",
        "computed_version",
        "computed_at",
        "expires_at",
      ])
      .where("singleton_id", "=", 1),
  );
}

export async function saveCountIfVersion(
  count: number,
  version: number,
): Promise<{ computed_at: Date } | undefined> {
  return checkedRow(
    computedAtRowSchema,
    db
      .updateTable("insight_digest_state")
      .set({
        undismissed_count: count,
        computed_version: version,
        computed_at: sql<Date>`now()`,
        expires_at: sql<Date>`add_interval(now(), '3 minutes')`,
      })
      .where("singleton_id", "=", 1)
      .where("dirty_version", "=", String(version))
      .returning("computed_at"),
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
