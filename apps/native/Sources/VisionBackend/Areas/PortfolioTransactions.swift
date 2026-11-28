import Foundation
import VisionNativeCore

/// The portfolio-transaction write routes of `routes/investments.ts`:
/// `services/investmentService.ts` over `services/portfolio/portfolioTransactionRules.ts`,
/// `portfolioTransactionService.ts` and `portfolioBrokerRetagService.ts`, with their
/// repositories' SQL. `createInvestmentTransaction`, `updatePortfolioTransaction`,
/// `deletePortfolioTransaction` replay the route's zod body gate, the payload
/// normalization, the ADR-108 unit-history validation and the SQL writes;
/// `bulkRetagPortfolioTransactions` replays the compare-and-set re-tag with its
/// partition and cost-basis economics guards.
///
/// The TypeScript `create` answers `data: null` although it writes the row: Bun's
/// `returningAll()` on `INSERT .. ON CONFLICT DO NOTHING` yields no row there, and the
/// route sends that null. The Swift port performs the same insert and mirrors the answer.
enum PortfolioTransactionsArea {
    /// Each successful create, update and delete starts the investment's price-history
    /// refresh (`refreshQuotesForInvestment`) without waiting for it, as the TypeScript route.
    static func register(
        _ backend: inout InProcessBackend, database: BackendDatabase, quotes: QuoteRefresher
    ) {
        backend.serve(OpenAPIOperations.CreateInvestmentTransaction.self) { request in
            let id = try InvestmentsArea.pathId(request)
            let body = try RequestBody.parseJavaScript(request.body)
            let result = try await database.run { session in
                try Self.create(session, Int(id.rawValue), body)
            }
            quotes.schedule(investment: Int(id.rawValue))
            return result
        }
        backend.serve(OpenAPIOperations.UpdatePortfolioTransaction.self) { request in
            let txnId = try Self.txnPathId(request)
            let body = try RequestBody.parseJavaScript(request.body)
            let row = try await database.run { session in
                try Self.updatedRow(session, txnId, body)
            }
            quotes.schedule(investment: row.investmentId.rawValue)
            return HandlerResult(data: .object(row.json))
        }
        backend.serve(OpenAPIOperations.DeletePortfolioTransaction.self) { request in
            let txnId = try Self.txnPathId(request)
            let investment = try await database.run { session in
                try Self.removeRow(session, txnId)
            }
            quotes.schedule(investment: investment)
            return HandlerResult(status: 204, data: .null)
        }
        backend.serve(OpenAPIOperations.BulkRetagPortfolioTransactions.self) { request in
            let body = try RequestBody.parseJavaScript(request.body)
            return try await database.run { session in
                try Self.retag(session, body)
            }
        }
    }

    /// `parseRequest({ params: txnParams })` in front of both `:txnId` routes.
    static func txnPathId(_ request: InProcessRequest) throws -> Int {
        let raw = request.pathParameters["txnId"] ?? ""
        guard let id = RequestID.valid(.string(raw)) else {
            throw BackendHTTPError.validation("txnId: must be a positive integer")
        }
        return Int(id)
    }

    // MARK: - The route's zod body (`parsePortfolioTransactionBody`)

    /// `PORTFOLIO_TXN_TYPES` of `@vision/types/portfolioTxnTypes`, the zod enum's order.
    static let txnTypes: [String] = [
        "buy", "sell", "dividend", "fee", "tax", "interest", "rent_income", "appreciation",
        "gift", "split", "merger", "spinoff", "return_of_capital",
    ]

    /// `PORTFOLIO_RECURRENCE_INTERVALS` of `@vision/types/recurrence`.
    static let recurrenceIntervals: [String] = [
        "daily", "weekly", "biweekly", "monthly", "quarterly", "yearly",
    ]

    /// The zod enum issue text: `Invalid option: expected one of "a"|"b"`.
    static func enumIssue(_ field: String, _ options: [String]) -> String {
        "\(field): Invalid option: expected one of \(options.map { "\"\($0)\"" }.joined(separator: "|"))"
    }

    /// The zod shape issue text of a received value.
    static func received(_ value: JSValue) -> String {
        switch value {
        case .null: return "null"
        case .bool: return "boolean"
        case .number(let value): return value.isNaN ? "NaN" : "number"
        case .string: return "string"
        case .array: return "array"
        case .object: return "object"
        }
    }

    /// `DECIMAL_NUMBER_STRING` of the service: a plain decimal literal or string.
    static func isDecimalNumberString(_ text: String) -> Bool {
        let bytes = Array(text.utf8)
        var index = 0
        if index < bytes.count, bytes[index] == UInt8(ascii: "-") { index += 1 }
        var whole = 0
        var fraction = 0
        while index < bytes.count, (48...57).contains(bytes[index]) { index += 1; whole += 1 }
        if index < bytes.count, bytes[index] == UInt8(ascii: ".") {
            index += 1
            while index < bytes.count, (48...57).contains(bytes[index]) { index += 1; fraction += 1 }
        }
        guard whole + fraction > 0, whole > 0 || fraction > 0 else { return false }
        if index < bytes.count, bytes[index] == UInt8(ascii: "e") || bytes[index] == UInt8(ascii: "E") {
            index += 1
            if index < bytes.count, bytes[index] == UInt8(ascii: "+") || bytes[index] == UInt8(ascii: "-") { index += 1 }
            var exponent = 0
            while index < bytes.count, (48...57).contains(bytes[index]) { index += 1; exponent += 1 }
            if exponent == 0 { return false }
        }
        return index == bytes.count
    }

    /// `assertCurrency` of `lib/validation.ts`: three upper-case letters after the loose
    /// string's trim and uppercasing.
    static func assertCurrency(_ value: String) -> String? {
        let currency = value.uppercased().trimmingCharacters(in: .whitespacesAndNewlines)
        return CurrencyCode(rawValue: currency)?.rawValue
    }

    /// `portfolioNumberField`: null and the empty string pass through; otherwise a number or
    /// a decimal string, bounds-checked by `validateNumber`.
    static func numberField(
        _ value: JSValue?, _ field: String, _ max: Double, _ issues: inout [String]
    ) -> JSValue? {
        guard let value, value != .null, value != .string("") else { return value }
        let bounds = "must be between \(formatInteger(-max)) and \(formatInteger(max))"
        switch value {
        case .number(let number):
            guard number.isFinite else {
                issues.append("\(field): \(field) must be a finite number")
                return nil
            }
            guard number >= -max, number <= max else {
                issues.append("\(field): \(field) \(bounds)")
                return nil
            }
            return value
        case .string(let text):
            guard isDecimalNumberString(text) else {
                issues.append("\(field): \(field) must be a number")
                return nil
            }
            let parsed = JavaScriptNumber.fromString(text)
            guard parsed.isFinite else {
                issues.append("\(field): \(field) must be a finite number")
                return nil
            }
            guard parsed >= -max, parsed <= max else {
                issues.append("\(field): \(field) \(bounds)")
                return nil
            }
            return .number(parsed)
        default:
            issues.append("\(field): \(field) must be a number")
            return nil
        }
    }

    static func formatInteger(_ value: Double) -> String {
        value == value.rounded() && abs(value) < 1e15
            ? String(Int64(value))
            : SQLArguments.javaScriptText(value)
    }

    /// `portfolioDateField`: `validateDateString`'s `YYYY-MM-DD` shape, then the same
    /// calendar-day reality `new Date(value)` and the ISO round-trip assert together (an
    /// impossible day like 2024-13-45 or 2024-02-30 is `is not a valid date`).
    static func dateField(
        _ value: JSValue?, _ field: String, _ allowClear: Bool, _ issues: inout [String]
    ) -> String? {
        guard let value else { return nil }
        if value == .null || value == .string("") {
            if allowClear { return nil }
            issues.append("\(field): \(field) cannot be cleared")
            return nil
        }
        guard case .string(let text) = value else {
            issues.append("\(field): \(field) must be in YYYY-MM-DD format")
            return nil
        }
        let bytes = Array(text.utf8)
        let digits: (Range<Int>) -> Bool = { range in range.allSatisfy { (48...57).contains(bytes[$0]) } }
        let shape = bytes.count == 10 && digits(0..<4) && bytes[4] == 45 && digits(5..<7)
            && bytes[7] == 45 && digits(8..<10)
        if !shape {
            issues.append("\(field): \(field) must be in YYYY-MM-DD format")
            return nil
        }
        let year = Int(String(decoding: bytes[0..<4], as: UTF8.self)) ?? 0
        let month = Int(String(decoding: bytes[5..<7], as: UTF8.self)) ?? 0
        let day = Int(String(decoding: bytes[8..<10], as: UTF8.self)) ?? 0
        guard CalendarDay(year: year, month: month, day: day) != nil, year > 0 else {
            issues.append("\(field): \(field) is not a valid date")
            return nil
        }
        return text
    }

    /// The validated write body, with each optional field's presence kept.
    struct TxnBody {
        var type: String?
        var date: String?
        var amount: JSValue?
        var units: JSValue?
        var pricePerUnit: JSValue?
        var fees: JSValue?
        var taxes: JSValue?
        var dividendAmountConvention: String?
        var currency: JSValue?
        var fxRateToEur: JSValue?
        var note: String?
        var isRecurring: Bool?
        var recurrenceInterval: String?
        var recurrenceEndDate: String?
        var accountId: JSValue?
        var hasRecurrenceEndDate = false
        var recurrenceEndDay: String?
        var hasIncomeRecognitionRole = false
        /// The column names the raw body carried, for the PATCH hasOwnProperty checks.
        var present: Set<String> = []
    }

    /// `parsePortfolioTransactionBody`: the schema's safeParse issues joined with `; `, the
    /// loose pass-through shape beside them.
    static func parseBody(_ body: JSValue?) throws -> TxnBody {
        var out = TxnBody()
        var issues: [String] = []
        guard let body, case .object(let object) = body else {
            // A primitive body is what zod names: only the corpus's object bodies reach the
            // fields, so the whole-body issue matches zod's `expected object` text.
            guard let body else { return out }
            throw BackendHTTPError.validation(
                "Invalid input: expected object, received \(received(body))")
        }
        out.hasIncomeRecognitionRole = object.has("income_recognition_role")
        out.present = Set(object.keys)
        // `z.enum(...).optional()`: a present value of any other kind (a number, null) is
        // the same invalid-option issue as an unknown string.
        if let type = object["type"] {
            if case .string(let text) = type, txnTypes.contains(text) {
                out.type = text
            } else {
                issues.append(enumIssue("type", txnTypes))
            }
        }
        out.date = dateField(object["date"], "date", false, &issues)
        out.amount = numberField(object["amount"], "amount", 99_999_999_999_999, &issues)
        out.units = numberField(object["units"], "units", 9_999_999_999, &issues)
        out.pricePerUnit = numberField(object["price_per_unit"], "price_per_unit", 999_999_999_999, &issues)
        out.fees = numberField(object["fees"], "fees", 99_999_999_999_999, &issues)
        out.taxes = numberField(object["taxes"], "taxes", 99_999_999_999_999, &issues)
        if let convention = object["dividend_amount_convention"] {
            if case .string(let text) = convention, ["gross", "net", "unknown"].contains(text) {
                out.dividendAmountConvention = text
            } else {
                issues.append(enumIssue("dividend_amount_convention", ["gross", "net", "unknown"]))
            }
        }
        out.currency = currencyField(object["currency"], &issues)
        out.fxRateToEur = numberField(object["fx_rate_to_eur"], "fx_rate_to_eur", 9_999_999_999, &issues)
        if let note = object["note"], note != .null {
            if case .string = note {} else {
                issues.append("note: Invalid input: expected string, received \(received(note))")
            }
            if case .string(let text) = note { out.note = text }
        }
        // `z.boolean().optional()`: null is not a boolean.
        if let recurring = object["is_recurring"] {
            if case .bool(let flag) = recurring {
                out.isRecurring = flag
            } else {
                issues.append(
                    "is_recurring: Invalid input: expected boolean, received \(received(recurring))")
            }
        }
        out.recurrenceInterval = recurrenceField(object["recurrence_interval"], &issues)
        if object["recurrence_end_date"] != nil {
            out.hasRecurrenceEndDate = true
            out.recurrenceEndDay = dateField(
                object["recurrence_end_date"], "recurrence_end_date", true, &issues)
        }
        out.accountId = object["account_id"]
        if !issues.isEmpty { throw BackendHTTPError.validation(issues.joined(separator: "; ")) }
        return out
    }

    /// `portfolioCurrencyField`: null/'' stay for the endpoint's own decision; a string is
    /// ISO-checked through `assertCurrency`.
    static func currencyField(_ value: JSValue?, _ issues: inout [String]) -> JSValue? {
        guard let value else { return nil }
        if value == .null { return .null }
        if value == .string("") { return .string("") }
        guard case .string(let text) = value, assertCurrency(text) != nil else {
            issues.append("currency: currency must be a 3-letter ISO code")
            return nil
        }
        return .string(text)
    }

    /// `portfolioRecurrenceIntervalField`: the enum, null, or the empty string as null.
    static func recurrenceField(_ value: JSValue?, _ issues: inout [String]) -> String? {
        guard let value else { return nil }
        if value == .null || value == .string("") { return "" }
        guard case .string(let text) = value, recurrenceIntervals.contains(text) else {
            issues.append(enumIssue("recurrence_interval", recurrenceIntervals))
            return nil
        }
        return text
    }
}

