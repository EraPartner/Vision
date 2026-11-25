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
    static func register(_ backend: inout InProcessBackend, database: BackendDatabase) {
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
}
