import Foundation

/// The settings of a custom statement parser (`CustomTransactionParserConfig` of
/// `importPipeline/adapters/generic.ts`).
struct CustomBankParserConfig: Equatable, Sendable {
    struct Columns: Equatable, Sendable {
        var date: String
        var recipient: String
        var amount: String
        var memo: String?
        var currency: String?
        var balance: String?
        var sourceReference: String?
    }

    var bankName: String?
    var accountType: String?
    var dateFormat: String?
    var separator: String?
    /// Leading lines to drop before the header.
    var skipRows = 0
    var encoding: String?
    /// The stored `number_format` value, checked when the file is read.
    var numberFormat: JSValue?
    var columns: Columns
}

/// The bank statement adapters (`importPipeline/adapters`): each reads the bytes of one
/// bank's CSV export into `ParsedBankTransactions`. Rows an adapter cannot read are counted
/// in `skipped`, never guessed at.
enum BankAdapters {
    /// The built-in adapters, in registry order, which is the order detection tries them in.
    enum Bank: String, CaseIterable, Sendable {
        case belfius, revolut, ing, bnp, kbc, vision, sabb, wise

        var displayName: String {
            switch self {
            case .belfius: "Belfius"
            case .revolut: "Revolut"
            case .ing: "ING"
            case .bnp: "BNP Paribas Fortis"
            case .kbc: "KBC"
            case .vision: "Vision"
            case .sabb: "SABB"
            case .wise: "Wise"
            }
        }

        /// Whether imported accounts keep one cash partition per currency.
        var multiCurrencyCash: Bool { self == .revolut }
    }

    private typealias Text = BankImportText

    // MARK: Registry

    /// `getAdapter(name)`: by internal name, whatever its case and spacing. `generic` is not a
    /// `Bank`; it is `parse(custom:)`.
    static func bank(named name: String?) -> Bank? {
        guard let name, !name.isEmpty else { return nil }
        var key = String.UnicodeScalarView()
        var inRun = false
        for scalar in JavaScriptCase.lowercased(name).unicodeScalars {
            if JavaScriptWhitespace.contains(scalar) {
                if !inRun { key.append("_") }
                inRun = true
            } else {
                inRun = false
                key.append(scalar)
            }
        }
        return Bank(rawValue: String(key))
    }

    /// `detectBank(sample)`: the first adapter whose signature the head of a file carries.
    static func detect(_ sample: String?) -> Bank? { Bank.allCases.first { matches($0, sample) } }

    /// `detectBankImportFormats(sample)`.
    static func detectAll(_ sample: String?) -> [Bank] { Bank.allCases.filter { matches($0, sample) } }

    /// `matchesBankImportFormat(format, sample)`.
    static func matches(_ bank: Bank, _ sample: String?) -> Bool {
        guard let sample, !sample.isEmpty else { return false }
        let text = Text.withoutByteOrderMark(sample)
        func lines(_ limit: Int) -> [String] { Array(Text.lines(keepingByteOrderMark: text).prefix(limit)) }
        let firstLine = Text.split(text, "\n").first ?? ""
        let lower = JavaScriptCase.lowercased(firstLine)
        switch bank {
        case .belfius:
            let head = lines(15)
            return head.contains { Text.contains($0, "Laatste saldo;") }
                || head.contains { line in
                    let start = Text.units(Text.trim(line))
                    return start.count >= 4 && start[0] == 0x42 && start[1] == 0x45 && Text.isDigit(start[2])
                        && Text.isDigit(start[3]) && Text.split(line, ";").count >= 12
                }
        case .revolut:
            return Text.hasPrefix(lower, "type,") && Text.contains(lower, "completed date") && Text.contains(lower, "state")
        case .ing:
            return lines(3).contains { Text.contains($0, "Omzetnummer") && Text.contains($0, "Detail van de omzet") }
        case .bnp:
            return lines(3).contains {
                Text.contains($0, "Volgnummer") && Text.contains($0, "Uitvoeringsdatum")
                    && Text.contains($0, "Valuta rekening")
            }
        case .kbc:
            let head = lines(5)
            return head.contains { Text.hasPrefix($0, "Rekeningnummer") }
                || head.contains { Text.contains($0, "Vrije Mededeling") }
        case .vision:
            let columns = Text.split(JavaScriptCase.lowercased(Text.trim(firstLine)), ",").map(Text.trim)
            let wanted = ["date", "bank account", "recipient", "memo", "amount", "currency"]
            return columns.count >= wanted.count && zip(columns, wanted).allSatisfy { Text.same($0, $1) }
        case .sabb:
            return Text.contains(lower, "transaction date") && Text.contains(lower, "amount(sar)")
        case .wise:
            return Text.contains(lower, "direction") && Text.contains(lower, "target amount")
                && Text.contains(lower, "source amount")
        }
    }

