import Foundation

/// Nexo "Transactions" export (`nexoTransactionHistoryAdapter.ts`). Fiat deposits and
/// withdrawals arrive as two lifecycle rows that are paired here; conversions between cash
/// and an asset become trades valued by the export's USD equivalent.
enum NexoStatement {
    private typealias Text = BankImportText
    private typealias Record = CSVParse.Record

    private static let requiredColumns = [
        "Transaction", "Type", "Input Currency", "Input Amount", "Output Currency", "Output Amount", "USD Equivalent",
        "Fee", "Fee Currency", "Details", "Date / Time (UTC)",
    ]
    private static let cashCodes: Set<String> = ["AUD", "CAD", "CHF", "EUR", "GBP", "JPY", "USD"]
    private static let adapter = PortfolioParserConfig.Format.nexoTransactionHistory
    /// Two lifecycle rows of one cash movement are at most this far apart.
    private static let pairWindowSeconds = 30.0 * 60

    private static func clean(_ record: Record, _ column: String) -> String { PortfolioAdapters.clean(record[column]) }
    private static func isCash(_ code: String) -> Bool { cashCodes.contains { Text.same($0, code) } }

    private static func magnitude(_ text: String) throws -> Double? {
        let text = Text.trim(text)
        if text.isEmpty { return nil }
        let value = try PortfolioAdapters.finite(Text.amount(text), adapter: adapter)
        return value.isNaN ? nil : abs(value)
    }

    private static func magnitude(_ record: Record, _ column: String) throws -> Double? {
        try magnitude(record[column] ?? "")
    }

    /// `feeAmount(value)`: blank or a dash is no fee; anything but a non-negative amount is nil.
    private static func feeAmount(_ record: Record) -> Double? {
        let text = clean(record, "Fee")
        if text.isEmpty || Text.same(text, "-") { return 0 }
        let value = Text.amount(text)
        return value.isFinite && value >= 0 ? value : nil
    }

    /// `assetCode(value)`: two to ten capitals or digits, else empty.
    private static func assetCode(_ value: String?) -> String {
        let code = JavaScriptCase.uppercased(PortfolioAdapters.clean(value))
        let all = Text.units(code)
        let fits = (2...10).contains(all.count) && all.allSatisfy { Text.isDigit($0) || ($0 >= 0x41 && $0 <= 0x5A) }
        return fits ? code : ""
    }

    private static func assetCode(_ record: Record, _ column: String) -> String { assetCode(record[column]) }

    /// `fiatCode(value)`: the cash currency a code names, also through its `X` wrapper (`EURX`).
    private static func fiatCode(_ value: String?) -> String? {
        let code = assetCode(value)
        if isCash(code) { return code }
        let all = Text.units(code)
        guard all.last == 0x58 else { return nil }
        let underlying = Text.text(all.dropLast())
        return isCash(underlying) ? underlying : nil
    }

    /// `/^word\b/i` on the Details cell.
    private static func details(_ record: Record, startWith word: String) -> Bool {
        let all = Text.units(clean(record, "Details"))
        let wanted = Text.units(word)
        func lowered(_ unit: UInt16) -> UInt16 { unit >= 0x41 && unit <= 0x5A ? unit + 0x20 : unit }
        guard all.count >= wanted.count, all.prefix(wanted.count).map(lowered) == wanted else { return false }
        guard all.count > wanted.count else { return true }
        let next = all[wanted.count]
        return !(Text.isDigit(next) || next == 0x5F || (next >= 0x41 && next <= 0x5A) || (next >= 0x61 && next <= 0x7A))
    }

    private static func isRejected(_ record: Record) -> Bool { details(record, startWith: "rejected") }
    private static func isApproved(_ record: Record) -> Bool { details(record, startWith: "approved") }

    private static func timeText(_ record: Record) -> String { clean(record, "Date / Time (UTC)") }

    /// `Date.parse` of the cell as `YYYY-MM-DDTHH:mm:ss[.sss]Z`, in seconds. Any other shape
    /// is left to the JavaScript engine in the TypeScript; here it is no time.
    private static func sourceTime(_ record: Record) -> Double? {
        let all = Text.units(Text.replacingFirst(timeText(record), " ", "T"))
        guard all.count >= 19, all[4] == 0x2D, all[7] == 0x2D, all[10] == 0x54, all[13] == 0x3A, all[16] == 0x3A else {
            return nil
        }
        func number(_ range: Range<Int>) -> Int? {
            all[range].allSatisfy(Text.isDigit) ? Int(Text.text(all[range])) : nil
        }
        var fraction = 0.0
        if all.count > 19 {
            let digits = all[20...]
            guard all[19] == 0x2E, (1...3).contains(digits.count), let value = Double("0." + Text.text(digits)),
                digits.allSatisfy(Text.isDigit)
            else { return nil }
            fraction = value
        }
        guard let year = number(0..<4), let month = number(5..<7), let day = number(8..<10), let hour = number(11..<13),
            let minute = number(14..<16), let second = number(17..<19), hour <= 23, minute <= 59, second <= 59,
            let dayNumber = Text.exactDay(year: Double(year), month: Double(month), day: Double(day)) ?? centuryDay(year, month, day)
        else { return nil }
        return Double(dayNumber) * 86_400 + Double(hour * 3600 + minute * 60 + second) + fraction
    }

