import Foundation
import VisionNativeCore

/// `buildTransactionWhere` of `lib/filterBuilder.ts`: the canonical transaction predicate over
/// `transactions t` joined with `recipients r`. Values bind in the order the clauses appear.
struct TransactionWhere: Sendable {
    var transactionId: TransactionID?
    var startDate: String?
    var endDate: String?
    var accountId: AccountID?
    var accountIds: [Int]?
    var bankAccount: String?
    var bankAccounts: [String]?
    var categoryId: CategoryID?
    var categoryIds: [Int]?
    var recipientId: RecipientID?
    var recipientGroupId: RecipientID?
    var recipientName: String?
    var search: String?
    var active = true
    var transactionType: String?
    var amountMin: Double?
    var amountMax: Double?
    var amountSigned = false
    var tagSlugs: [String]?

    /// `MAX_LIST_SIZE`.
    static let maxListSize = 50
    /// `MIN_SEARCH_LENGTH`.
    static let minSearchLength = 2

    struct Clause: Sendable {
        let sql: String
        let arguments: [SQLValue]
    }

    /// `effectiveCategoryIn`: own category, else the recipient's default, else the primary's.
    private static func effectiveCategoryIn(_ descendants: String, _ arguments: [SQLValue]) -> Clause {
        Clause(
            sql: """
                (
                      t.category_id IN \(descendants)
                      OR (t.category_id IS NULL AND t.recipient_id IN (SELECT id FROM recipients WHERE default_category_id IN \(descendants)))
                      OR (t.category_id IS NULL AND t.recipient_id IN (
                        SELECT r2.id FROM recipients r2
                        JOIN recipients pr2 ON r2.primary_recipient_id = pr2.id
                        WHERE r2.default_category_id IS NULL AND pr2.default_category_id IN \(descendants)
                      ))
                    )
                """,
            arguments: arguments + arguments + arguments)
    }

    private static func placeholders(_ count: Int) -> String {
        Array(repeating: "?", count: count).joined(separator: ", ")
    }

    /// `list.slice(0, 50).map(trim).filter(Boolean)`.
    private static func trimmedList(_ values: [String]) -> [String] {
        values.prefix(maxListSize).map(JavaScriptWhitespace.trim).filter { !$0.isEmpty }
    }