    /// One built-in adapter over the bytes of a statement, with its output held to the row
    /// contract.
    static func parse(_ bank: Bank, _ bytes: [UInt8]) throws -> ParsedBankTransactions {
        let parsed: ParsedBankTransactions
        switch bank {
        case .belfius: parsed = try belfius(bytes)
        case .revolut: parsed = try revolut(bytes)
        case .ing: parsed = try ing(bytes)
        case .bnp: parsed = try bnp(bytes)
        case .kbc: parsed = try kbc(bytes)
        case .vision: parsed = try vision(bytes)
        case .sabb: parsed = try sabb(bytes)
        case .wise: parsed = try wise(bytes)
        }
        return try checked(parsed, adapter: bank.rawValue)
    }

    /// The generic adapter: a statement read with the user's own column mapping.
    static func parse(custom config: CustomBankParserConfig, _ bytes: [UInt8]) throws -> ParsedBankTransactions {
        try checked(try generic(bytes, config), adapter: "generic")
    }

    /// `parsedBankTransactionsSchema`: a row breaking it is an adapter bug, and fails the import.
    private static func checked(_ parsed: ParsedBankTransactions, adapter: String) throws -> ParsedBankTransactions {
        func digits(_ text: String) -> Bool {
            let all = Text.units(text)
            return (1...18).contains(all.count) && all.allSatisfy(Text.isDigit)
        }
        for row in parsed.rows {
            let currencyFits = row.currency.map { Text.isoCurrency($0) != nil && Text.same(Text.isoCurrency($0) ?? "", $0) } ?? true
            let sequenceFits = (row.bankSequence ?? nil).map(digits) ?? true
            let sourceFits = (row.sourceReference ?? nil).map { !$0.isEmpty } ?? true
            guard !row.bankAccount.isEmpty, row.amount.isFinite, row.balance?.isFinite ?? true, currencyFits, sequenceFits,
                sourceFits
            else { throw BankImportError.contract(adapter: adapter) }
        }
        return parsed
    }

    // MARK: Shared pieces

    private static let semicolonOptions: CSVParse.Options = {
        var options = CSVParse.Options()
        options.delimiter = ";"
        options.skipEmptyLines = true
        options.relaxColumnCount = true
        options.relaxQuotes = true
        options.skipRecordsWithError = true
        return options
    }()

    private static let namedColumnOptions: CSVParse.Options = {
        var options = CSVParse.Options()
        options.columns = .firstRecord
        options.skipEmptyLines = true
        options.relaxColumnCount = true
        options.trim = true
        return options
    }()

    /// `parts[index] ? parts[index].trim() : ""`.
    private static func cell(_ parts: [String], _ index: Int) -> String {
        index < parts.count ? Text.trim(parts[index]) : ""
    }

    /// `(row[name] || "").trim()`.
    private static func field(_ row: CSVParse.Record, _ name: String) -> String { Text.trim(row[name] ?? "") }

    private static func orNil(_ text: String) -> String? { text.isEmpty ? nil : text }

    /// A case-insensitive search for any of `stems`, as a JavaScript `/a|b/i` does it: only the
    /// ASCII letters fold.
    private static func mentions(_ text: String, anyOf stems: [String]) -> Bool {
        let folded = Text.text(Text.units(text).map { $0 >= 0x41 && $0 <= 0x5A ? $0 + 0x20 : $0 })
        return stems.contains { Text.contains(folded, $0) }
    }

    private static func upper(_ text: String) -> String { JavaScriptCase.uppercased(text) }

    // MARK: Belfius

    private struct Sequenced {
        var row: ParsedBankTransaction
        let statement: Double
        let transaction: Double
    }

    private static func belfiusLastBalance(_ line: String) -> Double? {
        guard Text.contains(line, "Laatste saldo;") else { return nil }
        let parts = Text.split(line, ";")
        guard parts.count >= 2 else { return nil }
        let value = Text.commaDecimal(Text.trim(Text.replacingFirst(parts[1], " EUR", "")))
        return value.isNaN ? nil : value
    }

