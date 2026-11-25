import Foundation
import VisionNativeCore

/// `bulkSelection.ts`: the `{ ids } | { filter }` selector of the bulk routes — the dual-shape
/// filter normalization (camelCase and snake_case are one field; both at once is rejected),
/// the unknown-key rejection, the unset convention (absent, `null` and `""` all mean "no
/// filter"), the id and row caps, and the `expected_count` semantics of filter mode.
enum BulkSelection {
    static let idCap = 500
    static let filterCap = 5000

    /// `EXPORT_JOINS_SQL` of `transactionJoins.ts` — the list endpoint's own join shape, which
    /// the uncategorised predicate's `r`/`pr` joins require.
    static let exportJoins = """
        FROM transactions t
        LEFT JOIN recipients r ON t.recipient_id = r.id
        LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
        LEFT JOIN categories c ON t.category_id = c.id
        LEFT JOIN categories rc ON r.default_category_id = rc.id
        LEFT JOIN categories pc ON pr.default_category_id = pc.id
        LEFT JOIN accounts acct ON t.account_id = acct.id
        """

    /// The uncategorised queue predicate (`getUncategorisedWithCount`).
    static let uncategorisedClause =
        "COALESCE(t.category_id, r.default_category_id, pr.default_category_id) IS NULL"

    /// `isUnset`: absent, JSON `null` (a frontend `NaN` id) and `""` all mean "no filter".
    static func isUnset(_ value: JSValue?) -> Bool {
        guard let value else { return true }
        return value == .null || value == .string("")
    }

    static func optionalString(_ value: JSValue?, _ field: String) throws -> String? {
        if isUnset(value) { return nil }
        guard case .string(let text)? = value else {
            throw BackendHTTPError.validation("\(field) must be a string")
        }
        return text
    }

    static func optionalYmd(_ value: JSValue?, _ field: String) throws -> String? {
        if isUnset(value) { return nil }
        guard case .string(let text)? = value else {
            throw BackendHTTPError.validation("\(field) must be a string")
        }
        var issues: [String] = []
        _ = TransactionsArea.ymd(.string(text), field, &issues)
        if let issue = issues.first { throw BackendHTTPError.validation(issue) }
        return text
    }

    static func optionalBoolean(_ value: JSValue?, _ field: String, fallback: Bool) throws -> Bool {
        if isUnset(value) { return fallback }
        if case .bool(let flag)? = value { return flag }
        if case .string("true")? = value { return true }
        if case .string("false")? = value { return false }
        throw BackendHTTPError.validation("\(field) must be a boolean")
    }

    static func optionalAmount(_ value: JSValue?, _ field: String) throws -> Double? {
        if isUnset(value) { return nil }
        switch value {
        case .number?, .string?: break
        default: throw BackendHTTPError.validation("\(field) must be a number")
        }
        let number = value?.javaScriptNumber ?? .nan
        guard number.isFinite else {
            throw BackendHTTPError.validation("\(field) must be a finite number")
        }
        return number
    }

    static func optionalIdArray(_ value: JSValue?, _ field: String) throws -> [Int]? {
        guard let value, value != .null else { return nil }
        guard case .array(let items) = value else {
            throw BackendHTTPError.validation("\(field) must be an array of positive integers")
        }
        if items.isEmpty { return nil }
        var ids: [Int] = []
        for item in items {
            guard let id = TransactionsArea.validId(item) else {
                throw BackendHTTPError.validation(
                    "\(field) contains invalid value: \(AccountsArea.looseText(item))")
            }
            ids.append(id)
        }
        return ids
    }

    static func optionalStringArray(_ value: JSValue?, _ field: String) throws -> [String]? {
        guard let value, value != .null else { return nil }
        guard case .array(let items) = value else {
            throw BackendHTTPError.validation("\(field) must be an array of strings")
        }
        if items.isEmpty { return nil }
        return try items.map { item in
            guard case .string(let text)? = item,
                !JavaScriptWhitespace.trim(text).isEmpty
            else {
                throw BackendHTTPError.validation(
                    "\(field) contains invalid value: \(AccountsArea.looseText(item))")
            }
            return JavaScriptWhitespace.trim(text)
        }
    }

