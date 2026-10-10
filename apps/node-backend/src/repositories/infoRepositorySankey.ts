import { queryRows } from "../database/rowContracts.ts";
import { sankeyAggregateRowSchema } from "../database/rows/info.ts";
import type { SankeyAggregateRow } from "../database/rows/info.ts";
import { buildExclusionClauses } from "../lib/filterBuilder.ts";
import { getIncludeTransfers } from "./infoRepositoryHelpers.ts";

export type { SankeyAggregateRow };

/**
 * Return Sankey-ready aggregates while preserving category identity.
 * NULL category ids remain NULL; display labels are not used as keys.
 */
export async function getSankeyAggregates({
  yearStart,
  yearEnd,
  excludedCategoryIds = [],
  excludedRecipientIds = [],
}: {
  yearStart: string;
  yearEnd: string;
  excludedCategoryIds?: number[];
  excludedRecipientIds?: number[];
}): Promise<SankeyAggregateRow[]> {
  const includeTransfers = await getIncludeTransfers();
  const params: unknown[] = [yearStart, yearEnd];
  const exclusions = buildExclusionClauses({
    excludedCategoryIds,
    excludedRecipientIds,
    startParamIdx: params.length + 1,
  });
  params.push(...exclusions.params);
  const exclusionWhere = exclusions.whereSql
    ? `AND ${exclusions.whereSql}`
    : "";

  return queryRows(
    sankeyAggregateRowSchema,
    `
    SELECT
      c.id AS category_id,
      CASE WHEN c.legacy_compatible
           THEN c.general || ': ' || c.detail
           ELSE c.path_name END AS category_name,
      t.currency,
      (t.amount > 0) AS is_income,
      SUM(ABS(t.amount)) AS amount
    FROM transactions t
    LEFT JOIN recipients r ON t.recipient_id = r.id
    LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
    LEFT JOIN categories c ON COALESCE(t.category_id, r.default_category_id, pr.default_category_id) = c.id
    WHERE t.is_active = true
      ${includeTransfers ? "" : "AND t.is_transfer = false"}
      AND t.date BETWEEN $1 AND $2
      ${exclusionWhere}
    GROUP BY c.id, t.currency, (t.amount > 0)
    `,
    params,
  );
}

export default { getSankeyAggregates };
