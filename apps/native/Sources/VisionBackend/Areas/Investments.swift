import Foundation
import VisionNativeCore

/// A `portfolio_transactions` row as `mapPortfolioTxRow` emits it (`portfolioTxRepo.reads.ts`):
/// the NUMERIC text columns as JavaScript numbers, the DATE columns as calendar-day strings, and
/// the dedup columns dropped from the public shape.
struct PortfolioTxRow: Equatable, Sendable {
    let id: Int
    let investmentId: InvestmentID
    let type: String
    let date: String
    let amount: Double
    let units: Double?
    let pricePerUnit: Double?
    let fees: Double?
    let taxes: Double?
    let currency: String
    let fxRateToEur: Double?
    let note: String?
    let isRecurring: Bool
    let recurrenceInterval: String?
    let recurrenceEndDate: String?
    let createdAt: Instant
    let updatedAt: Instant
    let accountId: AccountID?
    let importBatchId: Int64?
    let dividendAmountConvention: String
    let incomeRecognitionRole: String

    init(_ row: SQLRow) throws {
        id = try row.integerId("id")
        investmentId = InvestmentID(rawValue: try row.integerId("investment_id"))
        type = try row.text("type")
        date = try row.text("date")
        amount = JavaScriptNumber.fromString(try row.text("amount"))
        units = try row.optionalDoubleText("units")
        pricePerUnit = try row.optionalDoubleText("price_per_unit")
        fees = try row.optionalDoubleText("fees")
        taxes = try row.optionalDoubleText("taxes")
        currency = try row.text("currency")
        fxRateToEur = try row.optionalDoubleText("fx_rate_to_eur")
        note = try row.optionalText("note")
        isRecurring = try row.bool("is_recurring")
        recurrenceInterval = try row.optionalText("recurrence_interval")
        recurrenceEndDate = try row.optionalText("recurrence_end_date")
        createdAt = try row.instant("created_at")
        updatedAt = try row.instant("updated_at")
        accountId = try row.optionalIntegerId("account_id").map { AccountID(rawValue: $0) }
        importBatchId = try row.optionalInt64("import_batch_id")
        dividendAmountConvention = try row.text("dividend_amount_convention")
        incomeRecognitionRole = try row.text("income_recognition_role")
    }

    /// The row as `res.json` writes it, the checked row schema's column order.
    var json: [String: JSONValue] {
        [
            "id": .int(id),
            "investment_id": .int(investmentId.rawValue),
            "type": .string(type),
            "date": .string(date),
            "amount": InvestmentsArea.jsNumber(amount),
            "units": units.map(InvestmentsArea.jsNumber) ?? .null,
            "price_per_unit": pricePerUnit.map(InvestmentsArea.jsNumber) ?? .null,
            "fees": fees.map(InvestmentsArea.jsNumber) ?? .null,
            "taxes": taxes.map(InvestmentsArea.jsNumber) ?? .null,
            "currency": .string(currency),
            "fx_rate_to_eur": fxRateToEur.map(InvestmentsArea.jsNumber) ?? .null,
            "note": note.map(JSONValue.string) ?? .null,
            "is_recurring": .bool(isRecurring),
            "recurrence_interval": recurrenceInterval.map(JSONValue.string) ?? .null,
            "recurrence_end_date": recurrenceEndDate.map(JSONValue.string) ?? .null,
            "created_at": .string(createdAt.text),
            "updated_at": .string(updatedAt.text),
            "account_id": accountId.map { JSONValue.int($0.rawValue) } ?? .null,
            // BIGINT as the decimal string `dbBigint` parses, which the client requires.
            "import_batch_id": importBatchId.map { JSONValue.string(String($0)) } ?? .null,
            "dividend_amount_convention": .string(dividendAmountConvention),
            "income_recognition_role": .string(incomeRecognitionRole),
        ]
    }
}

