import Foundation
import VisionNativeCore

// The facts the reconciliation plan re-reads from a staged row's literal record (ADR-270):
// the pure readers of the import adapters, ported with the plan because it cannot decide
// without them. The adapters' file parsing stays on Bun until the import area is ported.

// MARK: - Brokerage routing

/// `classifyBrokerageRow` of `services/importPipeline/brokerageRouting.ts`, for the one
/// answer the plan needs: the ledger direction of a cash row.
enum BrokerageRouting {
    private static let cashInflowKinds: Set<String> = [
        "deposit", "deposits", "cash deposit", "transfer in", "storting", "inleg", "terugbetaling", "einzahlung",
    ]
    private static let cashOutflowKinds: Set<String> = [
        "withdrawal", "withdrawals", "cash withdrawal", "transfer out", "opname", "auszahlung",
    ]
    private static let instrumentLessInflowKinds: Set<String> = ["dividend", "interest"]
    private static let instrumentLessOutflowKinds: Set<String> = ["fee", "tax"]

    /// The direction of a row that carries no instrument: `1` credits the sleeve, `-1`
    /// debits it, `nil` for a kind that is not a cash movement.
    static func instrumentLessCashDirection(kind: String?) -> Int? {
        let kind = JavaScriptWhitespace.trim((kind ?? "").lowercased())
        if cashInflowKinds.contains(kind) || instrumentLessInflowKinds.contains(kind) { return 1 }
        if cashOutflowKinds.contains(kind) || instrumentLessOutflowKinds.contains(kind) { return -1 }
        return nil
    }
}

// MARK: - IBKR

/// A funding movement's direction, as both IBKR exports name it.
enum FundingDirection: String, Sendable, Hashable {
    case deposit
    case withdrawal

    /// `1` for a deposit, `-1` for a withdrawal: the ledger sign.
    var sign: DecimalJS { self == .withdrawal ? DecimalJS(-1) : .one }
}

enum IbkrStatementNumber {
    enum Format: Sendable { case decimalDot, decimalComma }

    /// `ibkrNumber` of `ibkrTransactionHistoryAdapter.ts`: a decimal point with comma
    /// thousands, else the single reading a decimal-comma cell has.
    static func parse(_ cell: String) -> Double? {
        let trimmed = JavaScriptWhitespace.trim(cell)
        let text = trimmed.utf8.elementsEqual("-".utf8) ? "" : trimmed
        if text.isEmpty { return nil }
        let dot = customAmount(text, .decimalDot)
        if dot.isFinite { return dot }
        let comma = customAmount(text, .decimalComma)
        return comma.isFinite ? comma : nil
    }

    /// `parseCustomAmount` of `importPipeline/adapters/_shared.ts` for an explicit number
    /// format (the `auto` format, which can refuse an ambiguous cell, is not used here).
    static func customAmount(_ raw: String, _ format: Format) -> Double {
        var scalars = String.UnicodeScalarView()
        for scalar in JavaScriptWhitespace.trim(raw).unicodeScalars
        where !JavaScriptWhitespace.contains(scalar) && !"$€£¥".unicodeScalars.contains(scalar) {
            scalars.append(scalar)
        }
        var text = Substring(String(scalars))
        if text.isEmpty { return .nan }
        var negative = false
        if text.hasPrefix("("), text.hasSuffix(")") {
            negative = true
            text = text.dropFirst().dropLast()
        }
        if text.hasPrefix("-") || text.hasPrefix("+") {
            if text.hasPrefix("-") { negative = true }
            text = text.dropFirst()
        }
        // `/^(.*?)([eE][+-]?\d+)$/`: an exponent is the last `e` when only a sign and digits follow.
        var mantissa = text
        var exponent: Substring = ""
        if let mark = text.lastIndex(where: { $0 == "e" || $0 == "E" }) {
            var digits = text[text.index(after: mark)...]
            if digits.hasPrefix("+") || digits.hasPrefix("-") { digits = digits.dropFirst() }
            if ImportInterop.isASCIIDigits(digits) {
                mantissa = text[..<mark]
                exponent = text[mark...]
            }
        }
        let grouping: Character = format == .decimalDot ? "," : "."
        let point: Character = format == .decimalDot ? "." : ","
        guard isGroupedNumber(mantissa, grouping: grouping, point: point) else { return .nan }
        var plain = String(mantissa.filter { $0 != grouping })
        if format == .decimalComma, let comma = plain.firstIndex(of: ",") {
            plain.replaceSubrange(comma...comma, with: ".")
        }
        // parseDecimalSafe: `toDecimal(text).toNumber()`, NaN when decimal.js refuses it.
        guard let value = try? DecimalJS(plain + String(exponent)).toNumber, value.isFinite else { return .nan }
        return negative ? -value : value
    }

