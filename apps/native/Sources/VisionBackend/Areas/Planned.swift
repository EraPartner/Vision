import Foundation
import VisionNativeCore

/// A `planned_transactions` row with `selectPlannedFields`'s join columns, plus the
/// sub-collections `hydratePlannedRow` / `getAll` attach (`HydratedPlannedTransactionRow`).
struct PlannedRow: Sendable {
    /// `plannedExecutionRowSchema`: a row of `planned_transaction_executions`.
    struct Execution: Sendable {
        let id: Int
        let executedTransactionId: TransactionID
        let executionDate: String
        let createdAt: Instant?

        init(_ row: SQLRow) throws {
            id = try row.integerId("id")
            executedTransactionId = TransactionID(rawValue: try row.integerId("executed_transaction_id"))
            executionDate = try row.text("execution_date")
            if try row.optionalText("created_at") != nil { createdAt = try row.instant("created_at") } else {
                createdAt = nil
            }
        }
    }

    /// `loanScheduleRowSchema`: one installment of `planned_transaction_loan_schedule`.
    struct Installment: Sendable {
        let installmentNumber: Int
        let dueDate: String
        let paymentAmount: String
        let principalAmount: String
        let interestAmount: String
        let remainingPrincipal: String

        init(_ row: SQLRow) throws {
            installmentNumber = try row.integerId("installment_number")
            dueDate = try row.text("due_date")
            paymentAmount = try row.text("payment_amount")
            principalAmount = try row.text("principal_amount")
            interestAmount = try row.text("interest_amount")
            remainingPrincipal = try row.text("remaining_principal")
        }
    }

    /// `transactionTagRefSchema`: a tag attached to the row.
    struct Tag: Sendable {
        let id: Int
        let slug: String
        let color: String?
        let isActive: Bool

        init(_ row: SQLRow) throws {
            id = try row.integerId("id")
            slug = try row.text("slug")
            color = try row.optionalText("color")
            isActive = try row.bool("is_active")
        }

        var json: JSONValue {
            .object([
                "id": .int(id), "slug": .string(slug), "color": color.map(JSONValue.string) ?? .null,
                "is_active": .bool(isActive),
            ])
        }
    }

    let id: PlannedTransactionID
    let plannedDate: String
    let accountId: AccountID?
    let bankAccount: String?
    let recipientId: RecipientID?
    let recipientName: String?
    let amount: String
    let currency: String?
    let categoryId: CategoryID?
    let categoryName: String?
    let comment: String?
    let url: String?
    let isRecurring: Bool
    let recurrencePattern: String?
    let recurrenceEndDate: String?
    let maxOccurrences: Int?
    let reminderDaysBefore: Int?
    let isLoan: Bool
    let loanType: String?
    let loanPrincipal: String?
    let loanAnnualInterestRate: String?
    let loanTermMonths: Int?
    let loanStartDate: String?
    let loanPaymentDay: Int?
    let loanRegularPaymentAmount: String?
    let loanFirstPaymentDate: String?
    let isExecuted: Bool
    let lastExecutedDate: String?
    let isActive: Bool
    let createdAt: Instant?
    let updatedAt: Instant?
    let memo: String?

    var executions: [Execution] = []
    var executionCount: Int?
    var executedTransactionId: TransactionID?
    var loanSchedule: [Installment] = []
    var tags: [Tag] = []

    init(_ row: SQLRow) throws {
        func optionalId(_ column: String) throws -> Int? {
            guard let value = try row.optionalInt64(column) else { return nil }
            return Int(exactly: value)
        }
        func timestamp(_ column: String) throws -> Instant? {
            guard try row.optionalText(column) != nil else { return nil }
            return try row.instant(column)
        }
        id = PlannedTransactionID(rawValue: try row.integerId("id"))
        plannedDate = try row.text("planned_date")
        accountId = try optionalId("account_id").map { AccountID(rawValue: $0) }
        bankAccount = try row.optionalText("bank_account")
        recipientId = try optionalId("recipient_id").map { RecipientID(rawValue: $0) }
        recipientName = try row.optionalText("recipient_name")
        amount = try row.text("amount")
        currency = try row.optionalText("currency")
        categoryId = try optionalId("category_id").map { CategoryID(rawValue: $0) }
        categoryName = try row.optionalText("category_name")
        comment = try row.optionalText("comment")
        url = try row.optionalText("url")
        isRecurring = try row.bool("is_recurring")
        recurrencePattern = try row.optionalText("recurrence_pattern")
        recurrenceEndDate = try row.optionalText("recurrence_end_date")
        maxOccurrences = try optionalId("max_occurrences")
        reminderDaysBefore = try optionalId("reminder_days_before")
        isLoan = try row.bool("is_loan")
        loanType = try row.optionalText("loan_type")
        loanPrincipal = try row.optionalText("loan_principal")
        loanAnnualInterestRate = try row.optionalText("loan_annual_interest_rate")
        loanTermMonths = try optionalId("loan_term_months")
        loanStartDate = try row.optionalText("loan_start_date")
        loanPaymentDay = try optionalId("loan_payment_day")
        loanRegularPaymentAmount = try row.optionalText("loan_regular_payment_amount")
        loanFirstPaymentDate = try row.optionalText("loan_first_payment_date")
        isExecuted = try row.bool("is_executed")
        lastExecutedDate = try row.optionalText("last_executed_date")
        isActive = try row.bool("is_active")
        createdAt = try timestamp("created_at")
        updatedAt = try timestamp("updated_at")
        memo = try row.optionalText("memo")
    }

    /// `toNumber(toDecimal(text))`, or nil for a NULL column.
    static func money(_ text: String?) throws -> JSONValue? {
        guard let text else { return nil }
        return JSValue.number(try DecimalJS.from(text).toNumber).envelopeValue
    }

    /// `ymd`: a DATE value as the calendar-day string it stores.
    static func date(_ value: String?) -> JSONValue { value.map(JSONValue.string) ?? .null }

    /// `parseInt(String(value), 10)` of an INTEGER column.
    static func integer(_ value: Int?) -> JSONValue { value.map(JSONValue.int) ?? .null }

    /// `formatPlannedTransaction` at the end of `routes/plannedTransactions.ts`.
    var json: JSONValue {
        func text(_ value: String?) -> JSONValue { value.map(JSONValue.string) ?? .null }
        func nonEmpty(_ value: String?) -> JSONValue {
            value.flatMap { $0.isEmpty ? nil : JSONValue.string($0) } ?? .null
        }
        func money(_ amount: String?) -> JSONValue { (try? PlannedRow.money(amount)) ?? .null }
        var fields: [String: JSONValue] = [
            "id": .int(id.rawValue),
            "planned_date": PlannedRow.date(plannedDate),
            "account_id": accountId.map { JSONValue.int($0.rawValue) } ?? .null,
            "bank_account": text(bankAccount),
            "recipient_id": recipientId.map { JSONValue.int($0.rawValue) } ?? .null,
            "recipient_name": nonEmpty(recipientName),
            "memo": text(memo),
            "amount": money(amount),
            "currency": text(currency),
            "category_id": categoryId.map { JSONValue.int($0.rawValue) } ?? .null,
            "category_name": nonEmpty(categoryName),
            "comment": text(comment),
            "url": nonEmpty(url),
            "is_recurring": .bool(isRecurring),
            "recurrence_pattern": text(recurrencePattern),
            "recurrence_end_date": PlannedRow.date(recurrenceEndDate),
            "max_occurrences": PlannedRow.integer(maxOccurrences),
            "reminder_days_before": PlannedRow.integer(reminderDaysBefore),
            "is_executed": .bool(isExecuted),
            "last_executed_date": PlannedRow.date(lastExecutedDate),
            "is_loan": .bool(isLoan || false),
            "loan_type": nonEmpty(loanType),
            "loan_principal": money(loanPrincipal),
            "loan_annual_interest_rate": money(loanAnnualInterestRate),
            "loan_term_months": PlannedRow.integer(loanTermMonths),
            "loan_start_date": nonEmpty(loanStartDate),
            "loan_payment_day": PlannedRow.integer(loanPaymentDay),
            "loan_regular_payment_amount": money(loanRegularPaymentAmount),
            "loan_first_payment_date": nonEmpty(loanFirstPaymentDate),
        ]
        fields["loan_schedule"] = .array(loanSchedule.map { entry in
            .object([
                "installment_number": PlannedRow.integer(entry.installmentNumber),
                "due_date": PlannedRow.date(entry.dueDate),
                "payment_amount": money(entry.paymentAmount),
                "principal_amount": money(entry.principalAmount),
                "interest_amount": money(entry.interestAmount),
                "remaining_principal": money(entry.remainingPrincipal),
            ])
        })
        fields["executed_transaction_id"] = executedTransactionId.map { JSONValue.int($0.rawValue) } ?? .null
        fields["execution_count"] = .int(executionCount ?? 0)
        fields["executions"] = .array(executions.map { execution in
            .object([
                "id": .int(execution.id),
                "executed_transaction_id": .int(execution.executedTransactionId.rawValue),
                "execution_date": PlannedRow.date(execution.executionDate),
                "created_at": execution.createdAt.map { JSONValue.string($0.text) } ?? .null,
            ])
        })
        fields["tags"] = .array(tags.map(\.json))
        fields["is_active"] = .bool(isActive)
        fields["created_at"] = createdAt.map { JSONValue.string($0.text) } ?? .null
        fields["updated_at"] = updatedAt.map { JSONValue.string($0.text) } ?? .null
        fields["links"] = .array([])
        return .object(fields)
    }
}

/// `routes/plannedTransactions.ts` over `plannedTransactionService`,
/// `plannedExecutionService`, `plannedMatchService` and `plannedTotalsService`: the list,
/// the totals, the match suggestions, execute, delete and the write paths with the loan
/// schedule (create, update — port 10b).
enum PlannedArea {
    // MARK: - Registration