    /// A four-digit year below 100 is a real year in an ISO date, where `Date.UTC` would not
    /// take it for one.
    private static func centuryDay(_ year: Int, _ month: Int, _ day: Int) -> Int? {
        guard (0...99).contains(year), (1...12).contains(month), day >= 1 else { return nil }
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
        guard day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] else { return nil }
        return ImportInterop.daysFromCivil(year: year, month: month, day: day)
    }

    private static let tolerance = try? DecimalJS("0.00000001")

    private static func equalAmount(_ left: Double?, _ right: Double?) throws -> Bool {
        guard let left, let right, let tolerance else { return false }
        return try DecimalJS(left).minus(try DecimalJS(right)).abs.lt(tolerance)
    }

    private static func isFiatWrapper(_ record: Record) -> Bool {
        guard let input = fiatCode(record["Input Currency"]), let output = fiatCode(record["Output Currency"]) else {
            return false
        }
        return Text.same(input, output)
            && !Text.same(assetCode(record, "Input Currency"), assetCode(record, "Output Currency"))
    }

    private static func isDepositToExchange(_ record: Record) -> Bool {
        Text.same(clean(record, "Type"), "Deposit To Exchange")
    }

    private static func companionMatches(_ primary: Record, _ companion: Record) throws -> Bool {
        guard isApproved(primary), isApproved(companion) else { return false }
        let deposit = isDepositToExchange(primary)
        guard Text.same(clean(companion, "Type"), deposit ? "Exchange Deposited On" : "Withdraw Exchanged"),
            let left = sourceTime(primary), let right = sourceTime(companion), abs(left - right) <= pairWindowSeconds,
            Text.units(timeText(primary)).prefix(10).elementsEqual(Text.units(timeText(companion)).prefix(10))
        else { return false }
        let fiat = fiatCode(primary["Input Currency"])
        func sameFiat(_ column: String) -> Bool {
            let other = fiatCode(companion[column])
            return (fiat == nil && other == nil) || (fiat.map { code in other.map { Text.same($0, code) } ?? false } ?? false)
        }
        guard sameFiat("Input Currency"), sameFiat("Output Currency") else { return false }
        let companionInput = try magnitude(companion, "Input Amount")
        let companionOutput = try magnitude(companion, "Output Amount")
        let primaryOutput = try magnitude(primary, "Output Amount")
        if deposit {
            return try equalAmount(try magnitude(primary, "Input Amount"), companionInput)
                && (try equalAmount(primaryOutput, companionOutput))
        }
        return try equalAmount(primaryOutput, companionInput) && (try equalAmount(primaryOutput, companionOutput))
    }

    private static func reference(_ record: Record, _ suffix: String = "") -> String? {
        let id = clean(record, "Transaction")
        return id.isEmpty ? nil : id + suffix
    }

    private static func base(_ record: Record) -> ParsedPortfolioRow {
        ParsedPortfolioRow(
            day: Text.day(timeText(record), format: "%Y-%m-%d %H:%M:%S"), note: clean(record, "Details"),
            rawData: Text.rawData(record), sourceReference: reference(record))
    }

    private static func unsupported(_ record: Record, _ reason: String) throws -> ParsedPortfolioRow {
        let type = clean(record, "Type")
        var row = base(record)
        row.typeRaw = "Unsupported Nexo event: \(type.isEmpty ? "unknown" : type)"
        row.symbolRaw = assetCode(record, "Input Currency")
        row.units = try magnitude(record, "Input Amount")
        row.amount = try magnitude(record, "USD Equivalent")
        row.currency = "USD"
        row.note = reason
        return row
    }

    private static func fiatWrapper(_ record: Record, companion: Record) throws -> [ParsedPortfolioRow] {
        let fiat = fiatCode(record["Input Currency"])
        let provenance = Text.rawData(record) + "\n" + Text.rawData(companion)
        func refused(_ reason: String) throws -> [ParsedPortfolioRow] {
            var row = try unsupported(record, reason)
            row.rawData = provenance
            return [row]
        }
        guard let fee = feeAmount(record) else { return try refused("Nexo cash movement fee is not a valid amount") }
        if fee != 0 {
            let feeFiat = fiatCode(record["Fee Currency"])
            guard let fiat, let feeFiat, Text.same(fiat, feeFiat) else {
                return try refused("Nexo cash movement fee is not in the underlying fiat currency")
            }
        }
        let deposit = isDepositToExchange(record)
        let input = try magnitude(record, "Input Amount")
        let output = try magnitude(record, "Output Amount")
        var reconciles = false
        if let amount = deposit ? input : output, amount != 0 {
            if deposit {
                if let output { reconciles = try output == 0 || equalAmount(input, output) }
            } else if let input, let tolerance {
                reconciles = !(try DecimalJS(input).minus(try DecimalJS(amount)).minus(try DecimalJS(fee)).abs.gt(tolerance))
            }
        }
        guard reconciles, let amount = deposit ? input : output else {
            return try refused("Nexo cash principal and fee do not reconcile")
        }
        var movement = base(record)
        movement.typeRaw = deposit ? "Deposit" : "Withdrawal"
        movement.amount = amount
        movement.currency = fiat
        movement.note = deposit ? "Nexo fiat deposit" : "Nexo fiat withdrawal"
        movement.rawData = provenance
        if fee == 0 { return [movement] }
        var charge = base(record)
        charge.typeRaw = "Fee"
        charge.amount = fee
        charge.currency = fiat
        charge.note = "Nexo fiat movement fee"
        charge.sourceReference = reference(record, ":fee")
        charge.rawData = provenance
        return [movement, charge]
    }

    private static func trade(_ record: Record) throws -> ParsedPortfolioRow {
        let inputCode = assetCode(record, "Input Currency")
        let outputCode = assetCode(record, "Output Currency")
        guard let inputUnits = try magnitude(record, "Input Amount"),
            let outputUnits = try magnitude(record, "Output Amount"), let value = try magnitude(record, "USD Equivalent"),
            !inputCode.isEmpty, !outputCode.isEmpty, !Text.same(inputCode, outputCode), inputUnits != 0, outputUnits != 0,
            value != 0
        else {
            return try unsupported(
                record, "Nexo conversion is missing a distinct asset pair, units, or USD valuation")
        }
        let buying = isCash(inputCode)
        if buying == isCash(outputCode) {
            return try unsupported(record, "Nexo conversion has no unambiguous cash-like portfolio side")
        }
        let units = buying ? outputUnits : inputUnits
        let feeCurrency = assetCode(record, "Fee Currency")
        let fee = try magnitude(record, "Fee")
        let feeInDollars = Text.same(feeCurrency, "USD")
        if let fee, fee != 0, !feeInDollars {
            return try unsupported(
                record,
                "Nexo conversion fee in \(feeCurrency.isEmpty ? "an unknown currency" : feeCurrency) cannot be valued safely"
            )
        }
        var row = base(record)
        row.typeRaw = buying ? "Buy" : "Sell"
        row.symbolRaw = buying ? outputCode : inputCode
        row.units = units
        row.pricePerUnit = try DecimalJS(value).dividedBy(try DecimalJS(units)).toNumber
        row.amount = value
        row.fees = feeInDollars ? fee : nil
        row.currency = "USD"
        row.note = "Nexo conversion \(inputCode)/\(outputCode)"
        return row
    }

    private static func interest(_ record: Record) throws -> [ParsedPortfolioRow]? {
        let symbol = assetCode(record, "Output Currency")
        let units = try magnitude(record, "Output Amount")
        if let fiat = fiatCode(symbol) {
            let inputFiat = fiatCode(record["Input Currency"])
            guard isApproved(record), let inputFiat, Text.same(inputFiat, fiat), let units, units != 0,
                try equalAmount(try magnitude(record, "Input Amount"), units), feeAmount(record) == 0
            else {
                return [
                    try unsupported(record, "Nexo fiat interest has unresolved approval, principal, or fee evidence")
                ]
            }
            var row = base(record)
            row.typeRaw = "Interest"
            row.amount = units
            row.currency = fiat
            row.note = "Nexo fiat interest income"
            row.sourceReference = reference(record, ":income")
            return [row]
        }
        guard let value = try magnitude(record, "USD Equivalent"), !symbol.isEmpty, let units, units != 0, value != 0
        else { return nil }
        var income = base(record)
        income.typeRaw = "Interest"
        income.symbolRaw = symbol
        income.amount = value
        income.currency = "USD"
        income.note = "Nexo interest income"
        income.sourceReference = reference(record, ":income")
        var received = base(record)
        received.typeRaw = "Gift"
        received.symbolRaw = symbol
        received.units = units
        received.pricePerUnit = try DecimalJS(value).dividedBy(try DecimalJS(units)).toNumber
        received.amount = value
        received.currency = "USD"
        received.note = "Nexo interest units"
        received.sourceReference = reference(record, ":units")
        return [income, received]
    }

    private static func topUp(_ record: Record, origin: Double?) throws -> ParsedPortfolioRow? {
        let symbol = assetCode(record, "Output Currency")
        guard let units = try magnitude(record, "Output Amount"), !symbol.isEmpty, units != 0 else { return nil }
        var row = base(record)
        row.symbolRaw = symbol
        row.units = units
        row.amount = 0
        if let origin, origin > 0, origin == origin.rounded(), origin.isFinite {
            guard isApproved(record), feeAmount(record) == 0 else {
                return try unsupported(record, "Nexo incoming asset transfer has unresolved approval or fee evidence")
            }
            row.typeRaw = "AssetTransfer"
            row.fees = 0
            row.taxes = 0
            row.note =
                "Nexo internal asset transfer in; original acquisition basis is carried from the configured origin"
            row.assetTransfer = .init(
                direction: .incoming, basisStatus: .carried, feeUnits: "0", receivedUnits: JavaScriptNumber.text(units))
            return row
        }
        row.typeRaw = "Gift"
        row.note = "Nexo asset transfer in; original cost basis unavailable"
        row.assetTransfer = .init(direction: .incoming, basisStatus: .unresolved)
        return row
    }

    private static func proMovement(_ record: Record) throws -> ParsedPortfolioRow {
        let input = try magnitude(record, "Input Amount")
        guard isApproved(record), Text.same(assetCode(record, "Input Currency"), assetCode(record, "Output Currency")),
            (input ?? 0) != 0, try equalAmount(input, try magnitude(record, "Output Amount")), feeAmount(record) == 0
        else {
            return try unsupported(
                record, "Nexo Pro wallet movement has unresolved status, currency, units, or fees")
        }
        var row = base(record)
        row.typeRaw = "InternalMovement"
        row.amount = 0
        row.note =
            "Movement between Nexo Wallet and Pro within the same Vision account; Pro execution history is required"
        row.assetTransfer = .init(direction: .internal, basisStatus: .notApplicable)
        return row
    }

    private static func assetWithdrawal(_ record: Record) throws -> ParsedPortfolioRow {
        let symbol = assetCode(record, "Input Currency")
        guard let gross = try magnitude(record, "Input Amount"), let received = try magnitude(record, "Output Amount"),
            let fee = feeAmount(record), !symbol.isEmpty, Text.same(symbol, assetCode(record, "Output Currency")),
            gross != 0, received != 0, !(fee > 0 && !Text.same(assetCode(record, "Fee Currency"), symbol)),
            try DecimalJS(gross).eq(try DecimalJS(received).plus(try DecimalJS(fee)))
        else { return try unsupported(record, "Nexo asset withdrawal has unresolved units or fee currency") }
        var row = base(record)
        row.typeRaw = "AssetTransfer"
        row.symbolRaw = symbol
        row.units = gross
        row.amount = 0
        row.fees = 0
        row.taxes = 0
        row.note = "Nexo internal asset transfer"
        row.assetTransfer = .init(
            direction: .outgoing, basisStatus: .carried, feeUnits: JavaScriptNumber.text(fee),
            receivedUnits: JavaScriptNumber.text(received))
        return row
    }

    static func parse(_ bytes: [UInt8], _ config: PortfolioParserConfig) throws -> ParsedPortfolioRows {
        let records = try Text.records(try PortfolioAdapters.decoded(bytes, config), PortfolioAdapters.options()).records
        guard let first = records.first else { throw StatementImportError.failed("Nexo transaction history is empty") }
        let missing = requiredColumns.filter { !PortfolioAdapters.has(first, $0) }
        if !missing.isEmpty {
            throw StatementImportError.failed(
                "Nexo transaction history is missing columns: \(missing.joined(separator: ", "))")
        }
        func type(_ index: Int) -> String { clean(records[index], "Type") }
        func isExchange(_ index: Int) -> Bool {
            Text.same(type(index), "Deposit To Exchange") || Text.same(type(index), "Exchange To Withdraw")
        }
        let primaries = records.indices.filter { isExchange($0) && isFiatWrapper(records[$0]) && !isRejected(records[$0]) }
        var companions: [Int: Int] = [:]
        for primary in primaries {
            let matches = try records.indices.filter { try companionMatches(records[primary], records[$0]) }
            guard matches.count == 1, let companion = matches.first,
                try primaries.filter({ try companionMatches(records[$0], records[companion]) }).count == 1
            else { continue }
            companions[primary] = companion
        }
        let consumed = Set(companions.values)
        var parsed = ParsedPortfolioRows(skipped: 0)
        func skip() { parsed.skipped = (parsed.skipped ?? 0) + 1 }
        for index in records.indices {
            let record = records[index]
            if isRejected(record) || consumed.contains(index) {
                skip()
                continue
            }
            let kind = type(index)
            if let companion = companions[index] {
                parsed.rows += try fiatWrapper(record, companion: records[companion])
            } else if primaries.contains(index) {
                parsed.rows.append(
                    try unsupported(record, "Nexo fiat movement has no unique approved lifecycle companion"))
            } else if Text.same(kind, "Transfer From Pro Wallet") || Text.same(kind, "Transfer To Pro Wallet") {
                parsed.rows.append(try proMovement(record))
            } else if Text.same(kind, "Exchange Deposited On") || Text.same(kind, "Withdraw Exchanged") {
                parsed.rows.append(
                    try unsupported(record, "Nexo lifecycle or internal-transfer row requires explicit pairing review"))
            } else if isExchange(index) {
                parsed.rows.append(try trade(record))
            } else if Text.same(kind, "Interest") {
                if let rows = try interest(record) { parsed.rows += rows } else { skip() }
            } else if Text.same(kind, "Top up Crypto") {
                if let row = try topUp(record, origin: config.transferOriginAccount) { parsed.rows.append(row) } else { skip() }
            } else if Text.same(kind, "Withdrawal") {
                parsed.rows.append(try assetWithdrawal(record))
            } else {
                parsed.rows.append(try unsupported(record, "Unsupported Nexo transaction type"))
            }
        }
        return parsed
    }
}

