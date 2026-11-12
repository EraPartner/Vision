import Foundation

/// The detailed Saxo XLSX export (`parseWorkbook` of `saxoTransactionHistoryAdapter.ts`): the
/// `Transacties` sheet joined to its execution (`_Transacties`) and booking (`Bookings`)
/// details by account and booking record. A transaction the details do not explain exactly is
/// refused; nothing is estimated.
extension SaxoStatement {
    private static let idColumns = [
        "Rekening-ID", "Transactie-ID", "Bk Record Id", "Booking Id", "Corporate action-Id", "Positie-ID", "Order-ID",
    ]
    private static let joinColumns = ["Rekening-ID", "Bk Record Id"]
    private static let detailColumns =
        joinColumns + [
            "Transactie-ID", "Corporate action-Id", "Acties", "Instrument", "Instrumentsymbool", "Instrument ISIN",
            "Instrumentvaluta",
        ]
    private static let bookingColumns = detailColumns + ["Booking Id", "Amount Type", "Boekingsbedrag", "Omrekeningskoers"]
    private static let tradeColumns = detailColumns + ["Traded Quantity", "Prijs", "Verhandelde waarde"]

    private enum AmountKind { case principal, fee, tax, dividend, cash, unknown }

    private static func invalid(_ message: String) -> StatementImportError { .validation(message) }

    /// `date.toISOString()`; an invalid date throws there.
    private static func isoText(_ time: Double) throws -> String {
        guard !time.isNaN else { throw StatementImportError.failed("Invalid Date") }
        let days = Int((time / 86_400_000).rounded(.down))
        let milliseconds = Int(time - Double(days) * 86_400_000)
        let civil = XLSXWorkbook.civil(fromDays: days)
        func pad(_ value: Int, _ width: Int) -> String {
            let digits = String(value)
            return String(repeating: "0", count: max(0, width - digits.count)) + digits
        }
        let year =
            (0...9999).contains(civil.year) ? pad(civil.year, 4) : (civil.year < 0 ? "-" : "+") + pad(abs(civil.year), 6)
        return "\(year)-\(pad(civil.month, 2))-\(pad(civil.day, 2))T\(pad(milliseconds / 3_600_000, 2)):"
            + "\(pad(milliseconds / 60_000 % 60, 2)):\(pad(milliseconds / 1000 % 60, 2)).\(pad(milliseconds % 1000, 3))Z"
    }

    private static func json(_ cell: XLSXCell?, dateAsText: Bool) throws -> JSValue {
        switch cell {
        case nil: return .null
        case .text(let text): return .string(text)
        case .number(let raw): return .object(JSObject([("type", .string("number")), ("raw", .string(raw))]))
        case .boolean(let value): return .bool(value)
        case .date(let time):
            // `JSON.stringify(date)` is its ISO text, or null for an invalid date.
            if dateAsText { return time.isNaN ? .null : .string(try isoText(time)) }
            return .object(JSObject([("type", .string("date")), ("value", .string(try isoText(time)))]))
        }
    }

    /// `workbookProvenance(records)`: the literal rows a staged row was read from.
    static func provenance(_ records: [Record]) throws -> String {
        let origins = records.compactMap(\.origin)
        guard let first = origins.first, origins.count == records.count else {
            throw StatementImportError.failed("Saxo record has no workbook metadata")
        }
        let rows: [JSValue] = try origins.map { origin in
            .object(
                JSObject([
                    ("sheet", .string(origin.sheet)), ("row", .number(Double(origin.row))),
                    ("headers", .array(try origin.headers.map { try json($0, dateAsText: true) })),
                    ("cells", .array(try origin.cells.map { try json($0, dateAsText: false) })),
                ]))
        }
        return JSValue.object(
            JSObject([
                ("format", .string("saxo_xlsx_v1")), ("sourceFileHash", .string(first.sourceFileHash)),
                ("records", .array(rows)),
            ])
        ).jsonText
    }

    private static func isZeros(_ text: String) -> Bool { !text.isEmpty && text.utf16.allSatisfy { $0 == 0x30 } }