    static func register(_ backend: inout InProcessBackend, database: BackendDatabase) {
        backend.serve(OpenAPIOperations.GetPlannedTransactions.self) { request in
            let query = try PlannedArea.listQuery(request)
            let limit = JavaScriptInteger.clamped(request.query("limit"), min: 1, max: 5000, fallback: 50)
            let offset = JavaScriptInteger.clamped(request.query("offset"), min: 0, fallback: 0)
            return try await database.run { session in
                let page = try PlannedArea.getAll(
                    session, query, limit: Int(limit.value), offset: Int(offset.value))
                return HandlerResult(
                    data: .object([
                        "items": .array(page.0.map(\.json)),
                        "total": .int(page.1),
                        "limit": limit.json,
                        "offset": offset.json,
                        "links": .array([]),
                    ]))
            }
        }
        backend.serve(OpenAPIOperations.GetPlannedTotals.self) { request in
            let currency = try PlannedArea.totalsCurrency(request)
            return try await database.run { session in try PlannedArea.totals(session, currency: currency) }
        }
        backend.serve(OpenAPIOperations.GetPlannedMatchSuggestions.self) { _ in
            try await database.run { session in try PlannedArea.matchSuggestions(session) }
        }
        backend.serve(OpenAPIOperations.CreatePlannedTransaction.self) { request in
            let fields = try PlannedArea.createFields(request)
            return try await database.run { session in try PlannedArea.create(session, fields: fields) }
        }
        backend.serve(OpenAPIOperations.UpdatePlannedTransaction.self) { request in
            let id = try PlannedArea.pathId(request)
            return try await database.run { session in try PlannedArea.update(session, id: id, request: request) }
        }
        backend.serve(OpenAPIOperations.ExecutePlannedTransaction.self) { request in
            let id = try PlannedArea.pathId(request)
            let body = try PlannedArea.executeBody(request)
            return try await database.run { session in try PlannedArea.execute(session, id: id, body: body) }
        }
        backend.serve(OpenAPIOperations.DeletePlannedTransaction.self) { request in
            let id = try PlannedArea.pathId(request)
            return try await database.run { session in
                let deleted = try session.row(
                    "DELETE FROM planned_transactions WHERE id = ? RETURNING id", [PlannedArea.idValue(id)])
                guard deleted != nil else {
                    throw BackendHTTPError.notFound("Planned transaction \(id.rawValue) not found")
                }
                return HandlerResult.noContent
            }
        }
    }

    /// `validateIdParam` + `parseRouteId`: the path id as a planned transaction id.
    static func pathId(_ request: InProcessRequest) throws -> PlannedTransactionID {
        guard let raw = request.pathParameters["id"], let id = RequestID.valid(.string(raw)) else {
            throw BackendHTTPError.validation("id must be a positive integer")
        }
        return PlannedTransactionID(rawValue: Int(id))
    }

    static func idValue(_ id: PlannedTransactionID) -> SQLValue { .integer(Int64(id.rawValue)) }

    // MARK: - Shared SQL

    /// `plannedCategoryName`: the same three-level category resolution the transactions list
    /// uses (own → recipient default → primary-recipient default).
    static let categoryCase = """
    CASE
                       WHEN c.id IS NOT NULL THEN c.path_name
                       WHEN rc.id IS NOT NULL THEN rc.path_name
                       WHEN pc.id IS NOT NULL THEN pc.path_name
                       ELSE NULL
                     END
    """

    /// `plannedRecipientName`: the recipient cluster root, presentation-only.
    static let recipientNameSQL = "COALESCE(pr.name, r.name)"

    /// `plannedJoins`: the recipient chain, the three category levels and the account,
    /// whose name `bank_account` resolves to (ADR-088).
    static let joins = """
    LEFT JOIN recipients r ON pt.recipient_id = r.id
          LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
          LEFT JOIN categories c ON pt.category_id = c.id
          LEFT JOIN categories rc ON r.default_category_id = rc.id
          LEFT JOIN categories pc ON pr.default_category_id = pc.id
          LEFT JOIN accounts acct ON pt.account_id = acct.id
    """

    /// `selectPlannedFields`: `pt.*` plus the display columns.
    static let projection = """
    SELECT pt.*, acct.name AS bank_account, \(recipientNameSQL) AS recipient_name,
                   \(categoryCase) AS category_name
            FROM planned_transactions pt
            \(joins)
    """

    // MARK: - GET / (the list)

    /// `PlannedTransactionFilters`.
    struct Filters: Sendable {
        var startDate: String?
        var endDate: String?
        var bankAccount: String?
        var accountId: AccountID?
        var categoryId: CategoryID?
        var recipientId: RecipientID?
        var isRecurring: Bool?
        var isExecuted: Bool?
        var search: String?
        var active = true

        /// `filterPlannedTransactions`: the WHERE clauses in the repository's order.
        var clause: (sql: String, arguments: [SQLValue]) {
            var clauses: [String] = []
            var arguments: [SQLValue] = []
            if active { clauses.append("pt.is_active = 1") }
            if let startDate {
                clauses.append("pt.planned_date >= ts_date(?)")
                arguments.append(.text(startDate))
            }
            if let endDate {
                clauses.append("pt.planned_date <= ts_date(?)")
                arguments.append(.text(endDate))
            }
            if let accountId {
                clauses.append("pt.account_id = ?")
                arguments.append(.integer(Int64(accountId.rawValue)))
            } else if let bankAccount, !bankAccount.isEmpty {
                clauses.append("pt.account_id IN (SELECT fa.id FROM accounts as fa WHERE ilike(fa.name, ?))")
                arguments.append(.text("%\(bankAccount)%"))
            }
            if let categoryId {
                clauses.append(
                    "pt.category_id IN (SELECT category_id FROM category_ancestors WHERE ancestor_id = ?)")
                arguments.append(.integer(Int64(categoryId.rawValue)))
            }
            if let recipientId {
                clauses.append("pt.recipient_id = ?")
                arguments.append(.integer(Int64(recipientId.rawValue)))
            }
            if let isRecurring {
                clauses.append("pt.is_recurring = ?")
                arguments.append(.integer(isRecurring ? 1 : 0))
            }
            if let isExecuted {
                clauses.append("pt.is_executed = ?")
                arguments.append(.integer(isExecuted ? 1 : 0))
            }
            if let search, !search.isEmpty {
                clauses.append(
                    "(ilike(pt.memo, ?) OR ilike(pt.comment, ?) OR ilike(acct.name, ?) OR ilike(\(recipientNameSQL), ?) OR ilike(r.name, ?) OR ilike(\(categoryCase), ?))")
                let pattern = "%\(search)%"
                for _ in 0..<6 { arguments.append(.text(pattern)) }
            }
            return (clauses.joined(separator: " AND "), arguments)
        }
    }

    /// The GET query as the route builds it, in its throwing order: `bank_account`, then
    /// `search` (`optionalQueryString`), then `start_date`, `end_date` (`assertYmd`), then
    /// `account_id`, `category_id`, `recipient_id` (`assertOptionalId`).
    static func listQuery(_ request: InProcessRequest) throws -> Filters {
        func raw(_ key: String) -> JSValue? { TransactionsArea.raw(request, key) }
        func single(_ value: JSValue?, _ field: String) throws -> String? {
            guard let value else { return nil }
            guard case .string(let text) = value else {
                throw BackendHTTPError.validation("\(field) must be a single value")
            }
            return text
        }
        func optionalId(_ value: JSValue?, _ field: String) throws -> Int {
            guard let value, value != .null, value != .string("") else { throw MissingId(field: field) }
            guard let id = RequestID.valid(value) else {
                throw BackendHTTPError.validation("\(field) must be a positive integer")
            }
            return Int(id)
        }
        struct MissingId: Error { let field: String }
        var issues: [String] = []
        var filters = Filters()
        filters.bankAccount = try single(raw("bank_account"), "bank_account")
        let search = try single(raw("search"), "search")
        filters.startDate = TransactionsArea.ymd(raw("start_date"), "start_date", &issues)
        if let issue = issues.first { throw BackendHTTPError.validation(issue) }
        issues = []
        filters.endDate = TransactionsArea.ymd(raw("end_date"), "end_date", &issues)
        if let issue = issues.first { throw BackendHTTPError.validation(issue) }
        let assign: [String: (Int) -> Void] = [
            "account_id": { filters.accountId = AccountID(rawValue: $0) },
            "category_id": { filters.categoryId = CategoryID(rawValue: $0) },
            "recipient_id": { filters.recipientId = RecipientID(rawValue: $0) },
        ]
        for (field, set) in assign {
            guard let value = raw(field), value != .null, value != .string("") else { continue }
            guard let id = RequestID.valid(value) else {
                throw BackendHTTPError.validation("\(field) must be a positive integer")
            }
            set(Int(id))
        }
        if let recurring = raw("is_recurring") {
            filters.isRecurring = QueryInput.boolean(recurring.javaScriptString, default: false)
        }
        if let executed = raw("is_executed") {
            filters.isExecuted = QueryInput.boolean(executed.javaScriptString, default: false)
        }
        if let search, !search.isEmpty {
            filters.search = String(decoding: Array(search.utf16.prefix(200)), as: UTF16.self)
        }
        filters.active = QueryInput.boolean(request.query("active"), default: true)
        return filters
    }

    /// The rows of a batched sub-collection load, keyed by their planned transaction.
    static func grouped(_ rows: [SQLRow], _ key: String) throws -> [Int: [SQLRow]] {
        var grouped: [Int: [SQLRow]] = [:]
        for row in rows { grouped[try row.integerId(key), default: []].append(row) }
        return grouped
    }