// MARK: - The service payload and the shared rules engine

extension PortfolioTransactionsArea {
    /// `normalizeTransactionPayload` output: the fields the rules always (re)write.
    struct Normalized {
        var dividendAmountConvention: String
        var amount: Double?
        var units: Double?
        var pricePerUnit: Double?
        var fees: Double
        var taxes: Double
        var fxRateToEur: Double?
    }

    /// `parseOptionalNumber`: nullish and the empty string are absent, `Number(value)` else.
    static func optionalNumber(_ value: JSValue?, _ field: String, _ issues: inout [String]) -> Double? {
        guard let value, value != .null else { return nil }
        if case .string(let text) = value, text.isEmpty { return nil }
        let parsed = value.javaScriptNumber
        guard !parsed.isNaN else {
            issues.append("\(field) must be a valid number")
            return nil
        }
        return parsed
    }

    static let unitBasedAssetClasses: Set<String> = ["stock", "etf", "crypto", "metals"]

    static let epsilon = 1e-8

    /// Decimal helpers on the money shift the rules engine uses.
    static func decimal(_ value: Double) -> DecimalJS { (try? DecimalJS(value)) ?? .zero }
    static func decimalText(_ value: JSValue?) -> DecimalJS {
        guard let value, value != .null else { return .zero }
        switch value {
        case .number(let number): return decimal(number)
        case .string(let text): return (try? DecimalJS(text)) ?? .zero
        default: return .zero
        }
    }

    /// `roundMoney(value, places)`: half-even at `places`, back to a double.
    static func roundMoney(_ value: Double, _ places: Int) -> Double {
        decimal(value).toDecimalPlaces(places, .halfEven).toNumber
    }

    /// `normalizeBuySellMath`: any two of amount, units and price give the third; the three
    /// must agree within one cent.
    static func buySellMath(
        _ amount: Double?, _ units: Double?, _ pricePerUnit: Double?
    ) throws -> (amount: Double, units: Double, pricePerUnit: Double) {
        let hasAmount = amount != nil, hasUnits = units != nil, hasPrice = pricePerUnit != nil
        let provided = (hasAmount ? 1 : 0) + (hasUnits ? 1 : 0) + (hasPrice ? 1 : 0)
        if provided < 2 {
            throw BackendHTTPError.validation(
                "For buy/sell transactions, provide at least two of amount, units, and price_per_unit")
        }
        if let units, units <= 0 { throw positive() }
        if let pricePerUnit, pricePerUnit <= 0 { throw positive() }
        if let amount, amount <= 0 { throw positive() }
        func positive() -> BackendHTTPError {
            .validation(
                "For buy/sell transactions, amount, units, and price_per_unit must be positive")
        }
        var nextAmount = amount
        // Units and price are checked and multiplied in the form their NUMERIC(18,8) and
        // NUMERIC(18,6) columns store, so a stored trade still passes this check when it is
        // edited later (Astra report 4, finding 3). Swift only.
        var nextUnits = units.map { roundMoney($0, 8) }
        var nextPrice = pricePerUnit.map { roundMoney($0, 6) }
        if let nextUnits, nextUnits <= 0 { throw positive() }
        if let nextPrice, nextPrice <= 0 { throw positive() }
        // `multiply` and `divide` are decimal operations: 0.35 units at 0.005 is exactly
        // 0.00175, which rounds half-even to 0.0018, where the binary product rounds to 0.0017.
        func product(_ a: Double?, _ b: Double?) -> Double {
            decimal(a ?? 0).times(decimal(b ?? 0)).toDecimalPlaces(4, .halfEven).toNumber
        }
        func quotient(_ a: Double?, _ b: Double?, _ places: Int) -> Double {
            guard let value = try? decimal(a ?? 0).dividedBy(decimal(b ?? 0)) else { return .nan }
            return value.toDecimalPlaces(places, .halfEven).toNumber
        }
        if !hasAmount { nextAmount = product(nextUnits, nextPrice) }
        if !hasUnits { nextUnits = quotient(nextAmount, nextPrice, 8) }
        if !hasPrice { nextPrice = quotient(nextAmount, nextUnits, 6) }
        let expectedAmount = product(nextUnits, nextPrice)
        let comparableAmount = roundMoney(nextAmount ?? 0, 4)
        let difference = decimal(expectedAmount).minus(decimal(comparableAmount)).abs
        if difference.gt(decimal(0.01)) {
            throw BackendHTTPError.validation(
                "amount must equal units * price_per_unit for buy/sell transactions")
        }
        return (comparableAmount, roundMoney(nextUnits ?? 0, 8), roundMoney(nextPrice ?? 0, 6))
    }

    /// `normalizeTransactionPayload` for the write routes: the validated vocabulary plus the
    /// pass-through fields, with the rules' derived unit math.
    static func normalize(
        _ type: String?, _ recurrenceInterval: String?, _ dividendConvention: String?,
        _ amount: JSValue?, _ units: JSValue?, _ pricePerUnit: JSValue?,
        _ fees: JSValue?, _ taxes: JSValue?, _ fxRateToEur: JSValue?,
        assetClass: String?
    ) throws -> Normalized {
        if let type, !txnTypes.contains(type) {
            throw BackendHTTPError.validation("Invalid transaction type: \(type)")
        }
        if let recurrenceInterval, !recurrenceInterval.isEmpty, !recurrenceIntervals.contains(recurrenceInterval) {
            throw BackendHTTPError.validation("Invalid recurrence_interval: \(recurrenceInterval)")
        }
        let convention = dividendConvention ?? "unknown"
        guard ["gross", "net", "unknown"].contains(convention) else {
            throw BackendHTTPError.validation("Invalid dividend_amount_convention: \(convention)")
        }
        if type != "dividend" && convention != "unknown" {
            throw BackendHTTPError.validation(
                "dividend_amount_convention is only valid for dividend transactions")
        }
        var issues: [String] = []
        let amountNumber = optionalNumber(amount, "amount", &issues)
        let unitsNumber = optionalNumber(units, "units", &issues)
        let priceNumber = optionalNumber(pricePerUnit, "price_per_unit", &issues)
        let feesNumber = optionalNumber(fees, "fees", &issues)
        let taxesNumber = optionalNumber(taxes, "taxes", &issues)
        let fxNumber = optionalNumber(fxRateToEur, "fx_rate_to_eur", &issues)
        if !issues.isEmpty { throw BackendHTTPError.validation(issues.joined(separator: "; ")) }
        if let fxNumber, fxNumber <= 0 {
            throw BackendHTTPError.validation("fx_rate_to_eur must be positive")
        }
        let unitBased = assetClass.map(unitBasedAssetClasses.contains) ?? false

        if type == "buy" || type == "sell" {  // lint:allow string-literal-compare the stored wire value the TypeScript service dispatches on
            if unitBased {
                let math = try buySellMath(amountNumber, unitsNumber, priceNumber)
                return Normalized(
                    dividendAmountConvention: convention, amount: math.amount, units: math.units,
                    pricePerUnit: math.pricePerUnit, fees: feesNumber ?? 0, taxes: taxesNumber ?? 0,
                    fxRateToEur: fxNumber)
            }
            guard let amountNumber, amountNumber > 0 else {
                throw BackendHTTPError.validation("amount is required")
            }
            return Normalized(
                dividendAmountConvention: convention, amount: amountNumber, units: unitsNumber,
                pricePerUnit: priceNumber, fees: feesNumber ?? 0, taxes: taxesNumber ?? 0,
                fxRateToEur: fxNumber)
        }
        if type == "gift" {  // lint:allow string-literal-compare the stored wire value the TypeScript service dispatches on
            if let assetClass, !unitBasedAssetClasses.contains(assetClass) {
                throw BackendHTTPError.validation(
                    "gift transactions are only supported for unit-based investments")
            }
            guard let unitsNumber, unitsNumber > 0 else {
                throw BackendHTTPError.validation("gift transactions require units > 0")
            }
            if (feesNumber ?? 0) != 0 || (taxesNumber ?? 0) != 0 {
                throw BackendHTTPError.validation("gift transactions must have 0 fees and 0 taxes")
            }
            if let amountNumber, amountNumber < 0 {
                throw BackendHTTPError.validation("gift transaction amount cannot be negative")
            }
            return Normalized(
                dividendAmountConvention: convention, amount: amountNumber ?? 0,
                units: roundMoney(unitsNumber, 8),
                pricePerUnit: priceNumber.map { roundMoney($0, 6) },
                fees: 0, taxes: 0, fxRateToEur: fxNumber)
        }
        guard let amountNumber else { throw BackendHTTPError.validation("amount is required") }
        return Normalized(
            dividendAmountConvention: convention, amount: amountNumber, units: unitsNumber,
            pricePerUnit: priceNumber, fees: feesNumber ?? 0, taxes: taxesNumber ?? 0,
            fxRateToEur: fxNumber)
    }

