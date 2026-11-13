import Foundation

/// IBKR Client Portal "Transaction Status & History" funding workbook
/// (`ibkrFundingHistoryAdapter.ts`): each completed deposit or withdrawal becomes one cash row
/// in its own currency, identified by the account and IBKR reference number. The TypeScript
/// reads the file with SheetJS; this starts from the sheets as that reader returns them.
enum IbkrFundingHistory {
    enum Cell: Equatable, Sendable {
        case text(String)
        case number(String)
        case boolean(Bool)
    }

    struct Sheet: Equatable, Sendable {
        var name: String
        var rows: [[Cell?]]
        var sourceFileHash: String
        /// `xls` or `xlsx`.
        var sourceFormat: String
    }

    private static let columns: [String: [String]] = [
        "Deposit": [
            "Request Date", "Reference Number", "Method", "Account ID", "Account Title", "Delivering Institution",
            "From Account Number", "Routing Number", "Date Received", "Date Available for Trading",
            "Date Available for Withdrawal - Original Bank", "Date Available for Withdrawal - Other Bank", "Amount",
            "Status",
        ],
        "Withdrawal": [
            "Request Date", "Reference Number", "Method", "Account ID", "Account Title", "Receiving Institution",
            "Date Processed", "Amount", "Status",
        ],
    ]
    /// Statuses of a movement that reached the account.
    private static let completed: Set<String> = [
        "available", "sent", "complete", "completed", "processed", "received", "credited", "disbursed",
    ]
    /// Statuses of a request that never moved money.
    private static let open: Set<String> = [
        "pending", "processing", "requested", "rejected", "canceled", "cancelled", "failed", "returned", "reversed",
        "expired", "on hold",
    ]

    private struct Facts {
        var deposit: Bool
        var day: String
        var currency: String  // lint:allow raw-currency checked against the funding currency list on the line that sets it
        var amount: String
        var account: String
        var reference: String
        var method: String
        var status: String
        var institution: String?
    }

    private static func fail(_ message: String) -> StatementImportError { .validation("IBKR funding history \(message)") }

    private static func same(_ a: [String], _ b: [String]) -> Bool {
        a.count == b.count && zip(a, b).allSatisfy { BankImportText.same($0, $1) }
    }

    private static func text(_ cell: Cell?) throws -> String {
        switch cell {
        case nil: return ""
        case .number(let value): return value
        case .boolean: throw fail("requires text cells for its export fields")
        case .text(let value):
            guard value.utf16.count <= 10_000,
                !value.unicodeScalars.contains(where: { $0.value < 32 && ![9, 10, 13].contains($0.value) })
            else { throw fail("contains an unsupported literal value") }
            return JavaScriptWhitespace.trim(value)
        }
    }

    private static func isDigits(_ units: some Collection<UInt16>) -> Bool {
        !units.isEmpty && units.allSatisfy { $0 >= 0x30 && $0 <= 0x39 }
    }

    private static func date(_ value: String) throws -> String {
        let units = Array(value.utf16)
        guard units.count == 10, units[4] == 0x2D, units[7] == 0x2D, isDigits(units[0..<4]), isDigits(units[5..<7]),
            isDigits(units[8..<10])
        else { throw fail("requires ISO calendar dates (YYYY-MM-DD)") }
        func number(_ range: Range<Int>) -> Int { units[range].reduce(0) { $0 * 10 + Int($1) - 0x30 } }
        let year = number(0..<4)
        let month = number(5..<7)
        let day = number(8..<10)
        let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
        let lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
        guard (1...12).contains(month), day >= 1, day <= lengths[month - 1] else {
            throw fail("contains an invalid calendar date")
        }
        return value
    }

    private static func isUpper(_ unit: UInt16) -> Bool { unit >= 0x41 && unit <= 0x5A }
    private static func isAlphanumeric(_ unit: UInt16) -> Bool {
        isUpper(unit) || (unit >= 0x61 && unit <= 0x7A) || (unit >= 0x30 && unit <= 0x39)
    }

