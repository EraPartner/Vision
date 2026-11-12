import Foundation
import VisionNativeCore

/// An enriched `transactions` row (`enrichedTransactionDbRowSchema`) with its tags, as
/// `formatTransaction` of `routes/transactions.ts` answers it.
struct TransactionRow: Sendable {
    struct Tag: Sendable {
        let id: Int
        let slug: String
        let color: String?
        let isActive: Bool

        var json: JSONValue {
            .object([
                "id": .int(id), "slug": .string(slug), "color": color.map(JSONValue.string) ?? .null,
                "is_active": .bool(isActive),
            ])
        }
    }

    let id: TransactionID
    let date: String
    let amount: String
    let currency: String?
    let balance: String?
    let memo: String?
    let comment: String?
    let bankAccount: String?
    let accountId: AccountID?
    let recipientId: RecipientID?
    let categoryId: CategoryID?
    let effectiveCategoryId: CategoryID?
    let isActive: Bool
    let isTransfer: Bool
    let transferPeerId: TransactionID?
    let transferSource: String?
    let createdAt: Instant?
    let updatedAt: Instant?
    let recipientName: String?
    let categoryName: String?
    let runningBalance: String?
    var tags: [Tag] = []
    /// `amount_eur` after `convertRowsToEur`; nil when the list did not normalize.
    var amountEur: Double?
    var amountEurUnconverted = false

    init(_ row: SQLRow) throws {
        func optionalInt(_ column: String) throws -> Int? {
            guard try row.optionalInt64(column) != nil else { return nil }
            return try row.integerId(column)
        }
        func optionalInstant(_ column: String) throws -> Instant? {
            guard try row.optionalText(column) != nil else { return nil }
            return try row.instant(column)
        }
        func has(_ column: String) -> Bool { row.columns.indexes[column] != nil }
        id = TransactionID(rawValue: try row.integerId("id"))
        date = try row.text("date")
        amount = try row.text("amount")
        currency = try row.optionalText("currency")
        balance = try row.optionalText("balance")
        memo = try row.optionalText("memo")
        comment = try row.optionalText("comment")
        bankAccount = try row.optionalText("bank_account")
        accountId = try optionalInt("account_id").map { AccountID(rawValue: $0) }
        recipientId = try optionalInt("recipient_id").map { RecipientID(rawValue: $0) }
        categoryId = try optionalInt("category_id").map { CategoryID(rawValue: $0) }
        if has("effective_category_id") {
            effectiveCategoryId = try optionalInt("effective_category_id").map { CategoryID(rawValue: $0) }
        } else {
            effectiveCategoryId = nil
        }
        isActive = try row.bool("is_active")
        isTransfer = try row.bool("is_transfer")
        transferPeerId = try optionalInt("transfer_peer_id").map { TransactionID(rawValue: $0) }
        transferSource = try row.optionalText("transfer_source")
        createdAt = try optionalInstant("created_at")
        updatedAt = try optionalInstant("updated_at")
        recipientName = try row.optionalText("recipient_name")
        categoryName = try row.optionalText("category_name")
        if has("running_balance") {
            runningBalance = try row.optionalText("running_balance")
        } else {
            runningBalance = nil
        }
    }

    /// `toNumber(toDecimal(text))`.
    static func number(_ text: String) -> Double { JavaScriptNumber.fromString(text) }

    static func json(_ value: Double) -> JSONValue { JSValue.number(value).envelopeValue }

    /// `formatTransaction`.
    var json: JSONValue {
        func text(_ value: String?) -> JSONValue { value.map(JSONValue.string) ?? .null }
        func optionalId<Tag>(_ value: IntIdentifier<Tag>?) -> JSONValue { value.map { JSONValue.int($0.rawValue) } ?? .null }
        func nonEmpty(_ value: String?) -> JSONValue { value.flatMap { $0.isEmpty ? nil : JSONValue.string($0) } ?? .null }
        let amountNumber = Self.number(amount)
        var fields: [String: JSONValue] = [
            "id": .int(id.rawValue), "transaction_date": .string(date), "bank_account": text(bankAccount),
            "account_id": optionalId(accountId), "is_transfer": .bool(isTransfer), "transfer_peer_id": optionalId(transferPeerId),
            "transfer_source": text(transferSource), "recipient_id": optionalId(recipientId),
            "recipient_name": nonEmpty(recipientName), "memo": text(memo), "amount": Self.json(amountNumber),
            "amount_eur": Self.json(amountEur ?? amountNumber), "currency": text(currency),
            "balance": balance.map { Self.json(Self.number($0)) } ?? .null,
            "category_id": optionalId(effectiveCategoryId ?? categoryId), "category_name": nonEmpty(categoryName),
            "comment": text(comment), "tags": .array(tags.map(\.json)), "is_active": .bool(isActive),
            "created_at": createdAt.map { JSONValue.string($0.text) } ?? .null,
            "updated_at": updatedAt.map { JSONValue.string($0.text) } ?? .null, "links": .array([]),
        ]
        if amountEurUnconverted { fields["amount_eur_unconverted"] = .bool(true) }
        if let runningBalance { fields["running_balance"] = Self.json(Self.number(runningBalance)) }
        return .object(fields)
    }
}