/// Nexo Pro "Spot order history" (`nexoProTransactionHistoryAdapter.ts`): one row per order.
/// Only a final, filled order against a fiat quote becomes a trade; the arithmetic is exact
/// decimal, so the staged values are the export's own.
enum NexoProSpotHistory {
    private typealias Text = BankImportText
    private typealias Record = CSVParse.Record

    private static let requiredColumns = [
        "id", "timestamp", "pair", "side", "type", "price", "executedPrice", "triggerPrice", "requestedAmount",
        "filledAmount", "tradingFee", "feeCurrency", "status", "orderId",
    ]
    private static let fiatQuotes: Set<String> = ["AUD", "CAD", "CHF", "EUR", "GBP", "JPY", "USD"]
    private static let orderTypes = [
        "limit", "market", "stop_limit", "stop_market", "stop-limit", "stop-market", "stoploss",
    ]
    /// Cells this far outside the double range cannot end in a staged fill; refusing them
    /// first keeps the exact arithmetic small. Unverified corner: decimal.js would take the
    /// order through the checks before this one.
    private static let exponentLimit = 5000

    private static func text(_ record: Record, _ column: String) -> String { PortfolioAdapters.clean(record[column]) }
    private static func isFiat(_ code: String) -> Bool { fiatQuotes.contains { Text.same($0, code) } }