    /// `/^([A-Z]{3}) ((?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d{1,8})?)$/`, the listed
    /// currency, and an amount above zero up to 999,999,999,999.
    private static func nativeAmount(_ value: String) throws -> (currency: String, amount: String) {
        let units = Array(value.utf16)
        let shape = fail("requires an amount with its currency, such as USD 1,000.00")
        guard units.count > 4, units[0..<3].allSatisfy(isUpper), units[3] == 0x20 else { throw shape }
        let currency = String(decoding: units[0..<3], as: UTF16.self)
        let digits = units[4...]
        let parts = digits.split(separator: 0x2E, omittingEmptySubsequences: false)
        guard parts.count <= 2, let whole = parts.first, isDigits(whole.filter { $0 != 0x2C }) else { throw shape }
        if parts.count == 2 { guard isDigits(parts[1]), parts[1].count <= 8 else { throw shape } }
        if whole.contains(0x2C) {
            let groups = whole.split(separator: 0x2C, omittingEmptySubsequences: false)
            guard let first = groups.first, (1...3).contains(first.count), first.first != 0x30,
                groups.dropFirst().allSatisfy({ $0.count == 3 })
            else { throw shape }
        } else {
            guard whole.count == 1 || whole.first != 0x30 else { throw shape }
        }
        guard IbkrFundingFacts.fundingCurrencies.contains(currency) else { throw shape }
        let amount = try DecimalJS(String(decoding: digits.filter { $0 != 0x2C }, as: UTF16.self))
        guard amount.gt(.zero), !amount.gt(try DecimalJS("999999999999")) else {
            throw fail("contains an unsupported funding amount")
        }
        return (currency, amount.toFixed)
    }

    /// `movement(envelope)`: the movement of one row, or nil for a request that never moved
    /// money.
    private static func movement(sheet: String, columns: [String], cells: [Cell?], rowNumber: Int) throws -> Facts? {
        guard cells.count <= columns.count else { throw fail("contains a row wider than its header") }
        var record: [String: String] = [:]
        for (index, column) in columns.enumerated() { record[column] = try text(index < cells.count ? cells[index] : nil) }
        func field(_ name: String) -> String { record[name] ?? "" }
        for key in ["Request Date", "Reference Number", "Account ID", "Amount", "Status"] where field(key).isEmpty {
            throw fail("is missing \(key) on row \(rowNumber)")
        }
        let account = Array(field("Account ID").utf16)
        let reference = Array(field("Reference Number").utf16)
        guard (3...50).contains(account.count), isUpper(account[0]),
            account.dropFirst().allSatisfy({ isUpper($0) || ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x2A || $0 == 0x2D }),
            (1...100).contains(reference.count), reference.allSatisfy({ isAlphanumeric($0) || $0 == 0x2D })
        else { throw fail("contains an unsupported account or reference identity") }
        let status = field("Status")
        // `/i` without the unicode flag folds ASCII letters only.
        let folded = String(decoding: status.utf16.map { isUpper($0) ? $0 + 0x20 : $0 }, as: UTF16.self)
        if open.contains(where: { BankImportText.same($0, folded) }) { return nil }
        guard completed.contains(where: { BankImportText.same($0, folded) }) else {
            throw fail("contains an unknown funding status \"\(status)\"")
        }
        let deposit = sheet == "Deposit"
        let requested = try date(field("Request Date"))
        let completion = field(deposit ? "Date Received" : "Date Processed")
        let completedDay = completion.isEmpty ? requested : try date(completion)
        guard !completedDay.utf16.lexicographicallyPrecedes(requested.utf16) else {
            throw fail("contains inconsistent request and completion dates")
        }
        let native = try nativeAmount(field("Amount"))
        let method = field("Method")
        let institution = field(deposit ? "Delivering Institution" : "Receiving Institution")
        return Facts(
            deposit: deposit, day: requested, currency: native.currency, amount: native.amount, account: field("Account ID"),
            reference: field("Reference Number"), method: method.isEmpty ? "funding" : method, status: status,
            institution: institution.isEmpty ? nil : institution)
    }