/// `routes/transactions.ts` over `transactionService` and `transactionRepository.ts` for the
/// reads: the list (with the uncategorised queue, running balances and EUR normalization) and
/// one transaction. Writes, bulk actions, exports and transfers stay on Bun for now.
enum TransactionsArea {
    static func register(_ backend: inout InProcessBackend, database: BackendDatabase) {
        backend.serve(OpenAPIOperations.GetTransactions.self) { request in
            let query = try TransactionsArea.listQuery(request)
            return try await database.run { session in try TransactionsArea.list(session, query) }
        }
        backend.serve(OpenAPIOperations.GetTransaction.self) { request in
            let id = try TransactionsArea.pathId(request)
            return try await database.run { session in
                guard let row = try TransactionsArea.getById(session, id) else {
                    throw BackendHTTPError.notFound("Transaction with ID \(id.rawValue) not found")
                }
                return HandlerResult(data: row.json)
            }
        }
    }

    // MARK: - Request input

    /// `entityIdParamsSchema(TransactionIdSchema)`: "id must be a positive integer".
    static func pathId(_ request: InProcessRequest) throws -> TransactionID {
        guard let raw = request.pathParameters["id"], let id = RequestID.valid(.string(raw)) else {
            throw BackendHTTPError.validation("id must be a positive integer")
        }
        return TransactionID(rawValue: Int(id))
    }

    /// A query parameter as Express's parser holds it: absent, one string, or the array of a
    /// repeated key.
    static func raw(_ request: InProcessRequest, _ key: String) -> JSValue? {
        let values = request.queryItems.filter { $0.name == key }.map { JSValue.string($0.value ?? "") }
        if values.isEmpty { return nil }
        return values.count == 1 ? values[0] : .array(values)
    }

    /// `assertOptionalId`: absent or empty is no filter; anything else must be a valid id.
    static func optionalId(_ value: JSValue?, _ field: String, _ issues: inout [String]) -> Int? {
        guard let value, value != .null, value != .string("") else { return nil }
        guard let id = RequestID.valid(value) else {
            issues.append("\(field) must be a positive integer")
            return nil
        }
        return Int(id)
    }

    /// `assertYmd` (`validateDateString`): `YYYY-MM-DD` that JavaScriptCore's `Date` reads,
    /// which takes any month 1–12 and day 1–31.
    static func ymd(_ value: JSValue?, _ field: String, _ issues: inout [String]) -> String? {
        guard let value, value != .null, value != .string(""), value != .bool(false) else { return nil }
        guard case .string(let text) = value, isYmdShape(text) else {
            issues.append("\(field) must be in YYYY-MM-DD format")
            return nil
        }
        let bytes = Array(text.utf8)
        func number(_ range: Range<Int>) -> Int { range.reduce(0) { $0 * 10 + Int(bytes[$1] - 48) } }
        let month = number(5..<7)
        let day = number(8..<10)
        guard (1...12).contains(month), (1...31).contains(day) else {
            issues.append("\(field) is not a valid date")
            return nil
        }
        return text
    }

    static func isYmdShape(_ text: String) -> Bool {
        let bytes = Array(text.utf8)
        guard bytes.count == 10, bytes[4] == 45, bytes[7] == 45 else { return false }
        return [0, 1, 2, 3, 5, 6, 8, 9].allSatisfy { (48...57).contains(bytes[$0]) }
    }

    /// `singleQueryValue`: a repeated key is "<name> must be a single value".
    static func single(_ value: JSValue?, _ field: String, _ issues: inout [String]) -> String? {
        switch value {
        case .string(let text)?: return text
        case nil: return nil
        default:
            issues.append("\(field) must be a single value")
            return nil
        }
    }

