import Foundation
import VisionNativeCore

/// An `accounts` row (`accountRowSchema` of `database/rowSchemas.ts`).
struct AccountRow: Equatable, Sendable {
    /// `COLUMN_LIST` of `accountRepository.ts`, in its order.
    static let columns = """
        id, name, display_name, institution, currency, type, liquidity_class, spendable, in_net_worth, \
        tax_wrapper, owner, multi_currency_cash, has_cash_sleeve, funding_account_id, is_active, closed_at, \
        created_at, updated_at
        """

    let id: AccountID
    let name: String
    let displayName: String?
    let institution: String?
    let currency: String
    let type: String
    let liquidityClass: String
    let spendable: Bool
    let inNetWorth: Bool
    let taxWrapper: String
    let owner: String
    let multiCurrencyCash: Bool
    let hasCashSleeve: Bool
    let fundingAccountId: AccountID?
    let isActive: Bool
    let closedAt: Instant?
    let createdAt: Instant
    let updatedAt: Instant

    init(_ row: SQLRow) throws {
        id = AccountID(rawValue: try row.integerId("id"))
        name = try row.text("name")
        displayName = try row.optionalText("display_name")
        institution = try row.optionalText("institution")
        currency = try row.text("currency")
        type = try row.text("type")
        liquidityClass = try row.text("liquidity_class")
        spendable = try row.bool("spendable")
        inNetWorth = try row.bool("in_net_worth")
        taxWrapper = try row.text("tax_wrapper")
        owner = try row.text("owner")
        multiCurrencyCash = try row.bool("multi_currency_cash")
        hasCashSleeve = try row.bool("has_cash_sleeve")
        if try row.optionalInt64("funding_account_id") != nil {
            fundingAccountId = AccountID(rawValue: try row.integerId("funding_account_id"))
        } else {
            fundingAccountId = nil
        }
        isActive = try row.bool("is_active")
        if try row.optionalText("closed_at") != nil {
            closedAt = try row.instant("closed_at")
        } else {
            closedAt = nil
        }
        createdAt = try row.instant("created_at")
        updatedAt = try row.instant("updated_at")
    }

    /// The row as `res.json` writes it.
    var json: [String: JSONValue] {
        [
            "id": .int(id.rawValue), "name": .string(name), "display_name": displayName.map(JSONValue.string) ?? .null,
            "institution": institution.map(JSONValue.string) ?? .null, "currency": .string(currency),
            "type": .string(type), "liquidity_class": .string(liquidityClass), "spendable": .bool(spendable),
            "in_net_worth": .bool(inNetWorth), "tax_wrapper": .string(taxWrapper), "owner": .string(owner),
            "multi_currency_cash": .bool(multiCurrencyCash), "has_cash_sleeve": .bool(hasCashSleeve),
            "funding_account_id": fundingAccountId.map { JSONValue.int($0.rawValue) } ?? .null, "is_active": .bool(isActive),
            "closed_at": closedAt.map { JSONValue.string($0.text) } ?? .null, "created_at": .string(createdAt.text),
            "updated_at": .string(updatedAt.text),
        ]
    }
}

/// `routes/accounts.ts`, `services/accountService.ts` and `repositories/accountRepository.ts` for
/// the list and the create, update and delete of one account. The other account operations
/// (totals, close, merge, opening balance, statement balances, reconcile) stay on Bun.
///
/// The Bun caches over `accounts` are the `/api/info` response caches, which the TypeScript
/// writes clear with `invalidatePortfolioCaches`: they re-validate on `PRAGMA data_version`
/// (ADR-270 decision 4), so a write here clears them too.
enum AccountsArea {
    static func register(
        _ backend: inout InProcessBackend, database: BackendDatabase, followUps: LedgerFollowUps
    ) {
        backend.serve(OpenAPIOperations.GetAccounts.self) { request in
            let active = QueryInput.activeOrAll(request.query("active"))
            let page = PageParams.optional(
                limit: request.query("limit"), offset: request.query("offset"), maxLimit: 1000)
            return try await database.run { session in
                try AccountsArea.list(session, active: active, page: page)
            }
        }
        backend.serve(OpenAPIOperations.CreateAccount.self) { request in
            let fields = try AccountsArea.sanitize(try RequestBody.parseJavaScript(request.body), requireName: true)
            return try await database.run { session in
                try AccountsArea.create(session, fields)
            }
        }
        backend.serve(OpenAPIOperations.UpdateAccount.self) { request in
            let id = AccountID(rawValue: try RequestID.pathParameter(request))
            let fields = try AccountsArea.sanitize(try RequestBody.parseJavaScript(request.body), requireName: false)
            return try await database.run { session in
                try AccountsArea.update(session, id: id, fields)
            }
        }
        backend.serve(OpenAPIOperations.SetAccountStatementBalance.self) { request in
            let body = try RequestBody.parseJavaScript(request.body)
            let id = AccountID(rawValue: try RequestID.pathParameter(request))
            let currency = request.pathParameters["currency"] ?? ""
            return try await database.run { session in
                try AccountsArea.setStatementBalance(session, id: id, currency: currency, body: body)
            }
        }
        backend.serve(OpenAPIOperations.DeleteAccount.self) { request in
            let id = AccountID(rawValue: try RequestID.pathParameter(request))
            return try await database.run { session in
                try AccountsArea.remove(session, id: id)
            }
        }
        backend.serve(OpenAPIOperations.PreviewAccountPortfolioLots.self) { request in
            let id = AccountID(rawValue: try RequestID.pathParameter(request))
            return try await database.run { session in
                try AccountsArea.portfolioLotPreview(session, id: id)
            }
        }
        backend.serve(OpenAPIOperations.CloseAccount.self) { request in
            let id = AccountID(rawValue: try RequestID.pathParameter(request))
            let body = try RequestBody.parseJavaScript(request.body)
            let result = try await database.run { session in
                try AccountsArea.close(session, id: id, body: body)
            }
            // routes/accounts.ts: the new anchor or adjustment feeds the views and forecasts.
            followUps.scheduleAggregationRefresh()
            return result
        }
        backend.serve(OpenAPIOperations.PreviewAccountMerge.self) { request in
            let source = AccountID(rawValue: try RequestID.pathParameter(request))
            let into = try AccountsArea.mergePreviewTarget(request.query("into"))
            return try await database.run { session in
                try AccountsArea.mergePreview(session, source: source, target: into)
            }
        }
        backend.serve(OpenAPIOperations.MergeAccounts.self) { request in
            let target = AccountID(rawValue: try RequestID.pathParameter(request))
            let body = try RequestBody.parseJavaScript(request.body)
            let sourceIds = try AccountsArea.mergeBodySourceIds(body)
            if sourceIds.contains(target.rawValue) {
                throw BackendHTTPError.validation("source_ids must not include the survivor account")
            }
            return try await database.run { session in
                try AccountsArea.merge(session, target: target, sources: sourceIds)
            }
        }
        backend.serve(OpenAPIOperations.SetAccountOpeningBalance.self) { request in
            let id = AccountID(rawValue: try RequestID.pathParameter(request))
            let body = try RequestBody.parseJavaScript(request.body)
            let result = try await database.run { session in
                try AccountsArea.openingBalance(session, id: id, body: body)
            }
            // routes/accounts.ts: the new anchor or adjustment feeds the views and forecasts.
            followUps.scheduleAggregationRefresh()
            return result
        }
        backend.serve(OpenAPIOperations.ReconcileAccount.self) { request in
            let id = AccountID(rawValue: try RequestID.pathParameter(request))
            let body = try RequestBody.parseJavaScript(request.body)
            let result = try await database.run { session in
                try AccountsArea.reconcile(session, id: id, body: body)
            }
            // routes/accounts.ts: the new anchor or adjustment feeds the views and forecasts.
            followUps.scheduleAggregationRefresh()
            return result
        }
    }

    // MARK: - GET /api/accounts

