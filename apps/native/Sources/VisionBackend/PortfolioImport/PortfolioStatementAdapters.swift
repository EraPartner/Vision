import Foundation

/// One row as a portfolio statement adapter reads it (`ParsedPortfolioRow` of
/// `portfolioImportPipeline/portfolioGenericAdapter.ts`). Numbers are magnitudes; the type
/// carries the direction.
struct ParsedPortfolioRow: Equatable, Sendable {
    struct AssetTransfer: Equatable, Sendable {
        enum Direction: String, Sendable { case incoming = "in", outgoing = "out", `internal` }
        enum BasisStatus: String, Sendable { case carried, unresolved, notApplicable = "not_applicable" }
        var direction: Direction
        var basisStatus: BasisStatus
        var feeUnits: String?
        var receivedUnits: String?
    }

    struct AssetAdjustment: Equatable, Sendable {
        enum Kind: String, Sendable {
            case yieldAcquisition = "yield_acquisition", yieldReversal = "yield_reversal", assetFee = "asset_fee"
        }
        enum BasisPolicy: String, Sendable { case zero, zeroYieldOnly = "zero_yield_only", carried }
        var kind: Kind
        var basisPolicy: BasisPolicy
    }

    /// Days since 1970-01-01; nil when the source date could not be read.
    var day: Int?
    var typeRaw = ""
    var symbolRaw = ""
    var nameRaw = ""
    var units: Double?
    var pricePerUnit: Double?
    var amount: Double?
    var fees: Double?
    var taxes: Double?
    var currency: String?
    var fxRateToEur: Double?
    var note = ""
    var rawData: String
    var sourceAccountIdentity: String?
    /// The source's own identifier of the record.
    var sourceReference: String?
    var assetTransfer: AssetTransfer?
    var assetAdjustment: AssetAdjustment?

    var jsonValue: JSValue {
        func number(_ value: Double?) -> JSValue { value.map(JSValue.number) ?? .null }
        func text(_ value: String?) -> JSValue { value.map(JSValue.string) ?? .null }
        var out = JSObject([
            ("day", day.map { .number(Double($0)) } ?? .null), ("typeRaw", .string(typeRaw)),
            ("symbolRaw", .string(symbolRaw)), ("nameRaw", .string(nameRaw)), ("units", number(units)),
            ("pricePerUnit", number(pricePerUnit)), ("amount", number(amount)), ("fees", number(fees)),
            ("taxes", number(taxes)), ("currency", text(currency)), ("fxRateToEur", number(fxRateToEur)),
            ("note", .string(note)), ("rawData", .string(rawData)),
            ("sourceAccountIdentity", text(sourceAccountIdentity)), ("sourceId", text(sourceReference)),
        ])
        if let assetTransfer {
            var transfer = JSObject([
                ("direction", .string(assetTransfer.direction.rawValue)),
                ("basisStatus", .string(assetTransfer.basisStatus.rawValue)),
            ])
            if let fee = assetTransfer.feeUnits { transfer["feeUnits"] = .string(fee) }
            if let received = assetTransfer.receivedUnits { transfer["receivedUnits"] = .string(received) }
            out["assetTransfer"] = .object(transfer)
        }
        if let assetAdjustment {
            out["assetAdjustment"] = .object(
                JSObject([
                    ("kind", .string(assetAdjustment.kind.rawValue)),
                    ("basisPolicy", .string(assetAdjustment.basisPolicy.rawValue)),
                ]))
        }
        return .object(out)
    }
}

/// An adapter's result: the rows, its count of source rows it could not use, and the
/// statement's column names where the adapter reports them.
struct ParsedPortfolioRows: Equatable, Sendable {
    var rows: [ParsedPortfolioRow] = []
    var skipped: Int?
    var sourceColumns: [String]?

    var jsonValue: JSValue {
        var out = JSObject([("rows", .array(rows.map(\.jsonValue)))])
        if let skipped { out["skipped"] = .number(Double(skipped)) }
        if let sourceColumns { out["sourceColumns"] = .array(sourceColumns.map(JSValue.string)) }
        return .object(out)
    }
}

/// The settings a portfolio statement is read with (`PortfolioParserConfig`).
struct PortfolioParserConfig: Equatable, Sendable {
    enum Format: String, Sendable {
        case ibkrTransactionHistory = "ibkr_transaction_history"
        case ibkrFundingHistory = "ibkr_funding_history"
        case kinesisTransactionHistory = "kinesis_transaction_history"
        case nexoTransactionHistory = "nexo_transaction_history"
        case nexoProSpotHistory = "nexo_pro_spot_history"
        case saxoTransactionHistory = "saxo_transaction_history"
    }