/// `routes/investments.ts`, `services/investmentService.ts`, `repositories/investmentRepository.ts`
/// and `portfolioTxRepo.reads.ts` for the read operations the app calls whose path cannot collide
/// with an unported one: `getInvestments`, `getInvestmentSummary`, `getInvestmentTransactions`,
/// `getBulkPortfolioTransactions` and `listInvestmentProviders`.
///
/// `getInvestment` (GET /api/investments/{id}) is deliberately NOT registered yet: its template
/// would capture the unported `GET /api/investments/exposure` as an `id` and answer a 400 the
/// TypeScript router never sends (its fixed `/exposure` route wins there). It lands together with
/// the exposure reads, which need the portfolio summary core.
///
/// Bun keeps two 60 s in-memory response caches over these reads (`investmentsCache`,
/// `bulkTxnCache`), cleared by every TypeScript write over the same tables. They are not ported:
/// Swift reads fresh (ADR-270 decision 4), like the TS list count cache before them.
enum InvestmentsArea {
    static func register(_ backend: inout InProcessBackend, database: BackendDatabase) {
        backend.serve(OpenAPIOperations.GetInvestments.self) { request in
            let options = try InvestmentsArea.listQuery(request)
            return try await database.run { session in try InvestmentsArea.list(session, options) }
        }
        backend.serve(OpenAPIOperations.GetInvestmentSummary.self) { request in
            let id = try InvestmentsArea.pathId(request)
            return try await database.run { session in
                HandlerResult(data: .object(try InvestmentsArea.summary(session, id)))
            }
        }
        backend.serve(OpenAPIOperations.GetInvestmentTransactions.self) { request in
            let id = try InvestmentsArea.pathId(request)
            let options = try InvestmentsArea.transactionsQuery(request, id)
            return try await database.run { session in try InvestmentsArea.transactions(session, options) }
        }
        backend.serve(OpenAPIOperations.GetBulkPortfolioTransactions.self) { request in
            let options = try InvestmentsArea.bulkQuery(request)
            return try await database.run { session in try InvestmentsArea.bulk(session, options) }
        }
        backend.serve(OpenAPIOperations.ListInvestmentProviders.self) { _ in
            HandlerResult(data: .object([
                "providers": .array(providers.map { provider in
                    .object([
                        "key": .string(provider.key), "name": .string(provider.name),
                        "description": .string(provider.description),
                    ])
                })
            ]))
        }
    }

    // MARK: - Request input

    /// A query parameter as Express's parser holds it: absent, one string, or the array of a
    /// repeated key.
    static func raw(_ request: InProcessRequest, _ key: String) -> JSValue? {
        let values = request.queryItems.filter { $0.name == key }.map { JSValue.string($0.value ?? "") }
        if values.isEmpty { return nil }
        return values.count == 1 ? values[0] : .array(values)
    }

    /// `singleQueryString`: one string or absent; every other shape is the zod issue
    /// `<field>: must be a single value`.
    static func singleQuery(
        _ request: InProcessRequest, _ field: String, _ issues: inout [String]
    ) -> String? {
        switch raw(request, field) {
        case .string(let text)?: return text
        case nil: return nil
        default: issues.append("\(field): must be a single value"); return nil
        }
    }

    /// `parseRequest({ params: idParams })`: the `id`, else the 400 `id: must be a positive
    /// integer` (the zod params gate, whose message carries the field name).
    static func pathId(_ request: InProcessRequest) throws -> InvestmentID {
        guard let raw = request.pathParameters["id"], let id = RequestID.valid(.string(raw)) else {
            throw BackendHTTPError.validation("id: must be a positive integer")
        }
        return InvestmentID(rawValue: Int(id))
    }