    /// Tag slugs accept an array or the comma-separated query-string spelling, with every
    /// element trimmed and lowercased; an element that trims to nothing is rejected.
    static func optionalTagSlugs(_ value: JSValue?, _ field: String) throws -> [String]? {
        if isUnset(value) { return nil }
        let list: [String]
        if case .array(let items)? = value {
            list = items.map { $0.javaScriptString }
        } else if case .string(let text)? = value {
            list = text.split(separator: ",").map {
                JavaScriptWhitespace.trim(String($0)).lowercased()
            }
        } else {
            throw BackendHTTPError.validation(
                "\(field) must be an array of strings or a comma-separated string")
        }
        if list.isEmpty { return nil }
        return try list.map { entry in
            guard !JavaScriptWhitespace.trim(entry).isEmpty else {
                throw BackendHTTPError.validation(
                    "\(field) contains invalid value: \"\(entry)\"")
            }
            return entry
        }
    }

    static func parseTransactionType(_ value: JSValue?) throws -> String? {
        if isUnset(value) { return nil }
        if value == .string("income") { return "income" }
        if value == .string("expense") { return "expense" }
        throw BackendHTTPError.validation("transaction_type must be 'income' or 'expense'")
    }

    /// One field under either spelling; both at once is rejected rather than resolved by
    /// precedence.
    static func pick(_ filter: JSObject, _ camel: String, _ snake: String) throws -> JSValue? {
        if camel == snake { return filter[camel] }
        if let left = filter[camel], left != .null, let right = filter[snake], right != .null {
            throw BackendHTTPError.validation("Provide either `\(camel)` or `\(snake)`, not both")
        }
        if let left = filter[camel], left != .null { return left }
        return filter[snake]
    }

    static func optionalId(_ value: JSValue?, _ field: String) throws -> Int? {
        if isUnset(value) { return nil }
        guard let id = TransactionsArea.validId(value) else {
            throw BackendHTTPError.validation("\(field) must be a positive integer")
        }
        return id
    }

    /// `normalizeBulkFilter`: every field validated, unknown keys rejected, and the
    /// uncategorised override that clears the category filters and forces the active queue.
    static func normalize(_ filter: JSObject) throws -> (where: TransactionWhere, uncategorised: Bool) {
        let known: Set<String> = [
            "transactionId", "transaction_id", "startDate", "start_date", "endDate", "end_date",
            "accountId", "account_id", "bankAccount", "bank_account", "bankAccounts",
            "bank_accounts", "categoryId", "category_id", "categoryIds", "category_ids",
            "recipientId", "recipient_id", "recipientGroupId", "recipient_group_id",
            "recipientName", "recipient_name", "search", "active", "transaction_type",
            "amountMin", "amount_min", "amountMax", "amount_max", "amountSigned",
            "amount_signed", "tagSlugs", "tags", "uncategorised",
        ]
        let unknown = filter.entries.map { $0.0 }.filter { !known.contains($0) }
        if !unknown.isEmpty {
            throw BackendHTTPError.validation(
                "`filter` contains unknown field(s): \(unknown.joined(separator: ", "))")
        }

        let amountSigned = try optionalBoolean(
            try pick(filter, "amountSigned", "amount_signed"), "amount_signed", fallback: false)
        let uncategorised = try optionalBoolean(
            try pick(filter, "uncategorised", "uncategorised"), "uncategorised", fallback: false)

        var filters = TransactionWhere()
        filters.transactionId = try optionalId(
            try pick(filter, "transactionId", "transaction_id"), "transaction_id"
        ).map { TransactionID(rawValue: $0) }
        filters.startDate = try optionalYmd(
            try pick(filter, "startDate", "start_date"), "start_date")
        filters.endDate = try optionalYmd(try pick(filter, "endDate", "end_date"), "end_date")
        filters.accountId = try optionalId(
            try pick(filter, "accountId", "account_id"), "account_id"
        ).map { AccountID(rawValue: $0) }
        filters.bankAccount = try optionalString(
            try pick(filter, "bankAccount", "bank_account"), "bank_account")
        filters.bankAccounts = try optionalStringArray(
            try pick(filter, "bankAccounts", "bank_accounts"), "bank_accounts")
        filters.categoryId = try optionalId(
            try pick(filter, "categoryId", "category_id"), "category_id"
        ).map { CategoryID(rawValue: $0) }
        filters.categoryIds = try optionalIdArray(
            try pick(filter, "categoryIds", "category_ids"), "category_ids")
        filters.recipientId = try optionalId(
            try pick(filter, "recipientId", "recipient_id"), "recipient_id"
        ).map { RecipientID(rawValue: $0) }
        filters.recipientGroupId = try optionalId(
            try pick(filter, "recipientGroupId", "recipient_group_id"), "recipient_group_id"
        ).map { RecipientID(rawValue: $0) }
        filters.recipientName = try optionalString(
            try pick(filter, "recipientName", "recipient_name"), "recipient_name")
        let search = try optionalString(try pick(filter, "search", "search"), "search")
        if let search, search.count > 200 {
            throw BackendHTTPError.validation("search must be at most 200 characters")
        }
        filters.search = search
        filters.active = try optionalBoolean(
            try pick(filter, "active", "active"), "active", fallback: true)
        filters.transactionType = try parseTransactionType(
            try pick(filter, "transactionType", "transaction_type"))
        filters.amountMin = parseAmountFilter(
            try optionalAmount(try pick(filter, "amountMin", "amount_min"), "amount_min"),
            signed: amountSigned)
        filters.amountMax = parseAmountFilter(
            try optionalAmount(try pick(filter, "amountMax", "amount_max"), "amount_max"),
            signed: amountSigned)
        filters.amountSigned = amountSigned
        filters.tagSlugs = try optionalTagSlugs(try pick(filter, "tagSlugs", "tags"), "tags")

        if !uncategorised { return (filters, false) }
        filters.categoryId = nil
        filters.categoryIds = nil
        filters.active = true
        return (filters, true)
    }