    /// `/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/` read as an exact decimal.
    private static func decimal(_ text: String) -> DecimalJS? {
        var rest = Text.units(text)[...]
        let whole = rest.prefix(while: Text.isDigit)
        rest = rest.dropFirst(whole.count)
        var fraction: ArraySlice<UInt16> = []
        if rest.first == 0x2E {
            fraction = rest.dropFirst().prefix(while: Text.isDigit)
            rest = rest.dropFirst(1 + fraction.count)
            if whole.isEmpty, fraction.isEmpty { return nil }
        } else if whole.isEmpty {
            return nil
        }
        if let mark = rest.first, mark == 0x65 || mark == 0x45 {
            var digits = rest.dropFirst()
            if let sign = digits.first, sign == 0x2B || sign == 0x2D { digits = digits.dropFirst() }
            guard !digits.isEmpty, digits.allSatisfy(Text.isDigit), digits.count <= 9 else { return nil }
            rest = []
        }
        guard rest.isEmpty else { return nil }
        return try? DecimalJS(text)
    }

    private static func withinReach(_ value: DecimalJS) -> Bool {
        value.isZero || Swift.abs(value.exponent + value.coefficient.digitCount) <= exponentLimit
    }

    private static func representable(_ value: DecimalJS) -> Bool {
        let number = value.toNumber
        return number.isFinite && (value.isZero || number != 0)
    }

    /// `exportedDate(record)`: `YYYY-MM-DD[ T]hh:mm:ss[.fraction][Z]` on a real day.
    private static func day(_ record: Record) -> Int? {
        var all = Text.units(text(record, "timestamp"))[...]
        if all.last == 0x5A { all = all.dropLast() }
        guard all.count >= 19, all[all.startIndex + 10] == 0x20 || all[all.startIndex + 10] == 0x54,
            all[all.startIndex + 13] == 0x3A, all[all.startIndex + 16] == 0x3A
        else { return nil }
        func number(_ offset: Int) -> Int? {
            let pair = all[(all.startIndex + offset)..<(all.startIndex + offset + 2)]
            return pair.allSatisfy(Text.isDigit) ? Int(Text.text(pair)) : nil
        }
        let fraction = all.dropFirst(19)
        if !fraction.isEmpty {
            guard fraction.first == 0x2E, (2...10).contains(fraction.count), fraction.dropFirst().allSatisfy(Text.isDigit)
            else { return nil }
        }
        let date = all.prefix(10)
        guard let hour = number(11), let minute = number(14), let second = number(17), hour <= 23, minute <= 59,
            second <= 59, date.enumerated().allSatisfy({ $0.offset == 4 || $0.offset == 7 ? $0.element == 0x2D : Text.isDigit($0.element) })
        else { return nil }
        return Text.day(Text.text(date), format: "%Y-%m-%d")
    }