    /// The source column names of the generic mapping; nil or empty is not mapped.
    struct Columns: Equatable, Sendable {
        var date: String?
        var type: String?
        var symbol: String?
        var name: String?
        var units: String?
        var price: String?
        var amount: String?
        var fees: String?
        var taxes: String?
        var currency: String?
        var fxRate: String?
        var note: String?
        var sourceAccount: String?
        var sourceReference: String?
    }

    var format: Format?
    var dateFormat: String?
    var separator: String?
    var skipRows = 0
    var encoding: String?
    /// The stored `number_format` value, checked when the file is read.
    var numberFormat: JSValue?
    /// Yield units enter at zero cost basis (`yield_basis_policy: "zero"`).
    var zeroYieldBasis = false
    /// `transfer_origin_account_id`, as stored.
    var transferOriginAccount: Double?
    var columns = Columns()
}

/// `normalizeType` of `portfolioTypeNormalizer.ts`: a statement's own type label as a
/// canonical portfolio transaction type. A label nobody mapped is an error, never a guess.
enum PortfolioTypeNormalizer {
    enum Outcome: Equatable, Sendable {
        case type(String)
        case error(String)
    }

    static let validTypes: Set<String> = [
        "buy", "sell", "dividend", "fee", "tax", "interest", "rent_income", "appreciation", "gift", "split", "merger",
        "spinoff", "return_of_capital",
    ]

    private static let aliases: [String: String] = [
        "buy": "buy", "purchase": "buy", "bought": "buy", "koop": "buy", "aankoop": "buy", "kauf": "buy",
        "sell": "sell", "sale": "sell", "sold": "sell", "verkoop": "sell", "verkauf": "sell",
        "dividend": "dividend", "div": "dividend", "distribution": "dividend", "dividenden": "dividend",
        "fee": "fee", "fees": "fee", "commission": "fee", "kosten": "fee",
        "tax": "tax", "taxes": "tax", "withholding": "tax", "belasting": "tax",
        "interest": "interest", "rente": "interest", "gift": "gift", "split": "split",
    ]

    /// Dictionary lookups compare by code unit here, as a JavaScript object's keys do.
    private static func lookup(_ table: [String: String], _ key: String) -> String? {
        table.first { BankImportText.same($0.key, key) }?.value
    }

    static func normalize(_ raw: String?, mapping: [String: String] = [:], defaultType: String? = nil) -> Outcome {
        let trimmed = BankImportText.trim(raw ?? "")
        if trimmed.isEmpty {
            if let defaultType, validTypes.contains(where: { BankImportText.same($0, defaultType) }) {
                return .type(defaultType)
            }
            return .error("missing transaction type")
        }
        let lower = JavaScriptCase.lowercased(trimmed)
        if let mapped = lookup(mapping, trimmed) ?? lookup(mapping, lower), !mapped.isEmpty {
            guard validTypes.contains(where: { BankImportText.same($0, mapped) }) else {
                return .error("mapped type \"\(mapped)\" is not a valid portfolio transaction type")
            }
            return .type(mapped)
        }
        if let alias = lookup(aliases, lower) { return .type(alias) }
        if validTypes.contains(where: { BankImportText.same($0, lower) }) { return .type(lower) }
        return .error("unknown transaction type \"\(trimmed)\"")
    }
}

/// The upload boundary of `lib/portfolioUpload.ts` that needs no workbook reader.
enum PortfolioUpload {
    enum FileFormat: String, Sendable { case csv, xls, xlsx }

    /// `detectPortfolioFileFormat`: by the first bytes, never by the name.
    static func format(of bytes: some Collection<UInt8>) -> FileFormat {
        let head = Array(bytes.prefix(8))
        if head.starts(with: [0x50, 0x4B, 0x03, 0x04]) { return .xlsx }
        if head == [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1] { return .xls }
        return .csv
    }