    /// `/^(?:\d+|\d{1,3}(?:G\d{3})+)(?:P\d*)?$|^P\d+$/` for grouping `G` and point `P`.
    private static func isGroupedNumber(_ text: Substring, grouping: Character, point: Character) -> Bool {
        let parts = text.split(separator: point, maxSplits: 1, omittingEmptySubsequences: false)
        let whole = parts[0]
        let fraction = parts.count > 1 ? parts[1] : nil
        if let fraction, !fraction.isEmpty, !ImportInterop.isASCIIDigits(fraction) { return false }
        if whole.isEmpty { return fraction.map { !$0.isEmpty } ?? false }
        if ImportInterop.isASCIIDigits(whole) { return true }
        let groups = whole.split(separator: grouping, omittingEmptySubsequences: false)
        guard groups.count > 1, let first = groups.first, (1...3).contains(first.count),
            groups.allSatisfy(ImportInterop.isASCIIDigits)
        else { return false }
        return groups.dropFirst().allSatisfy { $0.count == 3 }
    }
}

/// One funding movement as the IBKR funding workbook states it (`IbkrFundingFacts`); the
/// fields the reconciliation plan reads.
struct IbkrFundingFacts: Equatable, Sendable {
    let direction: FundingDirection
    /// The request date, which is the staged transaction date.
    let day: String
    /// The date received or processed; the request date when blank.
    let completedDay: String
    let currency: CurrencyCode
    /// A positive magnitude in the movement's own currency.
    let amount: String
    let sourceAccount: String

    private enum Sheet: String {
        case deposit = "Deposit"
        case withdrawal = "Withdrawal"

        var columns: [String] {
            switch self {
            case .deposit:
                return [
                    "Request Date", "Reference Number", "Method", "Account ID", "Account Title",
                    "Delivering Institution", "From Account Number", "Routing Number", "Date Received",
                    "Date Available for Trading", "Date Available for Withdrawal - Original Bank",
                    "Date Available for Withdrawal - Other Bank", "Amount", "Status",
                ]
            case .withdrawal:
                return [
                    "Request Date", "Reference Number", "Method", "Account ID", "Account Title",
                    "Receiving Institution", "Date Processed", "Amount", "Status",
                ]
            }
        }

        var completedColumn: String { self == .deposit ? "Date Received" : "Date Processed" }
    }

    private enum CellKind: String {
        case text
        case number
        case boolean
    }

    private static let envelopeSchema = "ibkr_funding_workbook_row"
    private static let completedStatuses: Set<String> = [
        "available", "sent", "complete", "completed", "processed", "received", "credited", "disbursed",
    ]
    private static let openStatuses: Set<String> = [
        "pending", "processing", "requested", "rejected", "canceled", "cancelled", "failed", "returned", "reversed",
        "expired", "on hold",
    ]

    /// `Intl.supportedValuesOf("currency")` as Bun 1.4 answers it (307 codes). Node's ICU
    /// build lists fewer; Bun is the backend's runtime (ADR-263).
    private static let fundingCurrencies: Set<String> = Set(
        """
        ADP AED AFA AFN ALK ALL AMD ANG AOA AOK AON AOR ARA ARL ARM ARP ARS ATS AUD AWG AZM AZN BAD BAM BAN BBD \
        BDT BEC BEF BEL BGL BGM BGN BGO BHD BIF BMD BND BOB BOL BOP BOV BRB BRC BRE BRL BRN BRR BRZ BSD BTN BUK \
        BWP BYB BYN BYR BZD CAD CDF CHE CHF CHW CLE CLF CLP CNH CNX CNY COP COU CRC CSD CSK CUC CUP CVE CYP CZK \
        DDM DEM DJF DKK DOP DZD ECS ECV EEK EGP ERN ESA ESB ESP ETB EUR FIM FJD FKP FRF GBP GEK GEL GHC GHS GIP \
        GMD GNF GNS GQE GRD GTQ GWE GWP GYD HKD HNL HRD HRK HTG HUF IDR IEP ILP ILR ILS INR IQD IRR ISJ ISK ITL \
        JMD JOD JPY KES KGS KHR KMF KPW KRH KRO KRW KWD KYD KZT LAK LBP LKR LRD LSL LTL LTT LUC LUF LUL LVL LVR \
        LYD MAD MAF MCF MDC MDL MGA MGF MKD MKN MLF MMK MNT MOP MRO MRU MTL MTP MUR MVP MVR MWK MXN MXP MXV MYR \
        MZE MZM MZN NAD NGN NIC NIO NLG NOK NPR NZD OMR PAB PEI PEN PES PGK PHP PKR PLN PLZ PTE PYG QAR RHD ROL \
        RON RSD RUB RUR RWF SAR SBD SCR SDD SDG SDP SEK SGD SHP SIT SKK SLE SLL SOS SRD SRG SSP STD STN SUR SVC \
        SYP SZL THB TJR TJS TMM TMT TND TOP TPE TRL TRY TTD TWD TZS UAH UAK UGS UGX USD USN USS UYI UYP UYU UYW \
        UZS VEB VED VEF VES VND VNN VUV WST XAF XAG XAU XBA XBB XBC XBD XCD XCG XDR XEU XFO XFU XOF XPD XPF XPT \
        XRE XSU XTS XUA XXX YDD YER YUD YUM YUN YUR ZAL ZAR ZMK ZMW ZRN ZRZ ZWD ZWG ZWL ZWR
        """.split(separator: " ").map(String.init))