    /// `pair(record)`: `BASE/QUOTE`, each two to twelve capitals or digits.
    private static func pair(_ record: Record) -> (base: String, quote: String)? {
        let parts = Text.split(JavaScriptCase.uppercased(text(record, "pair")), "/")
        func fits(_ code: String) -> Bool {
            let all = Text.units(code)
            return (2...12).contains(all.count) && all.allSatisfy { Text.isDigit($0) || ($0 >= 0x41 && $0 <= 0x5A) }
        }
        guard parts.count == 2, fits(parts[0]), fits(parts[1]) else { return nil }
        return (parts[0], parts[1])
    }

    private static func base(_ record: Record) -> ParsedPortfolioRow {
        let instrument = pair(record)
        let order = text(record, "orderId")
        return ParsedPortfolioRow(
            day: day(record), typeRaw: "Unsupported Nexo Pro Spot order", symbolRaw: instrument?.base ?? "",
            currency: instrument.flatMap { isFiat($0.quote) ? $0.quote : nil }, rawData: Text.rawData(record),
            sourceReference: order.isEmpty ? nil : "nexo-pro:spot:order:\(order)")
    }

    private static func row(_ record: Record) -> ParsedPortfolioRow? {
        func refused(_ reason: String) -> ParsedPortfolioRow {
            var row = base(record)
            row.note = reason
            return row
        }
        func cell(_ column: String) -> DecimalJS? {
            let value = text(record, column)
            return value.isEmpty ? .zero : decimal(value)
        }
        let status = JavaScriptCase.lowercased(text(record, "status"))
        guard let filled = cell("filledAmount"), let fee = cell("tradingFee"), let execution = cell("executedPrice") else {
            return refused("Nexo Pro Spot order contains an invalid fill quantity, execution price, or fee")
        }
        let cancelled = Text.same(status, "cancelled") || Text.same(status, "canceled")
        if cancelled, filled.isZero {
            if !fee.isZero || !execution.isZero {
                return refused("Nexo Pro Spot cancelled order has fees or an execution price without any fill")
            }
            return nil
        }
        guard cancelled || Text.same(status, "completed") else {
            return refused("Nexo Pro Spot order is not final; a later export may contain more fills")
        }
        if filled.isZero || execution.isZero || text(record, "filledAmount").isEmpty
            || text(record, "executedPrice").isEmpty || text(record, "tradingFee").isEmpty
        {
            return refused("Nexo Pro Spot final order is missing a filled quantity, execution price, or explicit fee")
        }
        let orderType = JavaScriptCase.lowercased(text(record, "type"))
        guard orderTypes.contains(where: { Text.same($0, orderType) }) else {
            return refused("Nexo Pro Spot order type is unsupported")
        }
        let side = JavaScriptCase.lowercased(text(record, "side"))
        let buying = Text.same(side, "buy")
        guard buying || Text.same(side, "sell") else { return refused("Nexo Pro Spot order side must be buy or sell") }
        guard let instrument = pair(record), !Text.same(instrument.base, instrument.quote), !isFiat(instrument.base) else {
            return refused("Nexo Pro Spot order has no unambiguous asset and fiat quote pair")
        }
        guard isFiat(instrument.quote) else {
            return refused("Nexo Pro Spot crypto-quoted fills require a separate valuation and asset-leg contract")
        }
        let feeCurrency = JavaScriptCase.uppercased(text(record, "feeCurrency"))
        let feeInBase = Text.same(feeCurrency, instrument.base)
        if !fee.isZero, !feeInBase, !Text.same(feeCurrency, instrument.quote) {
            return refused("Nexo Pro Spot fee in a third asset cannot be valued from this export")
        }
        let limits = "Nexo Pro Spot execution exceeds supported numeric limits"
        guard withinReach(filled), withinReach(fee), withinReach(execution) else { return refused(limits) }
        var units = filled
        var quoteFee = fee
        if feeInBase {
            quoteFee = fee.times(execution)
            units = buying ? filled.minus(fee) : filled.plus(fee)
            if units.lte(.zero) { return refused("Nexo Pro Spot base-asset fee consumes the entire filled quantity") }
        }
        let amount = units.times(execution)
        if !buying, quoteFee.gt(amount) { return refused("Nexo Pro Spot sell fee exceeds its gross quote proceeds") }
        guard [units, execution, amount, quoteFee].allSatisfy(representable) else { return refused(limits) }
        var row = base(record)
        row.typeRaw = buying ? "Buy" : "Sell"
        row.units = units.toNumber
        row.pricePerUnit = execution.toNumber
        row.amount = amount.toNumber
        row.fees = quoteFee.toNumber
        row.taxes = 0
        row.currency = instrument.quote
        row.note = "Nexo Pro Spot filled order; source timestamp retained in provenance"
        return row
    }