    /// `accountRepository.getAll` then `accountService.list`.
    static func list(_ session: BackendSession, active: Bool?, page: PageParams?) throws -> HandlerResult {
        let activeFilter = active.map { $0 ? " AND a.is_active = 1" : " AND a.is_active = 0" } ?? ""
        var arguments: [SQLValue] = [.text(session.today())]
        var pageClause = ""
        if let page {
            pageClause = " LIMIT ?2 OFFSET ?3"
            arguments += [page.limit.sqlValue, page.offset.sqlValue]
        }
        let selected = AccountRow.columns.split(separator: ",")
            .map { "a." + $0.trimmingCharacters(in: .whitespaces) }.joined(separator: ", ")
        let rows = try session.rows(
            """
            SELECT \(selected),
                   lb.anchor_date,
                   lb.post_anchor_count,
                   bp.balance_parts,
                   (
                     SELECT json_group_array(json_object(
                              'currency', s.currency,
                              'balance', json(s.balance),
                              'balance_date', to_char(s.balance_date, 'YYYY-MM-DD')
                            ))
                       FROM (
                         SELECT currency, balance, balance_date
                           FROM account_statement_balances
                          WHERE account_id = a.id
                          ORDER BY currency
                       ) s
                   ) AS statement_balances,
                   (
                     SELECT json_group_array(t3.currency)
                       FROM (
                         SELECT DISTINCT currency FROM transactions
                          WHERE account_id = a.id AND is_active = 1 AND balance IS NOT NULL AND date <= ?1
                       ) t3
                   ) AS anchored_currencies,
                   (
                     SELECT 1 FROM transactions t2
                     WHERE t2.account_id = a.id AND t2.is_active = 1
                     ORDER BY t2.date DESC
                     LIMIT 1
                   ) IS NOT NULL AS has_transactions
            FROM accounts a
            \(AccountBalanceSQL.provenanceJoin(asOfDate: "?1"))
            \(AccountBalanceSQL.balancePartsJoin(asOfDate: "?1"))
            WHERE 1=1\(activeFilter) ORDER BY a.name\(pageClause)
            """, arguments)
        let rates = try latestRatesToEur(session)
        let items = try rows.map { try listItem($0, rates: rates) }
        let total: Int
        if page == nil {
            total = rows.count
        } else {
            var filter = ""
            var countArguments: [SQLValue] = []
            if let active {
                filter = " WHERE a.is_active = ?"
                countArguments.append(.integer(active ? 1 : 0))
            }
            let count = try session.row(
                "SELECT CAST(COUNT(*) AS TEXT) AS count FROM accounts a\(filter)", countArguments)
            total = try TagsArea.countValue(count, "account count")
        }
        var body = listBody(items.map(JSONValue.object), total: total, page: page)
        body["links"] = .array([])
        return HandlerResult(data: .object(body))
    }

    /// One `accountService.list` item: the row, its partitions converted into the account's
    /// currency at the latest stored rates, and the drift of the reconciliation base.
    static func listItem(_ row: SQLRow, rates: [String: DecimalJS]) throws -> [String: JSONValue] {
        let account = try AccountRow(row)
        var item = account.json
        if let anchorDate = try row.optionalText("anchor_date") { item["anchor_date"] = .string(anchorDate) }
        if let count = try row.optionalText("post_anchor_count") {
            // `parseInt(row.post_anchor_count, 10)` of a COUNT(*) cast to text.
            guard let parsed = JavaScriptInteger.parse(count) else {
                throw SQLRowDecodingError(column: "post_anchor_count", problem: "\(count) is not an integer")
            }
            item["post_anchor_count"] = JSValue.number(parsed).envelopeValue
        }
        // The currencies with a stamped balance, so the opening balance of another currency
        // stays available (Astra report 1, finding 29).
        if let text = try row.optionalText("anchored_currencies"), case .array(let values)? = JSValue.parse(text) {
            let codes = Set(values.map { storedCurrencyCode($0.stringValue) })
            if !codes.isEmpty {
                item["anchored_currencies"] = .array(
                    codes.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }.map(JSONValue.string))
            }
        }
        item["has_transactions"] = .bool(try row.bool("has_transactions"))

        let parts = try balanceParts(try row.optionalText("balance_parts"))
        let accountCurrency = storedCurrencyCode(account.currency)
        var total = DecimalJS.zero
        var unconverted: [String] = []
        for part in parts {
            guard let converted = try convert(part.balance, from: part.currency, to: accountCurrency, rates: rates)
            else {
                unconverted.append(part.currency)
                continue
            }
            total = total.plus(converted)
        }
        let base = statementPartition(parts, of: account)
        let baseBalance = base.balance.toDecimalPlaces(2).toNumber
        let statements = try statementBalances(try row.optionalText("statement_balances"))
        let statementBalance = statements.first { $0.currency == base.currency }?.balance

