/**
 * Shared FROM + JOIN block for transaction list/export queries. `transactionExport`
 * and `bulkSelection` run against the exact same join shape.
 */
import { sql } from "kysely";

export const EXPORT_JOINS_SQL = sql`
    FROM transactions t
    LEFT JOIN recipients r ON t.recipient_id = r.id
    LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
    LEFT JOIN categories c ON t.category_id = c.id
    LEFT JOIN categories rc ON r.default_category_id = rc.id
    LEFT JOIN categories pc ON pr.default_category_id = pc.id
    LEFT JOIN accounts acct ON t.account_id = acct.id`;