    var clause: Clause {
        var clauses = ["1=1"]
        var arguments: [SQLValue] = []
        func add(_ sql: String, _ values: [SQLValue] = []) {
            clauses.append(sql)
            arguments += values
        }
        if active { add("t.is_active = 1") }
        if let transactionId { add("t.id = ?", [transactionId.sqlValue]) }
        if let startDate, !startDate.isEmpty { add("t.date >= ?", [.text(startDate)]) }
        if let endDate, !endDate.isEmpty { add("t.date <= ?", [.text(endDate)]) }
        if let accountId {
            add("t.account_id = ?", [accountId.sqlValue])
        } else if let accountIds, !accountIds.isEmpty {
            add("t.account_id IN (\(Self.placeholders(accountIds.count)))", accountIds.map { .integer(Int64($0)) })
        }
        if let bankAccount, !bankAccount.isEmpty {
            add(
                "t.account_id IN (SELECT fa.id FROM accounts fa WHERE ilike(fa.name, ?))", [.text("%\(bankAccount)%")])
        } else if let bankAccounts, !bankAccounts.isEmpty {
            let safe = Self.trimmedList(bankAccounts)
            if !safe.isEmpty {
                add(
                    "t.account_id IN (SELECT fa.id FROM accounts fa WHERE fa.name IN (\(Self.placeholders(safe.count))))",
                    safe.map(SQLValue.text))
            }
        }
        if let categoryId {
            let clause = Self.effectiveCategoryIn(
                "(SELECT category_id FROM category_ancestors WHERE ancestor_id = ?)", [categoryId.sqlValue])
            add(clause.sql, clause.arguments)
        } else if let categoryIds, !categoryIds.isEmpty {
            let clause = Self.effectiveCategoryIn(
                "(SELECT category_id FROM category_ancestors WHERE ancestor_id IN (\(Self.placeholders(categoryIds.count))))",
                categoryIds.map { .integer(Int64($0)) })
            add(clause.sql, clause.arguments)
        }
        if transactionType == "income" {
            add("dec_sign(t.amount) > 0")
        } else if transactionType == "expense" {
            add("dec_sign(t.amount) < 0")
        }
        let amountColumn = amountSigned ? "t.amount" : "dec_abs(t.amount)"
        if let amountMin, amountMin.isFinite {
            add("dec_ge(\(amountColumn), ?)", [.text(SQLArguments.javaScriptText(amountMin))])
        }
        if let amountMax, amountMax.isFinite {
            add("dec_le(\(amountColumn), ?)", [.text(SQLArguments.javaScriptText(amountMax))])
        }
        if let recipientId {
            add(
                "t.recipient_id IN (SELECT id FROM recipients WHERE id = ? OR primary_recipient_id = ?)",
                [recipientId.sqlValue, recipientId.sqlValue])
        }
        if let recipientGroupId {
            let group = recipientGroupId.sqlValue
            add(
                """
                t.recipient_id IN (
                      SELECT id FROM recipients
                      WHERE id = ?
                         OR primary_recipient_id = ?
                         OR id = (SELECT primary_recipient_id FROM recipients WHERE id = ? AND primary_recipient_id IS NOT NULL)
                         OR primary_recipient_id = (SELECT primary_recipient_id FROM recipients WHERE id = ? AND primary_recipient_id IS NOT NULL)
                    )
                """, [group, group, group, group])
        }
        if let recipientName, !recipientName.isEmpty { add("ilike(r.name, ?)", [.text("%\(recipientName)%")]) }
        let searchText = search ?? ""
        if JavaScriptWhitespace.trim(searchText).utf16.count >= Self.minSearchLength {
            let term = SQLValue.text("%\(searchText)%")
            let matchingCategories =
                "SELECT sc.id FROM categories sc WHERE ilike(sc.path_name, ?) OR ilike(sc.general, ?) OR ilike(sc.detail, ?)"
            var branches = [
                "SELECT st.id FROM transactions st WHERE ilike(st.memo, ?) OR ilike(st.comment, ?)",
                "SELECT st.id FROM transactions st WHERE st.account_id IN (SELECT sa.id FROM accounts sa WHERE ilike(sa.name, ?))",
                "SELECT st.id FROM transactions st WHERE ilike(st.currency, ?)",
            ]
            var terms = 4
            func only(_ text: String, _ allowed: Set<UInt8>) -> Bool {
                !text.isEmpty && text.utf8.allSatisfy { allowed.contains($0) }
            }
            let digits = Set(UInt8(ascii: "0")...UInt8(ascii: "9"))
            if only(searchText, digits.union([UInt8(ascii: "."), UInt8(ascii: "-")])) {
                branches.append("SELECT st.id FROM transactions st WHERE ilike(CAST(st.amount AS TEXT), ?)")
                terms += 1
            }
            if only(searchText, digits.union([UInt8(ascii: "-")])) {
                branches.append("SELECT st.id FROM transactions st WHERE ilike(CAST(st.date AS TEXT), ?)")
                terms += 1
            }
            branches += [
                """
                SELECT st.id FROM transactions st WHERE st.recipient_id IN (
                        SELECT sr.id FROM recipients sr WHERE ilike(sr.name, ?)
                        UNION
                        SELECT sr.id FROM recipients sr WHERE sr.primary_recipient_id IN (
                          SELECT srp.id FROM recipients srp WHERE ilike(srp.name, ?)
                        )
                      )
                """,
                "SELECT st.id FROM transactions st WHERE st.category_id IN (\(matchingCategories))",
                """
                SELECT st.id FROM transactions st WHERE st.recipient_id IN (
                        SELECT sr.id FROM recipients sr WHERE sr.default_category_id IN (\(matchingCategories))
                        UNION
                        SELECT sr.id FROM recipients sr WHERE sr.primary_recipient_id IN (
                          SELECT srp.id FROM recipients srp WHERE srp.default_category_id IN (\(matchingCategories))
                        )
                      )
                """,
                """
                SELECT tt.transaction_id FROM transaction_tags tt
                        JOIN tags tg ON tg.id = tt.tag_id
                        WHERE tg.is_active = 1 AND ilike(tg.slug, ?)
                """,
            ]
            terms += 2 + 3 + 6 + 1
            add("t.id IN (\(branches.joined(separator: " UNION ")))", Array(repeating: term, count: terms))
        }
        if let tagSlugs, !tagSlugs.isEmpty {
            let safe = Self.trimmedList(tagSlugs)
            if !safe.isEmpty {
                add(
                    """
                    EXISTS (
                            SELECT 1 FROM transaction_tags tt
                            JOIN tags tg ON tg.id = tt.tag_id
                            WHERE tt.transaction_id = t.id
                              AND tg.slug IN (SELECT value FROM json_each(?))
                              AND tg.is_active = 1
                          )
                    """, [.text(JSValue.array(safe.map(JSValue.string)).jsonText)])
            }
        }
        return Clause(sql: clauses.joined(separator: " AND "), arguments: arguments)
    }
}

/// `parseAmountFilter`: `Number(value)` compared on magnitude unless `signed`; nil for a
/// missing, empty or unparseable value.
func parseAmountFilter(_ value: JSValue?, signed: Bool) -> Double? {
    guard let value, value != .null, value != .string("") else { return nil }
    let number = value.javaScriptNumber
    guard number.isFinite else { return nil }
    return signed ? number : abs(number)
}