    /// `replayUnits`: the engine's unit walk over a history.
    static func replayUnits(_ rows: [PortfolioCore.Txn]) -> Double {
        var net = DecimalJS.zero
        for row in rows {
            let units = row.units.decimal
            switch row.kind {
            case .buy, .gift, .transferIn:
                net = net.plus(units)
            case .transferOut, .assetFee, .unitReversal:
                net = net.minus(units)
            case .sell:
                net = DecimalJS.max(DecimalJS.zero, net.minus(units))
            case .split where units.gt(.zero) && net.gt(.zero):
                net = units
            default:
                break
            }
        }
        return net.toNumber
    }
}

// MARK: - The unit-event history (`getUnitEventsForInvestment`)

extension PortfolioTransactionsArea {
    /// One row of the unit-event UNION: a transaction, a custody transfer or an adjustment.
    struct UnitEvent {
        var id: Double
        var type: String
        var date: String
        var units: String
        var accountId: Double?
        var amount: String
        var fees: String
        var taxes: String
        var fxMultiplier: String?
        var currency: String?
        var sourceAccountId: Double?
        var destinationAccountId: Double?
        var feeUnits: String?
        var adjustmentKind: String?
        var basisPolicy: String?
        var eligibleSourceRecordHashes: [String?]
        var sourceRecordHash: String?
        var incomeRecognitionRole: String

        init(_ row: SQLRow) throws {
            id = Double(try row.int64("eventId"))
            type = try row.text("type")
            date = try row.text("date")
            units = try row.text("units")
            accountId = try row.optionalInt64("account_id").map(Double.init)
            amount = try row.text("amount")
            fees = try row.text("fees")
            taxes = try row.text("taxes")
            fxMultiplier = try row.optionalText("fxMultiplier")
            currency = try row.optionalText("currency")
            sourceAccountId = try row.optionalInt64("source_account_id").map(Double.init)
            destinationAccountId = try row.optionalInt64("destination_account_id").map(Double.init)
            feeUnits = try row.optionalText("fee_units")
            adjustmentKind = try row.optionalText("adjustment_kind")
            basisPolicy = try row.optionalText("basis_policy")
            if let hashes = try row.optionalText("eligible_source_record_hashes"),
                case .array(let items)? = JSValue.parse(hashes)
            {
                eligibleSourceRecordHashes = items.map { $0 == .null ? nil : $0.stringValue }
            } else {
                eligibleSourceRecordHashes = []
            }
            sourceRecordHash = try row.optionalText("source_record_hash")
            incomeRecognitionRole = try row.text("income_recognition_role")
        }

        /// A projected candidate row: the merged write over the fields the replay reads.
        init(
            id: Double, type: String, date: String, units: String, accountId: Double?,
            amount: String = "0", fees: String = "0", taxes: String = "0",
            fxMultiplier: String? = nil, currency: String? = nil,
            sourceAccountId: Double? = nil, destinationAccountId: Double? = nil,
            feeUnits: String? = nil, adjustmentKind: String? = nil, basisPolicy: String? = nil,
            eligibleSourceRecordHashes: [String?] = [], sourceRecordHash: String? = nil,
            incomeRecognitionRole: String = "standard"
        ) {
            self.id = id
            self.type = type
            self.date = date
            self.units = units
            self.accountId = accountId
            self.amount = amount
            self.fees = fees
            self.taxes = taxes
            self.fxMultiplier = fxMultiplier
            self.currency = currency
            self.sourceAccountId = sourceAccountId
            self.destinationAccountId = destinationAccountId
            self.feeUnits = feeUnits
            self.adjustmentKind = adjustmentKind
            self.basisPolicy = basisPolicy
            self.eligibleSourceRecordHashes = eligibleSourceRecordHashes
            self.sourceRecordHash = sourceRecordHash
            self.incomeRecognitionRole = incomeRecognitionRole
        }

        /// The row as the shared partition engine reads it (`asPartitionedTxns`).
        var txn: PortfolioCore.Txn {
            PortfolioCore.Txn(
                id: id, type: type, date: date,
                fxMultiplier: fxMultiplier.map { PortfolioCore.Numeric.text($0) },
                nativeCurrency: currency,
                units: .text(units), amount: .text(amount), fees: .text(fees), taxes: .text(taxes),
                incomeRecognitionRole: incomeRecognitionRole,
                accountId: accountId, sourceAccountId: sourceAccountId,
                destinationAccountId: destinationAccountId,
                feeUnits: feeUnits.map { PortfolioCore.Numeric.text($0) } ?? .null,
                adjustmentKind: adjustmentKind, basisPolicy: basisPolicy,
                eligibleSourceRecordHashes: eligibleSourceRecordHashes,
                sourceRecordHash: sourceRecordHash, currency: currency)
        }
    }

    /// `getUnitEventsForInvestment`: the UNION of transactions, transfers and adjustments.
    static func unitEvents(_ session: BackendSession, _ investmentId: Int) throws -> [UnitEvent] {  // lint:allow raw-id business table ids of the TypeScript route and repository reads
        try session.rows(
            """
            SELECT id AS eventId, type, to_char(date, 'YYYY-MM-DD') AS date,
                   COALESCE(units, '0') AS units, account_id, amount, fees, taxes,
                   CASE WHEN COALESCE(currency,'EUR')='EUR' THEN '1' ELSE COALESCE(fx_rate_to_eur,
                     (SELECT er.rate_to_eur FROM exchange_rates er WHERE er.currency_code=portfolio_transactions.currency AND er.rate_date<=portfolio_transactions.date ORDER BY er.rate_date DESC LIMIT 1)) END AS fxMultiplier, NULL AS source_account_id,
                   NULL AS destination_account_id, '0' AS fee_units, NULL AS transfer_id, currency,
                   source_record_hash, NULL AS adjustment_kind, NULL AS basis_policy,
                   NULL AS eligible_source_record_hashes, NULL AS adjustment_id, income_recognition_role
            FROM portfolio_transactions WHERE investment_id = ?
            UNION ALL
            SELECT id, 'asset_transfer', to_char(date,'YYYY-MM-DD'), units, NULL,
                   '0','0','0',NULL,source_account_id,destination_account_id,fee_units,id,NULL,
                   source_record_hash,NULL,NULL,NULL,NULL,'standard'
            FROM portfolio_asset_transfers WHERE investment_id = ?
            UNION ALL
            SELECT id,'asset_adjustment',to_char(date,'YYYY-MM-DD'),units,account_id,
                   '0','0','0',NULL,NULL,NULL,'0',NULL,NULL,
                   source_record_hash,adjustment_kind,basis_policy,eligible_source_record_hashes,id,'standard'
            FROM portfolio_asset_adjustments WHERE investment_id=?
            ORDER BY date ASC, eventId ASC
            """,
            [.integer(Int64(investmentId)), .integer(Int64(investmentId)), .integer(Int64(investmentId))]
        ).map { try UnitEvent($0) }
    }

    /// `hasAssetTransfersForInvestment`.
    static func hasAssetTransfers(_ session: BackendSession, _ investmentId: Int) throws -> Bool {  // lint:allow raw-id business table ids of the TypeScript route and repository reads
        try session.row(
            "SELECT 1 AS found FROM portfolio_asset_transfers WHERE investment_id = ? LIMIT 1",
            [.integer(Int64(investmentId))]) != nil
    }
}

// MARK: - `validatePortfolioUnitMutation`

extension PortfolioTransactionsArea {
    /// The parameters the unit-history validation takes.
    struct UnitMutation {
        var investmentId: Int  // lint:allow raw-id business table ids of the TypeScript route and repository reads
        var assetClass: String?
        var type: String
        var date: String?
        var units: Double?
        var accountId: Double?
        var candidate: UnitEvent?
        var excludeTransactionId: Int?  // lint:allow raw-id business table ids of the TypeScript route and repository reads
        var omitCandidate = false
        var checkProjectedHistory = false
    }

    /// `getAccountLabel`: the display, the stored name, or `account #N`.
    static func accountLabel(_ session: BackendSession, _ accountId: Double) throws -> String {
        if let row = try session.row(
            "SELECT display_name, name FROM accounts WHERE id = ?",
            [.integer(Int64(accountId))]
        ) {
            if let display = try row.optionalText("display_name"), !display.isEmpty { return display }
            if let name = try row.optionalText("name"), !name.isEmpty { return name }
        }
        return "account #\(Int(accountId))"
    }

    static func max0(_ value: Double) -> Double { value < 0 ? 0 : value }