    /// `plannedTransactionRepository.getAll`: the page with `COUNT(*) OVER()`, then the
    /// executions, the loan schedules of the loan rows and the tags of the page's rows,
    /// with the filtered count as the empty page's fallback.
    static func getAll(
        _ session: BackendSession, _ filters: Filters, limit: Int, offset: Int
    ) throws -> ([PlannedRow], Int) {
        let clause = filters.clause
        let whereSQL = clause.sql.isEmpty ? "" : " WHERE \(clause.sql)"
        var arguments = clause.arguments
        arguments += [.integer(Int64(limit)), .integer(Int64(offset))]
        let page = try session.rows(
            """
            SELECT pt.*, acct.name AS bank_account, \(recipientNameSQL) AS recipient_name,
                   \(categoryCase) AS category_name,
                   CAST(COUNT(*) OVER () AS TEXT) AS total_count
            FROM planned_transactions pt
            \(joins)\(whereSQL) ORDER BY pt.planned_date DESC LIMIT ? OFFSET ?
            """, arguments)
        var rows = try page.map(PlannedRow.init)
        var total = 0
        if let count = page.first.flatMap({ try? $0.optionalText("total_count") }) {
            total = Int(JavaScriptInteger.parse(count) ?? 0) ?? 0
        } else if page.isEmpty {
            if let row = try session.row(
                """
                SELECT CAST(count(*) AS TEXT) AS count FROM planned_transactions pt
                \(joins)\(whereSQL)
                """, clause.arguments),
                let count = try row.optionalText("count")
            {
                total = Int(JavaScriptInteger.parse(count) ?? 0) ?? 0
            }
        }
        if rows.isEmpty { return (rows, total) }

        let ids = JSValue.array(rows.map { .int($0.id.rawValue) }).jsonText
        // Executions, newest first within each planned transaction.
        let executions = try grouped(
            try session.rows(
                """
                SELECT id, planned_transaction_id, executed_transaction_id, execution_date, created_at \
                FROM planned_transaction_executions \
                WHERE planned_transaction_id IN (SELECT value FROM json_each(?)) \
                ORDER BY planned_transaction_id ASC, execution_date DESC
                """, [.text(ids)]),
            "planned_transaction_id")
        // Loan schedules, for the loan rows only.
        let loanIds = JSValue.array(rows.filter(\.isLoan).map { .int($0.id.rawValue) }).jsonText
        var schedules: [Int: [PlannedRow.Installment]] = [:]
        if loanIds != "[]" {
            schedules = try grouped(
                try session.rows(
                    """
                    SELECT planned_transaction_id, installment_number, due_date, payment_amount, \
                           principal_amount, interest_amount, remaining_principal \
                    FROM planned_transaction_loan_schedule \
                    WHERE planned_transaction_id IN (SELECT value FROM json_each(?)) \
                    ORDER BY planned_transaction_id ASC, installment_number ASC
                    """, [.text(loanIds)]),
                "planned_transaction_id")
                .mapValues { try $0.map(PlannedRow.Installment.init) }
        }
        // Tags, by slug within each planned transaction.
        let tags = try grouped(
            try session.rows(
                """
                SELECT ptt.planned_transaction_id, tg.id, tg.slug, tg.color, tg.is_active \
                FROM planned_transaction_tags AS ptt \
                INNER JOIN tags AS tg ON tg.id = ptt.tag_id \
                WHERE ptt.planned_transaction_id IN (SELECT value FROM json_each(?)) \
                ORDER BY ptt.planned_transaction_id ASC, tg.slug ASC
                """, [.text(ids)]),
            "planned_transaction_id")
        for index in rows.indices {
            let id = rows[index].id.rawValue
            let rowExecutions = try (executions[id] ?? []).map(PlannedRow.Execution.init)
            rows[index].executions = rowExecutions
            rows[index].executionCount = rowExecutions.count
            rows[index].executedTransactionId = rowExecutions.first?.executedTransactionId
            rows[index].loanSchedule = rows[index].isLoan ? schedules[id] ?? [] : []
            rows[index].tags = try (tags[id] ?? []).map(PlannedRow.Tag.init)
        }
        return (rows, total)
    }

    // MARK: - GET /totals

    /// `assertCurrency(optionalQueryString(req.query, "currency")) ?? EUR`.
    static func totalsCurrency(_ request: InProcessRequest) throws -> String {
        let value = TransactionsArea.raw(request, "currency")
        guard let value else { return "EUR" }
        guard case .string(let text) = value else {
            throw BackendHTTPError.validation("currency must be a single value")
        }
        if text.isEmpty { return "EUR" }
        let currency = JavaScriptWhitespace.trim(text.uppercased())
        guard AccountsArea.isCurrencyCode(currency) else {
            throw BackendHTTPError.validation("currency must be a 3-letter ISO code")
        }
        return currency
    }

    /// What `getForCommitmentProjection` reads off a row.
    struct Commitment: Sendable {
        let id: Int
        let plannedDate: String
        let amount: String
        let currency: String?
        let isRecurring: Bool
        let recurrencePattern: String?
        let recurrenceEndDate: String?
        let maxOccurrences: Int?
        let executionCount: Int

        init(_ row: SQLRow) throws {
            id = try row.integerId("id")
            plannedDate = try row.text("planned_date")
            amount = try row.text("amount")
            currency = try row.optionalText("currency")
            isRecurring = try row.bool("is_recurring")
            recurrencePattern = try row.optionalText("recurrence_pattern")
            recurrenceEndDate = try row.optionalText("recurrence_end_date")
            if let value = try row.optionalInt64("max_occurrences") { maxOccurrences = Int(value) } else {
                maxOccurrences = nil
            }
            executionCount = Int(try row.int64("execution_count"))
        }
    }

    /// `getForCommitmentProjection`: active, unexecuted rows through a day boundary.
    static func commitments(_ session: BackendSession, horizonEnd: String) throws -> [Commitment] {
        try session.rows(
            """
            SELECT pt.id, pt.planned_date, pt.amount, pt.currency, pt.is_recurring, \
                   pt.recurrence_pattern, pt.recurrence_end_date, pt.max_occurrences, \
                   (SELECT COUNT(*) FROM planned_transaction_executions AS "pte" \
                    WHERE "pte"."planned_transaction_id" = "pt"."id") AS "execution_count" \
            FROM planned_transactions pt \
            WHERE pt.is_active = 1 AND pt.is_executed = 0 AND pt.planned_date <= ts_date(?) \
            ORDER BY pt.planned_date ASC, pt.id ASC
            """, [.text(horizonEnd)]).map(Commitment.init)
    }

    /// `remainingOccurrences`: the row's occurrence budget, capped at 500.
    static func remainingOccurrences(_ row: Commitment) -> Int {
        guard let budget = row.maxOccurrences else { return 500 }
        return min(max(0, budget - row.executionCount), 500)
    }

    /// `occurrencesBetween`: the row's occurrences inside the window, honouring its
    /// recurrence end date.
    static func occurrencesBetween(_ row: Commitment, _ fromYmd: String, _ toYmd: String) throws -> [String] {
        let remaining = remainingOccurrences(row)
        if remaining == 0 { return [] }
        return try Recurrence.expandOccurrences(
            row: (row.plannedDate, row.isRecurring, row.recurrencePattern), horizonYmd: toYmd,
            maxOccurrences: remaining
        ).filter { date in
            date >= fromYmd && (row.recurrenceEndDate == nil || date <= row.recurrenceEndDate ?? date)
        }
    }

    /// A Money figure: the amount with its stored currency (`money()` of `lib/money.ts`).
    struct Money: Sendable {
        let amount: DecimalJS
        let currency: String
    }

    /// `plannedAmount`: `money(row.amount, currencyCode(row.currency))`.
    static func plannedAmount(_ row: Commitment) throws -> Money {
        Money(amount: try DecimalJS.from(row.amount), currency: AccountsArea.storedCurrencyCode(row.currency))
    }

    /// `times`: `money(multiply(value.amount, factor), value.currency)`.
    static func times(_ value: Money, _ factor: DecimalJS) -> Money {
        Money(amount: value.amount.times(factor), currency: value.currency)
    }

    /// `sumMoney` over one currency: the exact sum.
    static func sum(_ values: [DecimalJS]) -> DecimalJS {
        var total = DecimalJS.zero
        for value in values { total = total.plus(value) }
        return total
    }

    /// `roundMoney`: half-even to two places, as a number.
    static func roundMoney(_ value: DecimalJS) -> Double { value.toDecimalPlaces(2).toNumber }

    /// `roundedSum` of `plannedTotalsService`.
    static func roundedSum(_ values: [DecimalJS]) -> Double { roundMoney(sum(values)) }

    /// `convertAtLatestRates`: through EUR, nil when either side has no stored rate.
    static func convert(_ value: Money, to target: String, rates: [String: DecimalJS]) throws -> Money? {
        let source = AccountsArea.storedCurrencyCode(value.currency)
        if source == target { return Money(amount: value.amount, currency: target) }
        guard let fromRate = rates[source], let toRate = rates[target] else { return nil }
        return Money(amount: try value.amount.times(fromRate).dividedBy(toRate), currency: target)
    }