    /// `parseDefaultListOptions`: `parsePagination` with the route's bounds, the single-string
    /// `asset_class`, and the boolean `active`.
    static func listQuery(_ request: InProcessRequest) throws -> ListOptions {
        var issues: [String] = []
        let assetClass = singleQuery(request, "asset_class", &issues)
        if !issues.isEmpty { throw BackendHTTPError.validation(issues.joined(separator: "; ")) }
        return ListOptions(
            limit: JavaScriptInteger.clamped(request.query("limit"), min: 1, max: 1000, fallback: 200),
            offset: JavaScriptInteger.clamped(request.query("offset"), min: 0, fallback: 0),
            assetClass: assetClass.flatMap { $0.isEmpty ? nil : $0 },
            active: QueryInput.boolean(request.query("active"), default: true))
    }

    /// `parseInvestmentTransactionsOptions`: the same pagination with the route's own ceilings.
    static func transactionsQuery(
        _ request: InProcessRequest, _ id: InvestmentID
    ) throws -> TransactionsOptions {
        var issues: [String] = []
        let type = singleQuery(request, "type", &issues)
        if !issues.isEmpty { throw BackendHTTPError.validation(issues.joined(separator: "; ")) }
        return TransactionsOptions(
            investmentId: id,
            type: type.flatMap { $0.isEmpty ? nil : $0 },
            limit: JavaScriptInteger.clamped(request.query("limit"), min: 1, max: 1000, fallback: 200),
            offset: JavaScriptInteger.clamped(request.query("offset"), min: 0, fallback: 0))
    }

    /// `getBulkTransactions`: the route's query gate first (its zod issues answer before the
    /// handler runs), then the required `investment_ids` with `validateIntArray`'s accept set
    /// (a plain base-10 digit string per element, 1..2^31-1; one bad element rejects the list),
    /// the repository's dedupe, then `parseBulkTransactionsOptions`.
    static func bulkQuery(_ request: InProcessRequest) throws -> BulkOptions {
        var issues: [String] = []
        let type = singleQuery(request, "type", &issues)
        if !issues.isEmpty { throw BackendHTTPError.validation(issues.joined(separator: "; ")) }

        guard let rawIds = request.query("investment_ids"), !rawIds.isEmpty else {
            throw BackendHTTPError.validation("investment_ids is required")
        }
        var ids: [InvestmentID] = []
        for element in rawIds.split(separator: ",", omittingEmptySubsequences: false) {
            guard let id = RequestID.valid(.string(String(element))) else {
                throw BackendHTTPError.validation("investment_ids contains invalid value: \(element)")
            }
            ids.append(InvestmentID(rawValue: Int(id)))
        }
        // `normalizeInvestmentIds`: the `json_each` predicate wants distinct ids.
        var distinct: [InvestmentID] = []
        for id in ids where !distinct.contains(id) { distinct.append(id) }

        // `limit` stays opt-in (absent or empty means no outer LIMIT); anything else runs the
        // `parsePagination` clamp whose fallback of 1 keeps the previous `|| 1` behavior.
        let rawLimit = request.query("limit")
        let limit: Int?
        if rawLimit == nil || rawLimit == "" {  // lint:allow string-literal-compare Node querystring's empty string, not a content comparison
            limit = nil
        } else {
            limit = JavaScriptInteger.clamped(rawLimit, min: 1, max: 200_000, fallback: 1).intValue
        }
        return BulkOptions(
            investmentIds: distinct,
            type: type.flatMap { $0.isEmpty ? nil : $0 },
            perInvestmentLimit: Int(
                JavaScriptInteger.clamped(
                    request.query("per_investment_limit"), min: 1, max: 5000, fallback: 1000
                ).value),
            limit: limit,
            offset: JavaScriptInteger.clamped(request.query("offset"), min: 0, fallback: 0).intValue)
    }

    // MARK: - The parsed options

    struct ListOptions {
        let limit: JavaScriptInteger
        let offset: JavaScriptInteger
        let assetClass: String?
        let active: Bool
    }

    struct TransactionsOptions {
        let investmentId: InvestmentID
        let type: String?
        let limit: JavaScriptInteger
        let offset: JavaScriptInteger
    }