    /// `validatePortfolioUnitMutation`: ADR-108 scopes and oversold guards over the projected
    /// history.
    static func validateUnitMutation(_ session: BackendSession, _ mutation: UnitMutation) throws {
        guard let assetClass = mutation.assetClass, unitBasedAssetClasses.contains(assetClass) else { return }
        if (mutation.type == "buy" || mutation.type == "gift"),  // lint:allow string-literal-compare the stored wire value the TypeScript service dispatches on
            mutation.accountId == nil,
            !mutation.omitCandidate,
            !mutation.checkProjectedHistory,
            mutation.investmentId != 0,
            try hasAssetTransfers(session, mutation.investmentId)
        {
            throw BackendHTTPError.validation(
                "Acquisitions must name their custody account when asset transfer history exists")
        }
        if mutation.type != "sell" && !mutation.checkProjectedHistory { return }
        if mutation.investmentId == 0 || (!mutation.omitCandidate && mutation.date == nil) { return }

        let rows = try unitEvents(session, mutation.investmentId)
        let excluded = Set([mutation.excludeTransactionId].compactMap { $0 }.map(Double.init))
        let custodyTypes: Set<String> = ["asset_transfer", "asset_adjustment"]
        let retained = rows.filter { custodyTypes.contains($0.type) || !excluded.contains($0.id) }

        var projected: [UnitEvent] = retained
        if !mutation.omitCandidate {
            let units = SQLArguments.javaScriptText(max0(mutation.units ?? 0))
            let base = mutation.candidate
                ?? projectedCandidateRow(
                    type: mutation.type, date: mutation.date ?? "", units: mutation.units,
                    accountId: mutation.accountId)
            projected.append(UnitEvent(
                id: mutation.excludeTransactionId.map(Double.init) ?? 9_007_199_254_740_991,
                type: mutation.type, date: mutation.date ?? "", units: units,
                accountId: mutation.accountId,
                amount: base.amount, fees: base.fees, taxes: base.taxes,
                fxMultiplier: base.fxMultiplier, currency: base.currency,
                sourceAccountId: base.sourceAccountId, destinationAccountId: base.destinationAccountId,
                feeUnits: base.feeUnits, adjustmentKind: base.adjustmentKind,
                basisPolicy: base.basisPolicy,
                eligibleSourceRecordHashes: base.eligibleSourceRecordHashes,
                sourceRecordHash: base.sourceRecordHash,
                incomeRecognitionRole: base.incomeRecognitionRole))
        }

        let projectedTxns = projected.map(\.txn)
        if projected.contains(where: { custodyTypes.contains($0.type) }),
            !PortfolioCore.areLotsFullyAssigned(projectedTxns)
        {
            throw BackendHTTPError.validation(
                "Acquisitions and sales must name their custody account when asset transfer history exists")
        }

        let sellUnits = max0(mutation.units ?? 0)
        let accountScoped =
            mutation.type == "sell" && sellUnits > 0 && mutation.accountId != nil  // lint:allow string-literal-compare the stored wire value the TypeScript service dispatches on
            && (mutation.accountId ?? 0).rounded() == (mutation.accountId ?? 0)
            && (mutation.accountId ?? 0) > 0
            && PortfolioCore.areLotsFullyAssigned(projectedTxns)

        if !mutation.omitCandidate && mutation.type == "sell" && sellUnits > 0 {  // lint:allow string-literal-compare the stored wire value the TypeScript service dispatches on
            let prior = retained.filter { $0.date.isEmpty || $0.date <= (mutation.date ?? "") }
            let available: Double
            if accountScoped, let accountId = mutation.accountId {
                let streams = try PortfolioCustody.partitionTxnsByAccount(
                    prior.map(\.txn), method: "weighted_avg")
                let rows = streams.entries.first(where: { $0.key == accountId })?.rows ?? []
                available = replayUnits(rows)
            } else {
                available = replayUnits(prior.map(\.txn))
            }
            if sellUnits - available > epsilon {
                if !accountScoped {
                    throw BackendHTTPError.validation("sell units exceed available holdings")
                }
                let label = try accountLabel(session, mutation.accountId ?? 0)
                throw BackendHTTPError.validation(
                    "sell units exceed available holdings at \(label) "
                        + "(\(roundMoney(available, 8)) units held there)")
            }
        }

        if mutation.checkProjectedHistory || mutation.type == "sell" {  // lint:allow string-literal-compare the stored wire value the TypeScript service dispatches on
            let before = try PortfolioCore.partitionOversellDeficits(rows.map(\.txn))
            let after = try PortfolioCore.partitionOversellDeficits(projectedTxns)
            for (accountId, deficit) in after {
                if deficit - (before[accountId] ?? 0) > epsilon {
                    let label = try accountLabel(session, accountId)
                    throw BackendHTTPError.validation(
                        "change would create or worsen an oversold partition at \(label)")
                }
            }
            // Unassigned lots have no partitions, so the check above sees no deficit; the
            // pooled history must not become more oversold either (Astra report 4, finding 1).
            let beforeTxns = rows.map(\.txn)
            if !PortfolioCore.areLotsFullyAssigned(beforeTxns) || !PortfolioCore.areLotsFullyAssigned(projectedTxns) {
                let pooledBefore = PortfolioCore.pooledOversellDeficit(beforeTxns)
                let pooledAfter = PortfolioCore.pooledOversellDeficit(projectedTxns)
                if pooledAfter - pooledBefore > epsilon {
                    throw BackendHTTPError.validation("change would create or worsen an oversold history")
                }
            }
        }
    }

    /// The merge base of a candidate the mutation provides no row for: the replayed
    /// row the shares of `validatePortfolioUnitMutation` fall back to.
    static func projectedCandidateRow(
        type: String, date: String, units: Double?, accountId: Double?
    ) -> UnitEvent {
        UnitEvent(
            id: 9_007_199_254_740_991, type: type, date: date,
            units: SQLArguments.javaScriptText(max0(units ?? 0)), accountId: accountId)
    }

    /// The projected candidate the mutation appends to the history.
    static func projectedCandidate(
        type: String, date: String, units: Double?, accountId: Double?
    ) -> PortfolioCore.Txn {
        PortfolioCore.Txn(
            id: 9_007_199_254_740_991, type: type, date: date,
            units: .number(max0(units ?? 0)), accountId: accountId)
    }
}


// MARK: - SQL helpers over one row

extension PortfolioTransactionsArea {
    /// A stored portfolio transaction row (`mapPortfolioTxRow`), read by id.
    static func byId(_ session: BackendSession, _ id: Int) throws -> PortfolioTxRow? {
        try session.row(
            "SELECT * FROM portfolio_transactions WHERE id = ?", [.integer(Int64(id))]
        ).map { try PortfolioTxRow($0) }
    }

    /// `getAssetClassByInvestmentId`.
    static func assetClass(_ session: BackendSession, _ investmentId: Int) throws -> String? {  // lint:allow raw-id business table ids of the TypeScript route and repository reads
        try session.row(
            "SELECT asset_class FROM investments WHERE id = ?", [.integer(Int64(investmentId))]
        )?.optionalText("asset_class")
    }

    /// The investment the create route writes under: its currency, for the effective one.
    static func investmentCurrency(_ session: BackendSession, _ investmentId: Int) throws -> String? {  // lint:allow raw-id business table ids of the TypeScript route and repository reads
        try session.row(
            "SELECT currency FROM investments WHERE id = ?", [.integer(Int64(investmentId))]
        )?.optionalText("currency")
    }

    /// `validateId(value, "account_id")` for a present, non-null write value.
    static func accountId(_ value: JSValue?) throws -> Int? {
        guard let value, value != .null else { return nil }
        if case .number(let number) = value {
            guard number.rounded() == number, number >= 1, number <= 2_147_483_647 else {
                throw BackendHTTPError.validation("account_id must be a positive integer")
            }
            return Int(number)
        }
        if case .string(let text) = value {
            let bytes = Array(text.utf8)
            guard !bytes.isEmpty, bytes.allSatisfy({ (48...57).contains($0) }),
                let id = Int(text), id >= 1, id <= 2_147_483_647
            else {
                throw BackendHTTPError.validation("account_id must be a positive integer")
            }
            return id
        }
        throw BackendHTTPError.validation("account_id must be a positive integer")
    }

    /// `autoResolveFxRateToEur`: the stored rate on or within seven days before the date.
    static func storedRateToEur(
        _ session: BackendSession, _ currency: String, _ date: String
    ) throws -> Double? {
        let code = currency.isEmpty ? "EUR" : currency.uppercased()
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if code == "EUR" { return nil }  // lint:allow string-literal-compare the stored wire value the TypeScript service dispatches on
        guard let row = try session.row(
            """
            SELECT rate_to_eur FROM exchange_rates
            WHERE currency_code = ? AND rate_date <= ts_date(?) AND rate_date >= add_days(ts_date(?), -7)
            ORDER BY rate_date DESC LIMIT 1
            """,
            [.text(code), .text(date), .text(date)]
        ) else { return nil }
        let rate = JavaScriptNumber.fromString(try row.text("rate_to_eur"))
        return rate.isFinite ? rate : nil
    }

    /// The decimal text a NUMERIC column stores: a JavaScript number prints as it printed.
    static func decimalParam(_ value: JSValue?) -> String? {
        guard let value, value != .null else { return nil }
        if case .string(let text) = value { return text }
        return SQLArguments.javaScriptText(value.javaScriptNumber)
    }

    /// `insert(payload)`: the write route's INSERT, with the column defaults the ORM applies.
    /// `ON CONFLICT DO NOTHING` as the repository writes it: only a uniqueness conflict is
    /// skipped (answering nil); a CHECK or NOT NULL violation throws, where `INSERT OR IGNORE`
    /// would drop the row silently.
    static func insert(
        _ session: BackendSession, _ fields: WriteFields, _ txn: TxnBody, _ normalized: Normalized
    ) throws -> PortfolioTxRow? {
        var arguments: [SQLValue] = []
        func bind(_ value: String?) { arguments.append(value.map(SQLValue.text) ?? .null) }
        func bindInteger(_ value: Int?) { arguments.append(value.map { SQLValue.integer(Int64($0)) } ?? .null) }
        bind(SQLArguments.javaScriptText(normalized.amount ?? 0))
        arguments.append(.integer(Int64(fields.investmentId)))
        bind(txn.type)
        bind(txn.date)
        bind(normalized.units.map { SQLArguments.javaScriptText($0) })
        bind(normalized.pricePerUnit.map { SQLArguments.javaScriptText($0) })
        bind(decimalParam(.number(normalized.fees)))
        bind(decimalParam(.number(normalized.taxes)))
        bind(fields.currency)
        bind(fields.note)
        arguments.append(.integer(fields.isRecurring ? 1 : 0))
        bind(fields.recurrenceInterval)
        bind(fields.recurrenceEndDate)
        bind(fields.fxRateToEur.map { SQLArguments.javaScriptText($0) })
        bindInteger(fields.accountId)
        bind(fields.dividendAmountConvention)
        let rows = try session.rows(
            """
            INSERT INTO portfolio_transactions (
                amount, investment_id, type, date, units, price_per_unit, fees, taxes, currency,
                note, is_recurring, recurrence_interval, recurrence_end_date, fx_rate_to_eur,
                account_id, dividend_amount_convention
            ) VALUES (
                vision_numeric(?, 18, 4), ?, ?, ?, vision_numeric(?, 18, 8),
                vision_numeric(?, 18, 6), vision_numeric(?, 18, 4), vision_numeric(?, 18, 4),
                ?, ?, ?, ?, ?, vision_numeric(?, 20, 10), ?, ?
            ) ON CONFLICT DO NOTHING RETURNING *
            """,
            arguments)
        return try rows.first.map { try PortfolioTxRow($0) }
    }

    struct WriteFields {
        var investmentId = 0
        var currency: String?
        var note: String?
        var isRecurring = false
        var recurrenceInterval: String?
        var recurrenceEndDate: String?
        var fxRateToEur: Double?
        var accountId: Int?  // lint:allow raw-id business table ids of the TypeScript route and repository reads
        var dividendAmountConvention: String?
    }
}

// MARK: - Create