    private static func belfiusRow(_ record: CSVParse.Record) -> Sequenced? {
        let parts = record.cells
        guard parts.count >= 12 else { return nil }
        let statementNumber = cell(parts, 2)
        let transactionNumber = cell(parts, 3)
        let recipientAccount = cell(parts, 4)
        let recipientName = cell(parts, 5)
        let description = cell(parts, 8)
        guard let day = Text.dayMonthYear(cell(parts, 1)) else { return nil }
        let amount = Text.commaDecimal(cell(parts, 10))
        if amount.isNaN { return nil }
        let address = [cell(parts, 6), cell(parts, 7)].filter { !$0.isEmpty }
        var comment: [String] = []
        if !statementNumber.isEmpty { comment.append("Statement: \(statementNumber)") }
        if !transactionNumber.isEmpty { comment.append("Transaction: \(transactionNumber)") }
        if !cell(parts, 12).isEmpty { comment.append("BIC: \(cell(parts, 12))") }
        if !cell(parts, 13).isEmpty { comment.append("Country: \(cell(parts, 13))") }
        if !cell(parts, 14).isEmpty { comment.append(cell(parts, 14)) }
        func counter(_ text: String) -> Int64? {
            let all = Text.units(text)
            return (1...9).contains(all.count) && all.allSatisfy(Text.isDigit) ? Int64(text) : nil
        }
        var sequence: String?
        if let statement = counter(statementNumber), let transaction = counter(transactionNumber) {
            sequence = String(statement * 1_000_000_000 + transaction)
        }
        let account = Text.canonicalIBAN(cell(parts, 0))
        let row = ParsedBankTransaction(
            day: day, bankAccount: account.isEmpty ? "BELFIUS" : account,
            recipient: Text.uppercase(Text.cleanRecipient(recipientName.isEmpty ? description : recipientName)),
            memo: description.isEmpty ? "" : Text.uppercase(description), amount: amount,
            currency: Text.isoCurrency(parts[11]), balance: nil, recipientAccount: orNil(recipientAccount),
            recipientAddress: address.isEmpty ? nil : address.joined(separator: ", "),
            recipientBankName: recipientAccount.isEmpty ? nil : "BELFIUS", comment: Text.comment(comment),
            rawData: Text.rawData(record), sourceReference: .some(nil), bankSequence: .some(sequence))
        return Sequenced(
            row: row, statement: Text.parseInt(statementNumber), transaction: Text.parseInt(transactionNumber))
    }

    /// The statement's closing balance walked back over the rows, newest first.
    private static func applyRunningBalances(_ rows: inout [Sequenced], lastBalance: Double?) throws {
        guard let lastBalance, !rows.isEmpty else { return }
        // A balance or amount that is not finite breaks the row contract whatever is stamped.
        guard lastBalance.isFinite, rows.allSatisfy({ $0.row.amount.isFinite }) else {
            throw BankImportError.contract(adapter: Bank.belfius.rawValue)
        }
        var order = Array(rows.indices)
        if rows.allSatisfy({ $0.statement.isFinite && $0.transaction.isFinite }) {
            order.sort { a, b in
                if rows[a].statement != rows[b].statement { return rows[a].statement > rows[b].statement }
                if rows[a].transaction != rows[b].transaction { return rows[a].transaction > rows[b].transaction }
                return a < b
            }
        } else if rows[0].row.day < rows[rows.count - 1].row.day {
            order.reverse()
        }
        var balance = try DecimalJS(lastBalance)
        for index in order {
            rows[index].row.balance = DecimalMoney.roundMoney(balance)
            balance = balance.minus(try DecimalJS(rows[index].row.amount))
        }
    }

    private static func belfius(_ bytes: [UInt8]) throws -> ParsedBankTransactions {
        let content = Text.decode(bytes)
        let lines = Text.lines(content)
        var options = semicolonOptions
        options.fromLine = 14
        let output = try Text.records(content, options)
        var rows: [Sequenced] = []
        var skipped = output.skipped
        for record in output.records {
            if let row = belfiusRow(record) { rows.append(row) } else { skipped += 1 }
        }
        try applyRunningBalances(&rows, lastBalance: lines.count > 9 ? belfiusLastBalance(Text.trim(lines[9])) : nil)
        return ParsedBankTransactions(rows: rows.map(\.row), skipped: skipped)
    }

    // MARK: BNP Paribas Fortis

    private static let bnpNotExecuted = ["geweiger", "geannuleer", "annulering", "refus", "annul", "reject", "cancel"]

    private static func bnpNotExecuted(_ parts: [String]) -> Bool {
        !cell(parts, 12).isEmpty || mentions(cell(parts, 11), anyOf: bnpNotExecuted)
    }

    private static func bnpRow(_ record: CSVParse.Record) -> ParsedBankTransaction? {
        let parts = record.cells
        guard parts.count >= 9, !bnpNotExecuted(parts) else { return nil }
        let sequenceNumber = cell(parts, 0)
        let transactionType = cell(parts, 6)
        let counterpartyAccount = cell(parts, 7)
        let counterpartyName = cell(parts, 8)
        let message = cell(parts, 9)
        let details = cell(parts, 10)
        let status = cell(parts, 11)
        guard let day = Text.dayMonthYear(cell(parts, 1)) else { return nil }
        let amount = Text.amount(cell(parts, 3))
        if amount.isNaN { return nil }
        let typeOrDetails = transactionType.isEmpty ? details : transactionType
        var comment: [String] = []
        if !sequenceNumber.isEmpty { comment.append("Sequence: \(sequenceNumber)") }
        if !message.isEmpty { comment.append("Message: \(message)") }
        if !details.isEmpty, !Text.same(details, transactionType) { comment.append("Details: \(details)") }
        if !status.isEmpty { comment.append("Status: \(status)") }
        let account = Text.canonicalIBAN(cell(parts, 5))
        return ParsedBankTransaction(
            day: day, bankAccount: account.isEmpty ? "BNP" : account,
            recipient: Text.uppercase(Text.cleanRecipient(counterpartyName.isEmpty ? typeOrDetails : counterpartyName)),
            memo: Text.uppercase(typeOrDetails), amount: amount, currency: Text.isoCurrency(parts[4]), balance: nil,
            recipientAccount: orNil(counterpartyAccount), recipientAddress: nil,
            recipientBankName: counterpartyAccount.isEmpty ? nil : "BNP Paribas Fortis", comment: Text.comment(comment),
            rawData: Text.rawData(record), sourceReference: .some(nil))
    }

