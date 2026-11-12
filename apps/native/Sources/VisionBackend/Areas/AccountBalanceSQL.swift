import Foundation

/// `repositories/accountBalanceSql.ts` and `bankChronologySql.ts`: the anchor + delta balance of
/// an account, partitioned by transaction currency, as SQL text. `asOfDate` is the SQL of the
/// cut-off day (a bound `YYYY-MM-DD` parameter or `today()`).
enum AccountBalanceSQL {
    /// `bankChronologySql`: the bank's own sequence, else the row id after every sequence.
    static func chronology(_ alias: String) -> String {
        "dec_key(coalesce(\(alias).bank_sequence, dec_add('1000000000000000000000000000000', \(alias).id)))"
    }

    /// `newestFirst`: date, then bank chronology, then id, all descending.
    static func newestFirst(_ alias: String) -> String {
        "\(alias).date DESC, \(chronology(alias)) DESC, \(alias).id DESC"
    }

    /// `afterAnchor`: the row comes after the anchor in (date, chronology, id) order, or there
    /// is no anchor.
    static func afterAnchor(_ row: String, _ anchor: String) -> String {
        """
        (\(anchor).id IS NULL OR (\(row).date >= \(anchor).date
              AND (\(row).date, \(chronology(row)), \(row).id) > (\(anchor).date, \(chronology(anchor)), \(anchor).id)))
        """
    }

    /// `balanceProvenanceLateral`: per account, the latest stamped row up to `asOfDate`
    /// (`anchor_date`) and how many active rows follow it (`post_anchor_count`, as text).
    static func provenanceJoin(asOfDate: String) -> String {
        """
        LEFT JOIN (
          SELECT lb_anchor.lb_account_id,
                 to_char(lb_anc.date, 'YYYY-MM-DD') AS anchor_date,
                 CAST((
                   SELECT COUNT(*)
                   FROM transactions t2
                   WHERE t2.account_id = lb_anchor.lb_account_id AND t2.is_active = 1
                     AND t2.date <= \(asOfDate)
                     AND \(afterAnchor("t2", "lb_anc"))
                 ) AS TEXT) AS post_anchor_count
          FROM (
            SELECT lb_acc.id AS lb_account_id,
                   (SELECT t.id
                      FROM transactions t
                     WHERE t.account_id = lb_acc.id AND t.is_active = 1
                       AND t.date <= \(asOfDate)
                       AND t.balance IS NOT NULL
                     ORDER BY \(newestFirst("t"))
                     LIMIT 1) AS anchor_id
            FROM accounts lb_acc
          ) lb_anchor
          LEFT JOIN transactions lb_anc ON lb_anc.id = lb_anchor.anchor_id
        ) lb ON lb.lb_account_id = a.id
        """
    }

    /// `partitionBalancesSelect`: one row per (account, currency) with the partition's latest
    /// stamp plus the active amounts after it. `account` limits it to one account's SQL.
    static func partitionBalancesSelect(asOfDate: String, account: String? = nil) -> String {
        let accountFilter = account.map { "t.account_id = \($0)" } ?? "t.account_id IS NOT NULL"
        return """
            SELECT ccy.account_id, ccy.currency,
                   dec_add(COALESCE(anch.balance, '0'), (
                     SELECT COALESCE(dec_sum(t2.amount), '0')
                     FROM transactions t2
                     WHERE t2.account_id = ccy.account_id AND t2.is_active = 1
                       AND t2.date <= \(asOfDate)
                       AND t2.currency = ccy.currency
                       AND \(afterAnchor("t2", "anch"))
                   )) AS balance
            FROM (
              SELECT g.account_id, g.currency,
                     (SELECT t.id
                        FROM transactions t
                       WHERE t.account_id = g.account_id AND t.is_active = 1
                         AND t.date <= \(asOfDate)
                         AND t.balance IS NOT NULL
                         AND t.currency = g.currency
                       ORDER BY \(newestFirst("t"))
                       LIMIT 1) AS anchor_id
              FROM (
                SELECT t.account_id, COALESCE(t.currency, 'EUR') AS currency
                FROM transactions t
                WHERE \(accountFilter)
                  AND t.is_active = 1
                  AND t.date <= \(asOfDate)
                GROUP BY t.account_id, COALESCE(t.currency, 'EUR')
              ) g
            ) ccy
            LEFT JOIN transactions anch ON anch.id = ccy.anchor_id
            """
    }

    /// `computedBalanceByCurrencyAggLateral` with `balancePartsColumn`: per account a JSON array
    /// of `{ balance, currency }` partitions (balance as decimal text), or NULL without rows.
    static func balancePartsJoin(asOfDate: String) -> String {
        """
        LEFT JOIN (
          SELECT bp_acc.id AS bp_account_id,
                 (SELECT CASE WHEN COUNT(*) = 0 THEN NULL
                              ELSE json_group_array(json_object('balance', bp_part.balance, 'currency', bp_part.currency))
                         END
                    FROM (\(partitionBalancesSelect(asOfDate: asOfDate, account: "bp_acc.id"))
                          ORDER BY ccy.currency) bp_part) AS balance_parts
          FROM accounts bp_acc
        ) bp ON bp.bp_account_id = a.id
        """
    }
}