    /// `parseIdListQueryParam`: comma-separated ids; absent or empty is no filter.
    static func idList(_ value: JSValue?, _ field: String, _ issues: inout [String]) -> [Int]? {
        guard let value else { return nil }
        let joined = value.javaScriptString
        if joined.isEmpty { return nil }
        var ids: [Int] = []
        for element in joined.split(separator: ",", omittingEmptySubsequences: false) {
            guard let id = RequestID.valid(.string(String(element))) else {
                issues.append("\(field) contains invalid value: \(element)")
                return nil
            }
            ids.append(Int(id))
        }
        return ids
    }

    /// `parseBooleanQueryParam` over the raw value.
    static func flag(_ value: JSValue?, default defaultValue: Bool) -> Bool {
        guard let value else { return defaultValue }
        return QueryInput.boolean(value.javaScriptString, default: defaultValue)
    }

    /// `value === a || value === b ? value : undefined`.
    static func oneOf(_ value: JSValue?, _ allowed: Set<String>) -> String? {
        guard case .string(let text)? = value, allowed.contains(text) else { return nil }
        return text
    }

    struct ListQuery: Sendable {
        var filters = TransactionWhere()
        var limit = JavaScriptInteger(value: 50)
        var offset = JavaScriptInteger(value: 0)
        var sortBy: String?
        var sortDir: String?
        var includeBalance = false
        var uncategorised = false
        var normalizeToEur = false
        // lint:allow raw-currency free text from the query, upper-cased and looked up as given
        var targetCurrency: String?
    }

    /// `transactionFilterQueryShape` read in the schema's order, every issue collected.
    static func filterFields(_ request: InProcessRequest, _ issues: inout [String]) -> (TransactionWhere, ListQuery) {
        func value(_ key: String) -> JSValue? { raw(request, key) }
        var filters = TransactionWhere()
        var query = ListQuery()
        filters.transactionId = optionalId(value("transaction_id"), "transaction_id", &issues).map { TransactionID(rawValue: $0) }
        filters.startDate = ymd(value("start_date"), "start_date", &issues)
        filters.endDate = ymd(value("end_date"), "end_date", &issues)
        filters.accountId = optionalId(value("account_id"), "account_id", &issues).map { AccountID(rawValue: $0) }
        filters.bankAccount = single(value("bank_account"), "bank_account", &issues).flatMap { $0.isEmpty ? nil : $0 }
        filters.categoryId = optionalId(value("category_id"), "category_id", &issues).map { CategoryID(rawValue: $0) }
        filters.categoryIds = idList(value("category_ids"), "category_ids", &issues)
        filters.recipientId = optionalId(value("recipient_id"), "recipient_id", &issues).map { RecipientID(rawValue: $0) }
        filters.recipientGroupId = optionalId(value("recipient_group_id"), "recipient_group_id", &issues)
            .map { RecipientID(rawValue: $0) }
        filters.recipientName = single(value("recipient_name"), "recipient_name", &issues)
            .flatMap { $0.isEmpty ? nil : $0 }
        filters.search = single(value("search"), "search", &issues).flatMap { search in
            search.isEmpty ? nil : String(decoding: Array(search.utf16.prefix(200)), as: UTF16.self)
        }
        filters.active = flag(value("active"), default: true)
        query.sortBy = single(value("sort_by"), "sort_by", &issues).flatMap { $0.isEmpty ? nil : $0 }
        query.sortDir = oneOf(value("sort_dir"), ["asc", "desc"])
        query.includeBalance = flag(value("include_balance"), default: false)
        filters.transactionType = oneOf(value("transaction_type"), ["income", "expense"])
        let signed = flag(value("amount_signed"), default: false)
        filters.amountSigned = signed
        let exact = parseAmountFilter(value("amount_exact"), signed: signed)
        filters.amountMin = exact ?? parseAmountFilter(value("amount_min"), signed: signed)
        filters.amountMax = exact ?? parseAmountFilter(value("amount_max"), signed: signed)
        if let tags = value("tags"), tags != .string("") {
            let slugs = tags.javaScriptString.split(separator: ",", omittingEmptySubsequences: false)
                .map { JavaScriptWhitespace.trim(String($0)).lowercased() }.filter { !$0.isEmpty }
            filters.tagSlugs = slugs.isEmpty ? nil : slugs
        }
        return (filters, query)
    }