    /// `validateBulkSelection` + `resolveBulkSelection`: the concrete ids the action targets.
    /// `filter` rides as the raw body value so a non-object filter reads exactly as the
    /// TypeScript's `hasFilter` guard does.
    static func resolve(
        _ session: BackendSession, ids: JSValue?, filter: JSValue?,
        allowEmpty: Bool
    ) throws -> [Int] {
        var idItems: [JSValue] = []
        if case .array(let items)? = ids, !items.isEmpty { idItems = items }
        var filterObject: JSObject?
        if case .object(let entries)? = filter, !entries.isEmpty { filterObject = entries }
        let hasFilter = filterObject != nil

        if !idItems.isEmpty && hasFilter {
            throw BackendHTTPError.validation("Provide either `ids` or `filter`, not both")
        }
        if idItems.isEmpty && !hasFilter {
            throw BackendHTTPError.validation("Either `ids` or `filter` must be provided")
        }

        // ids mode: strict elements, no `Number()` coercion of the whole array.
        if !idItems.isEmpty {
            if idItems.count > idCap {
                throw BackendHTTPError.validation(
                    "`ids` must contain at most \(idCap) entries (received \(idItems.count))")
            }
            var resolved: [Int] = []
            for item in idItems {
                guard let id = TransactionsArea.validId(item) else {
                    throw BackendHTTPError.validation(
                        "ids contains invalid value: \(AccountsArea.looseText(item))")
                }
                resolved.append(id)
            }
            return resolved
        }

        if filter != nil, filter != .null, filterObject == nil {
            throw BackendHTTPError.validation("`filter` must be an object")
        }
        let (filters, uncategorised) = try normalize(filterObject ?? JSObject())
        let clause = filters.clause
        let sql = uncategorised ? "\(clause.sql) AND \(uncategorisedClause)" : clause.sql
        let countRows = try session.rows(
            "SELECT COUNT(*) AS n \(exportJoins) WHERE \(sql)", clause.arguments)
        let matched = Int(try countRows[0].int64("n"))
        if matched == 0 && !allowEmpty {
            throw BackendHTTPError.validation("Filter matches no transactions")
        }
        if matched > filterCap {
            throw BackendHTTPError.validation(
                "Filter matches \(matched) transactions; cap is \(filterCap)")
        }
        return try session.rows(
            "SELECT t.id \(exportJoins) WHERE \(sql) ORDER BY t.id", clause.arguments
        ).map { try $0.integerId("id") }
    }

    /// `parseBulkExpectedCount` of the route: only valid with `filter`, and in filter mode a
    /// positive integer up to the row cap.
    static func expectedCount(_ value: JSValue?, filter: JSValue?) throws -> Int? {
        if filter == nil || filter == .null {
            if value != nil {
                throw BackendHTTPError.validation("`expected_count` is only valid with `filter`")
            }
            return nil
        }
        let count = value?.javaScriptNumber ?? .nan
        guard count.isFinite, count == count.rounded(), count >= 1, count <= 5000 else {
            throw BackendHTTPError.validation(
                "`expected_count` must be an integer between 1 and 5000 in filter mode")
        }
        return Int(count)
    }
}
