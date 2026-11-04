import { sql } from "kysely";
import { asCurrencyCode } from "@vision/types/brands";
import { checkedRow, db } from "../database/db.ts";
import { decimalText } from "../database/columnTypes.ts";
import { withTransaction } from "../database/connection.ts";
import { cashProjectionRowSchema } from "../database/rows/info.ts";

const monthStart = (month: string) => sql<Date>`ts_date(${month} || '-01')`;

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
  const code = asCurrencyCode(currency);
  // One write transaction: the upsert, then the retention prune of months
  // before the start of the month two months ago. PostgreSQL ran both as one
  // statement (a data-modifying CTE), whose DELETE could not see the row the
  // upsert had just written, so the saved row always survived even when its
  // own month is past the cutoff; the prune excludes it explicitly to keep that.
  await withTransaction(async () => {
    await db
      .insertInto("insight_cash_projections")
      .values({
        month_start: monthStart(month),
        currency: code,
        method_id: methodId,
        month_end_net_cashflow: decimalText(value),
      })
      .onConflict((oc) =>
        oc.columns(["month_start", "currency", "method_id"]).doUpdateSet({
          month_end_net_cashflow: (eb) =>
            eb.ref("excluded.month_end_net_cashflow"),
          observed_at: sql<Date>`now()`,
        }),
      )
      .execute();
    await db
      .deleteFrom("insight_cash_projections")
      .where(
        "month_start",
        "<",
        sql<Date>`add_months(date_trunc('month', today()), -2)`,
      )
      .where((eb) =>
        eb.not(
          eb.and([
            eb("month_start", "=", monthStart(month)),
            eb("currency", "=", code),
            eb("method_id", "=", methodId),
          ]),
        ),
      )
      .execute();
  });
}

export default { getProjection, saveProjection };