    /// `transactionListQuerySchema`: the filters, then the queue, normalization and target
    /// currency, then `parsePagination` capped at 5000.
    static func listQuery(_ request: InProcessRequest) throws -> ListQuery {
        var issues: [String] = []
        var (filters, query) = filterFields(request, &issues)
        query.uncategorised = flag(raw(request, "uncategorised"), default: false)
        query.normalizeToEur = flag(raw(request, "normalize_to_eur"), default: false)
        query.targetCurrency = single(raw(request, "target_currency"), "target_currency", &issues)
        if !issues.isEmpty { throw BackendHTTPError.validation(issues.joined(separator: "; ")) }
        if query.uncategorised {
            filters.categoryId = nil
            filters.categoryIds = nil
            filters.active = true
        }
        query.filters = filters
        query.limit = .clamped(request.query("limit"), min: 1, max: 5000, fallback: 50)
        query.offset = .clamped(request.query("offset"), min: 0, fallback: 0)
        return query
    }

    // MARK: - SQL

    static let joins = """
          LEFT JOIN recipients r ON t.recipient_id = r.id
          LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
          LEFT JOIN categories c ON t.category_id = c.id
          LEFT JOIN categories rc ON r.default_category_id = rc.id
          LEFT JOIN categories pc ON pr.default_category_id = pc.id
          LEFT JOIN accounts acct ON t.account_id = acct.id
        """

    static let countJoins = "LEFT JOIN recipients r ON t.recipient_id = r.id"

    static let effectiveCategoryId = "COALESCE(t.category_id, r.default_category_id, pr.default_category_id)"

    static let categoryName = """
        CASE
                       WHEN c.id IS NOT NULL THEN c.path_name
                       WHEN rc.id IS NOT NULL THEN rc.path_name
                       WHEN pc.id IS NOT NULL THEN pc.path_name
                       ELSE NULL
                     END
        """

    static let recipientName = "COALESCE(pr.name, r.name)"

    static let projection = """
        SELECT t.*,
                     acct.name AS bank_account,
                     \(recipientName) AS recipient_name,
                     \(effectiveCategoryId) AS effective_category_id,
                     \(categoryName) AS category_name
        """

    /// `TRANSACTION_SORT_COLUMNS`.
    static let sortColumns: [String: String] = [
        "date": "t.date", "amount": "dec_key(t.amount)", "memo": "t.memo", "recipient": recipientName,
        "category": categoryName, "bank": "acct.name", "currency": "t.currency",
    ]

    /// `transactionOrderBy`.
    static func orderBy(_ sortBy: String?, _ sortDir: String?) -> String {
        guard let sortBy, let column = sortColumns[sortBy] else { return "t.date DESC, t.id DESC" }
        let direction = sortDir == "asc" ? "ASC NULLS LAST" : "DESC NULLS FIRST"
        return "\(column) \(direction), t.date DESC, t.id DESC"
    }

    /// `pageCte`.
    static func pageCte(_ whereSQL: String, _ joins: String, _ orderBy: String) -> String {
        """
            page AS MATERIALIZED (
              SELECT t.id, t.account_id, COALESCE(t.currency, 'EUR') AS currency
              FROM transactions t
              \(joins)
              WHERE \(whereSQL)
              ORDER BY \(orderBy) LIMIT ? OFFSET ?
            )
        """
    }

    /// `runningBalanceCtes`: binds the predicate's values once.
    static func runningBalanceCtes(_ whereSQL: String, _ joins: String, forPage: Bool) -> String {
        """
            ledger AS (
              SELECT t.id, t.account_id, COALESCE(t.currency, 'EUR') AS currency, t.balance,
                     dec_sum(t.amount) OVER ledger_order AS cumulative,
                     COUNT(t.balance) OVER ledger_order AS stamp_group,
                     \(forPage ? "t.id IN (SELECT p.id FROM page p)" : "1") AS on_page
              FROM transactions t
              \(joins)
              WHERE \(whereSQL)
              \(forPage ? """
                AND (COALESCE(t.account_id, -1), COALESCE(t.currency, 'EUR')) IN (
                  SELECT COALESCE(p.account_id, -1), p.currency FROM page p
                )
                """ : "")
              WINDOW ledger_order AS (
                PARTITION BY t.account_id, COALESCE(t.currency, 'EUR')
                ORDER BY t.date ASC, \(AccountBalanceSQL.chronology("\"t\"")) ASC, t.id ASC
              )
            ),
            ledger_balances AS (
              SELECT id, running_balance
              FROM (
                SELECT id, on_page,
                       dec_add(cumulative, COALESCE(
                         dec_sum(CASE WHEN balance IS NOT NULL THEN dec_sub(balance, cumulative) END)
                           OVER (PARTITION BY account_id, currency, stamp_group),
                         '0'
                       )) AS running_balance
                FROM ledger
              ) carried
              WHERE on_page
            )
        """
    }