    private static func bnp(_ bytes: [UInt8]) throws -> ParsedBankTransactions {
        let output = try Text.records(Text.decode(bytes), semicolonOptions)
        var parsed = ParsedBankTransactions(skipped: output.skipped, excluded: 0)
        var headerSeen = false
        for record in output.records {
            let line = Text.trim(Text.rawData(record))
            if Text.contains(line, "Volgnummer"), Text.contains(line, "Uitvoeringsdatum") {
                headerSeen = true
                continue
            }
            if !headerSeen { continue }
            if record.cells.count >= 9, bnpNotExecuted(record.cells) {
                parsed.skipped = (parsed.skipped ?? 0) + 1
                parsed.excluded = (parsed.excluded ?? 0) + 1
            } else if let row = bnpRow(record) {
                parsed.rows.append(row)
            } else {
                parsed.skipped = (parsed.skipped ?? 0) + 1
            }
        }
        return parsed
    }

    // MARK: ING

    private static func ingRow(_ record: CSVParse.Record) -> ParsedBankTransaction? {
        let parts = record.cells
        guard parts.count >= 9 else { return nil }
        let counterpartyAccount = cell(parts, 2)
        let transactionNumber = cell(parts, 3)
        let description = cell(parts, 8)
        let detail = cell(parts, 9)
        let message = cell(parts, 10)
        guard let day = Text.dayMonthYear(cell(parts, 4)) else { return nil }
        let amount = Text.commaDecimal(cell(parts, 6))
        if amount.isNaN { return nil }
        var comment: [String] = []
        if !transactionNumber.isEmpty { comment.append("Transaction: \(transactionNumber)") }
        if !message.isEmpty { comment.append("Message: \(message)") }
        let account = Text.canonicalIBAN(cell(parts, 0))
        return ParsedBankTransaction(
            day: day, bankAccount: account.isEmpty ? "ING" : account,
            recipient: Text.uppercase(detail.isEmpty ? description : detail), memo: Text.uppercase(description),
            amount: amount, currency: Text.isoCurrency(parts[7]), balance: nil,
            recipientAccount: orNil(counterpartyAccount), recipientAddress: nil,
            recipientBankName: counterpartyAccount.isEmpty ? nil : "ING", comment: Text.comment(comment),
            rawData: Text.rawData(record), sourceReference: .some(nil))
    }

    private static func ing(_ bytes: [UInt8]) throws -> ParsedBankTransactions {
        let output = try Text.records(Text.decode(bytes), semicolonOptions)
        var parsed = ParsedBankTransactions(skipped: output.skipped)
        var headerSeen = false
        for record in output.records {
            let line = Text.trim(Text.rawData(record))
            if Text.contains(line, "Omzetnummer"), Text.contains(line, "Boekingsdatum") {
                headerSeen = true
                continue
            }
            if !headerSeen { continue }
            if let row = ingRow(record) { parsed.rows.append(row) } else { parsed.skipped = (parsed.skipped ?? 0) + 1 }
        }
        return parsed
    }

    // MARK: KBC

    private static func kbcType(credit: String, debit: String) -> String? {
        func moves(_ text: String) -> Bool {
            guard !text.isEmpty else { return false }
            let value = Text.commaDecimal(text)
            return !value.isNaN && abs(value) > 0
        }
        if moves(credit) { return "CREDIT" }
        return moves(debit) ? "DEBIT" : nil
    }