    /// GET /totals: `computePlannedTotals({ currency })`: the rest of the month, the
    /// monthly equivalent, and the next-eight-days strip, every recurring occurrence
    /// counted on its own day, converted at the latest stored rates.
    static func totals(_ session: BackendSession, currency: String) throws -> HandlerResult {
        let rows = try commitments(session, horizonEnd: "9999-12-31")
        let rates = try AccountsArea.latestRatesToEur(session)
        let today = session.today()

        // restOfMonthTotals
        let monthEnd = try CalendarDays.adding(-1, to: CalendarDays.firstOfMonth(today, monthOffset: 1))
        var restIncoming: [DecimalJS] = []
        var restOutgoing: [DecimalJS] = []
        var restUnconverted = 0
        for row in rows {
            let count = try occurrencesBetween(row, today, monthEnd).count
            if count == 0 { continue }
            guard let converted = try convert(try plannedAmount(row), to: currency, rates: rates) else {
                restUnconverted += 1
                continue
            }
            let total = times(converted, try DecimalJS.from(String(count))).amount
            if converted.amount.lt(.zero) { restOutgoing.append(total) } else { restIncoming.append(total) }
        }

        // monthlyEquivalent
        var equivalents: [DecimalJS] = []
        var equivalentsUnconverted = 0
        for row in rows {
            guard row.isRecurring else { continue }
            guard let factor = try Recurrence.monthlyOccurrenceFactor(row.recurrencePattern) else { continue }
            if remainingOccurrences(row) == 0 { continue }
            guard let converted = try convert(try plannedAmount(row), to: currency, rates: rates) else {
                equivalentsUnconverted += 1
                continue
            }
            equivalents.append(times(converted, factor).amount)
        }

        // nextDaysTotals
        var dates: [String] = []
        for offset in 0..<8 { dates.append(try CalendarDays.adding(offset, to: today)) }
        let lastDate = dates[7]
        struct DayBucket {
            var incoming: [DecimalJS] = []
            var outgoing: [DecimalJS] = []
            var unconverted = 0
        }
        var days = Dictionary(uniqueKeysWithValues: dates.map { ($0, DayBucket()) })
        var unconvertedRows: Set<Int> = []
        for row in rows {
            let occurrences = try occurrencesBetween(row, today, lastDate)
            if occurrences.isEmpty { continue }
            let converted = try convert(try plannedAmount(row), to: currency, rates: rates)
            if converted == nil { unconvertedRows.insert(row.id) }
            for date in occurrences {
                guard days[date] != nil else { continue }
                var bucket = days[date] ?? DayBucket()
                if let converted {
                    if converted.amount.lt(.zero) { bucket.outgoing.append(converted.amount) } else {
                        bucket.incoming.append(converted.amount)
                    }
                } else {
                    bucket.unconverted += 1
                }
                days[date] = bucket
            }
        }
        let windowIncoming = sum(dates.flatMap { days[$0]?.incoming ?? [] })
        let windowOutgoing = sum(dates.flatMap { days[$0]?.outgoing ?? [] })

        return HandlerResult(
            data: .object([
                "currency": .string(currency),
                "today": .string(today),
                "month_end": .string(monthEnd),
                "rest_of_month": .object([
                    "incoming": JSValue.number(roundedSum(restIncoming)).envelopeValue,
                    "outgoing": JSValue.number(roundedSum(restOutgoing)).envelopeValue,
                    "unconverted_count": .int(restUnconverted),
                ]),
                "monthly_equivalent": .object([
                    "total": JSValue.number(roundedSum(equivalents)).envelopeValue,
                    "unconverted_count": .int(equivalentsUnconverted),
                ]),
                "next_days": .array(dates.map { date in
                    let bucket = days[date] ?? DayBucket()
                    return .object([
                        "date": .string(date),
                        "incoming": JSValue.number(roundedSum(bucket.incoming)).envelopeValue,
                        "outgoing": JSValue.number(roundedSum(bucket.outgoing)).envelopeValue,
                        "unconverted_count": .int(bucket.unconverted),
                    ])
                }),
                "next_days_total": .object([
                    "from": .string(today),
                    "to": .string(lastDate),
                    "incoming": JSValue.number(roundMoney(windowIncoming)).envelopeValue,
                    "outgoing": JSValue.number(roundMoney(windowOutgoing)).envelopeValue,
                    "net": JSValue.number(roundMoney(windowIncoming.plus(windowOutgoing))).envelopeValue,
                    "unconverted_count": .int(unconvertedRows.count),
                ]),
            ]))
    }

    // MARK: - GET /match-suggestions

    /// `plannedMatchCandidateRowSchema`: the fields the matcher reads.
    struct MatchCandidate: Sendable {
        let id: Int
        let recipientId: RecipientID?
        let recipientClusterId: RecipientID?
        let amount: String
        let plannedDate: String
        let currency: String?
        let isRecurring: Bool
        let recipientName: String?

        init(_ row: SQLRow) throws {
            id = try row.integerId("id")
            if let value = try row.optionalInt64("recipient_id") {
                recipientId = RecipientID(rawValue: Int(value))
            } else { recipientId = nil }
            if let value = try row.optionalInt64("recipient_cluster_id") {
                recipientClusterId = RecipientID(rawValue: Int(value))
            } else { recipientClusterId = nil }
            amount = try row.text("amount")
            plannedDate = try row.text("planned_date")
            currency = try row.optionalText("currency")
            isRecurring = try row.bool("is_recurring")
            recipientName = try row.optionalText("recipient_name")
        }
    }

    /// `listActiveUnexecuted`: the auto-link candidate rows (loans excluded).
    static func activeUnexecuted(_ session: BackendSession) throws -> [MatchCandidate] {
        try session.rows(
            """
            SELECT pt.id, pt.recipient_id, \
                   COALESCE(r.primary_recipient_id, pt.recipient_id) AS recipient_cluster_id, \
                   pt.amount, pt.planned_date, pt.currency, pt.is_recurring, \
                   \(recipientNameSQL) AS recipient_name \
            FROM planned_transactions pt \
            LEFT JOIN recipients r ON pt.recipient_id = r.id \
            LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id \
            WHERE pt.is_active = 1 AND pt.is_executed = 0 AND pt.recipient_id IS NOT NULL \
              AND (pt.is_loan = 0 OR pt.is_loan IS NULL)
            """).map(MatchCandidate.init)
    }

    /// `UnlinkedTransactionRow`: a recent transaction with no planned execution.
    struct UnlinkedTransaction: Sendable {
        let id: TransactionID
        let recipientClusterId: RecipientID?
        let amount: String
        let transactionDate: String
        let currency: String?
        let memo: String?
        let recipientName: String?

        init(_ row: SQLRow) throws {
            id = TransactionID(rawValue: try row.integerId("id"))
            if let value = try row.optionalInt64("recipient_cluster_id") {
                recipientClusterId = RecipientID(rawValue: Int(value))
            } else { recipientClusterId = nil }
            amount = try row.text("amount")
            transactionDate = try row.text("transaction_date")
            currency = try row.optionalText("currency")
            memo = try row.optionalText("memo")
            recipientName = try row.optionalText("recipient_name")
        }
    }

    /// `listRecentUnlinked` since a day.
    static func recentUnlinked(_ session: BackendSession, sinceDate: String) throws -> [UnlinkedTransaction] {
        try session.rows(
            """
            SELECT t.id, t.recipient_id, \
                   COALESCE(r.primary_recipient_id, t.recipient_id) AS recipient_cluster_id, \
                   t.amount, t.date AS transaction_date, t.currency, t.memo, r.name AS recipient_name \
            FROM transactions t \
            LEFT JOIN recipients r ON t.recipient_id = r.id \
            WHERE t.is_active = 1 AND t.recipient_id IS NOT NULL AND t.date >= ? \
              AND NOT (EXISTS (SELECT 1 FROM planned_transaction_executions AS "pte" \
                              WHERE "pte"."executed_transaction_id" = "t"."id")) \
            ORDER BY t.date DESC, t.id DESC
            """, [.text(sinceDate)]).map(UnlinkedTransaction.init)
    }

    /// GET /match-suggestions: `getMatchSuggestions`.
    static func matchSuggestions(_ session: BackendSession) throws -> HandlerResult {
        var suggestions: [JSONValue] = []
        let active = try activeUnexecuted(session)
        if !active.isEmpty {
            let sinceDate = try CalendarDays.adding(-45, to: session.today())
            let recent = try recentUnlinked(session, sinceDate: sinceDate)
            for planned in active {
                let like = PlannedMatchLike(
                    recipientClusterId: planned.recipientClusterId.map { JSValue.int($0.rawValue) },
                    currency: planned.currency.map { JSValue.string($0) },
                    amount: .string(planned.amount),
                    plannedDate: .string(planned.plannedDate))
                let candidates = recent.filter { transaction in
                    PlannedMatching.matchesTolerance(
                        like,
                        TxMatchLike(
                            recipientClusterId: transaction.recipientClusterId.map { JSValue.int($0.rawValue) },
                            currency: transaction.currency.map { JSValue.string($0) },
                            amount: .string(transaction.amount),
                            transactionDate: .string(transaction.transactionDate)))
                }
                if candidates.isEmpty { continue }
                let plannedAmount = try DecimalJS.from(planned.amount).toNumber
                let plannedFields: [String: JSONValue] = [
                    "id": .int(planned.id),
                    "recipient_id": planned.recipientId.map { JSONValue.int($0.rawValue) } ?? .null,
                    "recipient_name": planned.recipientName.map(JSONValue.string) ?? .null,
                    "amount": .double(plannedAmount),
                    "planned_date": .string(planned.plannedDate),
                    "currency": planned.currency.map(JSONValue.string) ?? .null,
                    "is_recurring": .bool(planned.isRecurring),
                ]
                let candidateFields: [JSONValue] = try candidates.map { transaction in
                    .object([
                        "id": .int(transaction.id.rawValue),
                        "recipient_name": transaction.recipientName.map(JSONValue.string) ?? .null,
                        "amount": .double(try DecimalJS.from(transaction.amount).toNumber),
                        "transaction_date": .string(transaction.transactionDate),
                        "currency": transaction.currency.map(JSONValue.string) ?? .null,
                        "memo": transaction.memo.map(JSONValue.string) ?? .null,
                    ])
                }
                suggestions.append(
                    .object([
                        "planned": .object(plannedFields),
                        "candidates": .array(candidateFields),
                    ]))
            }
        }
        return HandlerResult(data: .object(["items": .array(suggestions), "total": .int(suggestions.count)]))
    }

    // MARK: - POST /:id/execute

    // MARK: - POST / (create, port 10b)

    /// The SQL a raw body value binds (`toSqlParam` of `database/sqlite/values.ts`), with
    /// Bun's integer/real split: an exactly integral double inside Int64 binds as an
    /// integer, everything else (including −0) as a real; arrays and objects bind as their
    /// `JSON.stringify` text.
    static func looseSQL(_ value: JSValue?) throws -> SQLValue {
        switch value {
        case nil, .null?:
            return .null
        case .bool(let flag)?:
            return .integer(flag ? 1 : 0)
        case .number(let number)?:
            if number.isNaN { throw UnhandledJSError("NaN cannot be bound to SQLite") }
            if let exact = Int64(exactly: number), !(number == 0 && number.sign == .minus) {
                return .integer(exact)
            }
            return .real(number)
        case .string(let text)?:
            return .text(text)
        case .array?, .object?:
            return .text(value?.jsonText ?? "null")
        }
    }

    /// `decimalParam` of the repositories: a number binds as `String(n)`, anything else raw.
    static func decimalSQL(_ value: JSValue?) throws -> SQLValue {
        if case .number(let number)? = value { return .text(SQLArguments.javaScriptText(number)) }
        return try looseSQL(value)
    }

    /// `booleanInput` bound as a parameter: the flag, or a 22P02 that surfaces as a 500.
    static func booleanSQL(_ value: JSValue?) throws -> SQLValue {
        if let flag = try SQLBooleanInput.read(value) { return .integer(flag ? 1 : 0) }
        return .null
    }