    /// `enrichedPage`.
    static func enrichedPage(
        _ clause: TransactionWhere.Clause, includeBalance: Bool, sortBy: String?, sortDir: String?,
        limit: SQLValue, offset: SQLValue
    ) -> (String, [SQLValue]) {
        let order = orderBy(sortBy, sortDir)
        if !includeBalance {
            return (
                """
                \(projection)
                FROM transactions t
                \(joins)
                WHERE \(clause.sql)
                ORDER BY \(order) LIMIT ? OFFSET ?
                """, clause.arguments + [limit, offset]
            )
        }
        return (
            """
            WITH \(pageCte(clause.sql, joins, order)),
            \(runningBalanceCtes(clause.sql, joins, forPage: true))
            \(projection), lb.running_balance
            FROM page
            JOIN transactions t ON t.id = page.id
            \(joins)
            JOIN ledger_balances lb ON lb.id = t.id
            ORDER BY \(order)
            """, clause.arguments + [limit, offset] + clause.arguments
        )
    }

    /// `attachTagsToRows`.
    static func attachTags(_ session: BackendSession, _ rows: [TransactionRow]) throws -> [TransactionRow] {
        if rows.isEmpty { return [] }
        let ids = JSValue.array(rows.map { .int($0.id.rawValue) }).jsonText
        let tagRows = try session.rows(
            """
            select "tt"."transaction_id", "tg"."id", "tg"."slug", "tg"."color", "tg"."is_active" from "transaction_tags" as "tt" \
            inner join "tags" as "tg" on "tg"."id" = "tt"."tag_id" \
            where tt.transaction_id IN (SELECT value FROM json_each(?))
            """, [.text(ids)])
        var tags: [Int: [TransactionRow.Tag]] = [:]
        for row in tagRows {
            let transaction = try row.integerId("transaction_id")
            let tag = TransactionRow.Tag(
                id: try row.integerId("id"), slug: try row.text("slug"), color: try row.optionalText("color"),
                isActive: try row.bool("is_active"))
            tags[transaction, default: []].append(tag)
        }
        return rows.map { row in
            var row = row
            row.tags = tags[row.id.rawValue] ?? []
            return row
        }
    }

    static func getById(_ session: BackendSession, _ id: TransactionID) throws -> TransactionRow? {
        guard
            let row = try session.row(
                "\(projection)\n    FROM \"transactions\" t\n    \(joins)\n   WHERE t.id = ?", [id.sqlValue])
        else { return nil }
        return try attachTags(session, [TransactionRow(row)]).first
    }

    /// `getAllWithCount`: the page and the filtered count.
    static func allWithCount(_ session: BackendSession, _ query: ListQuery) throws -> ([TransactionRow], Int) {
        let clause = query.filters.clause
        let (pageSQL, arguments) = enrichedPage(
            clause, includeBalance: query.includeBalance, sortBy: query.sortBy, sortDir: query.sortDir,
            limit: query.limit.sqlValue, offset: query.offset.sqlValue)
        let rows = try session.rows(pageSQL, arguments).map(TransactionRow.init)
        let total = try session.row(
            "SELECT COUNT(*) AS total FROM transactions t \(countJoins) WHERE \(clause.sql)", clause.arguments)
        return (try attachTags(session, rows), Int(try total?.int64("total") ?? 0))
    }