    /// `workbookRecords(sheet, required)`.
    private static func records(_ sheet: XLSXSheet, hash: String, required: [String]) throws -> [Record] {
        guard let rawHeaders = sheet.rows.first else { throw invalid("Saxo \(sheet.name) sheet is empty") }
        let headers = rawHeaders.map { header(clean($0)) }
        guard Set(headers.map { Array($0.utf16) }).count == headers.count else {
            throw invalid("Saxo \(sheet.name) sheet has ambiguous duplicate headers")
        }
        let missing = required.filter { column in !headers.contains { Text.same($0, column) } }
        guard missing.isEmpty else {
            throw invalid("Saxo \(sheet.name) sheet is missing columns: \(missing.joined(separator: ", "))")
        }
        var out: [Record] = []
        for (index, cells) in sheet.rows.dropFirst().enumerated() {
            if cells.allSatisfy({ $0 == nil }) { continue }
            var named: [String: XLSXCell] = [:]
            for (column, name) in headers.enumerated() where column < cells.count { named[name] = cells[column] }
            for column in idColumns {
                guard case .number(let raw)? = named[column] else { continue }
                let digits = raw.utf16.drop { $0 == 0x30 }
                let safe =
                    !raw.isEmpty && raw.utf16.allSatisfy(Text.isDigit)
                    && (digits.count < 16 || (digits.count == 16 && (Double(raw) ?? .infinity) <= 9_007_199_254_740_991))
                guard safe else {
                    throw invalid("Saxo \(sheet.name) row \(index + 2) has an unsafe numeric identifier in \(column)")
                }
            }
            out.append(
                Record(
                    cells: named, line: nil,
                    origin: Origin(
                        sheet: sheet.name, row: index + 2, headers: rawHeaders, cells: cells, sourceFileHash: hash)))
        }
        return out
    }

    private static func joinKey(_ record: Record) throws -> [[UInt16]] {
        let fields = joinColumns.map { clean(record, $0) }
        guard !fields.contains(where: { $0.isEmpty || isZeros($0) }) else {
            throw invalid("Saxo workbook contains a missing booking record or account identity")
        }
        return fields.map { Array($0.utf16) }
    }

    private static func assertClose(_ actual: DecimalJS?, _ expected: DecimalJS?, _ reason: String) throws {
        guard let actual, let expected, !actual.minus(expected).abs.gt(try DecimalJS("0.01")) else { throw invalid(reason) }
    }

    private static func assertEqual(_ actual: Double?, _ expected: Double?, _ reason: String) throws {
        guard let actual, let expected, try DecimalJS(actual).eq(try DecimalJS(expected)) else { throw invalid(reason) }
    }

    private static func sum(_ records: [Record]) throws -> DecimalJS {
        var total = DecimalJS.zero
        for record in records {
            guard let amount = try number(record["Boekingsbedrag"]) else {
                throw invalid("Saxo workbook contains an invalid booking amount")
            }
            total = total.plus(try DecimalJS(amount))
        }
        return total
    }

    private static func amountKind(_ record: Record) -> AmountKind {
        let kind = JavaScriptCase.lowercased(clean(record, "Amount Type"))
        func isKind(_ names: String...) -> Bool { names.contains { Text.same($0, kind) } }
        /// `/^prefix\b/`: the prefix, then no letter, digit or underscore.
        func begins(_ prefix: String) -> Bool {
            let units = Text.units(kind)
            guard units.starts(with: prefix.utf16) else { return false }
            guard units.count > prefix.utf16.count else { return true }
            let next = units[prefix.utf16.count]
            return !(Text.isDigit(next) || (next >= 0x41 && next <= 0x5A) || (next >= 0x61 && next <= 0x7A) || next == 0x5F)
        }
        if isKind("aandeelbedrag", "share amount") { return .principal }
        if isKind("commissie", "commission") { return .fee }
        if begins("beurstaks") || begins("exchange tax") { return .tax }
        if isKind("corporate actions - cash dividenden", "corporate actions - cash dividends") { return .dividend }
        if isKind(
            "corporate actions - bronbelasting", "corporate actions - roerende voorheffing",
            "corporate actions - withholding tax", "corporate actions - belgian withholding tax")
        {
            return .tax
        }
        if isKind("cashbedrag", "cash amount") { return .cash }
        return .unknown
    }

    /// `workbookActionFormat`: the separator under which the text action's quantity and price
    /// equal the typed execution cells.
    private static func actionFormat(_ record: Record, _ trades: [Record]) throws -> Format? {
        guard let action = tradeAction(clean(record, "Acties")), trades.count == 1, let trade = trades.first else {
            return nil
        }
        let units = try magnitude(trade["Traded Quantity"])
        let price = try magnitude(trade["Prijs"])
        func read(_ text: String, _ format: IbkrStatementNumber.Format) -> Double? {
            let value = IbkrStatementNumber.customAmount(text, format)
            return value.isFinite ? abs(value) : nil
        }
        for (format, reading) in [(Format.decimalDot, IbkrStatementNumber.Format.decimalDot), (.decimalComma, .decimalComma)] {
            if let units, let price, read(action.quantity, reading) == units, read(action.price, reading) == price {
                return format
            }
        }
        return nil
    }