    struct BulkOptions {
        let investmentIds: [InvestmentID]
        let type: String?
        let perInvestmentLimit: Int
        let limit: Int?
        let offset: Int
    }

    // MARK: - Reads

    /// `investmentRepository.getAllWithCount` over the ticker-preference join: the window count,
    /// `ORDER BY i.name`, the same bound arguments.
    static func list(_ session: BackendSession, _ options: ListOptions) throws -> HandlerResult {
        var filters = ""
        var arguments: [SQLValue] = []
        if options.active {
            filters = " WHERE i.is_active = 1"
        }
        if let assetClass = options.assetClass {
            filters += filters.isEmpty ? " WHERE" : " AND"
            filters += " i.asset_class = ?"
            arguments.append(.text(assetClass))
        }
        let rows = try session.rows(
            """
            SELECT i.*, COALESCE(tp.show_in_ticker, 1) AS show_in_ticker,
                   CAST(COUNT(*) OVER () AS TEXT) AS total_count
            FROM investments i LEFT JOIN investment_ticker_prefs tp ON tp.investment_id = i.id\
            \(filters) ORDER BY i.name LIMIT ? OFFSET ?
            """,
            arguments + [options.limit.sqlValue, options.offset.sqlValue])
        let total = try rows.first.map { Int(try $0.text("total_count")) ?? 0 } ?? 0
        return HandlerResult(data: .object([
            "items": .array(try rows.map { .object(try investmentJson($0)) }),
            "total": .int(total),
            "limit": options.limit.json,
            "offset": options.offset.json,
            "links": .array([]),
        ]))
    }

    /// `portfolioTransactionRepository.getSummary`: exact NUMERIC `dec_sum` totals per
    /// (type, income_recognition_role) group, emitted with `Number()` coercion. A missing
    /// investment is not a 404 here: the breakdown of nothing is empty.
    static func summary(_ session: BackendSession, _ id: InvestmentID) throws -> [String: JSONValue] {
        let rows = try session.rows(
            """
            SELECT type, income_recognition_role,
                   dec_sum(amount) AS total_amount, dec_sum(units) AS total_units,
                   dec_sum(fees) AS total_fees, dec_sum(taxes) AS total_taxes,
                   CAST(count(*) AS TEXT) AS count
            FROM portfolio_transactions WHERE investment_id = ?
            GROUP BY type, income_recognition_role
            """,
            [.integer(Int64(id.rawValue))])
        return [
            "investment_id": .int(id.rawValue),
            "breakdown": .array(try rows.map { row in
                .object([
                    "type": .string(try row.text("type")),
                    "income_recognition_role": .string(try row.text("income_recognition_role")),
                    "total_amount": jsNumber(try row.text("total_amount")),
                    "total_units": try row.optionalDoubleText("total_units").map(jsNumber) ?? .null,
                    "total_fees": try row.optionalDoubleText("total_fees").map(jsNumber) ?? .null,
                    "total_taxes": try row.optionalDoubleText("total_taxes").map(jsNumber) ?? .null,
                    "count": .int(Int(try row.text("count")) ?? 0),
                ])
            }),
        ]
    }

    /// `listTransactions`: `getAllWithCount`, its window count and the `ORDER BY pt.date DESC,
    /// pt.id DESC` ordering, with the route's pagination defaults.
    static func transactions(
        _ session: BackendSession, _ options: TransactionsOptions
    ) throws -> HandlerResult {
        var filters = " WHERE pt.investment_id = ?"
        var arguments: [SQLValue] = [.integer(Int64(options.investmentId.rawValue))]
        if let type = options.type {
            filters += " AND pt.type = ?"
            arguments.append(.text(type))
        }
        let rows = try session.rows(
            """
            SELECT pt.*, CAST(COUNT(*) OVER () AS TEXT) AS total_count
            FROM portfolio_transactions pt\(filters) ORDER BY pt.date DESC, pt.id DESC LIMIT ? OFFSET ?
            """,
            arguments + [options.limit.sqlValue, options.offset.sqlValue])
        let total = try rows.first.map { Int(try $0.text("total_count")) ?? 0 } ?? 0
        return HandlerResult(data: .object([
            "items": .array(try rows.map { .object(try PortfolioTxRow($0).json) }),
            "total": .int(total),
            "limit": options.limit.json,
            "offset": options.offset.json,
            "links": .array([]),
        ]))
    }