extension PortfolioTransactionsArea {
    /// `createTransaction`: the investment must exist, the body's vocabulary must validate,
    /// and the service's rules and unit-history guards must accept the row. The answer is the
    /// inserted row (`returningAll`), or null when a uniqueness conflict skipped it.
    static func create(_ session: BackendSession, _ investmentId: Int, _ body: JSValue?) throws -> HandlerResult {  // lint:allow raw-id business table ids of the TypeScript route and repository reads
        guard let assetClass = try assetClass(session, investmentId) else {
            throw BackendHTTPError.notFound("Investment not found")
        }
        let txn = try parseBody(body)
        if txn.hasIncomeRecognitionRole {
            throw BackendHTTPError.validation("income_recognition_role is read-only")
        }
        guard let type = txn.type, let date = txn.date, !type.isEmpty, !date.isEmpty else {
            throw BackendHTTPError.validation("type and date are required")
        }
        var fields = WriteFields()
        fields.investmentId = investmentId
        let investmentCurrency = try investmentCurrency(session, investmentId) ?? "EUR"
        if case .string(let currency)? = txn.currency {
            fields.currency = assertCurrency(currency) ?? investmentCurrency
        } else {
            fields.currency = investmentCurrency
        }
        fields.note = txn.note
        fields.isRecurring = txn.isRecurring ?? false
        if txn.recurrenceInterval != nil, txn.recurrenceInterval != "" {
            fields.recurrenceInterval = txn.recurrenceInterval
        }
        if txn.hasRecurrenceEndDate, let end = bodyDate(txn) { fields.recurrenceEndDate = end }
        if case .number(let fx)? = txn.fxRateToEur { fields.fxRateToEur = fx }
        fields.accountId = try accountId(txn.accountId)
        var normalized: Normalized
        do {
            normalized = try normalize(
                type, fields.recurrenceInterval, txn.dividendAmountConvention,
                txn.amount, txn.units, txn.pricePerUnit, txn.fees, txn.taxes, txn.fxRateToEur,
                assetClass: assetClass)
        } catch let error as BackendHTTPError {
            throw error
        }
        fields.dividendAmountConvention = normalized.dividendAmountConvention
        if fields.fxRateToEur == nil {
            fields.fxRateToEur = try storedRateToEur(session, fields.currency ?? "EUR", date)
        }
        if !fields.isRecurring {
            fields.recurrenceInterval = nil
            fields.recurrenceEndDate = nil
        } else if let end = fields.recurrenceEndDate, end < date {
            throw BackendHTTPError.validation(
                "recurrence_end_date must be on or after the transaction date")
        }
        let inserted = try session.transaction { () -> PortfolioTxRow? in
            try validateUnitMutation(session, UnitMutation(
                investmentId: investmentId, assetClass: assetClass, type: type, date: date,
                units: normalized.units, accountId: fields.accountId.map(Double.init),
                checkProjectedHistory: type == "split"))  // lint:allow string-literal-compare the stored wire value the TypeScript service dispatches on
            return try insert(session, fields, txn, normalized)
        }
        return HandlerResult(status: 201, data: inserted.map { .object($0.json) } ?? .null)
    }

    /// The body's parsed `recurrence_end_date`, kept beside its presence in the TxnBody.
    static func bodyDate(_ txn: TxnBody) -> String? { txn.recurrenceEndDay }
}

// MARK: - Update

extension PortfolioTransactionsArea {
    /// One SET clause of `updateFields`, in the service's build order.
    struct UpdateClause {
        var column: String
        var value: SQLValue
        /// The NUMERIC typmod the column's decimal text stores through.
        var typmod: (Int, Int)?

        init(_ column: String, _ value: SQLValue, _ typmod: (Int, Int)? = nil) {
            self.column = column
            self.value = value
            self.typmod = typmod
        }
    }

    /// The numbers the repository may write: a JavaScript number prints as it printed.
    static func numberText(_ value: Double?) -> SQLValue {
        .text(SQLArguments.javaScriptText(value ?? 0))
    }

    static func optionalNumberText(_ value: Double?) -> SQLValue {
        value.map { SQLValue.text(SQLArguments.javaScriptText($0)) } ?? .null
    }

    /// `updatePeriod` over one PATCH, in the order the service builds `normalizedFields`.
    static func update(
        _ session: BackendSession, _ id: Int, _ body: JSValue?
    ) throws -> HandlerResult {
        let row = try updatedRow(session, id, body)
        return HandlerResult(data: .object(row.json))
    }

    /// `update`'s row: the updated transaction, whose investment the route refreshes.
    static func updatedRow(
        _ session: BackendSession, _ id: Int, _ body: JSValue?
    ) throws -> PortfolioTxRow {
        // The route's own pre-service guards.
        var txn = try parseBody(body ?? .null)
        if txn.hasIncomeRecognitionRole {
            throw BackendHTTPError.validation("income_recognition_role is read-only")
        }
        if let currency = txn.currency {
            if currency == .null || currency == .string("") {
                throw BackendHTTPError.validation("currency cannot be cleared")
            }
            if case .string(let text) = currency {
                guard let code = assertCurrency(text) else {
                    throw BackendHTTPError.validation("currency must be a 3-letter ISO code")
                }
                _ = code
            }
        }
        // A present, non-null account is validated before the service sees the row.
        var patchedAccountId: Int? = nil  // lint:allow raw-id business table ids of the TypeScript route and repository reads
        if let account = txn.accountId, account != .null {
            patchedAccountId = try accountId(account)
        }
        // A date or currency change invalidates the stamped FX rate: recompute it unless
        // the client supplied one explicitly.
        var recomputedFx: Double? = nil
        let recomputeFx = txn.fxRateToEur == nil
            && (txn.date != nil || (txn.currency != nil && txn.currency != .null))
        var staleFx = false
        if recomputeFx, let existing = try byId(session, id) {
            let currency: String
            if case .string(let text)? = txn.currency {
                currency = assertCurrency(text) ?? existing.currency
            } else {
                currency = existing.currency
            }
            let date = txn.date ?? existing.date
            recomputedFx = try storedRateToEur(session, currency, date)
            // A rate stamped for the old currency is wrong for the new one: with no rate to
            // replace it, it is cleared so valuation falls back to the historical quotes
            // (Astra report 4, finding 2). Swift only: the TypeScript keeps the old rate.
            staleFx = currency.uppercased() != existing.currency.uppercased()
                && existing.fxRateToEur != nil
        }
        if let rate = recomputedFx {
            txn.fxRateToEur = .number(rate)
        } else if staleFx {
            txn.fxRateToEur = .null
        }
        let updated = try session.transaction { () -> PortfolioTxRow? in
            try updateUnlocked(session, id, txn, patchedAccountId)
        }
        guard let row = updated else {
            throw BackendHTTPError.notFound("Portfolio transaction not found")
        }
        return row
    }

    /// `updateUnlocked`: the compare-and-patch body of the service.
    static func updateUnlocked(
        _ session: BackendSession, _ id: Int, _ txn: TxnBody, _ patchedAccountId: Int?  // lint:allow raw-id business table ids of the TypeScript route and repository reads
    ) throws -> PortfolioTxRow? {
        guard let existing = try byId(session, id) else { return nil }
        if txn.present.contains("type"), let type = txn.type, type != existing.type {
            throw BackendHTTPError.validation("type cannot be changed")
        }
        let assetClass = try assetClass(session, existing.investmentId.rawValue)
        let mergedType = txn.type ?? existing.type

        // `merged = { ...existing, ...fields }` over the unit math's three fields.
        let mergedAmount = txn.amount.map { JSValue.number($0.javaScriptNumber) }
            ?? .number(existing.amount)
        let mergedUnits = txn.units ?? existing.units.map { JSValue.number($0) } ?? .null
        let mergedPrice = txn.pricePerUnit ?? existing.pricePerUnit.map { JSValue.number($0) } ?? .null
        let mergedFees = txn.fees ?? .number(existing.fees ?? 0)
        let mergedTaxes = txn.taxes ?? .number(existing.taxes ?? 0)
        let mergedFx = txn.fxRateToEur ?? existing.fxRateToEur.map { JSValue.number($0) } ?? .null
        let mergedConvention = txn.dividendAmountConvention ?? existing.dividendAmountConvention
        let mergedInterval = txn.recurrenceInterval ?? existing.recurrenceInterval

        let appliesUnitMath =
            (mergedType == "buy" || mergedType == "sell")  // lint:allow string-literal-compare the stored wire value the TypeScript service dispatches on
            && assetClass.map(unitBasedAssetClasses.contains) == true
        let patchCount = (txn.amount != nil ? 1 : 0) + (txn.units != nil ? 1 : 0)
            + (txn.pricePerUnit != nil ? 1 : 0)
        if appliesUnitMath && patchCount == 1 {
            throw BackendHTTPError.validation(
                "For buy/sell transaction updates, provide at least two of amount, units, and price_per_unit")
        }

        var normalizationInputAmount: JSValue? = mergedAmount
        var normalizationInputUnits: JSValue? = mergedUnits
        var normalizationInputPrice: JSValue? = mergedPrice
        // The 2-of-3 patch re-derives the missing unit-math field from scratch.
        if appliesUnitMath && patchCount == 2 {
            if txn.amount == nil { normalizationInputAmount = nil }
            if txn.units == nil { normalizationInputUnits = nil }
            if txn.pricePerUnit == nil { normalizationInputPrice = nil }
        }
        let normalized = try normalize(
            mergedType, mergedInterval, mergedConvention,
            normalizationInputAmount, normalizationInputUnits, normalizationInputPrice,
            mergedFees, mergedTaxes, mergedFx, assetClass: assetClass)

        // `normalizedFields`: `{ ...fields }` (the body's own keys) overwritten by the
        // rewrites the rules apply.
        var clauses: [UpdateClause] = []
        if appliesUnitMath || txn.present.contains("amount") {
            clauses.append(UpdateClause("amount", numberText(normalized.amount), (18, 4)))
        }
        if appliesUnitMath || txn.present.contains("units") {
            clauses.append(UpdateClause("units", optionalNumberText(normalized.units), (18, 8)))
        }
        if appliesUnitMath || txn.present.contains("price_per_unit") {
            clauses.append(
                UpdateClause("price_per_unit", optionalNumberText(normalized.pricePerUnit), (18, 6)))
        }
        let applyDefaults = appliesUnitMath || mergedType == "gift"  // lint:allow string-literal-compare the stored wire value the TypeScript service dispatches on
        if applyDefaults || txn.present.contains("fees") {
            clauses.append(UpdateClause("fees", numberText(normalized.fees), (18, 4)))
        }
        if applyDefaults || txn.present.contains("taxes") {
            clauses.append(UpdateClause("taxes", numberText(normalized.taxes), (18, 4)))
        }
        if let currency = txn.currency, currency != .null, currency != .string(""),
            case .string(let text) = currency
        {
            clauses.append(UpdateClause("currency", .text(assertCurrency(text) ?? text)))
        }
        if txn.present.contains("note") {
            clauses.append(UpdateClause("note", txn.note.map { SQLValue.text($0) } ?? .null))
        }
        if txn.present.contains("is_recurring") {
            clauses.append(
                UpdateClause("is_recurring", .integer(txn.isRecurring == true ? 1 : 0)))
        }
        if txn.present.contains("recurrence_interval") {
            let interval = (txn.recurrenceInterval == nil || txn.recurrenceInterval == "")  // lint:allow string-literal-compare the stored wire value the TypeScript service dispatches on
                ? nil : txn.recurrenceInterval
            clauses.append(UpdateClause(
                "recurrence_interval", interval.map { SQLValue.text($0) } ?? .null))
        }
        if txn.present.contains("recurrence_end_date") {
            clauses.append(
                UpdateClause("recurrence_end_date", txn.recurrenceEndDay.map { SQLValue.text($0) } ?? .null))
        }
        if txn.fxRateToEur == .null {
            clauses.append(UpdateClause("fx_rate_to_eur", .null, (20, 10)))
        } else if let fx = normalized.fxRateToEur {
            clauses.append(UpdateClause("fx_rate_to_eur", numberText(fx), (20, 10)))
        }
        if txn.present.contains("account_id") {
            if let account = patchedAccountId {
                clauses.append(UpdateClause("account_id", .integer(Int64(account))))
            } else if txn.accountId == .null {
                clauses.append(UpdateClause("account_id", .null))
            } else {
                clauses.append(UpdateClause("account_id", .null))
            }
        }
        if txn.present.contains("dividend_amount_convention") {
            clauses.append(
                UpdateClause("dividend_amount_convention", .text(normalized.dividendAmountConvention)))
        }
        if txn.present.contains("date") {
            clauses.append(UpdateClause("date", .text(txn.date ?? existing.date)))
        }

        // `is_recurring: false` clears the window with the service's own rules; the date or
        // the end date moving may not leave the window inverted.
        if txn.isRecurring == false {
            // Both columns are cleared whether or not the patch names them.
            if let index = clauses.firstIndex(where: { $0.column == "recurrence_interval" }) {  // lint:allow string-literal-compare the stored wire value the TypeScript service dispatches on
                clauses[index].value = .null
            } else {
                clauses.append(UpdateClause("recurrence_interval", .null))
            }
            if let index = clauses.firstIndex(where: { $0.column == "recurrence_end_date" }) {  // lint:allow string-literal-compare the stored wire value the TypeScript service dispatches on
                clauses[index].value = .null
            } else {
                clauses.append(UpdateClause("recurrence_end_date", .null))
            }
        }
        let windowEnd = clauses.first(where: { $0.column == "recurrence_end_date" })?.value  // lint:allow string-literal-compare the stored wire value the TypeScript service dispatches on
        let day = clauses.first(where: { $0.column == "date" })?.value  // lint:allow string-literal-compare the stored wire value the TypeScript service dispatches on
        let mergedDate = txn.date ?? existing.date
        let mergedRecurring = txn.isRecurring ?? existing.isRecurring
        let mergedEnd: String?
        if txn.present.contains("recurrence_end_date") {
            mergedEnd = txn.recurrenceEndDay
        } else {
            mergedEnd = existing.recurrenceEndDate
        }
        if txn.isRecurring != false,
            txn.present.contains("recurrence_end_date") || txn.present.contains("date"),
            mergedRecurring, let mergedEnd, mergedEnd < mergedDate
        {
            throw BackendHTTPError.validation(
                "recurrence_end_date must be on or after the transaction date")
        }
        _ = windowEnd
        _ = day

        let touchesPartition = [
            "account_id", "date", "units", "amount", "fees", "taxes", "currency", "fx_rate_to_eur",
        ].contains { txn.present.contains($0) }
            && ["buy", "gift", "sell", "split"].contains(mergedType)
        let mergedAccount: Double?
        if txn.present.contains("account_id") {
            mergedAccount = (patchedAccountId ?? nil).map(Double.init)
        } else {
            mergedAccount = existing.accountId.map { Double($0.rawValue) }
        }
        let candidate = UnitEvent(
            id: Double(id), type: mergedType, date: mergedDate,
            units: SQLArguments.javaScriptText(normalized.units ?? existing.units ?? 0),
            accountId: mergedAccount,
            amount: SQLArguments.javaScriptText(normalized.amount ?? existing.amount),
            fees: SQLArguments.javaScriptText(normalized.fees),
            taxes: SQLArguments.javaScriptText(normalized.taxes),
            fxMultiplier: nil,
            currency: txn.currency.flatMap { c -> String? in
                if case .string(let text) = c { return assertCurrency(text) ?? text }
                return existing.currency }
                ?? existing.currency,
            incomeRecognitionRole: existing.incomeRecognitionRole)
        try validateUnitMutation(session, UnitMutation(
            investmentId: existing.investmentId.rawValue, assetClass: assetClass, type: mergedType,
            date: mergedDate, units: normalized.units ?? existing.units, accountId: mergedAccount,
            candidate: candidate, excludeTransactionId: id,
            checkProjectedHistory: touchesPartition))

        guard !clauses.isEmpty else { return existing }
        var assignments: [String] = []
        var arguments: [SQLValue] = []
        for clause in clauses {
            if let (precision, scale) = clause.typmod {
                assignments.append("\(clause.column) = vision_numeric(?, \(precision), \(scale))")
            } else {
                assignments.append("\(clause.column) = ?")
            }
            arguments.append(clause.value)
        }
        assignments.append("updated_at = now()")
        let rows = try session.rows(
            "UPDATE portfolio_transactions SET \(assignments.joined(separator: ", "))"
                + " WHERE id = ? RETURNING *",
            arguments + [.integer(Int64(id))])
        return try rows.first.map { try PortfolioTxRow($0) }
    }
}

