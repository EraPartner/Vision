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
        backend.serve(OpenAPIOperations.CreateTransaction.self) { request in
            let fields = try TransactionsArea.createFields(request)
            return try await database.run { session in try TransactionsArea.create(session, fields: fields) }
        }
        backend.serve(OpenAPIOperations.UpdateTransaction.self) { request in
            let id = try TransactionsArea.pathId(request)
            return try await database.run { session in
                try TransactionsArea.update(session, id: id, request: request)
            }
        }
        backend.serve(OpenAPIOperations.DeleteTransaction.self) { request in
            let id = try TransactionsArea.pathId(request)
            return try await database.run { session in try TransactionsArea.delete(session, id: id) }
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

    // MARK: - POST / (create, port 11)

    /// The SQL a raw body value binds, as `toSqlParam` over node:sqlite writes it: every
    /// number a double, a boolean its 1/0 double, arrays and objects their `JSON.stringify`
    /// text, and NaN a raised TypeError.
    static func looseSQL(_ value: JSValue?) throws -> SQLValue {
        switch value {
        case nil, .null?:
            return .null
        case .bool(let flag)?:
            return .real(flag ? 1 : 0)
        case .number(let number)?:
            if number.isNaN { throw UnhandledJSError("NaN cannot be bound to SQLite") }
            return .real(number)
        case .string(let text)?:
            return .text(text)
        case .array?, .object?:
            return .text(value?.jsonText ?? "null")
        }
    }

    /// `assertCurrency`: null and "" clear; anything else must read as ISO (upper-cased).
    static func currencyCode(_ value: JSValue?, issues: inout [String]) -> String? {
        guard let value, value != .null, value != .string("") else { return nil }
        let code = JavaScriptWhitespace.trim(value.javaScriptString.uppercased())
        guard AccountsArea.isCurrencyCode(code) else {
            issues.append("currency: currency must be a 3-letter ISO code")
            return nil
        }
        return code
    }

    /// `validateId`: a positive integer up to int32, as number or digits string.
    static func validId(_ value: JSValue?) -> Int? {
        if let text = value?.stringValue, !text.isEmpty, text.utf8.allSatisfy({ (48...57).contains($0) }) {
            return Int(text).flatMap { $0 >= 1 && $0 <= 2_147_483_647 ? $0 : nil }
        }
        guard case .number(let number)? = value, number.isFinite else { return nil }
        guard number == number.rounded(), number >= 1, number <= 2_147_483_647 else { return nil }
        return Int(number)
    }

    /// `createTransactionSchema`: the leaf checks in shape order, then the superRefine
    /// checks (zod collects both, reading a failed leaf as undefined).
    static func createFields(_ request: InProcessRequest) throws -> JSObject {
        let body = try RequestBody.parseJavaScript(request.body)
        guard case .object(var object)? = body ?? .object(JSObject()) else {
            throw BackendHTTPError.validation(
                "Invalid input: expected object, received \((body ?? .null).zodTypeName)")
        }
        var issues: [String] = []
        var account: Int?

        // tags: only "is an array" is checked; the items pass through unchecked.
        if let tags = object["tags"], !(case .array? = tags) {
            issues.append("tags: tags must be an array of strings")
        }
        // account_id/category_id: null clears; a present value must be a positive int.
        for field in ["account_id", "category_id"] {
            if let value = object[field] {
                if value == .null { continue }
                if let id = validId(value) {
                    object[field] = .number(Double(id))
                    if field == ["account_id"].contains(field) { account = id }
                } else {
                    issues.append("\(field): \(field) must be a positive integer")
                }
            }
        }
        // allow_duplicate: a boolean when present.
        if let flag = object["allow_duplicate"], !(case .bool? = flag) {
            issues.append("allow_duplicate: Invalid input: expected boolean, received \(flag.zodTypeName)")
        }
        // currency: absent, null and "" all clear.
        TransactionsArea.currencyCode(object["currency"], issues: &issues)
            .map { object["currency"] = .string($0) }
        // bank_account: retired — anything but absence fails.
        if let bankAccount = object["bank_account"] {
            issues.append("bank_account: Invalid input: expected never, received \(bankAccount.zodTypeName)")
        }

        // superRefine, always after the leaves; a failed account_id reads as undefined.
        let txDate = orNull(object["transaction_date"]) ?? orNull(object["date"])
        let recipient = object["recipient_id"]
        let amount = object["amount"]
        if txDate == nil || account == nil || recipient == nil || !truthy(recipient ?? .null)
            || amount == nil || amount == .null
        {
            issues.append("Missing required fields: date, account_id, recipient_id, amount")
            guard issues.isEmpty else { throw BackendHTTPError.validation(issues.joined(separator: "; ")) }
            return object
        }
        let amountNum = amount?.javaScriptNumber ?? .nan
        if !amountNum.isFinite || amountNum == 0 || abs(amountNum) > 1_000_000_000_000 {
            issues.append("amount must be a non-zero finite number within range")
        }
        if validId(recipient) == nil {
            issues.append("recipient_id must be a positive integer")
        }
        guard issues.isEmpty else { throw BackendHTTPError.validation(issues.joined(separator: "; ")) }
        return object
    }

    /// JavaScript truthiness, the `data.x || data.y` of the route's date pick.
    static func truthy(_ value: JSValue) -> Bool {
        switch value {
        case .null: return false
        case .bool(let flag): return flag
        case .number(let number): return number != 0 && !number.isNaN
        case .string(let text): return !text.isEmpty
        default: return true
        }
    }

    /// `x || undefined`: falsy reads as nil.
    static func orNull(_ value: JSValue?) -> JSValue? {
        (value.map(truthy) ?? false) ? value : nil
    }

    /// `manualAmountIdentity`: the NUMERIC(18,4) value as decimal.js prints it, ties
    /// away from zero. A value decimal.js cannot parse raises.
    static func manualAmountIdentity(_ amount: JSValue?) throws -> String {
        let text: String
        if case .number(let number)? = amount { text = SQLArguments.javaScriptText(number) } else {
            text = amount?.javaScriptString ?? ""
        }
        guard let decimal = try? DecimalJS.from(text) else {
            throw UnhandledJSError("[decimaljs] Invalid argument: not a valid number")
        }
        return decimal.toDecimalPlaces(4).description
    }

    /// `createManualTransactionHash`: the versioned identity of a manual create.
    // lint:allow raw-id the TypeScript helper hashes the account row id as a plain number
    static func manualHash(_ data: JSObject, date: String, accountId: Int) throws -> String {
        let recipientHash: JSValue
        if let recipient = data["recipient_id"], recipient != .null {
            recipientHash = .string(recipient.javaScriptString)
        } else {
            recipientHash = .null
        }
        let hashInput = JSValue.array([
            .string("manual-v3"),
            .string(String(date.prefix(10))),
            .string(try manualAmountIdentity(data["amount"])),
            recipientHash,
            .string(JavaScriptWhitespace.trim((data["memo"] ?? .null).javaScriptString).uppercased()),
            .string("id:\(accountId)"),
            .string(JavaScriptWhitespace.trim((data["currency"] ?? .null).javaScriptString).uppercased()),
        ])
        return SHA256Digest.hex(Array(hashInput.jsonText.utf8))
    }

    /// The manual dedup predicate of `isManualDuplicate`, bound as its raw sql held it.
    static func duplicatePredicate(
        _ date: String, _ identity: String, _ data: JSObject,
        // lint:allow raw-id the predicate binds the account row id as a plain integer
        accountId: Int
    ) throws -> [SQLValue] {
        let memo = JavaScriptWhitespace.trim((data["memo"] ?? .null).javaScriptString).uppercased()
        let currency = JavaScriptWhitespace.trim((data["currency"] ?? .null).javaScriptString).uppercased()
        let recipientParam: SQLValue
        if let recipient = data["recipient_id"], recipient != .null {
            recipientParam = looseSQL(recipient)
        } else {
            recipientParam = .null
        }
        return try [
            .text(String(date.prefix(10))),
            .text(identity),
            recipientParam,
            .text(memo),
            .integer(Int64(accountId)),
            .integer(Int64(accountId)),
            .integer(Int64(accountId)),
            .text(""),
            .text(currency),
        ]
    }

    /// The predicate's SQL text: the claim join and the field fallback both hold it.
    static let duplicateWhere = """
    t.date = ? AND dec_eq(t.amount, ?) AND t.recipient_id IS ? \
    AND UPPER(COALESCE(btrim(t.memo, char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, \
    8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)), '')) = ? \
    AND ((? IS NOT NULL AND t.account_id = ?) OR (? IS NULL AND COALESCE(UPPER(acct.name), '') = ?)) \
    AND UPPER(t.currency) = ? AND t.is_active = 1
    """

    /// POST "/": the manual dedup claim chain, the insert and the auto-link of
    /// `createManualTransaction`.
    static func create(_ session: BackendSession, fields data: JSObject) throws -> HandlerResult {
        guard let txValue = orNull(data["transaction_date"]) ?? orNull(data["date"]) else {
            throw UnhandledJSError("createManualTransaction: transaction_date missing")
        }
        let txDate = txValue.javaScriptString
        guard let account = validId(data["account_id"]) else {
            throw UnhandledJSError("createManualTransaction: account_id missing")
        }
        let identity = try manualAmountIdentity(data["amount"])
        let hash = try manualHash(data, date: txDate, accountId: account)

        let created = try session.transaction { () throws -> TransactionID in
            // The account must be active; a manual create always carries one.
            let active = try session.row(
                "SELECT id FROM accounts WHERE id = ? AND is_active = 1", [.integer(Int64(account))])
            if active == nil {
                throw BackendHTTPError.validation("account_id must reference an active account")
            }
            // The claim hint first, then the live field predicate.
            let predicate = try duplicatePredicate(txDate, identity, data, accountId: account)
            let claim = try session.row(
                """
                SELECT m.transaction_id FROM manual_transaction_dedup_claims AS m \
                INNER JOIN transactions AS t ON t.id = m.transaction_id AND t.is_active = 1 \
                LEFT JOIN accounts AS acct ON acct.id = t.account_id \
                WHERE m.deduplication_hash = ? AND \(duplicateWhere) LIMIT 1
                """, [.text(hash)] + predicate)
            let existing: Int?
            if let claim {
                existing = try claim.integerId("transaction_id")
            } else {
                let fieldMatch = try session.row(
                    """
                    SELECT t.id FROM transactions AS t \
                    LEFT JOIN accounts AS acct ON acct.id = t.account_id \
                    WHERE \(duplicateWhere) LIMIT 1
                    """, predicate)
                existing = try fieldMatch.map { try $0.integerId("id") }
            }
            if let existing, data["allow_duplicate"] != .bool(true) {
                throw BackendHTTPError(
                    status: 409, code: "CONFLICT", message: "Duplicate transaction detected",
                    details: .object(["existing_transaction_id": .int(existing)]))
            }
            let tagSlugs: [JSValue]?
            if case .array(let slugs)? = data["tags"] { tagSlugs = slugs } else { tagSlugs = nil }
            let inserted = try session.row(
                """
                INSERT INTO transactions (date, account_id, recipient_id, amount, memo, currency, category_id, comment, is_active) \
                VALUES (?, ?, ?, vision_numeric(?, 18, 4), ?, ?, ?, ?, 1) RETURNING id
                """,
                try [
                    looseSQL(.string(txDate)),
                    .integer(Int64(account)),
                    looseSQL(data["recipient_id"]),
                    PlannedArea.decimalText(data["amount"]),
                    looseSQL(try uppercasedText(data["memo"]) ?? .null),
                    looseSQL(orNull(data["currency"]).map { .string($0.javaScriptString.uppercased()) } ?? "EUR"),
                    looseSQL(data["category_id"]),
                    looseSQL(data["comment"]),
                ])
            guard let inserted else { throw UnhandledJSError("Transaction insert did not return a row") }
            let id = TransactionID(rawValue: try inserted.integerId("id"))
            if let tagSlugs {
                try setTransactionTags(session, id, tagSlugs)
            }
            try session.rows(
                """
                INSERT INTO manual_transaction_dedup_claims (deduplication_hash, transaction_id, updated_at) \
                VALUES (?, ?, now()) \
                ON CONFLICT (deduplication_hash) DO UPDATE SET transaction_id = excluded.transaction_id, updated_at = now()
                """, [.text(hash), .integer(Int64(id.rawValue))])
            return id
        }

        // The auto-clear of a matching planned payment; a failure never fails the create.
        let autoLinked: Int?
        do {
            autoLinked = try PlannedArea.autoLink(
                session, transaction: created, fields: data, txDate: txDate, accountId: account)
        } catch {
            autoLinked = nil
        }
        let row = try TransactionsArea.getById(session, created)
        var fields = row?.json ?? .null
        if case .object(var object) = fields {
            object["auto_linked"] = autoLinked.map { JSValue.int($0).envelopeValue } ?? .null
            fields = .object(object)
        }
        return HandlerResult(status: 201, data: fields)
    }

    /// A truthy string body value, upper-cased; `toUpperCase` raised a TypeError on
    /// anything else, which surfaced as the sanitized 500.
    static func uppercasedText(_ value: JSValue?) throws -> JSValue? {
        guard let value, truthy(value) else { return value }
        guard case .string(let text) = value else {
            throw UnhandledJSError("value.toUpperCase is not a function")
        }
        return .string(text.uppercased())
    }

    /// `decimalParam`: a number binds as its decimal text, anything else raw.
    static func decimalText(_ value: JSValue?) throws -> SQLValue {
        if case .number(let number)? = value { return .text(SQLArguments.javaScriptText(number)) }
        return try looseSQL(value)
    }

    /// `setTransactionTags`: replace the attached tags with the active slugs given.
    static func setTransactionTags(_ session: BackendSession, _ id: TransactionID, _ slugs: [JSValue]) throws {
        try session.rows("DELETE FROM transaction_tags WHERE transaction_id = ?", [id.sqlValue])
        let resolved = try session.rows(
            """
            SELECT id FROM tags WHERE slug IN (SELECT value FROM json_each(?)) AND is_active = 1
            """, [.text(JSValue.array(slugs).jsonText)])
        guard !resolved.isEmpty else { return }
        let ids = try JSValue.array(resolved.map { try .int($0.integerId("id")) })
        try session.rows(
            """
            INSERT INTO transaction_tags (transaction_id, tag_id) \
            SELECT ?, value FROM json_each(?) WHERE true \
            ON CONFLICT DO NOTHING
            """, [id.sqlValue, .text(ids.jsonText)])
    }

    // MARK: - PATCH /:id (update, port 11)

    /// The columns `sanitizeUpdateFields("transactions", …)` allows.
    static let updatableColumns: Set<String> = [
        "date", "transaction_date", "account_id", "recipient_id", "amount", "memo", "currency",
        "category_id", "comment", "is_active",
    ]

    /// `normalizeTransactionPatchFields` + `patchTransactionSchema`: the read-only keys
    /// strip, the `date` remap, then the leaf checks in shape order.
    static func patchFields(_ request: InProcessRequest) throws -> JSObject {
        let body = try RequestBody.parseJavaScript(request.body)
        guard case .object(var object)? = body ?? .object(JSObject()) else {
            throw BackendHTTPError.validation(
                "Invalid input: expected object, received \((body ?? .null).zodTypeName)")
        }
        var issues: [String] = []
        for key in ["links", "id", "created_at"] { object[key] = nil }
        if let date = object["date"] {
            object["date"] = nil
            object["transaction_date"] = date
        }
        if let tags = object["tags"], !(case .array? = tags) {
            issues.append("tags: tags must be an array of strings")
        }
        // transaction_date: guardField — falsy clears, then `assertYmd`'s own message.
        if let value = object["transaction_date"] {
            if !truthy(value) {
                issues.append("transaction_date: transaction_date cannot be cleared")
            } else {
                var dateIssues: [String] = []
                if truthy(value) { _ = ymd(value, "transaction_date", &dateIssues) }
                if dateIssues.isEmpty, !isJSString(value) {
                    dateIssues.append("transaction_date: transaction_date must be in YYYY-MM-DD format")
                }
                issues.append(contentsOf: dateIssues.map { "transaction_date: \($0)" })
            }
        }
        // amount: null and "" refuse, and the number replaces the raw input.
        if let amount = object["amount"] {
            if amount == .null || amount == .string("") {
                issues.append("amount: amount must be a number within range")
            } else {
                let number = amount.javaScriptNumber
                if !number.isFinite || abs(number) > 1_000_000_000_000 {
                    issues.append("amount: amount must be a number within range")
                } else {
                    object["amount"] = .number(number)
                }
            }
        }
        // currency: a clear refuses; anything else must read as ISO.
        if let currency = object["currency"] {
            if currency == .null || currency == .string("") {
                issues.append("currency: currency cannot be cleared")
            } else if currency != .null {
                _ = TransactionsArea.currencyCode(currency, issues: &issues)
                    .map { object["currency"] = .string($0) }
            }
        }
        if let bankAccount = object["bank_account"] {
            issues.append("bank_account: Invalid input: expected never, received \(bankAccount.zodTypeName)")
        }
        for field in ["account_id", "recipient_id", "category_id"] {
            guard let value = object[field], value != .null else { continue }
            if let id = validId(value) {
                object[field] = .number(Double(id))
            } else {
                issues.append("\(field): \(field) must be a positive integer")
            }
        }
        guard issues.isEmpty else { throw BackendHTTPError.validation(issues.joined(separator: "; ")) }
        return object
    }

    /// A string body value, as `z.string()` accepts.
    static func isJSString(_ value: JSValue?) -> Bool {
        if case .string? = value { return true }
        return false
    }

    /// PATCH `/:id`: `transactionService.update` over `transactionRepository.update` —
    /// the name resolution, the closed-account guard, the allow-listed SET and the tags, in
    /// one write transaction.
    static func update(
        _ session: BackendSession, id: TransactionID, request: InProcessRequest
    ) throws -> HandlerResult {
        var fields = try patchFields(request)
        // `resolveRecipientIdByName` / `resolveCategoryIdByName` — only when the id is
        // nullish (not merely falsy), as the service reads it.
        if let name = orNull(fields["recipient_name"]), fields["recipient_id"] == nil
            || fields["recipient_id"] == .null
        {
            guard case .string(let text) = name else { throw UnhandledJSError("recipient_name is not a string") }
            let normalized = RecipientText.normalizeForMatching(text)
            guard let row = try session.row(
                "SELECT id FROM recipients WHERE normalized_name = ? LIMIT 1", [.text(normalized)])
            else { throw BackendHTTPError.validation("Recipient with name '\(text)' does not exist") }
            fields["recipient_id"] = .number(Double(try row.integerId("id")))
        }
        fields["recipient_name"] = nil
        if let name = orNull(fields["category_name"]), fields["category_id"] == nil
            || fields["category_id"] == .null
        {
            let normalized = JavaScriptWhitespace.trim(AccountsArea.looseText(name).uppercased())
            let byPath = try session.rows(
                "SELECT id FROM categories WHERE path_name = ? AND is_active = 1 ORDER BY id LIMIT 2",
                [.text(normalized)])
            if byPath.count > 1 {
                throw BackendHTTPError.validation(
                    "Category path '\(normalized)' is ambiguous. Select the category by id.")
            }
            if let match = byPath.first {
                fields["category_id"] = .number(Double(try match.integerId("id")))
            } else {
                guard let delimiter = normalized.firstIndex(of: ":"), delimiter != normalized.startIndex else {
                    throw BackendHTTPError.validation(
                        "Invalid category name format '\(normalized)'. Select a category id or use 'General:Detail'.")
                }
                let general = JavaScriptWhitespace.trim(String(normalized[normalized.startIndex..<delimiter]))
                let detail = JavaScriptWhitespace.trim(String(normalized[normalized.index(after: delimiter)...]))
                let legacy = try session.rows(
                    """
                    SELECT id FROM categories WHERE general = ? AND detail = ? AND is_active = 1
                    UNION
                    SELECT c.id FROM category_merge_aliases AS a
                     INNER JOIN categories AS c ON c.id = a.target_category_id
                     WHERE a.general = ? AND a.detail = ? AND c.is_active = 1
                    ORDER BY id LIMIT 2
                    """, [.text(general), .text(detail), .text(general), .text(detail)])
                guard legacy.count == 1, let match = legacy.first else {
                    throw BackendHTTPError.validation(
                        "Category '\(normalized)' does not exist. Please create it first or use an existing category.")
                }
                fields["category_id"] = .number(Double(try match.integerId("id")))
            }
        }
        fields["category_name"] = nil

        var sanitized: [(String, JSValue)] = []
        var tags: [JSValue]?
        for (key, value) in fields.entries {
            if key == "tags" {  // lint:allow string-literal-compare the allow-list keys are the TypeScript literals
                if case .array(let slugs) = value { tags = slugs }
                continue
            }
            let normalized = JavaScriptWhitespace.trim(key.lowercased())
            if TransactionsArea.updatableColumns.contains(normalized) { sanitized.append((normalized, value)) }
        }
        // A PATCH that moves a ledger balance must find both accounts open.
        let ledgerTouching: Set<String> = [
            "amount", "date", "transaction_date", "currency", "account_id", "is_active",
        ]
        var targetAccount: Int?
        if let index = sanitized.firstIndex(where: { $0.0 == "account_id" }) {  // lint:allow string-literal-compare the column key is a TypeScript literal
            if case .number(let number)? = sanitized[index].1, number != 0 {
                targetAccount = Int(number)
            }
        }

        let found = try session.transaction { () throws -> Bool in
            if sanitized.contains(where: { ledgerTouching.contains($0.0) }) {
                let ownership = try session.rows(
                    """
                    SELECT id, account_id FROM transactions WHERE id IN \
                    (SELECT value FROM json_each(?)) ORDER BY id
                    """, [.text(JSValue.array([.int(id.rawValue)]).jsonText)])
                var accountIds = Set(ownership.compactMap { try? $0.optionalInt64("account_id") })
                if let targetAccount { accountIds.insert(Int64(targetAccount)) }
                guard !accountIds.isEmpty else { return false }
                let accounts = try session.rows(
                    """
                    SELECT id, is_active FROM accounts WHERE id IN \
                    (SELECT value FROM json_each(?)) ORDER BY id
                    """, [.text(JSValue.array(accountIds.sorted().map { .int(Int($0)) }).jsonText)])
                if accounts.count != accountIds.count
                    || accounts.contains(where: { (try? $0.bool("is_active")) != true })
                {
                    throw BackendHTTPError.validation(
                        "Reopen the account before changing its ledger balance")
                }
            }
            // The canonical account identity, checked on every PATCH that carries it.
            if let index = sanitized.firstIndex(where: { $0.0 == "account_id" }) {  // lint:allow string-literal-compare the column key is a TypeScript literal
                if case .number(let number)? = sanitized[index].1, number != 0, number.isFinite {
                    let active = try session.row(
                        "SELECT id FROM accounts WHERE id = ? AND is_active = 1",
                        [.real(number)])
                    if active == nil {
                        throw BackendHTTPError.validation(
                            "account_id must reference an active account")
                    }
                }
            }
            var changes: [(String, SQLValue)] = []
            for (key, value) in sanitized {
                let column = key == "transaction_date" ? "date" : key  // lint:allow string-literal-compare the column key is a TypeScript literal
                if key == "amount" {  // lint:allow string-literal-compare the column key is a TypeScript literal
                    changes.append((column, try decimalText(value)))
                } else if key == "is_active" {  // lint:allow string-literal-compare the column key is a TypeScript literal
                    if let flag = try SQLBooleanInput.read(value) {
                        changes.append((column, .integer(flag ? 1 : 0)))
                    } else {
                        changes.append((column, .null))
                    }
                } else if key == "transaction_date" || key == "date" {  // lint:allow string-literal-compare the column keys are the TypeScript literals
                    if let text = value.stringValue {
                        changes.append((column, .text(try session.time.dateInputText(text))))
                    } else {
                        changes.append((column, try looseSQL(value)))
                    }
                } else {
                    changes.append((column, try looseSQL(value)))
                }
            }
            if !changes.isEmpty {
                let assignments = changes.map { "\($0.0) = ?" }.joined(separator: ", ")
                let updated = try session.rows(
                    """
                    UPDATE transactions SET \(assignments), updated_at = now() \
                    WHERE id = ? RETURNING id
                    """, changes.map(\.1) + [id.sqlValue])
                guard !updated.isEmpty else { return false }
            } else {
                let exists = try session.row("SELECT id FROM transactions WHERE id = ?", [id.sqlValue])
                guard exists != nil else { return false }
            }
            if let tags {
                try setTransactionTags(session, id, tags)
            }
            return true
        }
        guard found else { throw BackendHTTPError.notFound("Transaction with ID \(id.rawValue) not found") }
        return HandlerResult(data: try getById(session, id)?.json ?? .null)
    }

    // MARK: - DELETE /:id (port 11)

    /// DELETE `/:id`: `hardDeleteWithCleanup` — the planned-execution guard refuses a
    /// linked row, then the attachments' paths are collected before the CASCADE, the row
    /// goes, and the stored files are unlinked best-effort.
    static func delete(_ session: BackendSession, id: TransactionID) throws -> HandlerResult {
        let paths = try session.rows(
            "SELECT stored_path FROM attachments WHERE transaction_id = ?", [id.sqlValue])
        let deleted = try session.transaction { () throws -> Int? in
            let linked = try session.row(
                """
                SELECT 1 FROM planned_transaction_executions \
                WHERE executed_transaction_id IN (SELECT value FROM json_each(?)) LIMIT 1
                """, [.text(JSValue.array([.int(id.rawValue)]).jsonText)])
            if linked != nil {
                throw BackendHTTPError.conflict(
                    "A selected transaction is linked to a planned payment. Remove that planned payment explicitly before deleting the transaction")
            }
            let removed = try session.rows(
                "DELETE FROM transactions WHERE id = ? RETURNING id", [id.sqlValue])
            return removed.isEmpty ? nil : try removed[0].integerId("id")
        }
        guard deleted != nil else { throw BackendHTTPError.notFound("Transaction with ID \(id.rawValue) not found") }
        for row in paths {
            if let path = try row.optionalText("stored_path") {
                try? FileManager.default.removeItem(atPath: path)
            }
        }
        return HandlerResult.noContent
    }
}