    /// `ibkrFundingFactsFromRawData`: the movement retained in a staged funding row's
    /// `raw_data`, or `nil` when the value is not such an envelope, the envelope is not one
    /// the adapter would stage, or the request never moved money.
    static func fromRawData(_ rawData: String?) -> IbkrFundingFacts? {
        guard let rawData, rawData.utf16.count <= 200_000, let envelope = JSValue.parse(rawData)?.objectValue,
            envelope["schema"]?.stringValue == envelopeSchema,
            let sheetName = envelope["sheet"]?.stringValue,
            case .number? = envelope["row_number"],
            case .array(let columnValues)? = envelope["columns"],
            case .array(let cellValues)? = envelope["cells"]
        else { return nil }
        var columns: [String] = []
        for value in columnValues {
            guard let name = value.stringValue else { return nil }
            columns.append(name)
        }
        // fundingCellSchema: a typed cell or null.
        var cells: [(kind: CellKind, text: String)?] = []
        for value in cellValues {
            if value == .null {
                cells.append(nil)
                continue
            }
            guard let cell = value.objectValue, let kind = cell["type"]?.stringValue.flatMap(CellKind.init(rawValue:))
            else { return nil }
            switch (kind, cell["value"]) {
            case (.text, .string(let text)?), (.number, .string(let text)?): cells.append((kind, text))
            case (.boolean, .bool?): cells.append((kind, ""))
            default: return nil
            }
        }
        // movement()
        guard let sheet = Sheet(rawValue: sheetName), columns == sheet.columns, cells.count <= columns.count
        else { return nil }
        var record: [String: String] = [:]
        for (index, column) in columns.enumerated() {
            guard let cell = index < cells.count ? cells[index] : nil else {
                record[column] = ""
                continue
            }
            switch cell.kind {
            case .number: record[column] = cell.text
            case .boolean: return nil
            case .text:
                guard cell.text.utf16.count <= 10_000,
                    !cell.text.unicodeScalars.contains(where: { $0.value < 32 && ![9, 10, 13].contains($0.value) })
                else { return nil }
                record[column] = JavaScriptWhitespace.trim(cell.text)
            }
        }
        func field(_ name: String) -> String { record[name] ?? "" }
        for required in ["Request Date", "Reference Number", "Account ID", "Amount", "Status"]
        where field(required).isEmpty {
            return nil
        }
        let account = field("Account ID")
        let status = field("Status").lowercased()
        guard account.wholeMatch(of: /[A-Z][A-Z0-9*\-]{2,49}/) != nil,
            field("Reference Number").wholeMatch(of: /[A-Za-z0-9\-]{1,100}/) != nil,
            !openStatuses.contains(status), completedStatuses.contains(status)
        else { return nil }
        let requested = field("Request Date")
        let completed = field(sheet.completedColumn)
        let completedDay = completed.isEmpty ? requested : completed
        guard ImportInterop.isCalendarDay(requested), ImportInterop.isCalendarDay(completedDay),
            completedDay >= requested,
            let match = field("Amount").wholeMatch(
                of: /([A-Z]{3}) ((?:0|[1-9][0-9]*|[1-9][0-9]{0,2}(?:,[0-9]{3})+)(?:\.[0-9]{1,8})?)/),
            fundingCurrencies.contains(String(match.1)), let currency = CurrencyCode(rawValue: String(match.1)),
            let amount = try? DecimalJS(String(match.2.filter { $0 != "," })),
            amount.gt(.zero), let ceiling = try? DecimalJS("999999999999"), !amount.gt(ceiling)
        else { return nil }
        return IbkrFundingFacts(
            direction: sheet == .deposit ? .deposit : .withdrawal, day: requested, completedDay: completedDay,
            currency: currency, amount: amount.toFixed, sourceAccount: account)
    }
}