    private static func kbcRow(_ record: CSVParse.Record) -> ParsedBankTransaction? {
        let parts = record.cells
        guard parts.count >= 15 else { return nil }
        let statementNumber = cell(parts, 4)
        let description = cell(parts, 6)
        let balanceText = cell(parts, 9)
        let counterpartyAccount = cell(parts, 12)
        let counterpartyBIC = cell(parts, 13)
        let counterpartyName = cell(parts, 14)
        guard let day = Text.dayMonthYear(cell(parts, 5)) else { return nil }
        let amount = Text.commaDecimal(cell(parts, 8))
        if amount.isNaN { return nil }
        let balance = balanceText.isEmpty ? Double.nan : Text.commaDecimal(balanceText)
        var comment: [String] = []
        if !statementNumber.isEmpty { comment.append("Statement: \(statementNumber)") }
        if let type = kbcType(credit: cell(parts, 10), debit: cell(parts, 11)) { comment.append("Type: \(type)") }
        if !counterpartyBIC.isEmpty { comment.append("BIC: \(counterpartyBIC)") }
        if !cell(parts, 16).isEmpty { comment.append("Structured: \(cell(parts, 16))") }
        if !cell(parts, 17).isEmpty { comment.append("Free: \(cell(parts, 17))") }
        let account = Text.canonicalIBAN(cell(parts, 0))
        return ParsedBankTransaction(
            day: day, bankAccount: account.isEmpty ? "KBC" : account,
            recipient: Text.uppercase(counterpartyName.isEmpty ? Text.cleanKbcRecipient(description) : counterpartyName),
            memo: description.isEmpty ? "" : Text.uppercase(description), amount: amount,
            currency: Text.isoCurrency(parts[3]), balance: balance.isNaN ? nil : balance,
            recipientAccount: orNil(counterpartyAccount), recipientAddress: orNil(cell(parts, 15)),
            recipientBankName: counterpartyAccount.isEmpty ? nil : "KBC", comment: Text.comment(comment),
            rawData: Text.rawData(record))
    }

    private static func kbc(_ bytes: [UInt8]) throws -> ParsedBankTransactions {
        let output = try Text.records(Text.decode(bytes), semicolonOptions)
        var parsed = ParsedBankTransactions(skipped: output.skipped)
        for record in output.records {
            let line = Text.trim(Text.rawData(record))
            if Text.hasPrefix(line, "Rekeningnummer") || Text.contains(line, "Vrije Mededeling")
                || Text.hasPrefix(line, String(repeating: ",", count: 35))
            {
                continue
            }
            if let row = kbcRow(record) { parsed.rows.append(row) } else { parsed.skipped = (parsed.skipped ?? 0) + 1 }
        }
        return parsed
    }

    // MARK: Revolut

    /// The fee to four places, without the zeros past the cents: `1.5000` is `1.50`.
    private static func revolutFee(_ fee: Double) -> String {
        var all = Text.units(JavaScriptNumber.toFixed(fee, 4))
        let count = all.count
        guard count >= 5, all[count - 5] == 0x2E, all[(count - 4)...].allSatisfy(Text.isDigit), all[count - 1] == 0x30
        else { return Text.text(all) }
        if all[count - 2] != 0x30 {
            all.removeLast()
        } else {
            all.removeLast(2)
        }
        return Text.text(all)
    }

    private static func revolutRow(_ record: CSVParse.Record) throws -> ParsedBankTransaction? {
        let parts = record.cells
        guard parts.count >= 10 else { return nil }
        let transactionType = cell(parts, 0)
        let product = cell(parts, 1)
        let completed = cell(parts, 3)
        let currencyCell = cell(parts, 7)
        let state = cell(parts, 8)
        let balanceText = cell(parts, 9)
        guard Text.same(upper(state), "COMPLETED"), !completed.isEmpty, let day = Text.flexibleDay(completed) else {
            return nil
        }
        let gross = Text.decimal(cell(parts, 5))
        if gross.isNaN { return nil }
        let feeValue = Text.decimal(cell(parts, 6))
        let fee = feeValue.isNaN ? 0 : feeValue
        var amount = gross
        if fee != 0 {
            // Past the finite numbers the difference is no amount at all: the row contract fails.
            guard gross.isFinite, fee.isFinite else { throw BankImportError.contract(adapter: Bank.revolut.rawValue) }
            amount = DecimalMoney.roundMoney(try DecimalJS(gross).minus(try DecimalJS(fee)))
        }
        let balance = balanceText.isEmpty ? Double.nan : Text.decimal(balanceText)
        var comment: [String] = []
        if !transactionType.isEmpty { comment.append("Type: \(transactionType)") }
        if !product.isEmpty { comment.append("Product: \(product)") }
        if fee > 0 { comment.append("Fee: \(revolutFee(fee)) \(currencyCell)") }
        if !state.isEmpty { comment.append("State: \(state)") }
        let productName = upper(product)
        return ParsedBankTransaction(
            day: day, bankAccount: Text.trim("REVOLUT \(productName)"),
            recipient: Text.uppercase(Text.cleanRecipient(cell(parts, 4))),
            memo: Text.uppercase("\(transactionType) - \(product)"), amount: amount,
            currency: Text.isoCurrency(currencyCell), balance: balance.isNaN ? nil : balance, recipientAccount: nil,
            recipientAddress: nil, recipientBankName: nil, comment: Text.comment(comment), rawData: Text.rawData(record))
    }