    /// `getUncategorisedWithCount`: the active rows whose effective category is NULL.
    static func uncategorisedWithCount(_ session: BackendSession, _ query: ListQuery) throws -> ([TransactionRow], Int) {
        let clause = query.filters.clause
        let order = orderBy(query.sortBy, query.sortDir)
        let uncategorisedWhere = "\(clause.sql)\n      AND \(effectiveCategoryId) IS NULL"
        let uncategorisedJoins = """
              LEFT JOIN recipients r ON t.recipient_id = r.id
              LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
              LEFT JOIN accounts acct ON t.account_id = acct.id
            """
        let head =
            query.includeBalance
            ? "WITH \(runningBalanceCtes(uncategorisedWhere, uncategorisedJoins, forPage: false)),"
            : "WITH"
        let sql = """
            \(head) total_cte AS (
                SELECT count(*) AS total
                FROM transactions t
                \(countJoins)
                LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
                WHERE \(uncategorisedWhere)
              ),
              uncategorised_rows AS (
                SELECT t.*,
                       acct.name AS bank_account,
                       r.name AS recipient_name,
                       NULL AS category_name\(query.includeBalance ? ", lb.running_balance" : ""),
                       CAST(ROW_NUMBER() OVER (ORDER BY \(order)) AS TEXT) AS _row_order
                FROM transactions t
                \(uncategorisedJoins)
                \(query.includeBalance ? "JOIN ledger_balances lb ON lb.id = t.id" : "")
                WHERE \(uncategorisedWhere)
                ORDER BY \(order)
                LIMIT ? OFFSET ?
              )
              SELECT u.*,
                     tc.total AS total_count
              FROM total_cte tc
              LEFT JOIN uncategorised_rows u ON true
              ORDER BY CAST(u._row_order AS INTEGER) NULLS LAST
            """
        var arguments = query.includeBalance ? clause.arguments : []
        arguments += clause.arguments + clause.arguments + [query.limit.sqlValue, query.offset.sqlValue]
        let rows = try session.rows(sql, arguments)
        let total = Int(try rows.first?.optionalInt64("total_count") ?? 0)
        let page = try rows.filter { try $0.optionalInt64("id") != nil }.map(TransactionRow.init)
        return (try attachTags(session, page), total)
    }

    // MARK: - EUR normalization

    /// `getRates` (`loadFromDatabase`): EUR at 1 and every latest stored rate as a number.
    static func latestRates(_ session: BackendSession) throws -> [String: Double] {
        var rates = ["EUR": 1.0]
        for row in try session.rows("SELECT currency_code, rate_to_eur FROM exchange_rates WHERE is_latest = 1") {
            rates[try row.text("currency_code")] = TransactionRow.number(try row.text("rate_to_eur"))
        }
        return rates
    }

    /// `(value || "EUR").toUpperCase().trim()`.
    static func currencyKey(_ value: String?) -> String {
        guard let value, !value.isEmpty else { return "EUR" }
        return JavaScriptWhitespace.trim(value.uppercased())
    }

    /// `convertRowsToEur` at the latest rates, marking each row it cannot convert; returns the
    /// `unconverted_count` / `unconverted_currencies` fields.
    static func normalize(
        _ rows: inout [TransactionRow], to target: String?, rates: [String: Double]
    ) -> [String: JSONValue] {
        let targetKey = currencyKey(target)
        func rate(_ code: String) -> Double? { code == "EUR" ? 1 : rates[code] }
        var count = 0
        var currencies = Set<String>()
        for index in rows.indices {
            let currency = currencyKey(rows[index].currency)
            let amount = TransactionRow.number(rows[index].amount)
            if currency == targetKey {
                rows[index].amountEur = amount
                continue
            }
            guard let from = rate(currency), from != 0, let to = rate(targetKey), to != 0 else {
                rows[index].amountEurUnconverted = true
                count += 1
                currencies.insert(currency)
                continue
            }
            rows[index].amountEur = (amount * from) / to
        }
        return [
            "unconverted_count": .int(count),
            "unconverted_currencies": .array(RecipientText.sortedUTF16(Array(currencies)).map(JSONValue.string)),
        ]
    }

    // MARK: - GET /api/transactions

    static func list(_ session: BackendSession, _ query: ListQuery) throws -> HandlerResult {
        let page = try (query.uncategorised ? uncategorisedWithCount(session, query) : allWithCount(session, query))
        var rows = page.0
        let total = page.1
        var body: [String: JSONValue] = [
            "total": .int(total), "limit": query.limit.json, "offset": query.offset.json, "links": .array([]),
        ]
        if query.normalizeToEur {
            let target = query.targetCurrency.flatMap { $0.isEmpty ? nil : $0 } ?? "EUR"
            let rates = try latestRates(session)
            body.merge(normalize(&rows, to: target, rates: rates)) { $1 }
        }
        body["items"] = .array(rows.map(\.json))
        return HandlerResult(data: .object(body))
    }
}