// MARK: - Nexo Pro

/// Exact source proof for one staged Nexo Pro Spot fill, as decimal text
/// (`NexoProSpotReconciliationEvidence` of `nexoProTransactionHistoryAdapter.ts`).
struct NexoProSpotEvidence: Equatable, Sendable {
    /// The export's `orderId` cell.
    let sourceOrder: String
    let sourceTimestamp: String
    let side: PortfolioEventKind
    let symbol: String
    let currency: CurrencyCode
    let unitPrice: String
    let grossUnits: String
    let netUnits: String
    let feeUnits: String
    /// `feeCurrency`: the asset the fee was charged in (the base asset or the quote).
    let feeAsset: String
    let quoteFee: String
    let grossQuoteAmount: String
    let amount: String

    private static let columnCount = 14
    private static let fiatQuotes: Set<String> = ["AUD", "CAD", "CHF", "EUR", "GBP", "JPY", "USD"]
    private static let cancelledStatuses: Set<String> = ["cancelled", "canceled"]
    private static let finalStatuses: Set<String> = ["completed", "cancelled", "canceled"]
    private static let orderTypes: Set<String> = [
        "limit", "market", "stop_limit", "stop_market", "stop-limit", "stop-market", "stoploss",
    ]
    /// A cell this far outside the double range (about 1e±308) cannot end in a staged fill:
    /// the adapter refuses values a double cannot hold ("exceeds supported numeric limits").
    /// Refusing it first keeps the exact arithmetic small. Unverified corner: a fee cell
    /// beyond 1e±1000 that an equally extreme price cancels out, which decimal.js would accept.
    private static let exponentLimit = 1000

    private enum Side: String {
        case buy
        case sell
    }

    /// `decimal(value)`: a non-negative plain or exponent decimal cell.
    private static func decimal(_ text: String) -> DecimalJS? {
        guard text.wholeMatch(of: /(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+\-]?[0-9]+)?/) != nil,
            let value = try? DecimalJS(text)
        else { return nil }
        return value
    }

    private static func withinDoubleRange(_ value: DecimalJS) -> Bool {
        value.isZero || Swift.abs(value.exponent + value.coefficient.digitCount) <= exponentLimit
    }

    /// `Number.isFinite(toNumber(value)) && (value.isZero() || toNumber(value) !== 0)`.
    private static func isRepresentable(_ value: DecimalJS) -> Bool {
        let number = value.toNumber
        return number.isFinite && (value.isZero || number != 0)
    }

    /// `getNexoProSpotReconciliationEvidence`: the proof of a literal CSV record, or `nil`
    /// when the record is not a filled buy or sell the adapter would stage.
    static func fromRawData(_ rawData: String?) -> NexoProSpotEvidence? {
        guard var content = rawData else { return nil }
        if content.unicodeScalars.first == "\u{FEFF}" { content = String(content.unicodeScalars.dropFirst()) }
        guard let tuples = try? CSVRecords.parse(content, relaxQuotes: false, relaxColumnCount: false),
            tuples.count == 1, let tuple = tuples.first, tuple.count == columnCount
        else { return nil }
        // id, timestamp, pair, side, type, price, executedPrice, triggerPrice, requestedAmount,
        // filledAmount, tradingFee, feeCurrency, status, orderId
        func cell(_ index: Int) -> String { JavaScriptWhitespace.trim(tuple[index]) }
        let timestamp = cell(1)
        let order = cell(13)
        guard !order.isEmpty, isExportedTimestamp(timestamp) else { return nil }

        // parseRecord: anything but a staged Buy or Sell is no evidence.
        let status = cell(12).lowercased()
        let filledText = cell(9)
        let feeText = cell(10)
        let executionText = cell(6)
        guard let filled = decimal(filledText), let fee = decimal(feeText), let execution = decimal(executionText),
            withinDoubleRange(filled), withinDoubleRange(fee), withinDoubleRange(execution),
            !(cancelledStatuses.contains(status) && filled.isZero),
            finalStatuses.contains(status), !filled.isZero, !execution.isZero,
            orderTypes.contains(cell(4).lowercased()), let side = Side(rawValue: cell(3).lowercased()),
            let pair = cell(2).uppercased().wholeMatch(of: /([A-Z0-9]{2,12})\/([A-Z0-9]{2,12})/)
        else { return nil }
        let base = String(pair.1)
        let quote = String(pair.2)
        let feeAsset = cell(11).uppercased()
        guard base != quote, !fiatQuotes.contains(base), fiatQuotes.contains(quote),
            let currency = CurrencyCode(rawValue: quote), fee.isZero || feeAsset == base || feeAsset == quote
        else { return nil }
        let feeInBase = feeAsset == base
        let feeUnits = feeInBase ? fee : DecimalJS.zero
        let netUnits = side == .buy ? filled.minus(feeUnits) : filled.plus(feeUnits)
        let quoteFee = feeInBase ? fee.times(execution) : fee
        let amount = netUnits.times(execution)
        guard !feeInBase || netUnits.gt(.zero), !(side == .sell && quoteFee.gt(amount)),
            [netUnits, execution, amount, quoteFee].allSatisfy(isRepresentable)
        else { return nil }
        return NexoProSpotEvidence(
            sourceOrder: order, sourceTimestamp: timestamp, side: side == .buy ? .buy : .sell, symbol: base,
            currency: currency, unitPrice: execution.toFixed, grossUnits: filled.toFixed, netUnits: netUnits.toFixed,
            feeUnits: feeUnits.toFixed, feeAsset: feeAsset, quoteFee: quoteFee.toFixed,
            grossQuoteAmount: filled.times(execution).toFixed, amount: amount.toFixed)
    }

    /// `exportedDate(record) !== null`: `YYYY-MM-DD[ T]hh:mm:ss[.fraction][Z]` on a real day.
    private static func isExportedTimestamp(_ text: String) -> Bool {
        guard
            let match = text.wholeMatch(
                of: /([0-9]{4}-[0-9]{2}-[0-9]{2})[ T]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]{1,9})?Z?/),
            let hour = Int(match.2), let minute = Int(match.3), let second = Int(match.4),
            hour <= 23, minute <= 59, second <= 59, let year = Int(match.1.prefix(4))
        else { return false }
        // parseDateWithFormat refuses a two-digit-year misparse (year below 100).
        return year >= 100 && ImportInterop.isCalendarDay(String(match.1))
    }

    /// `nexoProSourceMoneyMatches`: a literal execution value at the four-decimal staging
    /// precision. PostgreSQL NUMERIC rounded ties away from zero; normalized in-memory values
    /// use half-even. Both representations count.
    static func sourceMoneyMatches(literal: String?, staged: String?) throws -> Bool {
        guard let literal, let staged else { return false }
        let stagedValue = try DecimalJS.from(staged).toDecimalPlaces(4, .halfEven)
        let literalValue = try DecimalJS.from(literal)
        return literalValue.toDecimalPlaces(4, .halfEven).eq(stagedValue)
            || literalValue.toDecimalPlaces(4, .halfUp).eq(stagedValue)
    }
}