    private static func positive(_ value: Double?) -> Bool { (value ?? 0) > 0 }
    private static func nonPositive(_ value: Double?) -> Bool { (value ?? 0) <= 0 }
    private static func nonNegative(_ value: Double?) -> Bool { (value ?? 0) >= 0 }

    /// `parseWorkbookRecord(record, bookings, trades)`.
    private static func row(_ record: Record, bookings: [Record], trades: [Record]) throws -> ParsedPortfolioRow {
        let parsed = try row(record, try actionFormat(record, trades))
        let kind = JavaScriptCase.lowercased(clean(record, "Transactietype"))
        let action = JavaScriptCase.lowercased(clean(record, "Acties"))
        guard let accountCurrency = currency(record["Valuta"]), parsed.day != nil else {
            throw invalid("Saxo workbook contains an invalid transaction date or account currency")
        }
        guard !bookings.isEmpty else { throw invalid("Saxo workbook transaction is missing booking details") }
        try assertClose(
            try sum(bookings), try number(record["Boekingsbedrag"]).map { try DecimalJS($0) },
            "Saxo workbook booking details do not reconcile to the transaction net amount")
        for booking in bookings {
            guard detailColumns.allSatisfy({ Text.same(clean(booking, $0), clean(record, $0)) }) else {
                throw invalid("Saxo workbook booking details conflict with their transaction")
            }
            try assertEqual(
                try number(booking["Omrekeningskoers"]), try number(record["Omrekeningskoers"]),
                "Saxo workbook booking details use inconsistent exchange rates")
        }
        var buckets: [AmountKind: [Record]] = [:]
        for booking in bookings { buckets[amountKind(booking), default: []].append(booking) }
        func entries(_ key: AmountKind) -> [Record] { buckets[key] ?? [] }
        func magnitudeSum(_ key: AmountKind) throws -> Double { try sum(entries(key)).abs.toNumber }
        var base = parsed
        base.rawData = try provenance([record] + trades + bookings)
        base.currency = accountCurrency
        base.fxRateToEur = nil
        if buckets[.unknown] != nil {
            base.typeRaw = "Unsupported Saxo event: booking detail"
            base.note = "Saxo workbook contains an unsupported booking amount type"
            return base
        }
        func only(_ allowed: AmountKind...) -> Bool { buckets.keys.allSatisfy(allowed.contains) }
        func isKind(_ names: String...) -> Bool { names.contains { Text.same($0, kind) } }
        func isAction(_ names: String...) -> Bool { names.contains { Text.same($0, action) } }

        if isKind("transactie", "trade") {
            guard trades.count == 1, let trade = trades.first, entries(.principal).count == 1, only(.principal, .fee, .tax)
            else { throw invalid("Saxo workbook trade details are missing or ambiguous") }
            guard detailColumns.allSatisfy({ Text.same(clean(trade, $0), clean(record, $0)) }) else {
                throw invalid("Saxo workbook execution details conflict with their transaction")
            }
            let units = try magnitude(trade["Traded Quantity"])
            let nativePrice = try magnitude(trade["Prijs"])
            let nativeGross = try magnitude(trade["Verhandelde waarde"])
            guard let units, units != 0, let nativePrice, nativePrice != 0, let nativeGross, nativeGross != 0,
                parsed.typeRaw == "Buy" || parsed.typeRaw == "Sell"
            else { throw invalid("Saxo workbook trade contains invalid execution details") }
            try assertEqual(units, parsed.units, "Saxo workbook trade quantities do not agree")
            try assertEqual(nativePrice, parsed.pricePerUnit, "Saxo workbook trade quoted prices do not agree")
            guard let rate = try magnitude(record["Omrekeningskoers"]), rate != 0 else {
                throw invalid("Saxo workbook trade is missing its exchange rate")
            }
            let principal = try number(entries(.principal)[0]["Boekingsbedrag"])
            let costs = entries(.fee) + entries(.tax)
            guard !(parsed.typeRaw == "Buy" && nonNegative(principal)),
                !(parsed.typeRaw == "Sell" && nonPositive(principal)),
                try !costs.contains(where: { positive(try number($0["Boekingsbedrag"])) })
            else { throw invalid("Saxo workbook trade booking signs are inconsistent") }
            let gross = try magnitudeSum(.principal)
            try assertClose(
                try DecimalJS(gross), try DecimalJS(nativeGross).times(try DecimalJS(rate)),
                "Saxo workbook trade principal does not reconcile to its execution value")
            base.units = units
            base.pricePerUnit = try DecimalJS(gross).dividedBy(try DecimalJS(units)).toNumber
            base.amount = gross
            base.fees = try magnitudeSum(.fee)
            base.taxes = try magnitudeSum(.tax)
            return base
        }
        if isKind("corporate action", "corporateaction"), isAction("cashdividend", "cash dividend") {
            guard trades.isEmpty, entries(.dividend).count == 1, only(.dividend, .tax, .fee),
                !nonPositive(try number(entries(.dividend)[0]["Boekingsbedrag"])),
                try !(entries(.tax) + entries(.fee)).contains(where: { positive(try number($0["Boekingsbedrag"])) })
            else { throw invalid("Saxo workbook dividend details are missing or inconsistent") }
            let remark = clean(record, "Opmerking")
            base.typeRaw = "Dividend"
            base.amount = try magnitudeSum(.dividend)
            base.fees = try magnitudeSum(.fee)
            base.taxes = try magnitudeSum(.tax)
            base.note = remark.isEmpty ? "Saxo cash dividend" : remark
            return base
        }
        if parsed.typeRaw == "Deposit" || parsed.typeRaw == "Withdrawal" {
            let booked = try number(record["Boekingsbedrag"])
            guard trades.isEmpty, bookings.count == 1, entries(.cash).count == 1,
                !(parsed.typeRaw == "Deposit" && nonPositive(booked)),
                !(parsed.typeRaw == "Withdrawal" && nonNegative(booked))
            else { throw invalid("Saxo workbook cash details are ambiguous or inconsistent") }
        }
        return base
    }