    /// `assertCurrency` for a body value: null and "" clear, anything else must read as a
    /// 3-letter ISO code (upper-cased, trimmed). The issue message names the field twice,
    /// as `formatZodIssues` prefixes the path.
    static func currencyField(_ value: JSValue?, issues: inout [String]) -> String? {
        guard let value, value != .null, value != .string("") else { return nil }
        let code = JavaScriptWhitespace.trim(value.javaScriptString.uppercased())
        guard AccountsArea.isCurrencyCode(code) else {
            issues.append("currency: currency must be a 3-letter ISO code")
            return nil
        }
        return code
    }

    /// `categoryField` / numbers: a bound value that must be integer.
    static func isJSInteger(_ number: Double) -> Bool {
        number.isFinite && number == number.rounded()
    }

    /// A string body value, as `z.string()` accepts.
    static func isJSString(_ value: JSValue?) -> Bool {
        if case .string? = value { return true }
        return false
    }

    /// `createPlannedSchema`: the leaf checks of the loose object in shape order, then —
    /// only when every leaf parsed — the superRefine checks (path-less messages) and the
    /// amount/max-occurrences coercions of its transform.
    static func createFields(_ request: InProcessRequest) throws -> JSObject {
        let body = try RequestBody.parseJavaScript(request.body)
        guard case .object(var object)? = body ?? .object(JSObject()) else {
            throw BackendHTTPError.validation(
                "Invalid input: expected object, received \((body ?? .null).zodTypeName)")
        }
        var issues: [String] = []

        // tags: an array of strings; each failure names the array (or its item).
        if let tags = object["tags"] {
            if case .array(let items) = tags {
                for (index, item) in items.enumerated() where !isJSString(item) {
                    issues.append("tags.\(index): tags must be an array of strings")
                }
            } else {
                issues.append("tags: tags must be an array of strings")
            }
        }
        // memo: a string or null; create upper-cases it.
        if let memo = object["memo"], memo != .null, !isJSString(memo) {
            issues.append("memo: memo must be a string")
        }
        // reminder_days_before: null passes; else an integer within 0...365, coerced.
        if let reminder = object["reminder_days_before"], reminder != .null {
            let number = reminder.javaScriptNumber
            if !isJSInteger(number) || !(0...365).contains(number) {
                issues.append("reminder_days_before: reminder_days_before must be an integer between 0 and 365")
            } else {
                object["reminder_days_before"] = .number(number)
            }
        }
        // currency: absent, null and "" all clear; anything else must read as ISO.
        currencyField(object["currency"], issues: &issues)
            .map { object["currency"] = .string($0) }
        // account_id: z.number().int().positive() — a required leaf.
        if let account = object["account_id"] {
            if case .number(let number) = account {
                if number != number.rounded() {
                    issues.append("account_id: Invalid input: expected int, received number")
                } else if number <= 0 {
                    issues.append("account_id: Too small: expected number to be >0")
                }
            } else {
                issues.append(
                    "account_id: Invalid input: expected number, received \(account.zodTypeName)")
            }
        } else {
            issues.append("account_id: Invalid input: expected number, received undefined")
        }
        // bank_account: retired — anything but absence fails.
        if let bankAccount = object["bank_account"] {
            issues.append("bank_account: Invalid input: expected never, received \(bankAccount.zodTypeName)")
        }

        // superRefine runs only when every leaf parsed.
        guard issues.isEmpty else { throw BackendHTTPError.validation(issues.joined(separator: "; ")) }
        let isLoan = truthy(object["is_loan"] ?? .null)
        if !isLoan {
            let hasPlannedDate = truthy(object["planned_date"] ?? .null)
            let amount = object["amount"]
            if !hasPlannedDate || amount == nil || amount == .null {
                issues.append("Missing required fields: planned_date, amount")
            } else {
                // Number(amount), the value a non-finite or zero one refuses.
                let value = amount?.javaScriptNumber ?? .nan
                if !value.isFinite || value == 0 {
                    issues.append("amount must be a non-zero finite number")
                } else if abs(value) > 1_000_000_000_000 {
                    issues.append("amount must be between -1000000000000 and 1000000000000")
                }
            }
        } else if let term = object["loan_term_months"], truthy(term) {
            let value = term.javaScriptNumber
            if value < 1 || value > 600 {
                issues.append("loan_term_months must be between 1 and 600 months")
            }
        }
        // Only bounds that survive the loan branch's truthy deletion validate; a falsy
        // value is a valid clear, as `assertYmd`'s own `!value` branch reads it.
        if let end = object["recurrence_end_date"], end != .null, truthy(end),
            !(isLoan && truthy(end))
        {
            var dateIssues: [String] = []
            _ = TransactionsArea.ymd(end, "recurrence_end_date", &dateIssues)
            issues.append(contentsOf: dateIssues)
        }
        if let max = object["max_occurrences"], max != .null, !(isLoan && truthy(max)),
            !isJSInteger(max.javaScriptNumber) || max.javaScriptNumber < 1
        {
            issues.append("max_occurrences must be a positive integer")
        }
        if !isLoan, truthy(object["is_recurring"] ?? .null),
            !Recurrence.isValidPattern(object["recurrence_pattern"])
        {
            issues.append(
                "Invalid or missing recurrence_pattern: \(AccountsArea.looseText(object["recurrence_pattern"]))")
        }
        guard issues.isEmpty else { throw BackendHTTPError.validation(issues.joined(separator: "; ")) }

        // The transform: a non-loan amount and max_occurrences coerce through Number().
        if !isLoan {
            if let amount = object["amount"], amount != .null { object["amount"] = .number(amount.javaScriptNumber) }
            if let max = object["max_occurrences"], max != .null {
                object["max_occurrences"] = .number(max.javaScriptNumber)
            }
        }
        return object
    }

    /// POST "/": the loan schedule branch of the route, then `plannedTransactionService.create`.
    static func create(_ session: BackendSession, fields input: JSObject) throws -> HandlerResult {
        var data = input
        var schedule: [LoanSchedule.Installment] = []
        if truthy(data["is_loan"] ?? .null) {
            let generated = try LoanSchedule.generate(.init(
                loanType: data["loan_type"], loanPrincipal: data["loan_principal"],
                loanAnnualInterestRate: data["loan_annual_interest_rate"],
                loanTermMonths: data["loan_term_months"], loanStartDate: data["loan_start_date"],
                loanPaymentDay: data["loan_payment_day"]))
            data["loan_regular_payment_amount"] = .number(generated.regularPaymentAmount)
            if let firstDueDate = generated.firstDueDate {
                data["loan_first_payment_date"] = .string(firstDueDate)
            }
            data["amount"] = .number(-abs(generated.regularPaymentAmount))
            if let firstDueDate = generated.firstDueDate { data["planned_date"] = .string(firstDueDate) }
            data["is_recurring"] = .bool(true)
            data["recurrence_pattern"] = .string("monthly")
            for key in ["frequency", "custom_interval_days", "end_date"] where truthy(data[key] ?? .null) {
                data[key] = nil
            }
            if truthy(data["recurrence_end_date"] ?? .null) { data["recurrence_end_date"] = nil }
            if truthy(data["max_occurrences"] ?? .null) { data["max_occurrences"] = nil }
            schedule = generated.schedule
        }

        // `plannedTransactionService.create`'s normalizations, mirrored field by field.
        let memo: JSValue
        if let raw = data["memo"], truthy(raw), case .string(let text) = raw {
            memo = .string(text.uppercased())
        } else {
            memo = .null
        }
        let currency: JSValue
        if let code = data["currency"], truthy(code), case .string(let text) = code {
            currency = .string(text.uppercased())
        } else {
            currency = .string("EUR")
        }
        // The `Number(...) : null` coercions of the normalizations.
        func coerced(_ value: JSValue?) -> JSValue? {
            guard let value, value != .null else { return .null }
            return .number(value.javaScriptNumber)
        }
        // `x || null` — a falsy value clears.
        func orNull(_ value: JSValue?) -> JSValue? {
            (value.map(truthy) ?? false) ? value : .null
        }
        let isLoan = truthy(data["is_loan"] ?? .null)
        let recurrencePattern: JSValue = isLoan
            ? .string("monthly")
            : (orNull(data["recurrence_pattern"]) ?? .null)
        // `x || false`: a truthy value stays as written for `booleanInput` to read.
        let isRecurringFlag: JSValue = truthy(data["is_recurring"] ?? .null)
            ? (data["is_recurring"] ?? .bool(true)) : .bool(false)
        let isLoanFlag: JSValue = isLoan ? (data["is_loan"] ?? .bool(true)) : .bool(false)

        let plannedId = try session.transaction { () throws -> Int in
            // `stampAccountIdForUpdate` — `account_id` always survives the schema.
            let account = data["account_id"]
            if let account, account != .null {
                let active = try session.row(
                    "SELECT id FROM accounts WHERE id = ? AND is_active = 1", [try looseSQL(account)])
                if active == nil {
                    throw BackendHTTPError.validation("account_id must reference an active account")
                }
            }
            let inserted = try session.row(
                """
                INSERT INTO planned_transactions (
                   planned_date, account_id, recipient_id, amount, memo, currency, category_id, comment, url,
                   is_recurring, recurrence_pattern, recurrence_end_date, max_occurrences,
                   reminder_days_before, is_executed, is_active,
                   is_loan, loan_type, loan_principal, loan_annual_interest_rate,
                   loan_term_months, loan_start_date, loan_payment_day,
                   loan_regular_payment_amount, loan_first_payment_date
                 ) VALUES (
                   ts_date(?), ?, ?, vision_numeric(?, 18, 4), ?, ?, ?, ?, ?,
                   ?, ?, ts_date(?), ?,
                   ?, 0, 1,
                   ?, ?, vision_numeric(?, 18, 4), vision_numeric(?, 8, 4),
                   ?, ts_date(?), ?,
                   vision_numeric(?, 18, 4), ts_date(?)
                 ) RETURNING id
                """,
                try [
                    looseSQL(data["planned_date"]),
                    looseSQL(account),
                    looseSQL(data["recipient_id"]),
                    decimalSQL(data["amount"]),
                    looseSQL(memo),
                    looseSQL(currency),
                    looseSQL(data["category_id"]),
                    looseSQL(data["comment"]),
                    looseSQL(truthy(data["url"] ?? .null) ? data["url"] : .null),
                    booleanSQL(isRecurringFlag),
                    looseSQL(recurrencePattern),
                    looseSQL(orNull(data["recurrence_end_date"])),
                    looseSQL(coerced(data["max_occurrences"])),
                    looseSQL(coerced(data["reminder_days_before"])),
                    booleanSQL(isLoanFlag),
                    looseSQL(orNull(data["loan_type"])),
                    decimalSQL(coerced(data["loan_principal"])),
                    decimalSQL(coerced(data["loan_annual_interest_rate"])),
                    looseSQL(coerced(data["loan_term_months"])),
                    looseSQL(orNull(data["loan_start_date"])),
                    looseSQL(coerced(data["loan_payment_day"])),
                    decimalSQL(coerced(data["loan_regular_payment_amount"])),
                    looseSQL(orNull(data["loan_first_payment_date"])),
                ])
            guard let row = inserted else { throw UnhandledJSError("planned transaction INSERT returned no row") }
            let id = try row.integerId("id")
            if !schedule.isEmpty { try insertLoanSchedule(session, id: PlannedTransactionID(rawValue: id), schedule) }
            if case .array(let slugs)? = data["tags"], !slugs.isEmpty {
                try setPlannedTransactionTags(session, PlannedTransactionID(rawValue: id), slugs)
            }
            return id
        }
        let created = try getById(session, id: PlannedTransactionID(rawValue: plannedId))
        return HandlerResult(status: 201, data: created?.json ?? .null)
    }