    private static func json(_ cell: Cell?) -> JSValue {
        switch cell {
        case nil: return .null
        case .text(let value): return .object(JSObject([("type", .string("text")), ("value", .string(value))]))
        case .number(let value): return .object(JSObject([("type", .string("number")), ("value", .string(value))]))
        case .boolean(let value): return .object(JSObject([("type", .string("boolean")), ("value", .bool(value))]))
        }
    }

    /// `parseIbkrFundingHistory`, from the sheets the workbook reader returned.
    static func parse(_ sheets: [Sheet]) throws -> ParsedPortfolioRows {
        guard !sheets.isEmpty else { throw fail("contains no funding sheets") }
        var parsed = ParsedPortfolioRows(skipped: 0)
        var accounts: Set<[UInt16]> = []
        var references: Set<[[UInt16]]> = []
        for source in sheets {
            let header = try (source.rows.first ?? []).map(text)
            guard let expected = columns[source.name], same(header, expected) else {
                throw fail("requires the original Deposit or Withdrawal sheet with its complete header")
            }
            for (index, cells) in source.rows.enumerated().dropFirst() {
                let blank = cells.allSatisfy { cell in
                    switch cell {
                    case nil: return true
                    case .text(let value): return JavaScriptWhitespace.trim(value).isEmpty
                    default: return false
                    }
                }
                if blank { continue }
                guard let facts = try movement(sheet: source.name, columns: header, cells: cells, rowNumber: index + 1)
                else {
                    parsed.skipped = (parsed.skipped ?? 0) + 1
                    continue
                }
                guard references.insert([Array(facts.account.utf16), Array(facts.reference.utf16)]).inserted else {
                    throw fail("contains duplicate funding references")
                }
                accounts.insert(Array(facts.account.utf16))
                let rawData = JSValue.object(
                    JSObject([
                        ("schema", .string("ibkr_funding_workbook_row")), ("version", .number(1)),
                        ("source_file_hash", .string(source.sourceFileHash)), ("source_format", .string(source.sourceFormat)),
                        ("sheet", .string(source.name)), ("header_row", .number(1)), ("row_number", .number(Double(index + 1))),
                        ("columns", .array(header.map(JSValue.string))), ("cells", .array(cells.map(json))),
                    ])
                ).jsonText
                guard rawData.utf8.count <= 100_000 else { throw fail("contains a row exceeding the retained size limit") }
                let units = Array(facts.day.utf8).map { Int($0) - 0x30 }
                let day = XLSXWorkbook.days(
                    fromCivil: units[0] * 1000 + units[1] * 100 + units[2] * 10 + units[3], units[5] * 10 + units[6],
                    units[8] * 10 + units[9])
                parsed.rows.append(
                    ParsedPortfolioRow(
                        day: day, typeRaw: source.name, amount: JavaScriptNumber.fromString(facts.amount),
                        currency: facts.currency,
                        note: "IBKR \(facts.deposit ? "deposit" : "withdrawal") (\(facts.method), \(facts.status))"
                            + (facts.institution.map { " — \($0)" } ?? ""),
                        rawData: rawData, sourceAccountIdentity: facts.account, sourceReference: facts.reference))
            }
        }
        guard !parsed.rows.isEmpty else { throw fail("contains no completed funding movements") }
        guard accounts.count == 1 else { throw fail("must contain one broker account") }
        var names: [String] = []
        for source in sheets {
            for column in columns[source.name] ?? [] where !names.contains(column) { names.append(column) }
        }
        parsed.sourceColumns = names
        return parsed
    }
}