    /// `parseWorkbook(file)`.
    static func parseWorkbook(_ bytes: [UInt8]) throws -> ParsedPortfolioRows {
        do {
            let read = try PortfolioUpload.workbook(bytes)
            func table(_ name: String, _ columns: [String]) throws -> [Record] {
                let matches = read.sheets.filter { Text.same($0.name, name) }
                guard matches.count == 1, let match = matches.first else {
                    throw invalid("Saxo XLSX workbook requires one \(name) sheet")
                }
                return try records(match, hash: read.sourceFileHash, required: columns)
            }
            let main = try table("Transacties", requiredColumns)
            let trades = try table("_Transacties", tradeColumns)
            let bookings = try table("Bookings", bookingColumns)
            guard !main.isEmpty else { throw invalid("Saxo transaction history is empty") }
            var order: [[[UInt16]]] = []
            var groups: [[[UInt16]]: (record: Record, trades: [Record], bookings: [Record])] = [:]
            for record in main {
                let key = try joinKey(record)
                guard groups[key] == nil else {
                    throw invalid("Saxo workbook has ambiguous duplicate transaction booking records")
                }
                groups[key] = (record, [], [])
                order.append(key)
            }
            var bookingIDs: Set<[[UInt16]]> = []
            for (records, isBooking) in [(trades, false), (bookings, true)] {
                for record in records {
                    let key = try joinKey(record)
                    guard groups[key] != nil else { throw invalid("Saxo workbook contains an orphaned detail record") }
                    if isBooking {
                        let booking = clean(record, "Booking Id")
                        let id = [Array(clean(record, "Rekening-ID").utf16), Array(booking.utf16)]
                        guard !booking.isEmpty, bookingIDs.insert(id).inserted else {
                            throw invalid("Saxo workbook has duplicate or missing booking detail identifiers")
                        }
                        groups[key]?.bookings.append(record)
                    } else {
                        groups[key]?.trades.append(record)
                    }
                }
            }
            var parsed = ParsedPortfolioRows(skipped: 0)
            for key in order {
                guard let group = groups[key] else { continue }
                parsed.rows.append(try row(group.record, bookings: group.bookings, trades: group.trades))
            }
            return parsed
        } catch let ambiguous as AmbiguousNumber {
            // The TypeScript's ambiguous number is a validation error.
            throw invalid(ambiguous.message)
        }
    }
}