    /// `getBulkTransactions`: the per-investment `ROW_NUMBER()` window over `json_each`-bound
    /// ids, the `rn <= per_investment_limit` CTE, then the joined replay ordered and paged
    /// (SQLite has no OFFSET without LIMIT, so "no limit" is `LIMIT -1`), plus the separate
    /// full count of the same filter.
    static func bulk(_ session: BackendSession, _ options: BulkOptions) throws -> HandlerResult {
        let idsJSON = "[" + options.investmentIds.map { String($0.rawValue) }.joined(separator: ",") + "]"
        var typeClause = ""
        var typeArguments: [SQLValue] = []
        if let type = options.type {
            typeClause = " AND pt.type = ?"
            typeArguments.append(.text(type))
        }
        let rows = try session.rows(
            """
            WITH ranked AS (SELECT pt.id AS id, ROW_NUMBER() OVER (PARTITION BY pt.investment_id \
            ORDER BY pt.date DESC, pt.id DESC) AS rn FROM portfolio_transactions pt \
            WHERE pt.investment_id IN (SELECT value FROM json_each(?))\(typeClause)), \
            limited AS (SELECT id FROM ranked WHERE rn <= ?)
            SELECT pt.* FROM portfolio_transactions pt INNER JOIN limited AS l ON l.id = pt.id \
            ORDER BY pt.date DESC, pt.id DESC LIMIT ? OFFSET ?
            """,
            [.text(idsJSON)] + typeArguments
                + [.integer(Int64(options.perInvestmentLimit)),
                   .integer(Int64(options.limit ?? -1)), .integer(Int64(options.offset))])
        var countFilters = " investment_id IN (SELECT value FROM json_each(?))"
        if options.type != nil { countFilters += " AND type = ?" }
        let count = try session.row(
            "SELECT CAST(count(*) AS TEXT) AS count FROM portfolio_transactions WHERE\(countFilters)",
            options.type.map { type in [.text(idsJSON), .text(type)] } ?? [.text(idsJSON)])
        let total = try TagsArea.countValue(count, "portfolio transaction count")
        let items = try rows.map { try PortfolioTxRow($0).json }
        return HandlerResult(data: .object([
            "items": .array(items.map { .object($0) }),
            "total": .int(total),
            "limit": options.limit.map(JSONValue.int) ?? .int(items.count),
            "offset": .int(options.offset),
            "links": .array([]),
        ]))
    }

    // MARK: - Number emission

    /// `Number()` of a stored NUMERIC text: the same double the envelope then prints.
    static func jsNumber(_ text: String) -> JSONValue {
        JSValue.number(JavaScriptNumber.fromString(text)).envelopeValue
    }

    static func jsNumber(_ value: Double) -> JSONValue {
        JSValue.number(value).envelopeValue
    }