    static func parse(_ bytes: [UInt8], _ config: PortfolioParserConfig) throws -> ParsedPortfolioRows {
        var options = CSVParse.Options()
        options.skipEmptyLines = true
        options.columns = .renamed { headers in
            let names = headers.map(Text.trim)
            let missing = requiredColumns.filter { wanted in !names.contains { Text.same($0, wanted) } }
            if !missing.isEmpty {
                throw StatementImportError.validation(
                    "Nexo Pro Spot history is missing columns: \(missing.joined(separator: ", "))")
            }
            for (index, name) in names.enumerated() where names[..<index].contains(where: { Text.same($0, name) }) {
                throw StatementImportError.validation("Nexo Pro Spot history contains duplicate column names")
            }
            guard names.count == requiredColumns.count, zip(names, requiredColumns).allSatisfy({ Text.same($0, $1) }) else {
                throw StatementImportError.validation(
                    "Nexo Pro Spot history has an unsupported column order or schema extension")
            }
            return names
        }
        let output = try Text.records(try PortfolioAdapters.decoded(bytes, config), options)
        guard output.columns != nil else {
            throw StatementImportError.validation("Nexo Pro Spot history is missing its CSV header")
        }
        var parsed = ParsedPortfolioRows(skipped: 0)
        var orders: [String] = []
        for (index, record) in output.records.enumerated() {
            guard day(record) != nil else {
                throw StatementImportError.validation("Nexo Pro Spot row \(index + 2) has an invalid timestamp")
            }
            let order = text(record, "orderId")
            guard !order.isEmpty, !orders.contains(where: { Text.same($0, order) }) else {
                throw StatementImportError.validation(
                    "Nexo Pro Spot row \(index + 2) has a missing or duplicate order identifier")
            }
            orders.append(order)
            if let row = row(record) { parsed.rows.append(row) } else { parsed.skipped = (parsed.skipped ?? 0) + 1 }
        }
        return parsed
    }
}

/// Saxo "Transacties" CSV export (`saxoTransactionHistoryAdapter.ts`). Whether the file writes
/// a decimal point or comma is read from the cells that have only one reading; a number
/// that reads both ways with nothing to settle it makes its row unsupported.
enum SaxoStatement {
    typealias Text = BankImportText
    typealias Format = BankImportText.NumberFormat

    /// Where a workbook record came from, kept for its provenance envelope.
    struct Origin: Equatable, Sendable {
        var sheet: String
        var row: Int
        var headers: [XLSXCell?]
        var cells: [XLSXCell?]
        var sourceFileHash: String
    }

    /// One Saxo record by column name: the text cells of a CSV line or the typed cells of a
    /// workbook row.
    struct Record: Sendable {
        var cells: [String: XLSXCell]
        var line: CSVParse.Record?
        var origin: Origin?

        subscript(column: String) -> XLSXCell? { cells[column] }
    }

    static let requiredColumns = [
        "Transactiedatum", "Rekening-ID", "Transactie-ID", "Bk Record Id", "Booking Id", "Transactietype", "Acties",
        "Boekingsbedrag", "Valuta", "Omrekeningskoers", "Totale kosten", "Instrument", "Instrumentsymbool",
        "Instrument ISIN", "Instrumentvaluta",
    ]
    private static let numberColumns = ["Boekingsbedrag", "Omrekeningskoers", "Totale kosten", "Conversion cost"]

    struct AmbiguousNumber: Error {
        let text: String
        var message: String {
            "Saxo number \(text) reads differently with a decimal point or comma, and the file does not show which it uses"
        }
    }

    struct TradeAction {
        let buying: Bool
        let quantity: String
        let price: String
        let currency: String?
    }