// MARK: - Delete

extension PortfolioTransactionsArea {
    /// `deleteTransaction`: the row must exist and the remaining history must not become
    /// more oversold; the answer is the 204 of an empty body.
    static func remove(_ session: BackendSession, _ id: Int) throws -> HandlerResult {
        _ = try removeRow(session, id)
        return HandlerResult(status: 204, data: .null)
    }

    /// `remove`'s work: the deleted transaction's investment, which the route refreshes.
    static func removeRow(_ session: BackendSession, _ id: Int) throws -> Int {
        guard let existing = try byId(session, id) else {
            throw BackendHTTPError.notFound("Portfolio transaction not found")
        }
        let removed = try session.transaction { () -> Bool in
            guard try byId(session, id) != nil else { return false }
            let assetClass = try assetClass(session, existing.investmentId.rawValue)
            try validateUnitMutation(session, UnitMutation(
                investmentId: existing.investmentId.rawValue, assetClass: assetClass,
                type: existing.type, date: existing.date, units: existing.units,
                accountId: existing.accountId.map { Double($0.rawValue) },
                excludeTransactionId: id, omitCandidate: true,
                checkProjectedHistory: ["buy", "gift", "sell", "split"].contains(existing.type)))
            _ = try session.rows(
                "DELETE FROM portfolio_transactions WHERE id = ?", [.integer(Int64(id))])
            return true
        }
        guard removed else {
            throw BackendHTTPError.notFound("Portfolio transaction not found")
        }
        return existing.investmentId.rawValue
    }
}

// MARK: - The broker re-tag

extension PortfolioTransactionsArea {
    /// `parseBrokerRetagBody` output: the strict compare-and-set request.
    struct RetagRequest {
        var transactionIds: [Int]
        var fromAccountId: Int?  // lint:allow raw-id business table ids of the TypeScript route and repository reads
        var toAccountId: Int?  // lint:allow raw-id business table ids of the TypeScript route and repository reads
        var idempotencyKey: String
    }

    /// One re-tag event row, the repository's join of a transaction with its investment.
    /// A custody event carries the investment-level columns of one of that investment's
    /// transactions when it has any (`{ ...exemplar, ...event, investment_id }`).
    struct RetagEvent {
        var id: Double
        var investmentId: Int  // lint:allow raw-id business table ids of the TypeScript route and repository reads
        var type: String
        var date: String
        var units: String
        var accountId: Double?
        var amount: String
        var fees: String
        var taxes: String
        var currency: String?
        var fxRateToEur: String?
        var fxEur: String?
        var assetClass: String?
        var currentPrice: String?
        var interestRate: String?
        var sourceAccountId: Double?
        var destinationAccountId: Double?
        var feeUnits: String?
        var adjustmentKind: String?
        var basisPolicy: String?
        var eligibleSourceRecordHashes: [String?]
        var sourceRecordHash: String?
        var incomeRecognitionRole: String?

        /// A transaction row of `getUnitEventsForInvestments`: the transaction rows carry
        /// none of the custody projections, and the engine reads them as absent.
        init(_ row: SQLRow) throws {
            id = Double(try row.int64("id"))
            investmentId = try row.integerId("investment_id")
            type = try row.text("type")
            date = try row.text("date")
            units = try row.text("units")
            accountId = try row.optionalInt64("account_id").map(Double.init)
            amount = try row.text("amount")
            fees = try row.text("fees")
            taxes = try row.text("taxes")
            currency = try row.optionalText("currency")
            fxRateToEur = try row.optionalText("fx_rate_to_eur")
            fxEur = try row.optionalText("fx_multiplier_eur")
            assetClass = try row.optionalText("asset_class")
            currentPrice = try row.optionalText("current_price")
            interestRate = try row.optionalText("interest_rate")
            sourceAccountId = nil
            destinationAccountId = nil
            feeUnits = nil
            adjustmentKind = nil
            basisPolicy = nil
            eligibleSourceRecordHashes = []
            sourceRecordHash = nil
            incomeRecognitionRole = nil
        }

        /// A custody event over the exemplar's investment-level columns.
        init(custody event: UnitEvent, exemplar: RetagEvent?, investmentId: Int) {  // lint:allow raw-id business table ids of the TypeScript route and repository reads
            id = event.id
            self.investmentId = investmentId
            type = event.type
            date = event.date
            units = event.units
            accountId = event.accountId
            amount = event.amount
            fees = event.fees
            taxes = event.taxes
            currency = event.currency
            fxRateToEur = exemplar?.fxRateToEur
            fxEur = exemplar?.fxEur
            assetClass = exemplar?.assetClass
            currentPrice = exemplar?.currentPrice
            interestRate = exemplar?.interestRate
            sourceAccountId = event.sourceAccountId
            destinationAccountId = event.destinationAccountId
            feeUnits = event.feeUnits
            adjustmentKind = event.adjustmentKind
            basisPolicy = event.basisPolicy
            eligibleSourceRecordHashes = event.eligibleSourceRecordHashes
            sourceRecordHash = event.sourceRecordHash
            incomeRecognitionRole = event.incomeRecognitionRole
        }

        /// `isTransactionEvent`: custody events carry ids from their own tables.
        var isTransactionEvent: Bool {
            !PortfolioCustody.custodyEventTypes.contains(type)
        }

        /// The projected row of one selected event, moved onto the destination.
        func withAccountId(_ accountId: Double?) -> RetagEvent {
            var copy = self
            copy.accountId = accountId
            return copy
        }

        /// The event as the shared partition engine reads it, with the per-target FX the
        /// economics guard annotates.
        func txn(fxMultiplier: String?) -> PortfolioCore.Txn {
            PortfolioCore.Txn(
                id: id, type: type, date: date,
                fxMultiplier: fxMultiplier.map { PortfolioCore.Numeric.text($0) },
                nativeCurrency: currency,
                units: .text(units), amount: .text(amount), fees: .text(fees), taxes: .text(taxes),
                incomeRecognitionRole: incomeRecognitionRole,
                accountId: accountId, sourceAccountId: sourceAccountId,
                destinationAccountId: destinationAccountId,
                feeUnits: feeUnits.map { PortfolioCore.Numeric.text($0) } ?? .null,
                adjustmentKind: adjustmentKind, basisPolicy: basisPolicy,
                eligibleSourceRecordHashes: eligibleSourceRecordHashes,
                sourceRecordHash: sourceRecordHash, currency: currency)
        }
    }

