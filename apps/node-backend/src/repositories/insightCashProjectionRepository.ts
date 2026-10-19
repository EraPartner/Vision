import { sql } from "kysely";
import { asCurrencyCode } from "@vision/types/brands";
import { checkedRow, db } from "../database/db.ts";
import { cashProjectionRowSchema } from "../database/rows/info.ts";

const monthStart = (month: string) => sql<Date>`(${month} || '-01')::date`;

/** @param month YYYY-MM */
export async function getProjection(
  month: string,
  currency: string,
  methodId: string,
): Promise<number | undefined> {
  const row = await checkedRow(
    cashProjectionRowSchema,
    db
      .selectFrom("insight_cash_projections")
      .select("month_end_net_cashflow")
      .where("month_start", "=", monthStart(month))
      .where("currency", "=", asCurrencyCode(currency))
      .where("method_id", "=", methodId),
  );
  const value = row?.month_end_net_cashflow;
  return value == null ? undefined : Number(value);
}

async function saveProjection(
  month: string,
  currency: string,
  methodId: string,
  value: number,
): Promise<void> {
  await db
    .with("saved", (qb) =>
      qb
        .insertInto("insight_cash_projections")
        .values({
          month_start: monthStart(month),
          currency: asCurrencyCode(currency),
          method_id: methodId,
          month_end_net_cashflow: value,
        })
        .onConflict((oc) =>
          oc.columns(["month_start", "currency", "method_id"]).doUpdateSet({
            month_end_net_cashflow: (eb) =>
              eb.ref("excluded.month_end_net_cashflow"),
            observed_at: sql<Date>`NOW()`,
          }),
        )
        .returning(sql<number>`1`.as("saved")),
    )
    .deleteFrom("insight_cash_projections")
    .where(
      "month_start",
      "<",
      sql<Date>`date_trunc('month', CURRENT_DATE) - INTERVAL '2 months'`,
    )
    .where(({ exists, selectFrom }) =>
      exists(selectFrom("saved").select(sql<number>`1`.as("one"))),
    )
    .execute();
}

export default { getProjection, saveProjection };