    /// `String(date)` in the machine's time zone, as the engine writes it.
    static func dateText(_ time: Double) -> String {
        guard !time.isNaN else { return "Invalid Date" }
        let zone = TimeZone.current
        let moment = Date(timeIntervalSince1970: time / 1000)
        let offset = zone.secondsFromGMT(for: moment)
        let local = (time / 1000).rounded(.down) + Double(offset)
        let days = Int((local / 86_400).rounded(.down))
        let seconds = Int(local - Double(days) * 86_400)
        let civil = XLSXWorkbook.civil(fromDays: days)
        let weekday = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"][((days % 7) + 7) % 7]
        let month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][civil.month - 1]
        func pad(_ value: Int, _ width: Int = 2) -> String {
            let digits = String(abs(value))
            return (value < 0 ? "-" : "") + String(repeating: "0", count: max(0, width - digits.count)) + digits
        }
        let minutes = abs(offset) / 60
        let name: String
        if offset == 0, ["UTC", "GMT", "Etc/UTC", "Etc/GMT"].contains(zone.identifier) {
            name = "Coordinated Universal Time"
        } else {
            name =
                zone.localizedName(
                    for: zone.isDaylightSavingTime(for: moment) ? .daylightSaving : .standard,
                    locale: Locale(identifier: "en_US")) ?? zone.identifier
        }
        return "\(weekday) \(month) \(pad(civil.day)) \(pad(civil.year, 4)) \(pad(seconds / 3600)):\(pad(seconds / 60 % 60)):\(pad(seconds % 60))"
            + " GMT\(offset < 0 ? "-" : "+")\(pad(minutes / 60))\(pad(minutes % 60)) (\(name))"
    }

    /// `cleanCell(value)`: a number as its trimmed raw text, anything else as `String(value)`
    /// trimmed, a missing cell as nothing.
    static func clean(_ cell: XLSXCell?) -> String {
        switch cell {
        case nil: return ""
        case .text(let text): return Text.trim(text)
        case .number(let raw): return Text.trim(raw)
        case .boolean(let value): return value ? "true" : "false"
        case .date(let time): return dateText(time)
        }
    }

    static func clean(_ record: Record, _ column: String) -> String { clean(record[column]) }

    /// `normalizeHeader(value)`: trimmed, with no-break spaces as plain ones.
    static func header(_ value: String) -> String {
        Text.text(Text.units(Text.trim(value)).map { $0 == 0xA0 ? 0x20 : $0 })
    }

    private static func isASCIILetter(_ unit: UInt16) -> Bool {
        (unit >= 0x41 && unit <= 0x5A) || (unit >= 0x61 && unit <= 0x7A)
    }

    /// `/^(Koop|Verkoop|Buy|Sell)\s+([+-]?[\d.,]+)\s+@\s+([+-]?[\d.,]+)(?:\s+([A-Z]{3}))?$/i`.
    static func tradeAction(_ text: String) -> TradeAction? {
        var rest = Text.units(text)[...]
        func spaces() -> Bool {
            let run = rest.prefix(while: Text.isSpace)
            rest = rest.dropFirst(run.count)
            return !run.isEmpty
        }
        func number() -> String? {
            var token = rest.prefix(1).filter { $0 == 0x2B || $0 == 0x2D }
            let digits = rest.dropFirst(token.count).prefix { Text.isDigit($0) || $0 == 0x2E || $0 == 0x2C }
            guard !digits.isEmpty else { return nil }
            token += digits
            rest = rest.dropFirst(token.count)
            return Text.text(token)
        }
        let word = rest.prefix(while: isASCIILetter)
        let verb = Text.text(word.map { $0 >= 0x41 && $0 <= 0x5A ? $0 + 0x20 : $0 })
        guard ["koop", "verkoop", "buy", "sell"].contains(verb) else { return nil }
        rest = rest.dropFirst(word.count)
        guard spaces(), let quantity = number(), spaces(), rest.first == 0x40 else { return nil }
        rest = rest.dropFirst()
        guard spaces(), let price = number() else { return nil }
        var currency: String?
        if !rest.isEmpty {
            guard spaces(), rest.count == 3, rest.allSatisfy(isASCIILetter) else { return nil }
            currency = Text.text(rest)
        }
        return TradeAction(buying: verb == "koop" || verb == "buy", quantity: quantity, price: price, currency: currency)
    }

    /// The convention a cell proves by reading as a number in only one of them.
    private static func evidence(_ text: String) -> Format? {
        let dot = IbkrStatementNumber.customAmount(text, .decimalDot).isFinite
        let comma = IbkrStatementNumber.customAmount(text, .decimalComma).isFinite
        return dot == comma ? nil : (dot ? .decimalDot : .decimalComma)
    }

    private static func fileFormat(_ records: [Record]) -> Format? {
        var found: Set<Format> = []
        for record in records {
            var texts = numberColumns.map { clean(record, $0) }
            if let action = tradeAction(clean(record, "Acties")) { texts += [action.quantity, action.price] }
            for text in texts where !text.isEmpty {
                if let proof = evidence(text) { found.insert(proof) }
            }
        }
        return found.count == 1 ? found.first : nil
    }

    /// `number(value, format)`: a Saxo number in the export's own convention. A workbook
    /// number is typed and always uses a dot. Without a convention, a text that reads
    /// differently with either separator is ambiguous.
    static func number(_ value: XLSXCell?, _ format: Format? = nil) throws -> Double? {
        let text = clean(value)
        if text.isEmpty { return nil }
        if case .number = value {
            let parsed = IbkrStatementNumber.customAmount(text, .decimalDot)
            return parsed.isFinite ? parsed : nil
        }
        do {
            let parsed = try Text.customAmount(text, format ?? .auto)
            return parsed.isFinite ? parsed : nil
        } catch is StatementImportError {
            throw AmbiguousNumber(text: text)
        }
    }

    static func magnitude(_ value: XLSXCell?, _ format: Format? = nil) throws -> Double? {
        try number(value, format).map(abs)
    }

    private static func magnitude(_ text: String, _ format: Format?) throws -> Double? {
        try magnitude(.text(text), format)
    }

    static func currency(_ value: XLSXCell?) -> String? {
        let code = JavaScriptCase.uppercased(clean(value))
        return Text.isoCurrency(code).flatMap { Text.same($0, code) ? $0 : nil }
    }

    private static func reference(_ record: Record) -> String? {
        for column in ["Bk Record Id", "Transactie-ID", "Booking Id"] {
            let text = clean(record, column)
            if !text.isEmpty, !Text.units(text).allSatisfy({ $0 == 0x30 }) { return text }
        }
        return nil
    }

    /// `date(record)`: a workbook date as its UTC calendar day, a text as `YYYY-MM-DD` with
    /// either `-` or `/`.
    private static func day(_ record: Record) -> Int? {
        if case .date(let time)? = record["Transactiedatum"] {
            guard !time.isNaN else { return nil }
            let days = Int((time / 86_400_000).rounded(.down))
            // `Date.UTC` reads a year from 0 to 99 as 1900 to 1999.
            let civil = XLSXWorkbook.civil(fromDays: days)
            guard (0...99).contains(civil.year) else { return days }
            return XLSXWorkbook.days(fromCivil: civil.year + 1900, civil.month, 1) + civil.day - 1
        }
        let date = Text.text(Text.units(clean(record, "Transactiedatum")).map { $0 == 0x2F ? 0x2D : $0 })
        return Text.day(date, format: "%Y-%m-%d")
    }

    private static func base(_ record: Record) throws -> ParsedPortfolioRow {
        let account = clean(record, "Rekening-ID")
        return ParsedPortfolioRow(
            day: day(record),
            symbolRaw: Text.trim(Text.split(clean(record, "Instrumentsymbool"), ":").first ?? ""),
            nameRaw: clean(record, "Instrument"), currency: currency(record["Valuta"]), note: clean(record, "Opmerking"),
            rawData: try record.origin != nil ? provenance([record]) : (record.line.map(Text.rawData) ?? ""),
            sourceAccountIdentity: account.isEmpty ? nil : account,
            sourceReference: reference(record))
    }

    private static func unsupported(_ record: Record, _ reason: String) throws -> ParsedPortfolioRow {
        let action = clean(record, "Acties")
        let kind = clean(record, "Transactietype")
        var row = try base(record)
        row.typeRaw = "Unsupported Saxo event: \(action.isEmpty ? (kind.isEmpty ? "unknown" : kind) : action)"
        do { row.amount = try magnitude(record["Boekingsbedrag"]) } catch is AmbiguousNumber { row.amount = nil }
        row.note = reason
        return row
    }

    /// Units × price × rate must explain the booked amount within the costs plus 1 % (at
    /// least 1); without a booked amount or a rate nothing can be compared.
    private static func bookedValueAgrees(
        _ record: Record, units: Double, price: Double, instrumentCurrency: String, _ format: Format?  // lint:allow raw-currency statement cell text, compared as written
    ) throws -> Bool {
        let booked = try magnitude(record["Boekingsbedrag"], format)
        let sameCurrency = currency(record["Valuta"]).map { Text.same($0, instrumentCurrency) } ?? false
        let rate = sameCurrency ? 1 : try magnitude(record["Omrekeningskoers"], format)
        guard let booked, booked != 0, let rate, rate != 0 else { return true }
        let costs = try DecimalJS(try magnitude(record["Totale kosten"], format) ?? 0)
        let value = try DecimalJS(units).times(try DecimalJS(price)).times(try DecimalJS(rate))
        let tolerance = costs.plus(DecimalJS.max(.one, value.times(try DecimalJS("0.01"))))
        return value.minus(try DecimalJS(booked)).abs.lte(tolerance)
    }

    private static func trade(_ record: Record, _ format: Format?) throws -> ParsedPortfolioRow {
        let actionText = clean(record, "Acties")
        guard let action = tradeAction(actionText) else {
            return try unsupported(record, "Saxo trade action could not be parsed safely")
        }
        let units = try magnitude(action.quantity, format)
        let price = try magnitude(action.price, format)
        let instrumentCurrency = currency(
            action.currency.flatMap { $0.isEmpty ? nil : XLSXCell.text($0) } ?? record["Instrumentvaluta"])
        guard let units, units != 0, let price, price != 0, let instrumentCurrency else {
            return try unsupported(record, "Saxo trade is missing units, price, or instrument currency")
        }
        let accountCurrency = currency(record["Valuta"])
        let rate = try magnitude(record["Omrekeningskoers"], format)
        let accountFees = try magnitude(record["Totale kosten"], format)
        // A workbook trade is checked against its own execution and booking details instead.
        guard
            try record.origin != nil
                || bookedValueAgrees(record, units: units, price: price, instrumentCurrency: instrumentCurrency, format)
        else {
            return try unsupported(
                record,
                "Saxo trade \(actionText) does not agree with its booked amount; check the quantity and price before importing"
            )
        }
        let sameCurrency = accountCurrency.map { Text.same($0, instrumentCurrency) } ?? false
        var fees = accountFees
        if let accountFees, accountFees != 0, !sameCurrency, let rate, rate != 0 {
            fees = try DecimalJS(accountFees).dividedBy(try DecimalJS(rate)).toNumber
        }
        let remark = clean(record, "Opmerking")
        var row = try base(record)
        row.typeRaw = action.buying ? "Buy" : "Sell"
        row.units = units
        row.pricePerUnit = price
        row.fees = fees
        row.currency = instrumentCurrency
        row.fxRateToEur = accountCurrency == "EUR" && instrumentCurrency != "EUR" ? rate : nil
        row.note = remark.isEmpty ? actionText : remark
        return row
    }

    private static func known(_ record: Record, _ format: Format?) throws -> ParsedPortfolioRow {
        let kind = JavaScriptCase.lowercased(clean(record, "Transactietype"))
        let action = JavaScriptCase.lowercased(clean(record, "Acties"))
        func isKind(_ names: String...) -> Bool { names.contains { Text.same($0, kind) } }
        func isAction(_ names: String...) -> Bool { names.contains { Text.same($0, action) } }
        if isKind("transactie", "trade") { return try trade(record, format) }
        let remark = clean(record, "Opmerking")
        if isKind("storting/opname", "cash transfer"), isAction("storting", "deposit", "opname", "withdrawal") {
            let deposit = isAction("storting", "deposit")
            var row = try base(record)
            row.typeRaw = deposit ? "Deposit" : "Withdrawal"
            row.symbolRaw = ""
            row.nameRaw = ""
            row.amount = try magnitude(record["Boekingsbedrag"], format)
            row.note = remark.isEmpty ? (deposit ? "Saxo cash deposit" : "Saxo cash withdrawal") : remark
            return row
        }
        if isKind("corporate action", "corporateaction"), isAction("cashdividend", "cash dividend") {
            var row = try base(record)
            row.typeRaw = "Unsupported Saxo event: Cashdividend"
            row.amount = try magnitude(record["Boekingsbedrag"], format)
            row.fees = try magnitude(record["Totale kosten"], format)
            row.note =
                "Saxo CSV dividend contains only a net booking amount. Import the detailed XLSX workbook to retain gross dividends and withholding taxes."
            return row
        }
        return try unsupported(record, "Unsupported Saxo transaction type")
    }

    /// `parseRecord(record, format)`: an ambiguous number makes the row an unsupported event.
    static func row(_ record: Record, _ format: Format?) throws -> ParsedPortfolioRow {
        do {
            return try known(record, format)
        } catch let ambiguous as AmbiguousNumber {
            return try unsupported(record, ambiguous.message)
        }
    }

    static func parse(_ bytes: [UInt8], _ config: PortfolioParserConfig) throws -> ParsedPortfolioRows {
        if PortfolioUpload.format(of: bytes) == .xlsx { return try parseWorkbook(bytes) }
        var options = PortfolioAdapters.options(namedColumns: .renamed { $0.map(header) })
        options.columns = .renamed { $0.map(header) }
        let content = Text.withoutByteOrderMark(try PortfolioAdapters.decoded(bytes, config))
        let output = try CSVParse.parse(content, options)
        guard let first = output.records.first else {
            throw StatementImportError.failed("Saxo transaction history is empty")
        }
        let missing = requiredColumns.filter { !PortfolioAdapters.has(first, $0) }
        if !missing.isEmpty {
            throw StatementImportError.failed(
                "Saxo transaction history is missing columns: \(missing.joined(separator: ", "))")
        }
        // The header as the file writes it, before the names are normalised.
        var rawOptions = options
        rawOptions.columns = .none
        let rawHeader = try CSVParse.parse(content, rawOptions).records.first?.cells
        let records = output.records.map { Record(cells: $0.fields.mapValues(XLSXCell.text), line: $0) }
        let format = fileFormat(records)
        var parsed = ParsedPortfolioRows(skipped: 0, sourceColumns: rawHeader)
        for record in records {
            let row = try row(record, format)
            if row.day != nil { parsed.rows.append(row) } else { parsed.skipped = (parsed.skipped ?? 0) + 1 }
        }
        return parsed
    }
}