    /// One historical rate row of the index.
    struct RateRow {
        var currency: String
        var date: String
        var rate: Double
    }

    /// `parseBrokerRetagBody`: the strict shape with the corpus's issue texts.
    static func parseRetagBody(_ body: JSValue?) throws -> RetagRequest {
        guard let body, case .object(let object) = body else {
            throw BackendHTTPError.validation(
                "Invalid input: expected object, received \(body.map(received) ?? "null")")
        }
        var issues: [String] = []
        var ids: [Int] = []
        if case .array(let items)? = object["transaction_ids"] {
            for item in items {
                if case .number(let number) = item,
                    number.rounded() == number, number >= 1, number <= 2_147_483_647
                {
                    ids.append(Int(number))
                } else if case .number = item {
                    issues.append(
                        "transaction_ids: Invalid input: expected number in range 1..2147483647")
                } else {
                    issues.append(
                        "transaction_ids: Invalid input: expected number, received \(received(item))")
                }
            }
        } else if object["transaction_ids"] == nil {
            issues.append(
                "transaction_ids: Invalid input: expected array, received \(object["transaction_ids"].map(received) ?? "undefined")")
        } else {
            issues.append(
                "transaction_ids: Invalid input: expected array, received \(received(object["transaction_ids"] ?? .null))")
        }
        if ids.count < 1, !issues.contains(where: { $0.hasPrefix("transaction_ids") }) {
            issues.append("transaction_ids: Too small: expected array to have >=1 items")
        }
        if case .array(let items)? = object["transaction_ids"], items.count > 500 {
            issues.append("transaction_ids: Too big: expected array to have <=500 items")
        }
        if Set(ids).count != ids.count, !issues.contains(where: { $0.contains("range") }) {
            issues.append("transaction_ids: transaction_ids must be distinct")
        }
        func account(_ key: String) -> Int? {
            switch object[key] {
            case .number(let number)?:
                if number.rounded() == number, number >= 1, number <= 2_147_483_647 {
                    return Int(number)
                }
                issues.append("\(key): Invalid input: expected number in range 1..2147483647")
                return nil
            case .null?: return nil
            case .some(let value):
                issues.append("\(key): Invalid input: expected number, received \(received(value))")
                return nil
            default:
                issues.append("\(key): Invalid input: expected number, received undefined")
                return nil
            }
        }
        let from = account("from_account_id")
        let to = account("to_account_id")
        var key: String?
        switch object["idempotency_key"] {
        case .string(let text)?:
            if isZodUUID(text) { key = text } else { issues.append("idempotency_key: Invalid UUID") }
        case .some(let value):
            issues.append(
                "idempotency_key: Invalid input: expected string, received \(received(value))")
        default:
            issues.append("idempotency_key: Invalid input: expected string, received undefined")
        }
        // `z.strictObject`: any other key is refused before anything is written.
        let known: Set<String> = ["transaction_ids", "from_account_id", "to_account_id", "idempotency_key"]
        let unknown = object.keys.filter { !known.contains($0) }
        if !unknown.isEmpty {
            let quoted = unknown.map { "\"\($0)\"" }.joined(separator: ", ")
            issues.append(unknown.count == 1 ? "Unrecognized key: \(quoted)" : "Unrecognized keys: \(quoted)")
        }
        if !issues.isEmpty { throw BackendHTTPError.validation(issues.joined(separator: "; ")) }
        guard let key else {
            throw BackendHTTPError.validation("idempotency_key: Invalid input: expected string, received undefined")
        }
        return RetagRequest(
            transactionIds: ids, fromAccountId: from, toAccountId: to, idempotencyKey: key)
    }
}

extension PortfolioTransactionsArea {
    /// zod 4's `z.uuid()`: an RFC 9562 UUID (versions 1–8, variant 10xx) or the nil and max
    /// UUIDs, either case.
    static func isZodUUID(_ text: String) -> Bool {
        let lower = text.lowercased()
        if lower == "00000000-0000-0000-0000-000000000000" || lower == "ffffffff-ffff-ffff-ffff-ffffffffffff" {  // lint:allow string-literal-compare the nil and max UUIDs zod accepts
            return true
        }
        let bytes = Array(lower.utf8)
        guard bytes.count == 36 else { return false }
        for (index, byte) in bytes.enumerated() {
            if [8, 13, 18, 23].contains(index) {
                if byte != UInt8(ascii: "-") { return false }
            } else if !((byte >= 0x30 && byte <= 0x39) || (byte >= 0x61 && byte <= 0x66)) {
                return false
            }
        }
        guard (UInt8(ascii: "1")...UInt8(ascii: "8")).contains(bytes[14]) else { return false }
        return [UInt8(ascii: "8"), UInt8(ascii: "9"), UInt8(ascii: "a"), UInt8(ascii: "b")].contains(bytes[19])
    }

    /// `retagPortfolioTransactions`: the compare-and-set write with both history guards.
    static func retag(_ session: BackendSession, _ body: JSValue?) throws -> HandlerResult {
        let request = try parseRetagBody(body)
        let receipt = try session.transaction { () throws -> JSONValue in
            let ids = request.transactionIds.sorted()
            // The destination must be an active portfolio account.
            if let to = request.toAccountId {
                let eligible = try session.row(
                    "SELECT id FROM accounts WHERE id = ? AND is_active = 1"
                        + " AND type IN ('brokerage', 'crypto_exchange', 'wallet')",
                    [.integer(Int64(to))])
                guard eligible != nil else {
                    throw BackendHTTPError.validation(
                        "to_account_id must reference an active portfolio account")
                }
            }
            // The locked rows: every id must exist and sit on the expected broker.
            let placeholders = ids.map { _ in "?" }.joined(separator: ", ")
            let lockedRows = try session.rows(
                "SELECT id, investment_id, account_id FROM portfolio_transactions"
                    + " WHERE id IN (\(placeholders)) ORDER BY id ASC",
                ids.map { SQLValue.integer(Int64($0)) })
            let selectedById: [Int: Double?] = Dictionary(
                lockedRows.compactMap { row -> (Int, Double?)? in
                    guard let id = try? row.int64("id") else { return nil }
                    return (Int(id), try? row.optionalInt64("account_id").map(Double.init) ?? nil)
                }, uniquingKeysWith: { first, _ in first })
            func isOn(_ id: Int, _ accountId: Int?) -> Bool {  // lint:allow raw-id business table ids of the TypeScript route and repository reads
                guard let assigned = selectedById[id] else { return false }
                return assigned == accountId.map(Double.init)
            }
            // A repeated request finds every row already on the destination. Inside the
            // writer transaction that state cannot change, so report it without writing.
            if request.fromAccountId != request.toAccountId,
                ids.allSatisfy({ isOn($0, request.toAccountId) })
            {
                return receiptJson(request, ids, request.toAccountId, 0, true)
            }
            let staleIds = ids.filter { !isOn($0, request.fromAccountId) }
            if !staleIds.isEmpty {
                throw BackendHTTPError(
                    status: 409, code: "CONFLICT",
                    message: "selected portfolio transactions are missing or no longer have"
                        + " the expected broker assignment",
                    details: .object([
                        "stale_transaction_ids": .array(staleIds.map { JSONValue.int($0) })]))
            }

            // The histories and rates the guards replay.
            let investmentIds = Array(Set(lockedRows.compactMap { try? $0.integerId("investment_id") }))
                .sorted()
            let events = try retagEvents(session, investmentIds)
            let rates = try historicalRates(session)
            try assertRetagPreservesPartitionUnits(events, Set(ids), request.toAccountId)
            let method = costBasisMethod(session)
            try assertRetagPreservesPortfolioEconomics(
                events, Set(ids), request.toAccountId, method, session.today(), rates)

            var changedIds: [Int] = []
            if request.fromAccountId != request.toAccountId {
                let idsJson = "[" + ids.map(String.init).joined(separator: ",") + "]"
                var selectSql = "UPDATE portfolio_transactions SET account_id = ?"
                var arguments: [SQLValue] = [request.toAccountId.map { SQLValue.integer(Int64($0)) } ?? .null]
                if ids.count == 1 {
                    selectSql += " WHERE id = ?"
                    arguments.append(.integer(Int64(ids[0])))
                } else {
                    selectSql += " WHERE id IN (SELECT value FROM json_each(?))"
                    arguments.append(.text(idsJson))
                }
                if let from = request.fromAccountId {
                    selectSql += " AND account_id = ?"
                    arguments.append(.integer(Int64(from)))
                } else {
                    selectSql += " AND account_id IS NULL"
                }
                let changed = try session.rows(selectSql + " RETURNING id", arguments)
                changedIds = changed.compactMap { try? Int($0.int64("id")) }
                if changedIds.count != ids.count {
                    throw BackendHTTPError.conflict(
                        "broker assignments changed while the re-tag was being applied")
                }
            }
            return receiptJson(request, ids, request.fromAccountId, changedIds.count, false)
        }
        return HandlerResult(data: receipt)
    }

    static func receiptJson(
        _ request: RetagRequest, _ ids: [Int], _ previousAccountId: Int?,  // lint:allow raw-id business table ids of the TypeScript route and repository reads
        _ changedCount: Int, _ replayed: Bool
    ) -> JSONValue {
        .object([
            "idempotency_key": .string(request.idempotencyKey),
            "from_account_id": request.fromAccountId.map { JSONValue.int($0) } ?? .null,
            "to_account_id": request.toAccountId.map { JSONValue.int($0) } ?? .null,
            "transaction_ids": .array(ids.map { JSONValue.int($0) }),
            "previous_assignments": .array(ids.map { id in
                .object([
                    "transaction_id": .int(id),
                    "account_id": previousAccountId.map { JSONValue.int($0) } ?? .null,
                ])
            }),
            "selected_count": .int(ids.count),
            "changed_count": .int(changedCount),
            "replayed": .bool(replayed),
        ])
    }
}

// MARK: - The re-tag history reads and the two guards

extension PortfolioTransactionsArea {
    /// `getUnitEventsForInvestments`: the transaction rows of the joined projection,
    /// then each investment's custody events over the exemplar's investment columns.
    static func retagEvents(_ session: BackendSession, _ investmentIds: [Int]) throws -> [RetagEvent] {
        var events: [RetagEvent] = []
        if !investmentIds.isEmpty {
            let placeholders = investmentIds.map { _ in "?" }.joined(separator: ", ")
            events = try session.rows(
                """
                SELECT pt.id, pt.investment_id, pt.type,
                       to_char(pt.date, 'YYYY-MM-DD') AS date,
                       COALESCE(pt.amount, '0') AS amount,
                       COALESCE(pt.units, '0') AS units,
                       COALESCE(pt.fees, '0') AS fees,
                       COALESCE(pt.taxes, '0') AS taxes,
                       COALESCE(pt.currency, 'EUR') AS currency,
                       pt.fx_rate_to_eur,
                       CASE WHEN COALESCE(pt.currency, 'EUR') = 'EUR' THEN '1'
                            ELSE COALESCE(pt.fx_rate_to_eur,
                              (SELECT er.rate_to_eur FROM exchange_rates er
                                WHERE er.currency_code = pt.currency AND er.rate_date <= pt.date
                                ORDER BY er.rate_date DESC LIMIT 1)) END AS fx_multiplier_eur,
                       pt.account_id, i.asset_class,
                       COALESCE(i.current_price, '0') AS current_price,
                       COALESCE(i.interest_rate, '0') AS interest_rate
                FROM portfolio_transactions pt JOIN investments i ON i.id = pt.investment_id
                WHERE pt.investment_id IN (\(placeholders))
                ORDER BY pt.investment_id ASC, pt.date ASC, pt.id ASC
                """,
                investmentIds.map { SQLValue.integer(Int64($0)) }).map { try RetagEvent($0) }
        }
        for investmentId in investmentIds {
            let exemplar = events.first { $0.investmentId == investmentId }
            for event in try unitEvents(session, investmentId)
            where PortfolioCustody.custodyEventTypes.contains(event.type) {
                events.append(RetagEvent(custody: event, exemplar: exemplar, investmentId: investmentId))
            }
        }
        return events
    }