    /// `mapInvestmentRow`: the four NUMERIC columns as `Number()` of the stored text (NULL stays
    /// NULL), both timestamps as the canonical text, `show_in_ticker` from the join, in the
    /// checked row schema's column order.
    static func investmentJson(_ row: SQLRow) throws -> [String: JSONValue] {
        [
            "id": .int(try row.integerId("id")),
            "name": .string(try row.text("name")),
            "symbol": try row.optionalText("symbol").map(JSONValue.string) ?? .null,
            "asset_class": .string(try row.text("asset_class")),
            "currency": .string(try row.text("currency")),
            "current_price": try row.optionalDoubleText("current_price").map(jsNumber) ?? .null,
            "interest_rate": try row.optionalDoubleText("interest_rate").map(jsNumber) ?? .null,
            "maturity_date": try row.optionalText("maturity_date").map(JSONValue.string) ?? .null,
            "location": try row.optionalText("location").map(JSONValue.string) ?? .null,
            "municipality": try row.optionalText("municipality").map(JSONValue.string) ?? .null,
            "cadastral_income": try row.optionalDoubleText("cadastral_income").map(jsNumber) ?? .null,
            "municipality_tax_rate": try row.optionalDoubleText("municipality_tax_rate").map(jsNumber) ?? .null,
            "notes": try row.optionalText("notes").map(JSONValue.string) ?? .null,
            "is_active": .bool(try row.bool("is_active")),
            "price_provider": .string(try row.text("price_provider")),
            "price_provider_id": try row.optionalText("price_provider_id").map(JSONValue.string) ?? .null,
            "price_provider_url": try row.optionalText("price_provider_url").map(JSONValue.string) ?? .null,
            "price_provider_latest_url": try row.optionalText("price_provider_latest_url").map(JSONValue.string) ?? .null,
            "price_provider_latest_path": try row.optionalText("price_provider_latest_path").map(JSONValue.string) ?? .null,
            "price_provider_history_url": try row.optionalText("price_provider_history_url").map(JSONValue.string) ?? .null,
            "price_provider_history_path": try row.optionalText("price_provider_history_path").map(JSONValue.string) ?? .null,
            "price_provider_history_ts_path": try row.optionalText("price_provider_history_ts_path").map(JSONValue.string) ?? .null,
            "price_provider_history_price_path": try row.optionalText("price_provider_history_price_path").map(JSONValue.string) ?? .null,
            "price_updated_at": try row.instantOrNil("price_updated_at").map { .string($0.text) } ?? .null,
            "created_at": .string(try row.instant("created_at").text),
            "updated_at": .string(try row.instant("updated_at").text),
            "show_in_ticker": .bool(try row.bool("show_in_ticker")),
        ]
    }
}

/// `listProviders`: `SUPPORTED_PROVIDERS` of `priceProviderService.ts`, its order.
private let providers: [(key: String, name: String, description: String)] = [
    ("manual", "Manual", "Set price manually"),
    ("binance", "Binance", "Free crypto prices (use symbol, e.g. \"BTCUSDT\", \"ETHUSDT\", \"BNBEUR\")"),
    ("yahoo", "Yahoo Finance", "Stocks, ETFs & metals (use ticker, e.g. \"AAPL\", \"VWCE.DE\", \"GC=F\")"),
    ("custom", "Custom JSON", "Any JSON endpoint with a configurable price path"),
    ("kinesis", "Kinesis", "Precious metals & commodities (use symbol, e.g. \"KAU_USD\", \"XAU_USD\", \"XAG_USD\")"),
]

extension SQLRow {
    /// A NUMERIC text column the emitted row converts with `Number()`: NULL stays NULL.
    func optionalDoubleText(_ column: String) throws -> Double? {
        try optionalText(column).map { JavaScriptNumber.fromString($0) }
    }

    /// An `INTEGER` column the emitted row shows as an optional JSON number.
    func optionalIntegerId(_ column: String) throws -> Int? {
        guard let value = try optionalInt64(column) else { return nil }
        guard let id = Int(exactly: value) else {
            throw SQLRowDecodingError(column: column, problem: "id \(value) is out of range")
        }
        return id
    }

    func instantOrNil(_ column: String) throws -> Instant? {
        try optionalText(column).map { text in
            guard let iso = Self.isoMilliseconds(fromCanonical: text), let instant = Instant(iso) else {
                throw SQLRowDecodingError(column: column, problem: "\(text) is not a canonical timestamp")
            }
            return instant
        }
    }
}