    private static func revolut(_ bytes: [UInt8]) throws -> ParsedBankTransactions {
        var options = CSVParse.Options()
        options.skipEmptyLines = true
        options.relaxColumnCount = true
        let output = try Text.records(Text.decode(bytes), options)
        var parsed = ParsedBankTransactions(skipped: 0, excluded: 0)
        for (index, record) in output.records.enumerated() {
            let parts = record.cells
            if index == 0, let first = parts.first, Text.same(Text.trim(first), "Type") { continue }
            if parts.count >= 10, !Text.same(upper(cell(parts, 8)), "COMPLETED") {
                parsed.skipped = (parsed.skipped ?? 0) + 1
                parsed.excluded = (parsed.excluded ?? 0) + 1
            } else if let row = try revolutRow(record) {
                parsed.rows.append(row)
            } else {
                parsed.skipped = (parsed.skipped ?? 0) + 1
            }
        }
        return parsed
    }

    // MARK: SABB

    private static let sabbNotCompleted = ["pending", "declin", "reject", "refus", "revers", "fail", "cancel"]

    private static func isASCIILetter(_ unit: UInt16) -> Bool {
        (unit >= 0x41 && unit <= 0x5A) || (unit >= 0x61 && unit <= 0x7A)
    }

    private static func sabbRow(_ record: CSVParse.Record) -> ParsedBankTransaction? {
        let status = field(record, "Status")
        if mentions(status, anyOf: sabbNotCompleted) { return nil }
        let dateText = Text.units(field(record, "Transaction date"))
        if dateText.isEmpty { return nil }
        // `/^\d{2}\/\d{2}\/\d{4}/`.
        let dayFirst =
            dateText.count >= 10
            && (0..<10).allSatisfy { $0 == 2 || $0 == 5 ? dateText[$0] == 0x2F : Text.isDigit(dateText[$0]) }
        guard let day = dayFirst ? Text.dayMonthYear(Text.text(dateText.prefix(10))) : Text.flexibleDay(Text.text(dateText))
        else { return nil }
        let amountRaw = field(record, "Amount(SAR)")
        if amountRaw.isEmpty { return nil }
        let rawUnits = Text.units(amountRaw)
        let amount = Text.amount(Text.text(rawUnits.filter { !isASCIILetter($0) && !Text.isSpace($0) }))
        if amount.isNaN { return nil }
        let description = field(record, "Description")
        var cleaned = Text.units(description)
        if cleaned.count >= 16, cleaned.prefix(16).allSatisfy(Text.isDigit) { cleaned.removeFirst(16) }
        let recipientText = Text.trim(Text.text(cleaned))
        var comment: [String] = []
        if !status.isEmpty { comment.append("Status: \(status)") }
        if !field(record, "Posting date").isEmpty { comment.append("Posting Date: \(field(record, "Posting date"))") }
        if !field(record, "Amount(Other Currency)").isEmpty {
            comment.append("Other Currency: \(field(record, "Amount(Other Currency)"))")
        }
        // `/[A-Z]{3}/`: the first three capitals in a row.
        var currency = "SAR"
        if rawUnits.count >= 3 {
            for start in 0...(rawUnits.count - 3)
            where rawUnits[start..<(start + 3)].allSatisfy({ $0 >= 0x41 && $0 <= 0x5A }) {
                currency = Text.text(rawUnits[start..<(start + 3)])
                break
            }
        }
        return ParsedBankTransaction(
            day: day, bankAccount: "SABB",
            recipient: recipientText.isEmpty ? "UNKNOWN" : Text.uppercase(Text.cleanRecipient(recipientText)),
            memo: description.isEmpty ? "" : Text.uppercase(description), amount: amount, currency: currency, balance: nil,
            recipientAccount: nil, recipientAddress: nil, recipientBankName: nil, comment: Text.comment(comment),
            rawData: Text.rawData(record))
    }

    private static func sabb(_ bytes: [UInt8]) throws -> ParsedBankTransactions {
        let output = try Text.records(Text.decode(bytes), namedColumnOptions)
        var parsed = ParsedBankTransactions(skipped: 0, excluded: 0)
        for record in output.records {
            if mentions(field(record, "Status"), anyOf: sabbNotCompleted) {
                parsed.skipped = (parsed.skipped ?? 0) + 1
                parsed.excluded = (parsed.excluded ?? 0) + 1
            } else if let row = sabbRow(record) {
                parsed.rows.append(row)
            } else {
                parsed.skipped = (parsed.skipped ?? 0) + 1
            }
        }
        return parsed
    }

    // MARK: Vision

    private struct VisionRowIssue: Error { let reason: String }

    private static func withoutApostrophes(_ text: String) -> String {
        Text.text(Text.units(text).filter { $0 != 0x27 })
    }