// MARK: - Kinesis

/// Kinesis yield distributions under the zero yield-basis policy
/// (`portfolioImportPipeline/kinesisInKindIncome.ts`).
enum KinesisInKindIncome {
    private static let zeroPolicy = "zero"
    private static let incomeSuffix = ":income"
    private static let unitsSuffix = ":units"

    /// `isZeroYieldKinesisBatch`: a Kinesis batch that stages yield units at zero basis.
    static func isZeroYieldBatch(_ config: StoredBatchConfig?) -> Bool {
        config.fieldsFormat == .kinesisTransactionHistory
            && config?.fields["yield_basis_policy"]?.stringValue == zeroPolicy
    }

    /// Whether `row` is an `:income` dividend, whichever batch staged it.
    static func isIncomeDividend(_ row: ReconciliationSourceRow) -> Bool {
        row.kind == .dividend && row.sourceReference?.hasSuffix(incomeSuffix) == true
    }

    /// `kinesisInKindIncomeRowIds`: the `:income` dividends whose `:units` gift is staged in
    /// the same batch. Call only with the rows of one zero yield-basis Kinesis batch.
    static func incomeRowIDs(_ rows: [ReconciliationSourceRow]) -> Set<PortfolioImportRowID> {
        var units = Set<String>()
        for row in rows where row.kind == .gift {
            guard let reference = row.sourceReference, reference.hasSuffix(unitsSuffix), let hash = row.sourceRecordHash
            else { continue }
            units.insert("\(reference)|\(hash)")
        }
        var ids = Set<PortfolioImportRowID>()
        for row in rows where isIncomeDividend(row) {
            guard let reference = row.sourceReference else { continue }
            let unitsReference = String(reference.dropLast(incomeSuffix.count)) + unitsSuffix
            if units.contains("\(unitsReference)|\(row.sourceRecordHash ?? "null")") { ids.insert(row.id) }
        }
        return ids
    }
}