    /// `isLikelyPortfolioFile`: the name and declared type of an upload fit a statement.
    static func isLikelyStatement(name: String?, mimeType: String?) -> Bool {
        let name = JavaScriptCase.lowercased(name ?? "")
        let mime = JavaScriptCase.lowercased(mimeType ?? "")
        let common = mime.isEmpty || BankImportText.same(mime, "application/octet-stream")
        func ends(_ suffix: String) -> Bool { name.utf16.reversed().starts(with: suffix.utf16.reversed()) }
        let excel = BankImportText.same(mime, "application/vnd.ms-excel")
        return (ends(".csv") && (common || BankImportText.contains(mime, "csv") || BankImportText.same(mime, "text/plain") || excel))
            || (ends(".xlsx")
                && (common
                    || BankImportText.same(mime, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")))
            || (ends(".xls") && (common || excel))
    }
}

/// The portfolio statement adapters that read CSV (`portfolioImportPipeline`): the generic
/// column mapping and the IBKR, Kinesis, Nexo, Nexo Pro and Saxo statements, and the Saxo
/// workbook. The IBKR funding workbook is read by SheetJS in the TypeScript, which has no
/// Swift port; `IbkrFundingHistory` reads the sheets once something has read the file.
enum PortfolioAdapters {
    typealias Text = BankImportText

    /// `parseWithConfig(filePath, config)`: the statement read by the configured format, with
    /// the row contract of `parsedPortfolioRowSchema` checked on the way out.
    static func parse(_ bytes: [UInt8], _ config: PortfolioParserConfig) throws -> ParsedPortfolioRows {
        let parsed: ParsedPortfolioRows
        switch config.format {
        case .ibkrTransactionHistory: parsed = try IbkrTransactionHistory.parse(bytes, config)
        case .kinesisTransactionHistory: parsed = try KinesisStatement.parse(bytes, config)
        case .nexoTransactionHistory: parsed = try NexoStatement.parse(bytes, config)
        case .nexoProSpotHistory: parsed = try NexoProSpotHistory.parse(bytes, config)
        case .saxoTransactionHistory: parsed = try SaxoStatement.parse(bytes, config)
        case .ibkrFundingHistory:
            throw StatementImportError.failed("IBKR funding workbooks are not read by the Swift backend yet")
        case nil: parsed = try generic(bytes, config)
        }
        let numbers = parsed.rows.flatMap { [$0.units, $0.pricePerUnit, $0.amount, $0.fees, $0.taxes, $0.fxRateToEur] }
        guard numbers.allSatisfy({ $0?.isFinite ?? true }) else {
            throw StatementImportError.contract(adapter: config.format?.rawValue ?? "portfolio_generic")
        }
        return parsed
    }

    // MARK: Shared pieces

    /// `cleanCell(value)`: the trimmed cell, empty when the record has none.
    static func clean(_ value: String?) -> String { Text.trim(value ?? "") }

    /// `Object.keys(record)`: the names of the columns a record has cells for.
    static func keys(of record: CSVParse.Record, columns: [String?]?) -> [String] {
        let names = (columns ?? []).prefix(record.cells.count).compactMap { $0 }
        return JSObject(names.map { ($0, JSValue.null) }).keys
    }

    static func has(_ record: CSVParse.Record, _ column: String) -> Bool {
        record.fields.keys.contains { Text.same($0, column) }
    }

    /// A value past the finite numbers. The TypeScript carries it through decimal.js and
    /// nearly always fails the row contract with it; here it fails the import at once.
    static func finite(_ value: Double, adapter: PortfolioParserConfig.Format) throws -> Double {
        guard !value.isInfinite else { throw StatementImportError.contract(adapter: adapter.rawValue) }
        return value
    }

    static func options(namedColumns: CSVParse.Columns = .firstRecord) -> CSVParse.Options {
        var options = CSVParse.Options()
        options.columns = namedColumns
        options.skipEmptyLines = true
        options.relaxColumnCount = true
        return options
    }

    static func decoded(_ bytes: [UInt8], _ config: PortfolioParserConfig) throws -> String {
        Text.decode(bytes, try Text.encoding(config.encoding))
    }

    // MARK: Generic

    private static func genericRow(
        _ record: CSVParse.Record, _ config: PortfolioParserConfig, format: Text.NumberFormat, rowNumber: Int
    ) throws -> ParsedPortfolioRow? {
        let columns = config.columns
        func mapped(_ column: String?) -> String? { column.flatMap { $0.isEmpty ? nil : $0 } }
        func cell(_ column: String?) -> String { mapped(column).map { clean(record[$0]) } ?? "" }
        let dateText = cell(columns.date)
        guard !dateText.isEmpty, let day = Text.day(dateText, format: config.dateFormat ?? "") else { return nil }
        func magnitude(_ column: String?) throws -> Double? {
            guard let column = mapped(column), let raw = record[column], !Text.trim(raw).isEmpty else { return nil }
            let value = try Text.customAmount(raw, format, rowNumber: rowNumber, column: column)
            return value.isNaN ? nil : abs(value)
        }
        let currency = cell(columns.currency)
        let rate = try magnitude(columns.fxRate)
        let account = cell(columns.sourceAccount)
        let reference = cell(columns.sourceReference)
        let row = ParsedPortfolioRow(
            day: day, typeRaw: cell(columns.type), symbolRaw: cell(columns.symbol), nameRaw: cell(columns.name),
            units: try magnitude(columns.units), pricePerUnit: try magnitude(columns.price),
            amount: try magnitude(columns.amount), fees: try magnitude(columns.fees),
            taxes: try magnitude(columns.taxes), currency: currency.isEmpty ? nil : currency, fxRateToEur: rate,
            note: cell(columns.note), rawData: Text.rawData(record),
            sourceAccountIdentity: account.isEmpty ? nil : account, sourceReference: reference.isEmpty ? nil : reference)
        if Text.same(row.typeRaw, "asset_fee") || Text.same(row.typeRaw, "asset_transfer_witness") {
            throw StatementImportError.validation(
                "Native wallet receipt rows are no longer supported. Import the Kinesis transaction history instead.")
        }
        return row
    }

    private static func generic(_ bytes: [UInt8], _ config: PortfolioParserConfig) throws -> ParsedPortfolioRows {
        let format = try Text.numberFormat(config.numberFormat)
        let dateFormat = config.dateFormat ?? ""
        guard Text.supportedDateFormats.contains(where: { Text.same($0, dateFormat) }) else {
            throw StatementImportError.failed(
                "Unsupported date_format \"\(dateFormat)\". Supported: "
                    + Text.supportedDateFormats.joined(separator: ", "))
        }
        var options = options()
        options.delimiter = config.separator.flatMap { $0.isEmpty ? nil : $0 } ?? ","
        options.fromLine = config.skipRows + 1
        let output = try Text.records(try decoded(bytes, config), options)
        var parsed = ParsedPortfolioRows(skipped: 0)
        for (index, record) in output.records.enumerated() {
            if let row = try genericRow(record, config, format: format, rowNumber: index + 1) {
                parsed.rows.append(row)
            } else {
                parsed.skipped = (parsed.skipped ?? 0) + 1
            }
        }
        parsed.sourceColumns = output.records.first.map { keys(of: $0, columns: output.columns) } ?? []
        return parsed
    }
}

/// Interactive Brokers "Transaction History" (`ibkrTransactionHistoryAdapter.ts`): a statement
/// of several sections. Totals are in the statement's base currency, trade prices in the
/// row's own; Forex Trade Component rows are conversion details whose commissions are cash
/// expenses.
enum IbkrTransactionHistory {
    private typealias Text = BankImportText

    private static let section = "Transaction History"
    private static let requiredColumns = [
        "Date", "Description", "Transaction Type", "Symbol", "Quantity", "Price", "Price Currency", "Gross Amount",
        "Commission", "Net Amount", "Exchange Rate", "Transaction Fees",
    ]

    private struct ForexChargeIssue: Error { let column: String }

    /// `cleanCell(value)`: a lone dash is an empty cell.
    private static func clean(_ value: String?) -> String {
        let text = Text.trim(value ?? "")
        return Text.same(text, "-") ? "" : text
    }

    private static func magnitude(_ value: String?) -> Double? { IbkrStatementNumber.parse(value ?? "").map { abs($0) } }

    private struct Record {
        let columns: [String]
        let values: ArraySlice<String>
        subscript(name: String) -> String? {
            guard let index = columns.firstIndex(where: { Text.same($0, name) }) else { return nil }
            return index < values.count ? values[values.startIndex + index] : ""
        }
    }

    /// Quantity × price × multiplier × exchange rate must explain the Gross Amount within 1 %
    /// (at least 0.01); without a gross amount or a rate nothing can be compared.
    private static func grossAgrees(_ record: Record, baseCurrency: String, priceCurrency: String) throws -> Bool {  // lint:allow raw-currency statement cell text, compared as written
        let rate = Text.same(priceCurrency, baseCurrency) ? 1 : magnitude(record["Exchange Rate"])
        guard let units = magnitude(record["Quantity"]), let price = magnitude(record["Price"]),
            let gross = magnitude(record["Gross Amount"]), gross != 0, let rate, rate != 0
        else { return true }
        let exported = magnitude(record["Multiplier"])
        let multiplier = exported == nil || exported == 0 ? 1 : exported ?? 1
        let value = try DecimalJS(units).times(try DecimalJS(price)).times(try DecimalJS(multiplier))
            .times(try DecimalJS(rate))
        let tolerance = DecimalJS.max(try DecimalJS("0.01"), value.times(try DecimalJS("0.01")))
        return value.minus(try DecimalJS(gross)).abs.lte(tolerance)
    }

    private static func row(_ record: Record, baseCurrency: String, rawData: String) throws -> ParsedPortfolioRow? {  // lint:allow raw-currency statement cell text, compared as written
        let originalType = clean(record["Transaction Type"])
        if originalType.isEmpty { return nil }
        let description = clean(record["Description"])
        let day = Text.day(clean(record["Date"]), format: "%Y-%m-%d")
        let account = clean(record["Account"])
        var row = ParsedPortfolioRow(
            day: day, currency: baseCurrency, rawData: rawData, sourceAccountIdentity: account.isEmpty ? nil : account)
        if Text.same(originalType, "Forex Trade Component") {
            func charge(_ column: String) throws -> Double {
                let text = clean(record[column])
                guard let value = text.isEmpty ? 0 : IbkrStatementNumber.parse(text), value <= 0 else {
                    throw ForexChargeIssue(column: column)
                }
                return -value
            }
            let amount = try charge("Commission") + (try charge("Transaction Fees"))
            if amount == 0 { return nil }
            row.typeRaw = "Fee"
            row.amount = amount
            row.note = "\(description) (FX commission)"
            return row
        }
        if Text.same(originalType, "Adjustment"), Text.same(description, "FX Translations P&L") { return nil }
        let grossSigned = IbkrStatementNumber.parse(record["Gross Amount"] ?? "")
        var typeRaw = originalType
        if Text.same(originalType, "Foreign Tax Withholding") {
            typeRaw = "tax"
        } else if Text.same(originalType, "Adjustment") {
            guard let grossSigned, grossSigned != 0 else { return nil }
            typeRaw = grossSigned < 0 ? "Withdrawal" : "Deposit"
        }
        let isTrade = Text.same(typeRaw, "Buy") || Text.same(typeRaw, "Sell")
        let priceCurrency = JavaScriptCase.uppercased(clean(record["Price Currency"]))
        let exportedRate = magnitude(record["Exchange Rate"])
        row.symbolRaw = clean(record["Symbol"])
        if isTrade, !(try grossAgrees(record, baseCurrency: baseCurrency, priceCurrency: priceCurrency)) {
            row.typeRaw = "Unsupported IBKR event: \(originalType)"
            row.amount = magnitude(record["Gross Amount"])
            row.note =
                "IBKR \(originalType) of \(clean(record["Quantity"])) @ \(clean(record["Price"])) does not agree with its Gross Amount; check the quantity and price before importing"
            return row
        }
        let baseFees = (magnitude(record["Commission"]) ?? 0) + (magnitude(record["Transaction Fees"]) ?? 0)
        if isTrade, baseFees > 0, let exportedRate, exportedRate != 0 {
            // Both fee columns are base-currency amounts; a trade stores fees in its own currency.
            row.fees = baseFees / exportedRate
        } else if baseFees != 0 {
            row.fees = baseFees
        }
        row.typeRaw = typeRaw
        row.units = magnitude(record["Quantity"])
        row.pricePerUnit = magnitude(record["Price"])
        // A trade's total is a base-currency value, so its amount is left to units × price.
        row.amount = isTrade ? nil : magnitude(record["Gross Amount"])
        row.currency = isTrade ? (priceCurrency.isEmpty ? nil : priceCurrency) : baseCurrency
        row.fxRateToEur = isTrade && Text.same(baseCurrency, "EUR") ? exportedRate : nil
        row.note = description
        return row
    }

    static func parse(_ bytes: [UInt8], _ config: PortfolioParserConfig) throws -> ParsedPortfolioRows {
        var options = CSVParse.Options()
        options.skipEmptyLines = true
        options.relaxColumnCount = true
        options.relaxQuotes = true
        let records = try Text.records(try PortfolioAdapters.decoded(bytes, config), options).records
        func marks(_ record: CSVParse.Record, _ first: String, _ second: String) -> Bool {
            record.cells.count > 1 && Text.same(record.cells[0], first) && Text.same(record.cells[1], second)
        }
        let headers = records.indices.filter { marks(records[$0], section, "Header") }
        guard let headerIndex = headers.first else {
            throw StatementImportError.failed("IBKR CSV is missing the \"Transaction History\" header")
        }
        guard headers.count == 1 else {
            throw StatementImportError.failed("IBKR CSV has multiple \"Transaction History\" headers")
        }
        let columns = records[headerIndex].cells.dropFirst(2).map(Text.trim)
        if columns.contains(where: \.isEmpty) {
            throw StatementImportError.failed("IBKR Transaction History has blank column names")
        }
        for (index, column) in columns.enumerated() where columns[..<index].contains(where: { Text.same($0, column) }) {
            throw StatementImportError.failed("IBKR Transaction History has duplicate column names")
        }
        let missing = requiredColumns.filter { wanted in !columns.contains { Text.same($0, wanted) } }
        if !missing.isEmpty {
            throw StatementImportError.failed(
                "IBKR Transaction History is missing columns: \(missing.joined(separator: ", "))")
        }
        let summaries = records.filter {
            marks($0, "Summary", "Data") && Text.same(Text.trim($0.cells.count > 2 ? $0.cells[2] : "undefined"), "Base Currency")
        }
        guard summaries.count <= 1 else {
            throw StatementImportError.failed("IBKR CSV has multiple Summary base currency records")
        }
        guard let summary = summaries.first,
            let baseCurrency = Text.isoCurrency(clean(summary.cells.count > 3 ? summary.cells[3] : nil))
        else { throw StatementImportError.failed("IBKR CSV is missing a valid Summary base currency") }
        var parsed = ParsedPortfolioRows(skipped: 0, sourceColumns: columns)
        for record in records[(headerIndex + 1)...] where marks(record, section, "Data") {
            let source = Record(columns: columns, values: record.cells.dropFirst(2))
            do {
                if let row = try row(source, baseCurrency: baseCurrency, rawData: Text.rawData(record)), row.day != nil {
                    parsed.rows.append(row)
                } else {
                    parsed.skipped = (parsed.skipped ?? 0) + 1
                }
            } catch let issue as ForexChargeIssue {
                throw StatementImportError.failed("IBKR Forex Trade Component has an unsupported \(issue.column)")
            }
        }
        return parsed
    }
}

/// Kinesis Money "Transaction Statement" (`kinesisTransactionHistoryAdapter.ts`): one row per
/// currency leg. The two legs of an exchange order become one portfolio trade and one cash
/// movement.
enum KinesisStatement {
    private typealias Text = BankImportText
    private typealias Record = CSVParse.Record

    private static let requiredColumns = [
        "DateTime", "HIN", "Currency_Code", "Transaction_Type", "Transaction_ID", "Order_ID", "Currency_Pair", "Amount",
        "Trade_Price", "Total", "Fee", "Fee_Currency", "Trade_Value", "Trade_Value_Currency", "Starting_Balance",
        "Starting_Balance_Currency", "Closing_Balance", "Closing_Balance_Currency",
    ]
    private static let fiat: Set<String> = ["AUD", "CAD", "CHF", "EUR", "GBP", "SGD", "USD"]
    private static let adapter = PortfolioParserConfig.Format.kinesisTransactionHistory

    private static func clean(_ record: Record, _ column: String) -> String { PortfolioAdapters.clean(record[column]) }
    private static func upper(_ record: Record, _ column: String) -> String {
        JavaScriptCase.uppercased(clean(record, column))
    }
    private static func isFiat(_ code: String) -> Bool { fiat.contains { Text.same($0, code) } }

    private static func number(_ record: Record, _ column: String) throws -> Double? {
        let text = clean(record, column)
        if text.isEmpty { return nil }
        let value = try PortfolioAdapters.finite(Text.amount(text), adapter: adapter)
        return value.isNaN ? nil : value
    }

    private static func magnitude(_ record: Record, _ column: String) throws -> Double? {
        try number(record, column).map { abs($0) }
    }

    private static func currency(_ code: String) -> String? {
        let code = JavaScriptCase.uppercased(Text.trim(code))
        return Text.same(code, "C1USD") ? "USD" : Text.isoCurrency(code).flatMap { Text.same($0, code) ? $0 : nil }
    }

    private static func day(_ record: Record) -> Int? {
        // `.replace(/\s+UTC$/i, "")`.
        var all = Text.units(clean(record, "DateTime"))
        if all.count > 3, Text.same(JavaScriptCase.uppercased(Text.text(all.suffix(3))), "UTC"),
            all[all.count - 3] < 0x80, all[all.count - 2] < 0x80, all[all.count - 1] < 0x80, Text.isSpace(all[all.count - 4])
        {
            all.removeLast(3)
            while let last = all.last, Text.isSpace(last) { all.removeLast() }
        }
        return Text.day(Text.text(all), format: "%Y-%m-%d %H:%M:%S")
    }

    private static func balanceDelta(_ record: Record) throws -> Double? {
        guard let start = try number(record, "Starting_Balance"), let close = try number(record, "Closing_Balance")
        else { return nil }
        return try DecimalJS(close).minus(try DecimalJS(start)).toNumber
    }

    private static func reference(_ record: Record, _ suffix: String = "") -> String? {
        let id = clean(record, "Transaction_ID")
        return id.isEmpty ? nil : id + suffix
    }

    private static func base(_ record: Record) -> ParsedPortfolioRow {
        let account = clean(record, "HIN")
        return ParsedPortfolioRow(
            day: day(record), rawData: Text.rawData(record), sourceAccountIdentity: account.isEmpty ? nil : account,
            sourceReference: reference(record))
    }

    private static func unsupported(_ record: Record, _ reason: String) throws -> ParsedPortfolioRow {
        let code = upper(record, "Currency_Code")
        let amount = try balanceDelta(record).map { abs($0) } ?? (try magnitude(record, "Amount"))
        let type = clean(record, "Transaction_Type")
        var row = base(record)
        row.typeRaw = "Unsupported Kinesis event: \(type.isEmpty ? "unknown" : type)"
        row.note = reason
        if isFiat(code) {
            row.amount = amount
            row.currency = currency(code)
        } else {
            row.symbolRaw = code
            row.units = amount
        }
        return row
    }

    private static func trade(_ records: [Record]) throws -> [ParsedPortfolioRow]? {
        guard records.count == 2 else { return nil }
        let pair = upper(records[0], "Currency_Pair")
        guard records.allSatisfy({ Text.same(upper($0, "Currency_Pair"), pair) }) else { return nil }
        let codes = Text.split(pair, "_")
        guard codes.count == 2, !codes[0].isEmpty, !codes[1].isEmpty,
            let asset = records.first(where: { Text.same(upper($0, "Currency_Code"), codes[0]) }),
            let quote = records.first(where: { Text.same(upper($0, "Currency_Code"), codes[1]) }),
            let tradeCurrency = currency(codes[1])
        else { return nil }
        let assetDelta = try balanceDelta(asset)
        let quoteDelta = try balanceDelta(quote)
        let units = try magnitude(asset, "Total") ?? assetDelta.map { abs($0) } ?? (try magnitude(asset, "Amount"))
        let price = try magnitude(asset, "Trade_Price")
        let cash = try quoteDelta.map { abs($0) } ?? (try magnitude(quote, "Amount")) ?? (try magnitude(quote, "Total"))
        guard day(asset) != nil, let assetDelta, assetDelta != 0, let quoteDelta, quoteDelta != 0, let units, units != 0,
            let price, price != 0, let cash, cash != 0
        else { return nil }
        var quoteFee: Double?
        if let fee = try magnitude(asset, "Fee") {
            let feeCurrency = upper(asset, "Fee_Currency")
            if Text.same(feeCurrency, codes[0]) {
                quoteFee = try DecimalJS(fee).times(try DecimalJS(price)).toNumber
            } else if Text.same(feeCurrency, codes[1]) {
                quoteFee = fee
            }
        }
        var assetRow = base(asset)
        assetRow.typeRaw = assetDelta > 0 ? "Buy" : "Sell"
        assetRow.symbolRaw = codes[0]
        assetRow.units = units
        assetRow.pricePerUnit = price
        assetRow.fees = quoteFee
        assetRow.currency = tradeCurrency
        assetRow.note = "Kinesis trade \(pair)"
        var cashRow = base(quote)
        cashRow.typeRaw = quoteDelta > 0 ? "Deposit" : "Withdrawal"
        cashRow.amount = cash
        cashRow.currency = tradeCurrency
        cashRow.note = "Kinesis trade cash leg \(pair)"
        return [assetRow, cashRow]
    }

    private static let zeroBasis = ParsedPortfolioRow.AssetAdjustment(kind: .yieldAcquisition, basisPolicy: .zero)

    private static func distribution(_ record: Record, zeroBasis zero: Bool) throws -> [ParsedPortfolioRow]? {
        let symbol = upper(record, "Currency_Code")
        guard let units = try magnitude(record, "Amount"), let value = try magnitude(record, "Trade_Value"),
            !symbol.isEmpty, !isFiat(symbol), units != 0, value != 0,
            let valueCurrency = currency(clean(record, "Trade_Value_Currency"))
        else { return nil }
        let label = Text.text(Text.units(clean(record, "Transaction_Type")).map { $0 == 0x5F ? 0x20 : $0 })
        var income = base(record)
        income.typeRaw = "Dividend"
        income.symbolRaw = symbol
        income.amount = value
        income.currency = valueCurrency
        income.note = label
        income.sourceReference = reference(record, ":income")
        var received = base(record)
        received.typeRaw = "Gift"
        received.symbolRaw = symbol
        received.units = units
        received.pricePerUnit = zero ? 0 : try DecimalJS(value).dividedBy(try DecimalJS(units)).toNumber
        received.amount = zero ? 0 : value
        received.currency = valueCurrency
        received.note = "\(label) units"
        received.sourceReference = reference(record, ":units")
        if zero { received.assetAdjustment = zeroBasis }
        return [income, received]
    }

    private static func nonTrade(_ record: Record, zeroBasis zero: Bool) throws -> [ParsedPortfolioRow]? {
        let type = clean(record, "Transaction_Type")
        let code = upper(record, "Currency_Code")
        let fiat = isFiat(code)
        let delta = try balanceDelta(record)
        let amount = try delta.map { abs($0) } ?? (try magnitude(record, "Amount"))
        if Text.same(type, "Holder's_Distribution") || Text.same(type, "Velocity's_Distribution") {
            return try distribution(record, zeroBasis: zero)
        }
        var row = base(record)
        if Text.same(type, "Holder's_Distribution_Adjustment") {
            if !fiat, let delta, delta > 0, let amount, amount != 0 {
                row.typeRaw = "Gift"
                row.symbolRaw = code
                row.units = amount
                row.amount = 0
                row.pricePerUnit = zero ? 0 : nil
                row.note = "Kinesis holder distribution adjustment; original cost basis policy retained"
                if zero {
                    row.assetAdjustment = zeroBasis
                } else {
                    row.assetTransfer = .init(direction: .incoming, basisStatus: .unresolved)
                }
                return [row]
            }
            if !fiat, let delta, delta < 0, let amount, amount != 0, zero,
                try DecimalJS(try number(record, "Amount") ?? 0).eq(try DecimalJS(delta))
            {
                row.typeRaw = "AssetAdjustment"
                row.symbolRaw = code
                row.units = amount
                row.amount = 0
                row.fees = 0
                row.taxes = 0
                row.note =
                    "Kinesis holder distribution reversal; only source-proven zero-basis yield units are eligible"
                row.assetAdjustment = .init(kind: .yieldReversal, basisPolicy: .zeroYieldOnly)
                return [row]
            }
            return [
                try unsupported(
                    record,
                    "Kinesis negative holder distribution adjustment requires an explicit known-zero yield basis policy and eligible source history"
                )
            ]
        }
        if Text.same(type, "Deposit") {
            guard let amount, amount != 0 else { return nil }
            if fiat {
                row.typeRaw = "Deposit"
                row.amount = amount
                row.currency = currency(code)
                row.note = "Kinesis cash deposit"
            } else {
                row.typeRaw = "Gift"
                row.symbolRaw = code
                row.units = amount
                row.amount = 0
                row.note = "Kinesis asset transfer in; original cost basis unavailable"
                row.assetTransfer = .init(direction: .incoming, basisStatus: .unresolved)
            }
            return [row]
        }
        let cardPayment = Text.same(type, "Withdrawal(Card Payment)")
        if Text.same(type, "Withdrawal") || cardPayment {
            guard let amount, amount != 0 else { return nil }
            if fiat {
                row.typeRaw = "Withdrawal"
                row.amount = amount
                row.fees = try magnitude(record, "Fee")
                row.currency = currency(code)
                row.note = cardPayment ? "Kinesis card payment" : "Kinesis cash withdrawal"
                return [row]
            }
            let received = try magnitude(record, "Amount")
            let fee = try number(record, "Fee")
            guard let delta, delta < 0, let received, received != 0, let fee, fee >= 0,
                !(fee > 0 && !Text.same(upper(record, "Fee_Currency"), code)),
                try DecimalJS(amount).eq(try DecimalJS(received).plus(try DecimalJS(fee)))
            else { return [try unsupported(record, "Kinesis asset withdrawal has unresolved units or fee currency")] }
            row.typeRaw = "AssetTransfer"
            row.symbolRaw = code
            row.units = amount
            row.amount = 0
            row.fees = 0
            row.taxes = 0
            row.note = "Kinesis internal asset transfer"
            row.assetTransfer = .init(
                direction: .outgoing, basisStatus: .carried, feeUnits: JavaScriptNumber.text(fee),
                receivedUnits: JavaScriptNumber.text(received))
            return [row]
        }
        return [try unsupported(record, "Unsupported Kinesis transaction type")]
    }

    static func parse(_ bytes: [UInt8], _ config: PortfolioParserConfig) throws -> ParsedPortfolioRows {
        let output = try Text.records(try PortfolioAdapters.decoded(bytes, config), PortfolioAdapters.options())
        let records = output.records
        guard let first = records.first else {
            throw StatementImportError.failed("Kinesis Transaction Statement is empty")
        }
        let missing = requiredColumns.filter { !PortfolioAdapters.has(first, $0) }
        if !missing.isEmpty {
            throw StatementImportError.failed(
                "Kinesis Transaction Statement is missing columns: \(missing.joined(separator: ", "))")
        }
        func isTrade(_ record: Record) -> Bool { Text.same(clean(record, "Transaction_Type"), "Trade") }
        func legs(_ order: String) -> [Record] {
            records.filter { isTrade($0) && Text.same(clean($0, "Order_ID"), order) }
        }
        var handled: [String] = []
        var parsed = ParsedPortfolioRows(skipped: 0, sourceColumns: PortfolioAdapters.keys(of: first, columns: output.columns))
        for record in records {
            if isTrade(record) {
                let order = clean(record, "Order_ID")
                if handled.contains(where: { Text.same($0, order) }) { continue }
                handled.append(order)
                // Legs without an order identifier are never grouped: the first stands alone.
                let group = order.isEmpty ? [record] : legs(order)
                if let rows = try trade(group) {
                    parsed.rows += rows
                } else {
                    parsed.rows += try group.map { try unsupported($0, "Kinesis trade legs could not be paired safely") }
                }
            } else if let rows = try nonTrade(record, zeroBasis: config.zeroYieldBasis) {
                parsed.rows += rows
            } else {
                parsed.skipped = (parsed.skipped ?? 0) + 1
            }
        }
        return parsed
    }
}