    /// `insertLoanScheduleBatch`: the installment rows of a generated schedule.
    static func insertLoanSchedule(
        _ session: BackendSession, id: PlannedTransactionID, _ schedule: [LoanSchedule.Installment]
    ) throws {
        var values: [SQLValue] = []
        var placeholders: [String] = []
        for installment in schedule {
            placeholders.append(
                "(?, ?, ts_date(?), vision_numeric(?, 18, 4), vision_numeric(?, 18, 4), "
                    + "vision_numeric(?, 18, 4), vision_numeric(?, 18, 4))")
            values.append(contentsOf: [
                idValue(id), .integer(Int64(installment.number)), .text(installment.dueDate),
                .text(SQLArguments.javaScriptText(installment.paymentAmount)),
                .text(SQLArguments.javaScriptText(installment.principalAmount)),
                .text(SQLArguments.javaScriptText(installment.interestAmount)),
                .text(SQLArguments.javaScriptText(installment.remainingPrincipal)),
            ])
        }
        try session.rows(
            """
            INSERT INTO planned_transaction_loan_schedule (
               planned_transaction_id, installment_number, due_date,
               payment_amount, principal_amount, interest_amount, remaining_principal
             ) VALUES \(placeholders.joined(separator: ", "))
            """, values)
    }

    /// `setPlannedTransactionTags`: replace the attached tags with the active slugs given.
    static func setPlannedTransactionTags(
        _ session: BackendSession, _ id: PlannedTransactionID, _ slugs: [JSValue]
    ) throws {
        try session.rows("DELETE FROM planned_transaction_tags WHERE planned_transaction_id = ?", [idValue(id)])
        let resolved = try session.rows(
            """
            SELECT id FROM tags WHERE slug IN (SELECT value FROM json_each(?)) AND is_active = 1
            """, [.text(JSValue.array(slugs).jsonText)])
        guard !resolved.isEmpty else { return }
        let ids = try JSValue.array(resolved.map { try .int($0.integerId("id")) })
        try session.rows(
            """
            INSERT INTO planned_transaction_tags (planned_transaction_id, tag_id)
             SELECT ?, value FROM json_each(?) WHERE true
             ON CONFLICT DO NOTHING
            """, [idValue(id), .text(ids.jsonText)])
    }

    // MARK: - PATCH /:id (update, port 10b)

    /// The columns `sanitizeUpdateFields("planned_transactions", …)` allows.
    static let updatableColumns: Set<String> = [
        "planned_date", "account_id", "recipient_id", "amount", "memo", "currency", "category_id",
        "comment", "url", "is_recurring", "recurrence_pattern", "recurrence_end_date", "max_occurrences",
        "reminder_days_before", "is_executed", "is_active", "last_executed_date", "is_loan", "loan_type",
        "loan_principal", "loan_annual_interest_rate", "loan_term_months", "loan_start_date",
        "loan_payment_day", "loan_regular_payment_amount", "loan_first_payment_date",
    ]

    /// The write plugin's conversions for an `UPDATE planned_transactions SET`.
    static func updateSQL(_ column: String, _ value: JSValue, _ time: SQLTimestamps) throws -> SQLValue {
        func canonical(precision: Int, scale: Int) throws -> SQLValue {
            if value == .null { return .null }
            switch value {
            case .string(let text):
                return .text(try ExactDecimal.parse(text).coerced(precision: precision, scale: scale).description)
            case .number(let number):
                return .text(
                    try ExactDecimal.parse(SQLArguments.javaScriptText(number))
                        .coerced(precision: precision, scale: scale).description)
            default:
                return try looseSQL(value)
            }
        }
        if ["amount", "loan_principal", "loan_regular_payment_amount"].contains(column) {
            return try canonical(precision: 18, scale: 4)
        }
        if ["loan_annual_interest_rate"].contains(column) {
            return try canonical(precision: 8, scale: 4)
        }
        if ["is_active", "is_executed", "is_loan", "is_recurring"].contains(column) {
            return try booleanSQL(value)
        }
        if ["last_executed_date", "loan_first_payment_date", "loan_start_date", "planned_date", "recurrence_end_date"]
            .contains(column)
        {
            if let text = value.stringValue { return .text(try time.dateInputText(text)) }
            return try looseSQL(value)
        }
        return try looseSQL(value)
    }

    /// `patchPlannedSchema`: the leaf checks in shape order, with transform coercions applied.
    static func patchFields(_ request: InProcessRequest) throws -> JSObject {
        let body = try RequestBody.parseJavaScript(request.body)
        guard case .object(var object)? = body ?? .object(JSObject()) else {
            throw BackendHTTPError.validation(
                "Invalid input: expected object, received \((body ?? .null).zodTypeName)")
        }
        var issues: [String] = []

        if let tags = object["tags"] {
            if case .array(let items) = tags {
                for (index, item) in items.enumerated() where !isJSString(item) {
                    issues.append("tags.\(index): tags must be an array of strings")
                }
            } else {
                issues.append("tags: tags must be an array of strings")
            }
        }
        if let reminder = object["reminder_days_before"], reminder != .null {
            let number = reminder.javaScriptNumber
            if !isJSInteger(number) || !(0...365).contains(number) {
                issues.append("reminder_days_before: reminder_days_before must be an integer between 0 and 365")
            } else {
                object["reminder_days_before"] = .number(number)
            }
        }
        if let end = object["recurrence_end_date"], end != .null, truthy(end) {
            var dateIssues: [String] = []
            _ = TransactionsArea.ymd(end, "recurrence_end_date", &dateIssues)
            issues.append(contentsOf: dateIssues.map { "recurrence_end_date: \($0)" })
        }
        if let max = object["max_occurrences"], max != .null,
            !isJSInteger(max.javaScriptNumber) || max.javaScriptNumber < 1
        {
            issues.append("max_occurrences: max_occurrences must be a positive integer")
        }
        if let currency = object["currency"] {
            if currency == .null || currency == .string("") {
                issues.append("currency: currency cannot be cleared")
            } else {
                if let code = currencyField(currency, issues: &issues) {
                    object["currency"] = .string(code)
                }
            }
        }
        if let account = object["account_id"] {
            guard case .number(let number) = account, number.isFinite else {
                if account != .null {
                    issues.append("account_id: Invalid input: expected number, received \(account.zodTypeName)")
                }
            }
            if case .number(let number)? = object["account_id"], number.isFinite {
                if number != number.rounded() {
                    issues.append("account_id: Invalid input: expected int, received number")
                } else if number <= 0 {
                    issues.append("account_id: Too small: expected number to be >0")
                }
            }
        }
        if let bankAccount = object["bank_account"] {
            issues.append("bank_account: Invalid input: expected never, received \(bankAccount.zodTypeName)")
        }
        if let amount = object["amount"], amount != .null, amount != .string("") {
            let number = amount.javaScriptNumber
            if !number.isFinite || number == 0 || abs(number) > 1_000_000_000_000 {
                issues.append("amount: amount must be a non-zero finite number within range")
            } else {
                object["amount"] = .number(number)
            }
        } else if let amount = object["amount"] {
            if amount == .null || amount == .string("") {
                issues.append("amount: amount must be a non-zero finite number within range")
            }
        }
        if let pattern = object["recurrence_pattern"], truthy(pattern),
            !Recurrence.isValidPattern(pattern)
        {
            issues.append("recurrence_pattern: Invalid recurrence_pattern: \(AccountsArea.looseText(pattern))")
        }
        return try objectAfterIssues(object, issues)
    }

    /// `parseInput`'s throw once every leaf of the patch schema was checked.
    static func objectAfterIssues(_ object: JSObject, _ issues: [String]) throws -> JSObject {
        if !issues.isEmpty { throw BackendHTTPError.validation(issues.joined(separator: "; ")) }
        return object
    }