    /// `getHistoricalRates`: the stored rates, currency and day ascending.
    static func historicalRates(_ session: BackendSession) throws -> [RateRow] {
        try session.rows(
            """
            SELECT currency_code, to_char(rate_date, 'YYYY-MM-DD') AS rate_date, rate_to_eur
            FROM exchange_rates ORDER BY currency_code ASC, rate_date ASC
            """
        ).map { row in
            RateRow(
                currency: try row.text("currency_code"), date: try row.text("rate_date"),
                rate: PortfolioCore.jsToNumber(.text(try row.text("rate_to_eur"))))
        }
    }

    /// `resolveCostBasisMethod`: the stored setting, or weighted average.
    static func costBasisMethod(_ session: BackendSession) -> String {
        guard let row = try? session.row("SELECT value FROM user_settings WHERE key = 'cost_basis_method'"),
            let raw = try? row.text("value"), case .string(let value) = JSValue.parse(raw),
            PortfolioCore.isCostBasisMethod(value)
        else { return "weighted_avg" }
        return value
    }

    /// Whether a history row is one of the selected transactions.
    static func isSelectedRetagRow(_ row: RetagEvent, _ selectedIds: Set<Int>) -> Bool {
        row.isTransactionEvent && selectedIds.contains(Int(row.id))
    }

    /// `buildRateIndex` + `rateOnOrBefore`: the stored rates per currency, the last
    /// rate on or before a day, else the currency's latest rate.
    static func buildRateIndex(_ rates: [RateRow]) -> (entries: [String: [(String, Double)]], keys: [String]) {
        var entries: [String: [(String, Double)]] = [:]
        var keys: [String] = []
        for row in rates {
            let currency = row.currency.uppercased()
            if entries[currency] == nil { keys.append(currency) }
            entries[currency, default: []].append((row.date, row.rate))
        }
        return (entries, keys)
    }

    static func rateOnOrBefore(
        _ index: (entries: [String: [(String, Double)]], keys: [String]),
        _ currency: String, _ date: String
    ) -> Double? {
        if currency == "EUR" { return 1 }  // lint:allow string-literal-compare the stored wire value the TypeScript service dispatches on
        let entries = index.entries[currency] ?? []
        var match: Double?
        for entry in entries {
            if entry.0 > date { break }
            if entry.1.isFinite && entry.1 > 0 { match = entry.1 }
        }
        if match != nil { return match }
        return entries.last?.1
    }

    /// `validatePortfolioAssetTransferHistory` over the projected re-tag rows.
    static func validateRetagAssetTransferHistory(_ txns: [PortfolioCore.Txn]) throws {
        guard txns.contains(where: { PortfolioCustody.custodyEventTypes.contains($0.type) }) else { return }
        guard PortfolioCore.areLotsFullyAssigned(txns) else {
            throw BackendHTTPError.conflict(
                "Asset custody events require the original acquisitions to be reconciled"
                + " to their source accounts")
        }
        do {
            for method in PortfolioCore.costBasisMethods {
                _ = try PortfolioCustody.projectAssetTransferPartitions(txns, method: method)
            }
            if try !(PortfolioCore.partitionOversellDeficits(txns).isEmpty) {
                throw PortfolioCore.Failure(message: "Custody history contains an oversell")
            }
        } catch let error as BackendHTTPError {
            throw error
        } catch {
            throw BackendHTTPError.conflict(
                "Asset transfer custody history is invalid: \(String(describing: error))")
        }
    }

    /// `assertRetagPreservesPartitionUnits`: existing deficits are tolerated, but a
    /// re-tag may not create or worsen one.
    static func assertRetagPreservesPartitionUnits(
        _ rows: [RetagEvent], _ selectedIds: Set<Int>, _ toAccountId: Int?  // lint:allow raw-id business table ids of the TypeScript route and repository reads
    ) throws {
        var byInvestment: [Int: [RetagEvent]] = [:]
        var order: [Int] = []
        for row in rows {
            if byInvestment[row.investmentId] == nil { order.append(row.investmentId) }
            byInvestment[row.investmentId, default: []].append(row)
        }
        for investmentId in order {
            let beforeRows = byInvestment[investmentId] ?? []
            let afterRows = beforeRows.map { row in
                isSelectedRetagRow(row, selectedIds)
                    ? row.withAccountId(toAccountId.map(Double.init)) : row
            }
            let before = try PortfolioCore.partitionOversellDeficits(beforeRows.map { $0.txn(fxMultiplier: nil) })
            try validateRetagAssetTransferHistory(afterRows.map { $0.txn(fxMultiplier: nil) })
            let after = try PortfolioCore.partitionOversellDeficits(afterRows.map { $0.txn(fxMultiplier: nil) })
            for (accountId, deficit) in after {
                if deficit - (before[accountId] ?? 0) > epsilon {
                    throw BackendHTTPError.validation(
                        "re-tag would create or worsen an oversold partition for investment"
                        + " \(investmentId) at account \(Int(accountId))")
                }
            }
        }
    }

    /// `assertRetagPreservesPortfolioEconomics`: the exact partitioned engine must
    /// answer the same core before and after the assignment change.
    static func assertRetagPreservesPortfolioEconomics(
        _ rows: [RetagEvent], _ selectedIds: Set<Int>, _ toAccountId: Int?,  // lint:allow raw-id business table ids of the TypeScript route and repository reads
        _ method: String, _ todayYmd: String, _ rates: [RateRow]
    ) throws {
        let index = buildRateIndex(rates)
        var targets: [String] = ["EUR"]
        for key in index.keys where !targets.contains(key) { targets.append(key) }
        var byInvestment: [Int: [RetagEvent]] = [:]
        var order: [Int] = []
        for row in rows {
            if byInvestment[row.investmentId] == nil { order.append(row.investmentId) }
            byInvestment[row.investmentId, default: []].append(row)
        }
        let epsilonDecimal = PortfolioCore.toDecimal(epsilon)
        for investmentId in order {
            let beforeRows = byInvestment[investmentId] ?? []
            let afterRows = beforeRows.map { row in
                isSelectedRetagRow(row, selectedIds)
                    ? row.withAccountId(toAccountId.map(Double.init)) : row
            }
            let investment = PortfolioCore.Investment(
                assetClass: beforeRows.first?.assetClass ?? "stock",
                currentPrice: .text(beforeRows.first?.currentPrice ?? "0"),
                interestRate: .text(beforeRows.first?.interestRate ?? "0"))
            let options = PortfolioCore.Options(costBasisMethod: method, todayYmd: todayYmd)
            let before = try PortfolioCore.buildInvestmentSummaryCorePartitioned(
                investment, beforeRows.map { $0.txn(fxMultiplier: nil) }, opts: options).core
            let after = try PortfolioCore.buildInvestmentSummaryCorePartitioned(
                investment, afterRows.map { $0.txn(fxMultiplier: nil) }, opts: options).core
            func drifted(_ afterValue: DecimalJS, _ beforeValue: DecimalJS, _ field: String) throws {
                if afterValue.minus(beforeValue).abs.gt(epsilonDecimal) {
                    throw BackendHTTPError.validation(
                        "re-tag would change \(field) for investment \(investmentId)"
                        + " under \(method) cost basis")
                }
            }
            try drifted(after.totalUnits, before.totalUnits, "totalUnits")
            try drifted(after.totalInvested, before.totalInvested, "totalInvested")
            try drifted(after.realizedGain, before.realizedGain, "realizedGain")

            for target in targets {
                func withTargetFx(_ rowsToAnnotate: [RetagEvent]) throws -> [PortfolioCore.Txn] {
                    try rowsToAnnotate.map { row in
                        let source = (row.currency ?? "EUR").uppercased()
                        let stamped: Double = row.fxRateToEur.map {
                            PortfolioCore.jsToNumber(.text($0))
                        } ?? 0
                        let sourceRate =
                            stamped.isFinite && stamped > 0
                            ? stamped
                            : source == "EUR" ? 1 : (rateOnOrBefore(index, source, row.date) ?? Double.nan)  // lint:allow string-literal-compare the stored wire value the TypeScript service dispatches on
                        let fxEur: Double = row.fxEur.map { PortfolioCore.jsToNumber(.text($0)) } ?? 0
                        let targetRate = rateOnOrBefore(index, target, row.date)
                        let fxMultiplier: Double
                        if source == target {
                            fxMultiplier = 1
                        } else if target == "EUR", fxEur.isFinite, fxEur > 0 {  // lint:allow string-literal-compare the stored wire value the TypeScript service dispatches on
                            fxMultiplier = fxEur
                        } else {
                            fxMultiplier = (sourceRate ?? Double.nan) / (targetRate ?? Double.nan)
                        }
                        guard fxMultiplier.isFinite, fxMultiplier > 0 else {
                            throw BackendHTTPError.validation(
                                "re-tag cannot verify \(target) cost basis for investment"
                                + " \(investmentId)")
                        }
                        return row.txn(fxMultiplier: SQLArguments.javaScriptText(fxMultiplier))
                    }
                }
                let beforeTarget = try PortfolioCore.buildInvestmentSummaryCorePartitioned(
                    investment, withTargetFx(beforeRows), opts: options
                ).core.converted
                let afterTarget = try PortfolioCore.buildInvestmentSummaryCorePartitioned(
                    investment, withTargetFx(afterRows), opts: options
                ).core.converted
                func driftedConverted(_ afterValue: DecimalJS, _ beforeValue: DecimalJS, _ field: String) throws {
                    if afterValue.minus(beforeValue).abs.gt(epsilonDecimal) {
                        throw BackendHTTPError.validation(
                            "re-tag would change \(target) \(field) for investment \(investmentId)"
                            + " under \(method) cost basis")
                    }
                }
                try driftedConverted(afterTarget.totalInvested, beforeTarget.totalInvested, "totalInvested")
                try driftedConverted(afterTarget.realizedGain, beforeTarget.realizedGain, "realizedGain")
            }
        }
    }
}
