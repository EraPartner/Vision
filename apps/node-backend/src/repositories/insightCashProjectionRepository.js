import { query } from "../database/connection.js";

export async function getProjection(month, currency, methodId) {
  const result = await query(
    `SELECT month_end_net_cashflow
       FROM insight_cash_projections
      WHERE month_start = ($1 || '-01')::date
        AND currency = $2 AND method_id = $3`,
    [month, currency, methodId],
  );
  const value = result.rows[0]?.month_end_net_cashflow;
  return value == null ? undefined : Number(value);
}

export async function saveProjection(month, currency, methodId, value) {
  await query(
    `WITH saved AS (
       INSERT INTO insight_cash_projections
         (month_start, currency, method_id, month_end_net_cashflow)
       VALUES (($1 || '-01')::date, $2, $3, $4)
       ON CONFLICT (month_start, currency, method_id)
       DO UPDATE SET month_end_net_cashflow = EXCLUDED.month_end_net_cashflow,
                     observed_at = NOW()
       RETURNING 1
     )
     DELETE FROM insight_cash_projections
      WHERE month_start < date_trunc('month', CURRENT_DATE) - INTERVAL '2 months'
        AND EXISTS (SELECT 1 FROM saved)`,
    [month, currency, methodId, value],
  );
}

export default { getProjection, saveProjection };