    /// PATCH `/:id`: the route's resolvers, loan patch defaults, recurrence guard and the
    /// service's update in one transaction.
    static func update(
        _ session: BackendSession, id: PlannedTransactionID, request: InProcessRequest
    ) throws -> HandlerResult {
        guard let existing = try getById(session, id: id) else {
            throw BackendHTTPError.notFound("Planned transaction \(id.rawValue) not found")
        }
        var fields = try patchFields(request)
        for key in ["links", "id", "executions", "execution_count", "executed_transaction_id"] {
            fields[key] = nil
        }

        // `resolveRecipientIdFromName`: the recipient name resolves or the update fails.
        if let name = fields["recipient_name"], truthy(name),
            !(fields["recipient_id"].map(truthy) ?? false)
        {
            guard case .string(let text) = name else { throw UnhandledJSError("recipient_name is not a string") }
            let normalized = RecipientText.normalizeForMatching(text)
            guard let row = try session.row(
                "SELECT id FROM recipients WHERE normalized_name = ? LIMIT 1", [.text(normalized)])
            else { throw BackendHTTPError.validation("Recipient with name '\(text)' does not exist") }
            fields["recipient_id"] = .int(try row.integerId("id"))
        }
        fields["recipient_name"] = nil

        // `resolveCategoryIdFromName` of `categoryService`.
        if let name = fields["category_name"], truthy(name),
            !(fields["category_id"].map(truthy) ?? false)
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
                fields["category_id"] = .int(try match.integerId("id"))
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
                fields["category_id"] = .int(try match.integerId("id"))
            }
        }
        fields["category_name"] = nil

        // `applyLoanPatchDefaults` + `resolveLoanScheduleDirective`.
        let loanKeys = [
            "loan_type", "loan_principal", "loan_annual_interest_rate", "loan_term_months",
            "loan_start_date", "loan_payment_day",
        ]
        let loanFieldsChanged = loanKeys.contains { fields[$0] != nil }
        let resultingIsLoan: Bool
        if let flag = fields["is_loan"] { resultingIsLoan = truthy(flag) } else { resultingIsLoan = existing.isLoan }
        var generatedSchedule: [LoanSchedule.Installment]?
        if resultingIsLoan && (loanFieldsChanged || fields["is_loan"] == .bool(true)) {
            // `??` reads null as absent here, as JavaScript's nullish coalescing does.
            func loanValue(_ key: String, _ existingValue: JSValue?) -> JSValue? {
                let patched = fields[key]
                if let patched, patched != .null { return patched }
                return existingValue
            }
            let generated = try LoanSchedule.generate(.init(
                loanType: loanValue("loan_type", existing.loanType.map { .string($0) }),
                loanPrincipal: loanValue(
                    "loan_principal", existing.loanPrincipal.map { .string($0) }),
                loanAnnualInterestRate: loanValue(
                    "loan_annual_interest_rate", existing.loanAnnualInterestRate.map { .string($0) }),
                loanTermMonths: loanValue(
                    "loan_term_months", existing.loanTermMonths.map { .int($0) }),
                loanStartDate: loanValue(
                    "loan_start_date", existing.loanStartDate.map { .string($0) }),
                loanPaymentDay: loanValue(
                    "loan_payment_day", existing.loanPaymentDay.map { .int($0) })))
            fields["loan_regular_payment_amount"] = .number(generated.regularPaymentAmount)
            if let firstDueDate = generated.firstDueDate {
                fields["loan_first_payment_date"] = .string(firstDueDate)
            }
            fields["amount"] = .number(-abs(generated.regularPaymentAmount))
            if fields["planned_date"] == nil, let firstDueDate = generated.firstDueDate {
                fields["planned_date"] = .string(firstDueDate)
            }
            if fields["is_recurring"] == nil { fields["is_recurring"] = .bool(true) }
            if fields["recurrence_pattern"] == nil { fields["recurrence_pattern"] = .string("monthly") }
            generatedSchedule = generated.schedule
        } else if fields["is_loan"] == .bool(false), existing.isLoan {
            for key in [
                "loan_type", "loan_principal", "loan_annual_interest_rate", "loan_term_months",
                "loan_start_date", "loan_payment_day", "loan_regular_payment_amount",
                "loan_first_payment_date",
            ] {
                fields[key] = .null
            }
        }
        // The loan schedule directive: the generated rows, [] to clear, nil to leave as is.
        let loanScheduleDirective: [LoanSchedule.Installment]?
        if let generated = generatedSchedule {
            loanScheduleDirective = generated
        } else if fields["is_loan"] == .bool(false), existing.isLoan {
            loanScheduleDirective = []
        } else {
            loanScheduleDirective = nil
        }

        // The merged-state recurrence guard, only when the PATCH touches those fields.
        if fields["is_recurring"] != nil || fields["recurrence_pattern"] != nil {
            let resultingRecurring: Bool
            if fields["is_recurring"] != nil {
                resultingRecurring = truthy(fields["is_recurring"] ?? .null)
            } else {
                resultingRecurring = existing.isRecurring
            }
            let resultingPattern: JSValue?
            if let pattern = fields["recurrence_pattern"] {
                resultingPattern = pattern
            } else {
                resultingPattern = existing.recurrencePattern.map { .string($0) }
            }
            if !resultingIsLoan, resultingRecurring, !Recurrence.isValidPattern(resultingPattern) {
                throw BackendHTTPError.validation(
                    "Invalid or missing recurrence_pattern: \(AccountsArea.looseText(resultingPattern))")
            }
        }

        // `sanitizeUpdateFields` — the allow-list, with lower-cased, trimmed keys.
        var sanitized: [(String, JSValue)] = []
        var tags: [JSValue]?
        for (key, value) in fields.entries {
            let normalized = JavaScriptWhitespace.trim(key.lowercased())
            if ["tags"].contains(key) {
                if case .array(let slugs) = value { tags = slugs }
                continue
            }
            if PlannedArea.updatableColumns.contains(normalized) { sanitized.append((normalized, value)) }
        }
        let found = try session.transaction { () throws -> Bool in
            // `stampAccountIdForUpdate` — inside the write transaction.
            let accountColumn = "account_id"
            if let index = sanitized.firstIndex(where: { $0.0 == accountColumn }) {
                let account = sanitized[index].1
                if account != .null {
                    let active = try session.row(
                        "SELECT id FROM accounts WHERE id = ? AND is_active = 1", [try looseSQL(account)])
                    if active == nil {
                        throw BackendHTTPError.validation("account_id must reference an active account")
                    }
                }
            }
            let changes = sanitized
            if changes.isEmpty {
                let exists = try session.row(
                    "SELECT id FROM planned_transactions WHERE id = ?", [idValue(id)]) != nil
                guard exists else { return false }
            } else {
                let assignments = changes.map { "\($0.0) = ?" }
                let arguments = try changes.map { try updateSQL($0.0, $0.1, session.time) }
                let updated = try session.rows(
                    """
                    UPDATE planned_transactions SET \(assignments.joined(separator: ", ")), updated_at = now() \
                    WHERE id = ? RETURNING id
                    """, arguments + [idValue(id)])
                guard !updated.isEmpty else { return false }
            }
            if let directive = loanScheduleDirective {
                try session.rows(
                    "DELETE FROM planned_transaction_loan_schedule WHERE planned_transaction_id = ?",
                    [idValue(id)])
                if !directive.isEmpty { try insertLoanSchedule(session, id: id, directive) }
            }
            if let tags {
                try setPlannedTransactionTags(session, id, tags)
            }
            return true
        }
        guard found else { throw BackendHTTPError.notFound("Planned transaction \(id.rawValue) not found") }
        return HandlerResult(data: try getById(session, id: id)?.json ?? .null)
    }

    /// `executeBodySchema`: the executed transaction id and the optional execution date.
    struct ExecuteBody: Sendable {
        let executedTransactionId: TransactionID
        let executionDate: String?
    }

    /// The execute body as `parseInput(executeBodySchema, req.body ?? {})` reads it: an
    /// object whose transform checks the id first, then the date; the first failure wins.
    static func executeBody(_ request: InProcessRequest) throws -> ExecuteBody {
        let body = try RequestBody.parseJavaScript(request.body)
        guard case .object(let fields)? = body ?? .object(JSObject()) else {
            throw BackendHTTPError.validation(
                "Invalid input: expected object, received \((body ?? .null).zodTypeName)")
        }
        let id = fields["executed_transaction_id"]
        guard let id, PlannedArea.truthy(id) else {
            throw BackendHTTPError.validation("Missing required field: executed_transaction_id")
        }
        guard let valid = RequestID.valid(id) else {
            throw BackendHTTPError.validation("executed_transaction_id must be a positive integer")
        }
        var executionDate: String?
        if let date = fields["execution_date"], truthy(date) {
            var issues: [String] = []
            executionDate = TransactionsArea.ymd(date, "execution_date", &issues)
            if let issue = issues.first { throw BackendHTTPError.validation(issue) }
            if case .string(let text) = date, TransactionsArea.isYmdShape(text), executionDate != nil {
                // `validateDateString`'s `new Date` check accepted the y-m-d text.
            } else {
                throw BackendHTTPError.validation("execution_date is not a valid date")
            }
        }
        return ExecuteBody(
            executedTransactionId: TransactionID(rawValue: Int(valid)), executionDate: executionDate)
    }

    /// JavaScript truthiness of a body value.
    static func truthy(_ value: JSValue) -> Bool {
        switch value {
        case .null: return false
        case .bool(let bool): return bool
        case .number(let number): return number != 0 && !number.isNaN
        case .string(let text): return !text.isEmpty
        default: return true
        }
    }

    /// `plannedTransactionRepository.getById` + `hydratePlannedRow`.
    static func getById(_ session: BackendSession, id: PlannedTransactionID) throws -> PlannedRow? {
        guard let row = try session.row("\(projection) WHERE pt.id = ?", [idValue(id)]) else { return nil }
        return try hydrate(session, PlannedRow(row))
    }

    /// `hydratePlannedRow`: the executions, the loan schedule (loans) and the tags.
    static func hydrate(_ session: BackendSession, _ row: PlannedRow) throws -> PlannedRow {
        var row = row
        let executions = try session.rows(
            """
            SELECT id, planned_transaction_id, executed_transaction_id, execution_date, created_at \
            FROM planned_transaction_executions WHERE planned_transaction_id = ? \
            ORDER BY execution_date DESC
            """, [idValue(row.id)]).map(PlannedRow.Execution.init)
        row.executions = executions
        row.executionCount = executions.count
        row.executedTransactionId = executions.first?.executedTransactionId
        if row.isLoan {
            row.loanSchedule = try session.rows(
                """
                SELECT installment_number, due_date, payment_amount, principal_amount, interest_amount, \
                       remaining_principal \
                FROM planned_transaction_loan_schedule WHERE planned_transaction_id = ? \
                ORDER BY installment_number ASC
                """, [idValue(row.id)]).map(PlannedRow.Installment.init)
        }
        row.tags = try session.rows(
            """
            SELECT tg.id, tg.slug, tg.color, tg.is_active \
            FROM planned_transaction_tags AS ptt INNER JOIN tags AS tg ON tg.id = ptt.tag_id \
            WHERE ptt.planned_transaction_id = ? ORDER BY tg.slug ASC
            """, [idValue(row.id)]).map(PlannedRow.Tag.init)
        return row
    }

    /// `executePlanned` of `plannedExecutionService.ts`: one write transaction around the
    /// state read, the replay check, the guards, the advance and the tag inheritance; a
    /// duplicate replay answers with the `Idempotent-Replay` header.
    static func execute(
        _ session: BackendSession, id: PlannedTransactionID, body: ExecuteBody
    ) throws -> HandlerResult {
        let replay = try session.transaction { () throws -> (Bool, PlannedRow?) in
            // `lockForExecution`: the write transaction itself is the lock.
            try session.row("SELECT id FROM planned_transactions WHERE id = ?", [idValue(id)])
            let state = try session.row(
                """
                SELECT pt.*, acct.name AS bank_account, \
                       \(recipientNameSQL) AS recipient_name, \(categoryCase) AS category_name, \
                       COALESCE(r.primary_recipient_id, pt.recipient_id) AS "recipient_cluster_id", \
                       (SELECT COUNT(*) FROM planned_transaction_executions AS "e" \
                        WHERE "e"."planned_transaction_id" = "pt"."id") AS "execution_count", \
                       (SELECT 1 FROM planned_transaction_executions AS "e" \
                        WHERE "e"."planned_transaction_id" = "pt"."id" \
                          AND "e"."executed_transaction_id" = ?) AS "duplicate::bool" \
                FROM planned_transactions pt \(joins) WHERE pt.id = ?
                """, [.integer(Int64(body.executedTransactionId.rawValue)), idValue(id)])
            guard let state else {
                throw BackendHTTPError.notFound("Planned transaction \(id.rawValue) not found")
            }
            let row = try PlannedRow(state)
            let duplicate = try state.bool("duplicate::bool")
            let executionCount = Int(try state.int64("execution_count"))
            let tagIds = try session.rows(
                "SELECT tag_id AS id FROM planned_transaction_tags WHERE planned_transaction_id = ?",
                [idValue(id)]
            ).map { try $0.integerId("id") }

            // A completed series still accepts a replay of its final execution.
            if duplicate { return (true, try getById(session, id: id)) }
            if !row.isActive || row.isExecuted {
                throw BackendHTTPError.conflict("Planned transaction is inactive or complete")
            }
            guard
                let transaction = try session.row(
                    """
                    SELECT t.currency, t.amount, t.is_active, \
                           COALESCE(r.primary_recipient_id, t.recipient_id) AS "recipient_cluster_id" \
                    FROM transactions t LEFT JOIN recipients r ON r.id = t.recipient_id \
                    WHERE t.id = ?
                    """, [.integer(Int64(body.executedTransactionId.rawValue))])
            else { throw BackendHTTPError.notFound("Transaction not found") }
            guard try transaction.bool("is_active") else {
                throw BackendHTTPError.conflict("Executed transaction must be active")
            }
            guard let plannedCurrency = row.currency, let transactionCurrency = try transaction.optionalText("currency"),
                plannedCurrency.uppercased() == transactionCurrency.uppercased()
            else {
                throw BackendHTTPError.conflict("Planned payment and transaction currencies must match")
            }
            if row.isRecurring, let max = row.maxOccurrences, executionCount >= max {
                throw BackendHTTPError.conflict("Recurring planned transaction is complete")
            }


            let execDate = body.executionDate ?? session.today()
            var fields: [(String, SQLValue)] = [
                ("last_executed_date", .text(execDate)),
                ("is_executed", .integer(row.isRecurring ? 0 : 1)),
            ]
            if row.isRecurring, let pattern = row.recurrencePattern,
                let next = try Recurrence.nextOccurrenceYmd(row.plannedDate, pattern)
            {
                let reachedMax = row.maxOccurrences.map { executionCount + 1 >= $0 } ?? false
                let pastEnd = row.recurrenceEndDate.map { next > $0 } ?? false
                if reachedMax || pastEnd {
                    fields[1] = ("is_executed", .integer(1))
                } else {
                    fields[1] = ("is_executed", .integer(0))
                    fields.append(("planned_date", .text(next)))
                }
            }

            // `insertExecutionInTransaction`: ON CONFLICT DO NOTHING — a re-run is a replay.
            let inserted = try session.rows(
                """
                INSERT INTO planned_transaction_executions \
                       (planned_transaction_id, executed_transaction_id, execution_date) \
                VALUES (?, ?, ?) \
                ON CONFLICT (planned_transaction_id, executed_transaction_id) DO NOTHING \
                RETURNING id
                """, [idValue(id), .integer(Int64(body.executedTransactionId.rawValue)), .text(execDate)])
            if inserted.isEmpty { return (true, try getById(session, id: id)) }

            var updates = fields.map { "\($0.0) = ?" }
            updates.append("updated_at = now()")
            try session.rows(
                "UPDATE planned_transactions SET \(updates.joined(separator: ", ")) WHERE id = ? RETURNING id",
                fields.map(\.1) + [idValue(id)])
            // `inheritTransactionTagsInTransaction`.
            if !tagIds.isEmpty {
                let tagIdsText = JSValue.array(tagIds.map { .int($0) }).jsonText
                try session.rows(
                    """
                    INSERT INTO transaction_tags (transaction_id, tag_id) \
                    SELECT ?, value FROM json_each(?) WHERE true ON CONFLICT DO NOTHING
                    """, [.integer(Int64(body.executedTransactionId.rawValue)), .text(tagIdsText)])
            }
            return (false, try getById(session, id: id))
        }
        return HandlerResult(
            data: replay.1?.json ?? .null,
            headers: replay.0 ? ["Idempotent-Replay": "true"] : [:])
    }
}