    private static func visionRow(_ record: CSVParse.Record) throws -> ParsedBankTransaction {
        let dateText = field(record, "Date")
        if dateText.isEmpty { throw VisionRowIssue(reason: "Date is required") }
        guard let day = Text.flexibleDay(dateText) else { throw VisionRowIssue(reason: "Date is invalid") }
        let amount = Text.amount(Text.trim(withoutApostrophes(record["Amount"] ?? "")))
        if !amount.isFinite { throw VisionRowIssue(reason: "Amount is invalid") }
        let accountCell = record["Bank Account"] ?? ""
        let recipient = field(record, "Recipient")
        let memoCell = record["Memo"] ?? ""
        let balanceText = Text.trim(withoutApostrophes(record["Balance"] ?? ""))
        let balance = balanceText.isEmpty ? Double.nan : Text.amount(balanceText)
        let category = field(record, "Category")
        var comment: [String] = []
        if !category.isEmpty { comment.append("Imported Category: \(category)") }
        if !field(record, "Comment").isEmpty { comment.append(field(record, "Comment")) }
        return ParsedBankTransaction(
            day: day, bankAccount: Text.uppercase(Text.trim(accountCell.isEmpty ? "VISION" : accountCell)),
            recipient: recipient.isEmpty ? "UNKNOWN" : Text.uppercase(Text.cleanRecipient(recipient)),
            memo: memoCell.isEmpty ? "" : Text.uppercase(Text.trim(memoCell)), amount: amount,
            currency: Text.isoCurrency(record["Currency"]) ?? "EUR", balance: balance.isNaN ? nil : balance,
            recipientAccount: nil, recipientAddress: nil, recipientBankName: nil, comment: Text.comment(comment),
            rawData: Text.rawData(record))
    }

    private static func vision(_ bytes: [UInt8]) throws -> ParsedBankTransactions {
        let output = try Text.records(Text.decode(bytes), namedColumnOptions)
        var parsed = ParsedBankTransactions(skipped: 0, issues: [])
        for (index, record) in output.records.enumerated() {
            do {
                parsed.rows.append(try visionRow(record))
            } catch let issue as VisionRowIssue {
                parsed.skipped = (parsed.skipped ?? 0) + 1
                if (parsed.issues?.count ?? 0) < 10 { parsed.issues?.append("Data row \(index + 1): \(issue.reason)") }
            }
        }
        return parsed
    }

    // MARK: Wise

    private static func wiseRow(_ record: CSVParse.Record) -> ParsedBankTransaction? {
        guard Text.same(upper(field(record, "Status")), "COMPLETED") else { return nil }
        let finished = record["Finished on"] ?? ""
        let dateText = Text.trim(finished.isEmpty ? record["Created on"] ?? "" : finished)
        guard !dateText.isEmpty, let day = Text.flexibleDay(dateText) else { return nil }
        let direction = upper(field(record, "Direction"))
        let targetAmount = field(record, "Target amount (after fees)")
        let sourceAmount = field(record, "Source amount (after fees)")
        let targetCurrency = upper(field(record, "Target currency"))
        let sourceCurrency = upper(field(record, "Source currency"))
        // An outgoing transfer books the side that left this account, any other the side that
        // arrived; the other side stands in when the preferred one is blank.
        let outgoing = Text.same(direction, "OUT")
        func preferred(_ source: String, _ target: String) -> String {
            let (first, second) = outgoing ? (source, target) : (target, source)
            return first.isEmpty ? second : first
        }
        let amountText = preferred(sourceAmount, targetAmount)
        if amountText.isEmpty { return nil }
        var amount = Text.amount(amountText)
        if amount.isNaN { return nil }
        if outgoing { amount = -abs(amount) } else if Text.same(direction, "IN") { amount = abs(amount) }
        let currencyText = preferred(sourceCurrency, targetCurrency)
        guard let currency = Text.isoCurrency(currencyText.isEmpty ? "USD" : currencyText) else { return nil }
        let targetName = field(record, "Target name")
        let sourceName = field(record, "Source name")
        let incoming = Text.same(direction, "IN")
        let firstName = incoming ? sourceName : targetName
        let recipient = firstName.isEmpty ? (incoming ? targetName : sourceName) : firstName
        let memoParts = [field(record, "Reference"), field(record, "Category"), field(record, "Note")]
            .filter { !$0.isEmpty }
        let identifier = field(record, "ID")
        let fee = field(record, "Source fee amount")
        let rate = field(record, "Exchange rate")
        var comment: [String] = []
        if !identifier.isEmpty { comment.append("ID: \(identifier)") }
        if !direction.isEmpty { comment.append("Direction: \(direction)") }
        if !fee.isEmpty, Text.parseFloat(fee) > 0 { comment.append("Fee: \(fee) \(field(record, "Source fee currency"))") }
        if !rate.isEmpty, Text.parseFloat(rate) > 0 { comment.append("Rate: \(rate)") }
        if !Text.same(sourceCurrency, targetCurrency), !sourceCurrency.isEmpty, !targetCurrency.isEmpty {
            comment.append("\(sourceAmount) \(sourceCurrency) → \(targetAmount) \(targetCurrency)")
        }
        if !field(record, "Batch").isEmpty { comment.append("Batch: \(field(record, "Batch"))") }
        return ParsedBankTransaction(
            day: day, bankAccount: "WISE \(currency)",
            recipient: recipient.isEmpty ? "UNKNOWN" : Text.uppercase(Text.cleanRecipient(recipient)),
            memo: Text.uppercase(memoParts.isEmpty ? "WISE TRANSFER" : memoParts.joined(separator: " - ")), amount: amount,
            currency: currency, balance: nil, recipientAccount: nil, recipientAddress: nil, recipientBankName: nil,
            comment: Text.comment(comment), rawData: Text.rawData(record), sourceReference: .some(orNil(identifier)))
    }