        item["statement_balances"] = .array(
            statements.map { statement in
                JSONValue.object([
                    "currency": .string(statement.currency), "balance": number(statement.balance),
                    "balance_date": .string(statement.date),
                ])
            })
        item["computed_balance"] = number(total.toDecimalPlaces(2).toNumber)
        item["balance_parts"] = .array(
            parts.map { JSONValue.object(["currency": .string($0.currency), "balance": number($0.balance.toNumber)]) })
        item["balance_incomplete"] = .bool(!unconverted.isEmpty)
        item["unconverted_currencies"] = .array(unconverted.map(JSONValue.string))
        item["reconcilable_balance"] = number(baseBalance)
        item["reconcilable_currency"] = .string(base.currency)
        if let statementBalance {
            let drift = try DecimalJS(statementBalance).minus(try DecimalJS(baseBalance)).toDecimalPlaces(2)
            item["drift"] = number(drift.toNumber)
        } else {
            item["drift"] = .null
        }
        return item
    }

    /// A JavaScript number as `JSON.stringify` writes it.
    static func number(_ value: Double) -> JSONValue { JSValue.number(value).envelopeValue }

    struct Partition: Equatable {
        let currency: String
        let balance: DecimalJS
    }

    /// The `balance_parts` JSON: `{ balance, currency }` with the balance as decimal text.
    static func balanceParts(_ text: String?) throws -> [Partition] {
        guard let text else { return [] }
        guard case .array(let items)? = JSValue.parse(text) else {
            throw SQLRowDecodingError(column: "balance_parts", problem: "is not a JSON array")
        }
        return try items.map { item in
            guard let object = item.objectValue, let balance = object["balance"]?.stringValue else {
                throw SQLRowDecodingError(column: "balance_parts", problem: "has a malformed partition")
            }
            return Partition(
                currency: storedCurrencyCode(object["currency"]?.stringValue), balance: try DecimalJS.from(balance))
        }
    }

    struct Statement: Equatable {
        let currency: String
        let balance: Double
        let date: String
    }

    /// The `statement_balances` JSON: `{ currency, balance, balance_date }` with a numeric balance.
    static func statementBalances(_ text: String?) throws -> [Statement] {
        guard let text else { return [] }
        guard case .array(let items)? = JSValue.parse(text) else {
            throw SQLRowDecodingError(column: "statement_balances", problem: "is not a JSON array")
        }
        return try items.map { item in
            guard let object = item.objectValue, case .number(let balance)? = object["balance"],
                let date = object["balance_date"]?.stringValue
            else { throw SQLRowDecodingError(column: "statement_balances", problem: "has a malformed reading") }
            // `toNumber(toDecimal(balance))` gives the number back.
            return Statement(currency: storedCurrencyCode(object["currency"]?.stringValue), balance: balance, date: date)
        }
    }

    /// `storedCurrencyCode`: upper case, `EUR` when empty or missing.
    static func storedCurrencyCode(_ value: String?) -> String {
        guard let value, !value.isEmpty else { return "EUR" }
        return value.uppercased()
    }

    /// `isCurrencyCode`: three ASCII capitals.
    static func isCurrencyCode(_ text: String) -> Bool {
        text.utf8.count == 3 && text.utf8.allSatisfy { (65...90).contains($0) }
    }

    /// `loadLatestRatesToEur`: EUR at 1 and every stored latest rate above 0.
    static func latestRatesToEur(_ session: BackendSession) throws -> [String: DecimalJS] {
        var rates = ["EUR": DecimalJS.one]
        let rows = try session.rows(
            "SELECT currency_code, rate_to_eur FROM exchange_rates WHERE is_latest = 1 ORDER BY currency_code ASC")
        for row in rows {
            let code = try row.text("currency_code").uppercased()
            // A rate decimal.js reads as NaN or an infinity fails `isFinite()`.
            guard isCurrencyCode(code), let rate = try? DecimalJS.from(try row.optionalText("rate_to_eur")),
                rate.gt(.zero)
            else { continue }
            rates[code] = rate
        }
        return rates
    }

    /// `convertAtLatestRates`: through EUR, or nil when either side has no rate.
    static func convert(_ amount: DecimalJS, from source: String, to target: String, rates: [String: DecimalJS]) throws
        -> DecimalJS?
    {
        if source == target { return amount }
        guard let fromRate = rates[source], let toRate = rates[target] else { return nil }
        return try amount.times(fromRate).dividedBy(toRate)
    }

    /// `statementPartition`: the account's own currency, else the only partition that is not
    /// zero at cents, else zero in the account's currency.
    static func statementPartition(_ parts: [Partition], of account: AccountRow) -> Partition {
        let want = storedCurrencyCode(account.currency)
        if let own = parts.first(where: { $0.currency == want }) { return own }
        let funded = parts.filter { !$0.balance.toDecimalPlaces(2).isZero }
        if funded.count == 1 { return funded[0] }
        return Partition(currency: want, balance: .zero)
    }

    // MARK: - Request bodies

    static let accountTypes = ["checking", "savings", "brokerage", "crypto_exchange", "wallet", "pension", "liability"]
    static let liquidityClasses = ["liquid", "semi_liquid", "illiquid"]
    static let taxWrappers = ["none", "pension", "tax_advantaged"]
    static let owners = ["me", "partner", "joint"]

    private static let nameMessage = "name is required and must be a non-empty string"

    /// `nameField`: a string that is not blank, stored trimmed.
    static let nameField = Zod.transform(
        Zod.errored(.string, nameMessage).check(
            .refine(nameMessage) { value in
                guard let text = value?.stringValue else { return true }
                return !JavaScriptWhitespace.trim(text).isEmpty
            })
    ) { value, _ in
        guard let text = value?.stringValue else { return value }
        return JSValue.string(JavaScriptWhitespace.trim(text))
    }

    /// `clearableStringField`: null clears, a string is trimmed.
    static func clearableString(_ key: String) -> Zod {
        Zod.transform(Zod.errored(.string, "\(key) must be a string").nullable) { value, _ in
            guard let text = value?.stringValue else { return value }
            return .string(JavaScriptWhitespace.trim(text))
        }.optional
    }

    /// `currencyField`: `assertCurrency`, and a null or empty code is refused too.
    static let currencyField = Zod.transform(.unknown) { value, issues in
        let message = "currency must be a 3-letter ISO code"
        guard let value, value != .null, value != .string("") else {
            issues.append(ZodIssue(message: message))
            return nil
        }
        let code = JavaScriptWhitespace.trim(value.javaScriptString.uppercased())
        guard isCurrencyCode(code) else {
            issues.append(ZodIssue(message: message))
            return nil
        }
        return .string(code)
    }.optional

    static func enumField(_ key: String, _ allowed: [String]) -> Zod {
        Zod.errored(.enumeration(allowed), "\(key) must be one of: \(allowed.joined(separator: ", "))").optional
    }

    static func boolField(_ key: String) -> Zod {
        Zod.errored(.boolean, "\(key) must be a boolean").optional
    }

    /// `fundingAccountIdField`: null clears; otherwise `validateId`.
    static let fundingAccountIdField = Zod.transform(.unknown) { value, issues in
        guard let value, value != .null else { return value }
        guard let id = RequestID.valid(value) else {
            issues.append(ZodIssue(message: "funding_account_id must be a positive integer"))
            return nil
        }
        return .number(id)
    }.optional

    /// `accountUpdateSchema` (every field optional) or `accountCreateSchema` (name required).
    static func schema(requireName: Bool) -> Zod {
        .object(
            [
                ("name", requireName ? nameField : nameField.optional),
                ("display_name", clearableString("display_name")),
                ("institution", clearableString("institution")),
                ("currency", currencyField),
                ("type", enumField("type", accountTypes)),
                ("liquidity_class", enumField("liquidity_class", liquidityClasses)),
                ("tax_wrapper", enumField("tax_wrapper", taxWrappers)),
                ("owner", enumField("owner", owners)),
                ("spendable", boolField("spendable")),
                ("in_net_worth", boolField("in_net_worth")),
                ("multi_currency_cash", boolField("multi_currency_cash")),
                ("has_cash_sleeve", boolField("has_cash_sleeve")),
                ("is_active", boolField("is_active")),
                ("funding_account_id", fundingAccountIdField),
                ("statement_balance", Zod.never.optional),
                ("statement_balance_date", Zod.never.optional),
            ], .strip)
    }

    /// The validated fields of a create or update body, in the schema's order.
    struct Fields: Sendable {
        var columns: [(String, SQLValue)]

        func has(_ column: String) -> Bool { columns.contains { $0.0 == column } }

        subscript(column: String) -> SQLValue? {
            get { columns.first { $0.0 == column }?.1 }
            set {
                guard let newValue else {
                    columns.removeAll { $0.0 == column }
                    return
                }
                if let index = columns.firstIndex(where: { $0.0 == column }) {
                    columns[index].1 = newValue
                } else {
                    columns.append((column, newValue))
                }
            }
        }

        /// `fields.name` in the conflict message: the trimmed name, or `undefined`.
        var nameText: String {
            if case .text(let name)? = self["name"] { return name }
            return "undefined"
        }

        /// `fields.funding_account_id` when it names an account.
        var fundingAccountId: AccountID? {
            if case .integer(let id)? = self["funding_account_id"] { return AccountID(rawValue: Int(id)) }
            return nil
        }
    }

    /// `sanitize`: the schema's parse, or the 400 of its issues.
    static func sanitize(_ body: JSValue?, requireName: Bool) throws -> Fields {
        switch schema(requireName: requireName).parse(body) {
        case .failure(let failure):
            throw BackendHTTPError.validation(failure.message)
        case .success(let output):
            guard case .object(let object)? = output else { return Fields(columns: []) }
            return Fields(
                columns: object.entries.compactMap { key, value in
                    // The never-fields cannot pass, so every key left is a writable column.
                    switch value {
                    case .null: return (key, .null)
                    case .bool(let flag): return (key, .integer(flag ? 1 : 0))
                    case .number(let number): return (key, .integer(Int64(number)))
                    case .string(let text): return (key, .text(text))
                    case .array, .object: return nil
                    }
                })
        }
    }

    // MARK: - Writes

    static func getById(_ session: BackendSession, _ id: AccountID) throws -> AccountRow? {
        try session.row("SELECT \(AccountRow.columns) FROM accounts WHERE id = ?", [.integer(Int64(id.rawValue))])
            .map(AccountRow.init)
    }

    /// `assertFundingAccountValid`: the funding account exists, is not the account itself,
    /// and does not close a cycle (walked upward from it, stopping at a repeat).
    static func assertFundingAccountValid(_ session: BackendSession, _ funding: AccountID?, of account: AccountID?) throws {
        guard let funding else { return }
        if let account, funding == account {
            throw BackendHTTPError.validation("funding_account_id cannot reference the account itself")
        }
        guard let fundingRow = try getById(session, funding) else {
            throw BackendHTTPError.validation(
                "funding_account_id \(funding.rawValue) does not reference an existing account")
        }
        guard let account else { return }
        var seen: Set<AccountID> = [funding]
        var ancestor = fundingRow.fundingAccountId
        while let current = ancestor {
            if current == account {
                throw BackendHTTPError.validation("funding_account_id \(funding.rawValue) would create a funding cycle")
            }
            if seen.contains(current) { return }
            seen.insert(current)
            guard let row = try getById(session, current) else { return }
            ancestor = row.fundingAccountId
        }
    }

    /// `withFundingGraphTransaction` when the body touches the funding graph, else plain.
    static func fundingGraph<T>(_ session: BackendSession, _ fields: Fields, _ body: () throws -> T) throws -> T {
        fields.has("funding_account_id") ? try session.transaction(body) : try body()
    }

    /// The service's mapping of a create or update constraint error.
    static func writeError(_ error: any Error, _ fields: Fields) -> any Error {
        guard let error = error as? DatabaseError else { return error }
        if error.code == "23505" {
            return BackendHTTPError.conflict("An account named \"\(fields.nameText)\" already exists")
        }
        if error.code == "23503" {
            return BackendHTTPError.validation("funding_account_id does not reference an existing account")
        }
        return error
    }

    /// `accountService.create`: 201 with the new row.
    static func create(_ session: BackendSession, _ fields: Fields) throws -> HandlerResult {
        let account = try fundingGraph(session, fields) { () throws -> AccountRow in
            try assertFundingAccountValid(session, fields.fundingAccountId, of: nil)
            do {
                let names = fields.columns.map { $0.0 }.joined(separator: ", ")
                let marks = Array(repeating: "?", count: fields.columns.count).joined(separator: ", ")
                guard
                    let row = try session.row(
                        "INSERT INTO accounts (\(names)) VALUES (\(marks)) RETURNING \(AccountRow.columns)",
                        fields.columns.map { $0.1 })
                else { throw SQLRowDecodingError(column: "accounts", problem: "account INSERT returned no row") }
                return try AccountRow(row)
            } catch {
                throw writeError(error, fields)
            }
        }
        var data = account.json
        data["links"] = .array([])
        return HandlerResult(status: 201, data: .object(data))
    }

    /// `accountService.update`: the lifecycle stamps, then the changed row.
    static func update(_ session: BackendSession, id: AccountID, _ input: Fields) throws -> HandlerResult {
        var fields = input
        let account = try fundingGraph(session, fields) { () throws -> AccountRow in
            try assertFundingAccountValid(session, fields.fundingAccountId, of: id)
            var current: AccountRow?
            if fields.has("is_active") {
                current = try getById(session, id)
                if current == nil { throw BackendHTTPError.notFound("Account \(id.rawValue) not found") }
            }
            // Closing stamps `closed_at` (a repeated close keeps it) and leaves net worth unless
            // the body says otherwise; reopening clears it.
            if fields["is_active"] == .integer(0), current?.isActive == true {
                fields["closed_at"] = .text(try SQLTimestamps.formatInstant(session.currentInstant()))
                if !fields.has("in_net_worth") { fields["in_net_worth"] = .integer(0) }
            } else if fields["is_active"] == .integer(1) {
                fields["closed_at"] = SQLValue.null
            }
            let row: SQLRow?
            do {
                if fields.columns.isEmpty {
                    row = try session.row("SELECT \(AccountRow.columns) FROM accounts WHERE id = ?", [.integer(Int64(id.rawValue))])
                } else {
                    let assignments = fields.columns.map { "\($0.0) = ?" }.joined(separator: ", ")
                    row = try session.row(
                        "UPDATE accounts SET \(assignments), updated_at = now() WHERE id = ? RETURNING \(AccountRow.columns)",
                        fields.columns.map { $0.1 } + [.integer(Int64(id.rawValue))])
                }
            } catch {
                throw writeError(error, fields)
            }
            guard let row else { throw BackendHTTPError.notFound("Account \(id.rawValue) not found") }
            return try AccountRow(row)
        }
        var data = account.json
        data["links"] = .array([])
        return HandlerResult(data: .object(data))
    }

    /// `accountService.remove`: 204, 404 when absent, 409 while rows still reference it.
    static func remove(_ session: BackendSession, id: AccountID) throws -> HandlerResult {
        let removed = try session.transaction { () throws -> SQLRow? in
            do {
                return try session.row("DELETE FROM accounts WHERE id = ? RETURNING id", [.integer(Int64(id.rawValue))])
            } catch let error as DatabaseError where error.code == "23503" || error.code == "23001" {
                throw BackendHTTPError.conflict(
                    "Account \(id.rawValue) still has activity referencing it and cannot be deleted. Close the account instead.")
            }
        }
        guard removed != nil else { throw BackendHTTPError.notFound("Account \(id.rawValue) not found") }
        return .noContent
    }

    // MARK: - PUT /api/accounts/{id}/statement-balances/{currency}

    /// `looseText` of `lib/looseText.ts`: arrays joined with commas (a null element is `null`),
    /// objects as JSON, anything else `String(value)`; undefined is `undefined`.
    static func looseText(_ value: JSValue?) -> String {
        switch value {
        case nil: return "undefined"
        case .string(let text)?: return text
        case .array(let items)?: return items.map { looseText($0) }.joined(separator: ",")
        case .object?: return value?.jsonText ?? ""
        case let other?: return other.javaScriptString
        }
    }

    /// `statementBalanceField` unwrapped: null stays null, else `validateNumber` within ±1e12.
    static let statementBalanceValue = Zod.transform(.unknown) { value, issues in
        if value == .null { return .null }
        let number = value?.javaScriptNumber ?? .nan
        guard number.isFinite else {
            issues.append(ZodIssue(message: "statement_balance must be a finite number"))
            return nil
        }
        guard number >= -1e12, number <= 1e12 else {
            issues.append(
                ZodIssue(message: "statement_balance must be between -1000000000000 and 1000000000000"))
            return nil
        }
        return .number(number)
    }

    /// `statementBalanceDateField` unwrapped: null stays null, else a real `YYYY-MM-DD` day. A
    /// year below 100 fails, as `Date.UTC` reads it as 19xx.
    static let statementDateValue = Zod.transform(.unknown) { value, issues in
        if value == .null { return .null }
        let text = looseText(value)
        let year = Int(text.prefix(4)) ?? 0
        guard Zod.isISODate(text), year >= 100 else {
            issues.append(ZodIssue(message: "statement_balance_date must be a valid ISO date (YYYY-MM-DD)"))
            return nil
        }
        return .string(text)
    }

    static let statementReadingSchema = Zod.object(
        [("balance", statementBalanceValue), ("date", statementDateValue)], .strip)

    /// `accountService.setStatementBalance`: replace one currency's statement reading.
    static func setStatementBalance(_ session: BackendSession, id: AccountID, currency: String, body: JSValue?) throws
        -> HandlerResult
    {
        guard try getById(session, id) != nil else {
            throw BackendHTTPError.notFound("Account \(id.rawValue) not found")
        }
        // `assertCurrency`: an empty code is the service's own refusal, with the same message.
        let code = JavaScriptWhitespace.trim(currency.uppercased())
        guard isCurrencyCode(code) else { throw BackendHTTPError.validation("currency must be a 3-letter ISO code") }
        let balance: Double
        let date: String
        switch statementReadingSchema.parse(body) {
        case .failure(let failure):
            throw BackendHTTPError.validation(failure.issues.map(\.message).joined(separator: "; "))
        case .success(let output):
            guard case .object(let reading)? = output, case .number(let number)? = reading["balance"],
                case .string(let day)? = reading["date"]
            else { throw BackendHTTPError.validation("balance and date are required") }
            balance = number
            date = day
        }
        // `decimalText` then the writer's NUMERIC(18, 4) coercion.
        guard
            let row = try session.row(
                """
                INSERT INTO account_statement_balances (account_id, currency, balance, balance_date)
                VALUES (?, ?, vision_numeric(?, 18, 4), ?)
                ON CONFLICT (account_id, currency) DO UPDATE SET balance = excluded.balance,
                  balance_date = excluded.balance_date
                RETURNING account_id, currency, balance, to_char(balance_date, 'YYYY-MM-DD') AS balance_date
                """,
                [
                    .integer(Int64(id.rawValue)), .text(code), .text(SQLArguments.javaScriptText(balance)),
                    .text(date),
                ])
        else { throw SQLRowDecodingError(column: "account_statement_balances", problem: "the upsert returned no row") }
        let stored = try DecimalJS.from(try row.text("balance"))
        return HandlerResult(
            data: .object([
                "account_id": .int(try row.integerId("account_id")), "currency": .string(try row.text("currency")),
                "balance": number(stored.toNumber), "balance_date": .string(try row.text("balance_date")),
                "links": .array([]),
            ]))
    }

    // MARK: - P14 (account operations)

    /// `recipientRepository.getOrCreateSystemId`: the shared SYSTEM recipient, inserted inactive.
    static func systemRecipientId(_ session: BackendSession) throws -> Int {
        let name = RecipientsArea.systemName
        let normalized = RecipientText.normalizeForMatching(name)
        if let row = try session.row("SELECT id FROM recipients WHERE normalized_name = ?", [.text(normalized)]) {
            return try row.integerId("id")
        }
        guard
            let row = try session.row(
                """
                INSERT INTO recipients (name, normalized_name, is_active)
                VALUES (?, ?, 0)
                ON CONFLICT (normalized_name) DO UPDATE SET normalized_name = excluded.normalized_name
                RETURNING id
                """,
                [.text(name), .text(normalized)])
        else {
            throw SQLRowDecodingError(column: "recipients", problem: "the system recipient upsert returned no row")
        }
        return try row.integerId("id")
    }

    /// The account's `balance_parts` for `asOf`, or an empty array without rows.
    static func currentBalanceParts(_ session: BackendSession, id: AccountID) throws -> [Partition] {
        let parts = try session.row(
            """
            SELECT bp.balance_parts
              FROM accounts a
              \(AccountBalanceSQL.balancePartsJoin(asOfDate: "?1"))
             WHERE a.id = ?2
            """,
            [.text(session.today()), .integer(Int64(id.rawValue))])
        return try balanceParts(try parts?.optionalText("balance_parts"))
    }

    /// `previewAccountPortfolioLots`: the account-wide lot event selection.
    static func portfolioLotPreview(_ session: BackendSession, id: AccountID) throws -> HandlerResult {
        guard try getById(session, id) != nil else {
            throw BackendHTTPError.notFound("Account \(id.rawValue) not found")
        }
        let types = JSValue.array([.string("buy"), .string("gift"), .string("sell")]).jsonText
        let rows = try session.rows(
            """
            SELECT id, COUNT(*) OVER () AS eligible
              FROM portfolio_transactions
             WHERE account_id = ? AND type IN (SELECT value FROM json_each(?))
             ORDER BY id ASC
             LIMIT 501
            """,
            [.integer(Int64(id.rawValue)), .text(types)])
        let eligible = (try rows.first.map { Int(try $0.int64("eligible")) }) ?? 0
        let transactionIds = eligible <= 500 ? try rows.map { try $0.integerId("id") } : []
        return HandlerResult(
            data: .object([
                "account_id": .int(id.rawValue), "eligible_count": .int(eligible),
                "transaction_ids": .array(transactionIds.map(JSONValue.int)), "limit": .int(500),
                "links": .array([]),
            ]))
    }

    /// `closeAccount`: an idempotent close, with one zero-out adjustment per non-zero partition.
    static func close(_ session: BackendSession, id: AccountID, body: JSValue?) throws -> HandlerResult {
        var rawHandling: JSValue = .string("")
        if let value = body?.objectValue?["balance_handling"], value != .null { rawHandling = value }
        let balanceHandling = looseText(rawHandling)
        let handling: String
        if balanceHandling == "preserve" { handling = "preserve" }  // lint:allow string-literal-compare the two balance_handling labels of accountCloseService
        else if balanceHandling == "adjustment" { handling = "adjustment" }  // lint:allow string-literal-compare the two balance_handling labels of accountCloseService
        else {
            throw BackendHTTPError.validation(
                "balance_handling is required and must be 'preserve' or 'adjustment'")
        }
        let outcome = try session.transaction { () -> (alreadyClosed: Bool, adjustments: [[String: JSONValue]]) in
            guard let account = try session.row(
                "SELECT id, is_active FROM accounts WHERE id = ?", [.integer(Int64(id.rawValue))])
            else { throw BackendHTTPError.notFound("Account \(id.rawValue) not found") }
            if !(try account.bool("is_active")) { return (true, []) }
            var inserted: [[String: JSONValue]] = []
            if handling == "adjustment" {  // lint:allow string-literal-compare the two balance_handling labels of accountCloseService
                let partitions = try currentBalanceParts(session, id: id)
                var stamped: [(amount: Double, currency: String)] = []
                for part in partitions {
                    let amount = DecimalMoney.roundToCents(part.balance).negated.toNumber
                    if abs(amount) >= 0.005 {
                        stamped.append((amount, part.currency.uppercased()))
                    }
                }
                if !stamped.isEmpty {
                let recipient = try systemRecipientId(session)
                let parts = JSValue.array(
                    stamped.map { pair -> JSValue in
                        JSValue.object(
                            JSObject([
                                ("amount", JSValue.string(SQLArguments.javaScriptText(pair.amount))),
                                ("currency", JSValue.string(pair.currency)),
                            ]))
                    }
                ).jsonText
                let rows = try session.rows(
                    """
                    INSERT INTO transactions
                      (date, amount, currency, memo, account_id, recipient_id, is_transfer, transfer_source, is_active)
                    SELECT ?, vision_numeric(p.value ->> '$.amount', 18, 4), p.value ->> '$.currency',
                           'ACCOUNT CLOSE ADJUSTMENT', ?, ?, 1, 'adjustment', 1
                      FROM (SELECT value FROM json_each(?) ORDER BY key) p
                    RETURNING id, amount, currency, transfer_source
                    """,
                    [
                        .text(session.today()), .integer(Int64(id.rawValue)), .integer(Int64(recipient)),
                        .text(parts),
                    ])
                let insertedRows = try rows.map { try (try $0.integerId("id"), $0) }.sorted { $0.0 < $1.0 }.map { $0.1 }
                inserted = try insertedRows.map { row in
                    [
                        "id": .int(try row.integerId("id")),
                        "amount": number(try DecimalJS.from(try row.text("amount")).toNumber),
                        "currency": .string(try row.text("currency")),
                        "transfer_source": .string(try row.text("transfer_source")),
                    ]
                }
                }
            }
            _ = try session.rows(
                """
                UPDATE accounts
                   SET is_active = 0, in_net_worth = 0, closed_at = COALESCE(closed_at, now()), updated_at = now()
                 WHERE id = ?
                """,
                [.integer(Int64(id.rawValue))])
            return (false, inserted)
        }
        return HandlerResult(
            data: .object([
                "account_id": .int(id.rawValue), "balance_handling": .string(handling),
                "already_closed": .bool(outcome.alreadyClosed),
                "adjustments": .array(outcome.adjustments.map(JSONValue.object)), "links": .array([]),
            ]))
    }

    /// `mergePreviewQuery`: `?into=` as a strict positive integer, `1e3` refused.
    static func mergePreviewTarget(_ raw: String?) throws -> AccountID {
        if let value = TransactionsArea.validId(.string(raw ?? "")) {
            return AccountID(rawValue: value)
        }
        throw BackendHTTPError.validation("into must be a positive integer account id")
    }

    struct StampRange {
        let minDate: String
        let maxDate: String
    }

    /// `getStampedDateRangesByAccount`: the active stamped rows' date range per account.
    static func stampRanges(_ session: BackendSession, ids: [Int]) throws -> [StampRange] {
        let json = JSValue.array(ids.map(JSValue.int)).jsonText
        return try session.rows(
            """
            SELECT account_id, to_char(MIN(date), 'YYYY-MM-DD') AS min_date, to_char(MAX(date), 'YYYY-MM-DD') AS max_date
              FROM transactions
             WHERE account_id IN (SELECT value FROM json_each(?)) AND is_active = 1 AND balance IS NOT NULL
             GROUP BY account_id
            """,
            [.text(json)]).map {
                StampRange(minDate: try $0.text("min_date"), maxDate: try $0.text("max_date"))
            }
    }

    /// `stampRangesOverlap`: closed ranges, pairwise — lexicographic day text compares as dates.
    static func stampRangesOverlap(_ ranges: [StampRange]) -> Bool {
        for index in ranges.indices {
            for other in ranges[(index + 1)...] where
                ranges[index].minDate <= other.maxDate && other.minDate <= ranges[index].maxDate
            {
                return true
            }
        }
        return false
    }

    /// `getOpeningAnchorsByAccount` then `collidingAnchorCurrencies`.
    static func collidingAnchorCurrencies(_ session: BackendSession, ids: [Int]) throws -> [String] {
        let json = JSValue.array(ids.map(JSValue.int)).jsonText
        let anchors = try session.rows(
            """
            SELECT account_id, currency FROM transactions
             WHERE account_id IN (SELECT value FROM json_each(?)) AND transfer_source = 'opening'
            """,
            [.text(json)])
        var accountsByCurrency: [String: Set<Int>] = [:]
        for anchor in anchors {
            let code = storedCurrencyCode(try anchor.optionalText("currency"))
            accountsByCurrency[code, default: []].insert(try anchor.integerId("account_id"))
        }
        return accountsByCurrency.filter { $0.value.count > 1 }.map(\.key).sorted()
    }

    /// `previewMergeprojectedBalanceParts` — the anchor+delta partitions of survivor + source as
    /// one account: the union relabelled as the survivor over a CTE that shadows `transactions`.
    static func projectedBalanceParts(_ session: BackendSession, target: AccountID, union: [Int]) throws -> [Partition] {
        let unionJson = JSValue.array(union.map(JSValue.int)).jsonText
        let row = try session.row(
            """
            WITH transactions AS (
              SELECT CAST(?2 AS INTEGER) AS account_id, src.date, src.amount, src.currency,
                     src.is_active, src.balance, src.bank_sequence, src.id
                FROM main.transactions src
               WHERE src.account_id IN (SELECT value FROM json_each(?1))
            )
            SELECT bp.balance_parts
              FROM accounts a
              \(AccountBalanceSQL.balancePartsJoin(asOfDate: "?3"))
             WHERE a.id = ?2
            """,
            [.text(unionJson), .integer(Int64(target.rawValue)), .text(session.today())])
        return try balanceParts(try row?.optionalText("balance_parts"))
    }

    /// `countOf`: the rows of one table whose column references the source account.
    static func referenceCount(_ session: BackendSession, table: String, column: String, id: AccountID) throws -> Int {
        let row = try session.row(
            "SELECT COUNT(*) AS n FROM \(table) WHERE \(column) = ?", [.integer(Int64(id.rawValue))])
        return (try row.map { Int(try $0.int64("n")) }) ?? 0
    }

    static func mergePreview(
        _ session: BackendSession, source: AccountID, target: AccountID
    ) throws -> HandlerResult {
        if target == source { throw BackendHTTPError.validation("An account cannot be merged into itself") }
        guard let targetRow = try session.row("SELECT id, currency FROM accounts WHERE id = ?", [.integer(Int64(target.rawValue))])
        else { throw BackendHTTPError.notFound("Account \(target.rawValue) not found") }
        guard try session.row("SELECT id FROM accounts WHERE id = ?", [.integer(Int64(source.rawValue))]) != nil
        else { throw BackendHTTPError.notFound("Account \(source.rawValue) not found") }
        let targetCurrency = storedCurrencyCode(try targetRow.optionalText("currency"))
        let union = [target.rawValue, source.rawValue]
        let partitions = try projectedBalanceParts(session, target: target, union: union)
        let rates = try latestRatesToEur(session)
        var total = DecimalJS.zero
        var unconverted: [String] = []
        for part in partitions {
            if let converted = try convert(part.balance, from: part.currency, to: targetCurrency, rates: rates) {
                total = total.plus(converted)
            } else {
                unconverted.append(part.currency)
            }
        }
        return HandlerResult(
            data: .object([
                "into": .int(target.rawValue), "source": .int(source.rawValue),
                "reassigned": .object([
                    "transactions": .int(try referenceCount(session, table: "transactions", column: "account_id", id: source)),
                    "planned": .int(
                        try referenceCount(session, table: "planned_transactions", column: "account_id", id: source)),
                    "portfolio": .int(
                        try referenceCount(session, table: "portfolio_transactions", column: "account_id", id: source)),
                    "funding": .int(try referenceCount(session, table: "accounts", column: "funding_account_id", id: source)),
                ]),
                "projectedBalance": number(DecimalMoney.roundToCents(total).toNumber),
                "projectedBalanceCurrency": .string(targetCurrency),
                "balanceParts": .array(
                    partitions.map { .object(["currency": .string($0.currency), "balance": number($0.balance.toNumber)]) }),
                "projectedBalanceIncomplete": .bool(!unconverted.isEmpty),
                "unconvertedCurrencies": .array(unconverted.map(JSONValue.string)),
                "stampsInterleaved": .bool(
                    try stampRangesOverlap(stampRanges(session, ids: union))),
                "openingAnchorCollision": .bool(
                    try !collidingAnchorCurrencies(session, ids: union).isEmpty),
                "links": .array([]),
            ]))
    }

    /// `mergeBody`: every entry validated as sent, so a malformed entry rejects the whole request.
    static let maxMergeSources = 500

    static func mergeBodySourceIds(_ body: JSValue?) throws -> [Int] {
        var ids: [Int] = []
        guard let object = body?.objectValue else {
            if body == nil || body == .null { return ids }
            throw BackendHTTPError.validation("Invalid input: expected object, received \(body?.zodTypeName ?? "array")")
        }
        guard case .array(let rawIds)? = object["source_ids"] else { return ids }
        if rawIds.count > maxMergeSources {
            throw BackendHTTPError.validation("source_ids must contain at most \(maxMergeSources) accounts")
        }
        var rejected: [String] = []
        for (index, raw) in rawIds.enumerated() {
            if let id = TransactionsArea.validId(raw) {
                ids.append(id)
            } else {
                rejected.append("source_ids[\(index)] (\(raw.jsonText))")
            }
        }
        if !rejected.isEmpty {
            throw BackendHTTPError.validation(
                "source_ids must contain only integers, no accounts were merged: \(rejected.joined(separator: "; "))")
        }
        return ids
    }

    /// `assertMergeFundingCycleSafe`: a repointed funding edge may not close a cycle.
    static func assertMergeFundingCycleSafe(_ session: BackendSession, target: AccountID, sources: [Int]) throws {
        let sourceSet = Set(sources)
        var visited: Set<AccountID> = []
        var current = target
        var traversedRepointedEdge = false
        while !visited.contains(current) {
            visited.insert(current)
            guard
                let account = try getById(session, current),
                let rawParent = account.fundingAccountId
            else { return }
            let parent = sourceSet.contains(rawParent.rawValue) ? target : rawParent
            if parent != rawParent { traversedRepointedEdge = true }
            current = parent
        }
        if traversedRepointedEdge {
            throw BackendHTTPError.validation("Merging these accounts would create a funding-account cycle")
        }
    }

    /// `mergeAccounts`: repoint every reference, then delete the sources — atomically.
    /// Imported custody history (asset adjustments and asset transfers) references its accounts
    /// with ON DELETE RESTRICT, and a transfer between two merged accounts cannot be repointed
    /// (source and destination must differ), so the merge refuses before any write instead of
    /// failing on the source delete (Astra consolidated C3).
    static func assertNoMergeCustodyHistory(_ session: BackendSession, sourceJson: String) throws {
        let row = try session.row(
            """
            SELECT
              (SELECT count(*) FROM portfolio_asset_adjustments
                WHERE account_id IN (SELECT value FROM json_each(?1))) AS adjustments,
              (SELECT count(*) FROM portfolio_asset_transfers
                WHERE source_account_id IN (SELECT value FROM json_each(?1))
                   OR destination_account_id IN (SELECT value FROM json_each(?1))) AS transfers
            """, [.text(sourceJson)])
        let adjustments = Int(try row?.int64("adjustments") ?? 0)
        let transfers = Int(try row?.int64("transfers") ?? 0)
        guard adjustments == 0 && transfers == 0 else {
            throw BackendHTTPError.validation(
                "The account to merge has imported custody history (\(adjustments) asset adjustment(s), "
                    + "\(transfers) asset transfer(s)) that a merge cannot move. "
                    + "Undo the imports that created it, then merge.")
        }
    }

    static func merge(_ session: BackendSession, target: AccountID, sources: [Int]) throws -> HandlerResult {
        var seen: Set<Int> = []
        let ids = sources.filter { seen.insert($0).inserted }
        if ids.isEmpty {
            throw BackendHTTPError.validation("Provide at least one distinct source account to merge")
        }
        return try session.transaction {
            guard try getById(session, target) != nil else {
                throw BackendHTTPError.notFound("Account \(target.rawValue) not found")
            }
            let sourceJson = JSValue.array(ids.map(JSValue.int)).jsonText
            let found = try session.rows(
                "SELECT id FROM accounts WHERE id IN (SELECT value FROM json_each(?))", [.text(sourceJson)])
            let foundIds = Set(try found.map { try $0.integerId("id") })
            let missing = ids.filter { !foundIds.contains($0) }
            if !missing.isEmpty {
                throw BackendHTTPError.notFound("Account(s) not found: \(missing.map(String.init).joined(separator: ", "))")
            }
            try assertMergeFundingCycleSafe(session, target: target, sources: ids)
            try assertNoMergeCustodyHistory(session, sourceJson: sourceJson)
            let union = [target.rawValue] + ids
            let stampsInterleaved = try stampRangesOverlap(stampRanges(session, ids: union))
            let collisions = try collidingAnchorCurrencies(session, ids: union)
            if !collisions.isEmpty {
                throw BackendHTTPError.validation(
                    "More than one of these accounts has an opening balance in \(collisions.joined(separator: ", ")). "
                        + "Remove the opening balance from all but one of them, then merge "
                        + "(an account can hold only one opening balance per currency).")
            }
            let unionJson = JSValue.array(union.map(JSValue.int)).jsonText
            let arguments: [SQLValue] = [.integer(Int64(target.rawValue)), .text(sourceJson)]
            // The affected-row count, as the TypeScript repoints read it; no id list is built.
            func repointed(_ sql: String) throws -> Int {
                try session.write(sql, arguments)
            }
            let transactions = try repointed(
                "UPDATE transactions SET account_id = ?1 WHERE account_id IN (SELECT value FROM json_each(?2))")
            // A transfer whose two legs now sit in the survivor breaks the distinct-account
            // rule: release both legs so neither stays excluded from income and spending
            // (Astra report 4, finding 15). Swift only. System legs (anchors, adjustments,
            // trade cash legs) keep their marks.
            _ = try session.write(
                """
                UPDATE transactions SET is_transfer = 0, transfer_peer_id = NULL, transfer_source = NULL
                 WHERE account_id = ?1 AND transfer_source IN ('auto', 'manual')
                   AND transfer_peer_id IN (SELECT id FROM transactions WHERE account_id = ?1)
                """, [.integer(Int64(target.rawValue))])
            let planned = try repointed(
                "UPDATE planned_transactions SET account_id = ?1 WHERE account_id IN (SELECT value FROM json_each(?2))")
            let portfolio = try repointed(
                "UPDATE portfolio_transactions SET account_id = ?1 WHERE account_id IN (SELECT value FROM json_each(?2))")
            _ = try repointed(
                "UPDATE portfolio_import_batches SET account_id = ?1 WHERE account_id IN (SELECT value FROM json_each(?2))")
            let funding = try repointed(
                "UPDATE accounts SET funding_account_id = ?1 WHERE funding_account_id IN (SELECT value FROM json_each(?2))")
            if stampsInterleaved {
                _ = try session.rows(
                    "DELETE FROM account_statement_balances WHERE account_id = ?", [.integer(Int64(target.rawValue))])
            }
            _ = try session.rows(
                "DELETE FROM accounts WHERE id IN (SELECT value FROM json_each(?)) AND id <> ?",
                [.text(sourceJson), .integer(Int64(target.rawValue))])
            return HandlerResult(
                data: .object([
                    "into": .int(target.rawValue),
                    "merged": .array(ids.map(JSONValue.int)),
                    "reassigned": .object([
                        "transactions": .int(transactions), "planned": .int(planned),
                        "portfolio": .int(portfolio), "funding": .int(funding),
                    ]),
                    "stampsInterleaved": .bool(stampsInterleaved), "links": .array([]),
                ]))
        }
    }

    /// `validateDateString`: `new Date` accepts any `YYYY-MM-DD` with a real month, rolling days.
    static func openingBalanceDate(_ text: String) -> String? {
        let bytes = Array(text.utf8)
        guard bytes.count == 10, bytes[4] == 45, bytes[7] == 45 else { return nil }
        func value(_ range: Range<Int>) -> Int { range.reduce(0) { $0 * 10 + Int(bytes[$1] - 48) } }
        guard [0, 1, 2, 3, 5, 6, 8, 9].allSatisfy({ (48...57).contains(bytes[$0]) }) else { return nil }
        let month = value(5..<7)
        let day = value(8..<10)
        guard (1...12).contains(month), (1...31).contains(day) else { return nil }
        return text
    }

    /// The transaction row as `transactionRowSchema` wires it: amounts as decimal text, the
    /// date as its UTC-midnight instant.
    static func rawTransactionJSON(_ row: SQLRow) throws -> JSONValue {
        func nullableId(_ column: String) throws -> JSONValue {
            try row.optionalInt64(column).map { JSONValue.int(Int($0)) } ?? .null
        }
        func nullableText(_ column: String) throws -> JSONValue {
            try row.optionalText(column).map(JSONValue.string) ?? .null
        }
        return .object([
            "id": .int(try row.integerId("id")),
            "date": .string(try row.text("row_date")),
            "amount": .string(try row.text("amount")),
            "currency": .string(try row.text("currency")),
            "balance": try nullableText("balance"),
            "memo": try nullableText("memo"),
            "comment": try nullableText("comment"),
            "recipient_id": .int(try row.integerId("recipient_id")),
            "recipient_bank_account_id": try nullableId("recipient_bank_account_id"),
            "category_id": try nullableId("category_id"),
            "is_active": .bool(try row.bool("is_active")),
            "created_at": .string(try row.instant("created_at").text),
            "updated_at": .string(try row.instant("updated_at").text),
            "import_batch_id": try nullableId("import_batch_id"),
            "matched_pattern_id": try nullableId("matched_pattern_id"),
            "is_transfer": .bool(try row.bool("is_transfer")),
            "transfer_peer_id": try nullableId("transfer_peer_id"),
            "transfer_source": try nullableText("transfer_source"),
            "account_id": try nullableId("account_id"),
            "source_record_hash": try nullableText("source_record_hash"),
            "dedup_fingerprint": try nullableText("dedup_fingerprint"),
            "dedup_fingerprint_version": try nullableId("dedup_fingerprint_version"),
            "bank_sequence": try nullableText("bank_sequence"),
        ])
    }

    /// The `RETURNING` columns of the opening-balance anchor upsert.
    static let anchorColumns = """
        id, to_char(date, 'YYYY-MM-DD') || 'T00:00:00.000Z' AS row_date, amount, currency, balance, memo, comment,
        recipient_id, recipient_bank_account_id, category_id, is_active, created_at, updated_at, import_batch_id,
        matched_pattern_id, is_transfer, transfer_peer_id, transfer_source, account_id, source_record_hash,
        dedup_fingerprint, dedup_fingerprint_version, bank_sequence
        """

    /// `setOpeningBalance`: stamp or refresh the single opening-balance anchor of an account+currency.
    static func openingBalance(_ session: BackendSession, id: AccountID, body: JSValue?) throws -> HandlerResult {
        guard let account = try getById(session, id) else {
            throw BackendHTTPError.notFound("Account \(id.rawValue) not found")
        }
        let object = body?.objectValue
        var issues: [String] = []
        let rawBalance = object?["balance"]
        var balance = 0.0
        if let value = rawBalance, value != .null, value != .string(""), value.javaScriptNumber.isFinite {
            balance = value.javaScriptNumber
        } else {
            issues.append("balance is required and must be a number")
        }
        let rawDate = object?["date"]
        let dateText = (rawDate == nil || rawDate == .null) ? "" : looseText(rawDate)
        var day = ""
        if dateText.isEmpty {
            issues.append("date is required and must be an ISO date (YYYY-MM-DD)")
        } else if !TransactionsArea.isYmdShape(dateText) {
            // `validateDateString`'s regex reject keeps its own wording before the
            // month/day range read adds "date is not a valid date".
            issues.append("date must be in YYYY-MM-DD format")
        } else if openingBalanceDate(dateText) == nil {
            issues.append("date is not a valid date")
        } else {
            day = dateText
        }
        let rawCurrency = object?["currency"]
        var currency: String?
        if let rawCurrency, rawCurrency != .null, rawCurrency != .string("") {
            let code = JavaScriptWhitespace.trim(rawCurrency.javaScriptString.uppercased())
            if isCurrencyCode(code) {
                currency = code
            } else {
                issues.append("currency must be a 3-letter ISO code")
            }
        }
        if !issues.isEmpty { throw BackendHTTPError.validation(issues.joined(separator: "; ")) }
        let anchorCurrency = currency ?? storedCurrencyCode(account.currency)
        return try session.transaction {
            let earliest = try session.row(
                """
                SELECT to_char(MIN(date), 'YYYY-MM-DD') AS earliest
                  FROM transactions
                 WHERE account_id = ? AND is_active = 1 AND currency = ? AND transfer_source IS NOT 'opening'
                """,
                [.integer(Int64(id.rawValue)), .text(anchorCurrency)])
            let warning: JSONValue
            if let earliest, let first = try earliest.optionalText("earliest"), first <= day {
                warning = .string(
                    "Opening-balance date does not precede existing activity; a later import-stamped balance will override this anchor.")
            } else {
                warning = .null
            }
            let recipient = try systemRecipientId(session)
            let existing = try session.row(
                "SELECT id FROM transactions WHERE account_id = ? AND transfer_source = 'opening' AND currency = ? LIMIT 1",
                [.integer(Int64(id.rawValue)), .text(anchorCurrency)])
            let balanceText = SQLArguments.javaScriptText(balance)
            let anchor: SQLRow
            if let existing {
                guard
                    let row = try session.row(
                        """
                        UPDATE transactions
                           SET balance = vision_numeric(?, 18, 4), date = ?, memo = 'OPENING BALANCE',
                               amount = vision_numeric(0, 18, 4), is_active = 1, updated_at = now()
                         WHERE id = ?
                        RETURNING \(AccountsArea.anchorColumns)
                        """,
                        [.text(balanceText), .text(day), .integer(Int64(try existing.integerId("id")))])
                else {
                    throw SQLRowDecodingError(column: "transactions", problem: "the anchor UPDATE returned no row")
                }
                anchor = row
            } else {
                guard
                    let row = try session.row(
                        """
                        INSERT INTO transactions
                          (date, amount, balance, currency, memo, account_id, recipient_id, is_transfer, transfer_source, is_active)
                        VALUES (?, vision_numeric(0, 18, 4), vision_numeric(?, 18, 4), ?, 'OPENING BALANCE', ?, ?, 1, 'opening', 1)
                        RETURNING \(AccountsArea.anchorColumns)
                        """,
                        [
                            .text(day), .text(balanceText), .text(anchorCurrency),
                            .integer(Int64(id.rawValue)), .integer(Int64(recipient)),
                        ])
                else {
                    throw SQLRowDecodingError(column: "transactions", problem: "the anchor INSERT returned no row")
                }
                anchor = row
            }
            return HandlerResult(
                data: .object([
                    "transaction": try rawTransactionJSON(anchor), "warning": warning, "links": .array([]),
                ]))
        }
    }

    /// `reconcileAccount`: resolve the account's drift by accepting the ledger or stamping a delta.
    static func reconcile(_ session: BackendSession, id: AccountID, body: JSValue?) throws -> HandlerResult {
        let object = body?.objectValue
        let mode = looseText(object?["mode"] ?? .string(""))
        guard mode == "accept" || mode == "adjustment" else {  // lint:allow string-literal-compare the two reconcile modes of reconcileService
            throw BackendHTTPError.validation("mode is required and must be 'accept' or 'adjustment'")
        }
        var requestedCode: String?
        if let rawCurrency = object?["currency"], rawCurrency != .null, rawCurrency != .string("") {
            let code = JavaScriptWhitespace.trim(rawCurrency.javaScriptString.uppercased())
            guard isCurrencyCode(code) else {
                throw BackendHTTPError.validation("currency must be a 3-letter ISO code")
            }
            requestedCode = code
        }
        return try session.transaction {
            guard let account = try getById(session, id) else {
                throw BackendHTTPError.notFound("Account \(id.rawValue) not found")
            }
            let currencyValue: SQLValue = requestedCode.map(SQLValue.text) ?? .null
            let row = try session.row(
                """
                SELECT a.currency AS account_currency, COALESCE(?2, a.currency) AS reconcile_currency,
                       s.balance AS statement_balance, bp.balance_parts
                  FROM accounts a
                  \(AccountBalanceSQL.balancePartsJoin(asOfDate: "?1"))
                  LEFT JOIN account_statement_balances s
                    ON s.account_id = a.id AND s.currency = COALESCE(?2, a.currency)
                 WHERE a.id = ?3
                """,
                [.text(session.today()), currencyValue, .integer(Int64(id.rawValue))])
            guard let row else { throw BackendHTTPError.notFound("Account \(id.rawValue) not found") }
            guard let statementText = try row.optionalText("statement_balance") else {
                throw BackendHTTPError.validation("Account has no statement balance to reconcile against")
            }
            let parts = try balanceParts(try row.optionalText("balance_parts"))
            let fallbackBase = statementPartition(parts, of: account)
            // The statement was read in the account currency; a fallback partition in another
            // currency would post the drift unconverted in that currency (Astra consolidated C1).
            let statementCurrency = storedCurrencyCode(account.currency)
            if requestedCode == nil, fallbackBase.currency.uppercased() != statementCurrency.uppercased() {
                throw BackendHTTPError.validation(
                    "The statement balance is in \(statementCurrency) but the ledger balance is in "
                        + "\(fallbackBase.currency.uppercased()). Choose the currency to reconcile.")
            }
            let reconcileCurrency = (requestedCode ?? fallbackBase.currency).uppercased()
            let exactPart = parts.first { $0.currency.uppercased() == reconcileCurrency }
            let base: Partition
            if let requestedCode {
                base = Partition(currency: reconcileCurrency, balance: exactPart?.balance ?? .zero)
            } else {
                base = fallbackBase
            }
            let statement = try DecimalJS.from(statementText).toNumber
            let computed = DecimalMoney.roundToCents(base.balance).toNumber
            let drift = try DecimalJS.from(SQLArguments.javaScriptText(statement))
                .minus(DecimalJS.from(SQLArguments.javaScriptText(computed))).toNumber
            if abs(drift) < 0.005 {
                throw BackendHTTPError.validation("Account is already reconciled (no drift to resolve)")
            }
            if mode == "accept" {  // lint:allow string-literal-compare the two reconcile modes of reconcileService
                guard
                    let upserted = try session.row(
                        """
                        INSERT INTO account_statement_balances (account_id, currency, balance, balance_date)
                        VALUES (?, ?, vision_numeric(?, 18, 4), ?)
                        ON CONFLICT (account_id, currency) DO UPDATE SET balance = excluded.balance,
                          balance_date = excluded.balance_date
                        RETURNING balance
                        """,
                        [
                            .integer(Int64(id.rawValue)), .text(reconcileCurrency),
                            .text(SQLArguments.javaScriptText(computed)), .text(session.today()),
                        ])
                else {
                    throw SQLRowDecodingError(
                        column: "account_statement_balances", problem: "the upsert returned no row")
                }
                return HandlerResult(
                    data: .object([
                        "mode": .string(mode), "drift": .int(0), "currency": .string(reconcileCurrency),
                        "statement_balance": number(try DecimalJS.from(try upserted.text("balance")).toNumber),
                        "computed_balance": number(computed), "transaction": .null, "links": .array([]),
                    ]))
            }
            let recipient = try systemRecipientId(session)
            guard
                let inserted = try session.row(
                    """
                    INSERT INTO transactions
                      (date, amount, currency, memo, account_id, recipient_id, is_transfer, transfer_source, is_active)
                    VALUES (?, vision_numeric(?, 18, 4), ?, 'BALANCE ADJUSTMENT', ?, ?, 1, 'adjustment', 1)
                    RETURNING id, amount, transfer_source
                    """,
                    [
                        .text(session.today()), .text(SQLArguments.javaScriptText(drift)), .text(base.currency),
                        .integer(Int64(id.rawValue)), .integer(Int64(recipient)),
                    ])
            else {
                throw SQLRowDecodingError(column: "transactions", problem: "the adjustment INSERT returned no row")
            }
            return HandlerResult(
                data: .object([
                    "mode": .string(mode), "drift": .int(0), "currency": .string(reconcileCurrency),
                    "statement_balance": number(statement), "computed_balance": number(statement),
                    "transaction": .object([
                        "id": .int(try inserted.integerId("id")),
                        "amount": number(try DecimalJS.from(try inserted.text("amount")).toNumber),
                        "transfer_source": .string(try inserted.text("transfer_source")),
                    ]),
                    "links": .array([]),
                ]))
        }
    }
}