/// `PlannedLike` of `lib/plannedMatching.ts`.
/// A thrown `TypeError` or invariant failure the TypeScript answer masked as a 500.
struct UnhandledJSError: Error, Sendable {
    let message: String

    init(_ message: String) {
        self.message = message
    }
}

struct PlannedMatchLike: Sendable {
    var recipientClusterId: JSValue?
    var currency: JSValue?
    var amount: JSValue?
    var plannedDate: JSValue?

    init(
        recipientClusterId: JSValue?, currency: JSValue?, amount: JSValue?, plannedDate: JSValue?
    ) {
        self.recipientClusterId = recipientClusterId
        self.currency = currency
        self.amount = amount
        self.plannedDate = plannedDate
    }
}

/// `TxLike` of `lib/plannedMatching.ts`.
struct TxMatchLike: Sendable {
    var recipientClusterId: JSValue?
    var currency: JSValue?
    var amount: JSValue?
    var transactionDate: JSValue?

    init(
        recipientClusterId: JSValue?, currency: JSValue?, amount: JSValue?, transactionDate: JSValue?
    ) {
        self.recipientClusterId = recipientClusterId
        self.currency = currency
        self.amount = amount
        self.transactionDate = transactionDate
    }
}

/// `lib/plannedMatching.ts`: the shared tolerance predicate of manual and automatic
/// matching — the same recipient cluster, the same currency and sign, the amount within
/// max(1, 5 %) and the dates within ±5 days.
enum PlannedMatching {
    static let dateWindowDays = 5

    static func matchesTolerance(_ planned: PlannedMatchLike, _ tx: TxMatchLike) -> Bool {
        guard let plannedCluster = planned.recipientClusterId, plannedCluster != .null,
            let txCluster = tx.recipientClusterId, txCluster != .null
        else { return false }
        if plannedCluster.javaScriptNumber != txCluster.javaScriptNumber { return false }
        guard case .string(let plannedCurrency)? = planned.currency, !plannedCurrency.isEmpty,
            case .string(let txCurrency)? = tx.currency, !txCurrency.isEmpty,
            plannedCurrency.uppercased() == txCurrency.uppercased()
        else { return false }
        let plannedAmount = planned.amount?.javaScriptNumber ?? .nan
        let txAmount = tx.amount?.javaScriptNumber ?? .nan
        guard plannedAmount.isFinite, txAmount.isFinite, plannedAmount != 0, txAmount != 0,
            sign(plannedAmount) == sign(txAmount)
        else { return false }
        let tolerance = Swift.max(1, abs(plannedAmount) * 0.05)
        if abs(abs(txAmount) - abs(plannedAmount)) > tolerance { return false }
        guard let pDate = normalizeDateLikeToYmd(planned.plannedDate),
            let tDate = normalizeDateLikeToYmd(tx.transactionDate),
            let difference = try? CalendarDays.difference(from: pDate, to: tDate)
        else { return false }
        return abs(difference) <= PlannedMatching.dateWindowDays
    }

    /// `normalizeDateLikeToYmd` of `lib/dateFormat.ts` for the shapes a stored DATE column
    /// and a corpus JSON value hold: nil, a string with a real calendar-day `YYYY-MM-DD`
    /// prefix, or a string whose trimmed form names a bare number. The loose local-`Date`
    /// parse of other strings is not ported: a DATE column never holds one.
    static func normalizeDateLikeToYmd(_ value: JSValue?) -> String? {
        guard let value, value != .null else { return nil }
        guard case .string(let text) = value else { return nil }
        let trimmed = JavaScriptWhitespace.trim(text)
        if trimmed.isEmpty || isBareNumber(trimmed) { return nil }
        let prefix = String(decoding: Array(trimmed.utf16.prefix(10)), as: UTF16.self)
        if TransactionsArea.isYmdShape(prefix), (try? CalendarDays.epochDay(prefix)) != nil {
            return prefix
        }
        return nil
    }

    /// `/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/`.
    static func isBareNumber(_ text: String) -> Bool {
        let bytes = Array(text.utf8)
        func digit(_ byte: UInt8) -> Bool { (48...57).contains(byte) }
        var index = 0
        if index < bytes.count, bytes[index] == 43 || bytes[index] == 45 { index += 1 }
        var digits = 0
        while index < bytes.count, digit(bytes[index]) {
            index += 1
            digits += 1
        }
        if index < bytes.count, bytes[index] == 46 {
            index += 1
            while index < bytes.count, digit(bytes[index]) {
                index += 1
                digits += 1
            }
        }
        return digits > 0 && index == bytes.count
    }

    /// `Math.sign`: -1, 0, 1, or NaN for NaN.
    static func sign(_ value: Double) -> Double {
        guard !value.isNaN else { return .nan }
        if value > 0 { return 1 }
        if value < 0 { return -1 }
        return 0
    }
}