    private static func wise(_ bytes: [UInt8]) throws -> ParsedBankTransactions {
        let output = try Text.records(Text.decode(bytes), namedColumnOptions)
        var parsed = ParsedBankTransactions(skipped: 0, excluded: 0)
        for record in output.records {
            if !Text.same(upper(field(record, "Status")), "COMPLETED") {
                parsed.skipped = (parsed.skipped ?? 0) + 1
                parsed.excluded = (parsed.excluded ?? 0) + 1
            } else if let row = wiseRow(record) {
                parsed.rows.append(row)
            } else {
                parsed.skipped = (parsed.skipped ?? 0) + 1
            }
        }
        return parsed
    }

    // MARK: Generic

    private static func genericRow(
        _ record: CSVParse.Record, _ config: CustomBankParserConfig, format: Text.NumberFormat, bankAccount: String,
        rowNumber: Int
    ) throws -> ParsedBankTransaction? {
        let columns = config.columns
        let dateText = field(record, columns.date)
        guard !dateText.isEmpty, let day = Text.day(dateText, format: config.dateFormat ?? "") else { return nil }
        let amount = try Text.customAmount(
            record[columns.amount] ?? "", format, rowNumber: rowNumber, column: columns.amount)
        if amount.isNaN { return nil }
        func mapped(_ column: String?) -> String? { column.flatMap { $0.isEmpty ? nil : $0 } }
        var balance: Double?
        if let column = mapped(columns.balance) {
            let value = try Text.customAmount(record[column] ?? "", format, rowNumber: rowNumber, column: column)
            if !value.isNaN { balance = value }
        }
        return ParsedBankTransaction(
            day: day, bankAccount: bankAccount, recipient: field(record, columns.recipient),
            memo: mapped(columns.memo).map { field(record, $0) } ?? "", amount: amount,
            currency: mapped(columns.currency).flatMap { Text.isoCurrency(record[$0]) }, balance: balance,
            recipientAccount: nil, recipientAddress: nil, recipientBankName: nil, comment: nil,
            rawData: Text.rawData(record),
            sourceReference: .some(mapped(columns.sourceReference).flatMap { orNil(field(record, $0)) }))
    }

    private static func generic(_ bytes: [UInt8], _ config: CustomBankParserConfig) throws -> ParsedBankTransactions {
        let format = try Text.numberFormat(config.numberFormat)
        let dateFormat = config.dateFormat ?? ""
        guard Text.supportedDateFormats.contains(where: { Text.same($0, dateFormat) }) else {
            throw BankImportError.failed(
                "Unsupported date_format \"\(dateFormat)\". Supported: "
                    + Text.supportedDateFormats.joined(separator: ", "))
        }
        var options = CSVParse.Options()
        options.columns = .firstRecord
        options.skipEmptyLines = true
        options.delimiter = config.separator.flatMap { $0.isEmpty ? nil : $0 } ?? ","
        options.fromLine = config.skipRows + 1
        options.relaxColumnCount = true
        let content = Text.decode(bytes, try Text.encoding(config.encoding))
        let output = try Text.records(content, options)
        let bankName = config.bankName.flatMap { $0.isEmpty ? nil : $0 } ?? "CUSTOM"
        let accountType = config.accountType.flatMap { $0.isEmpty ? nil : $0 }
        let bankAccount = Text.uppercase(accountType.map { "\(bankName) \(upper($0))" } ?? bankName)
        var parsed = ParsedBankTransactions(skipped: 0)
        for (index, record) in output.records.enumerated() {
            if let row = try genericRow(record, config, format: format, bankAccount: bankAccount, rowNumber: index + 1) {
                parsed.rows.append(row)
            } else {
                parsed.skipped = (parsed.skipped ?? 0) + 1
            }
        }
        return parsed
    }
}
