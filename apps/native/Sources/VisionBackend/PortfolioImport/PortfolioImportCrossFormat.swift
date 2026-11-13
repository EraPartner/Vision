import Foundation
import VisionNativeCore

/// The pre-read ledger evidence the cross-format decisions are pure over.
struct CrossFormatContext: Equatable, Sendable {
    /// Settled rows of other batches whose ledger event still exists.
    var ledgerSources: [CrossFormatLedgerSourceRow] = []
    /// `version:fingerprint` identities an active cash transaction carries.
    var cashFingerprints: Set<String> = []
    /// Identities of base-currency rows a funding correction replaced.
    var correctedAliases: Set<String> = []
    /// Active cash transactions on the selected accounts that no import owns.
    var manualCash: [ManualCashCandidateRow] = []
    /// Identities an earlier review settled as recorded by another export.
    var settledIdentities: Set<String> = []
}

/// The date, amount and currency of an existing brokerage cash transaction.
struct CashLedgerValues: Equatable, Sendable {
    var day: String
    var amount: String
    var currency: CurrencyCode
}

/// An amount in its currency.
struct CashValue: Equatable, Sendable {
    var amount: String
    var currency: CurrencyCode
}

/// A planned change to an existing cash transaction: a funding correction, or a manual
/// entry that gains the row's source identity.
struct CashAdoptionDecision: Equatable, Sendable {
    enum Reason: String, Sendable {
        case ibkrNativeFunding = "ibkr_native_funding"
        case manualCash = "manual_cash"
    }

    /// The committed staging row whose transaction is corrected.
    struct Original: Equatable, Sendable {
        var batchID: PortfolioImportBatchNumericID
        var stagingRowID: PortfolioImportRowID
    }

    var reason: Reason
    var transactionID: LedgerTransactionID
    var policy: AdoptionPolicy
    var existing: CashLedgerValues
    /// The corrected amount and currency (unchanged for manual cash).
    var after: CashValue
    var original: Original?
}

/// What one staged row becomes because another source already holds it.
enum CrossFormatDecision: Equatable, Sendable {
    /// Another staged row of the plan records the event. `policy` is `.preferSource` when
    /// the statement policy paired a near match.
    case duplicateSource(rowID: PortfolioImportRowID, policy: AdoptionPolicy?)
    case duplicate(transactionID: LedgerTransactionID, policy: AdoptionPolicy?)
    case adoptCash(CashAdoptionDecision)
    case policyRequired(transactionID: LedgerTransactionID, existing: CashLedgerValues)
    case blocked(reason: ReconciliationBlockReason, candidateTransactionIDs: [LedgerTransactionID])
    /// The owner chose to keep this row apart from its near match: it imports through the
    /// ordinary path, which must not offer these ledger transactions as its likely copy again.
    case keptApart(transactionIDs: [LedgerTransactionID])
}

/// One broker event can reach Vision through more than one export (ADR-236 amendment):
/// Saxo's CSV and detailed XLSX transaction histories, IBKR's Transaction History CSV and
/// its funding workbook, or an entry the owner typed by hand. This decides, purely over
/// pre-read rows, which staged row is already recorded by another source, so that no
/// combination or order of imports counts an event twice. A port of
/// `services/portfolioImportCrossFormat.ts` (ADR-270).
///
/// - Saxo: both exports carry the booking record id of the same account. That pair is the
///   cross-format source identity; the workbook row is preferred.
/// - IBKR funding: the formats share no id. A CSV deposit or withdrawal and a workbook
///   movement are one event when account, direction, date and amount (workbook amount times
///   the CSV exchange rate) agree. The workbook keeps the movement's own currency, so it is
///   preferred, and it corrects a base currency deposit that an earlier CSV import recorded.
/// - Manual cash: an active cash transaction that no import owns, on the same account with
///   the same currency and signed amount, is adopted instead of duplicated.
///
/// Rows that several candidates could explain are blocked for review instead of being
/// paired by guess; indistinguishable rows pair by count.
enum PortfolioImportCrossFormat {
    /// Manual entries within this many days may record the same movement.
    private static let manualCashDays = 7.0
    /// A CSV funding movement this many days outside its workbook twin's request and
    /// completion dates, with the same value, may still be the same movement. Such a near
    /// match is never paired or kept apart without the owner's choice.
    private static let nearFundingDays = 10.0

    private static let saxoWorkbookPrefix = #"{"format":"saxo_xlsx_v1""#
    private static let bookingRecordHeader = "Bk Record Id"
    private static let ownIDHeaders: Set<String> = ["Transactie-ID", "Booking Id"]
    private static let transactionHistorySection = "Transaction History"
    private static let dataDiscriminator = "Data"

    // MARK: Shared readers

    /// `cellText(value).trim().replace(/^-$/, "").toUpperCase()`.
    private static func text(_ value: String?) -> String {
        let trimmed = JavaScriptWhitespace.trim(value ?? "")
        return trimmed.utf8.elementsEqual("-".utf8) ? "" : trimmed.uppercased()
    }

    private static func isZeros(_ text: String) -> Bool {
        !text.isEmpty && text.utf8.allSatisfy { $0 == UInt8(ascii: "0") }
    }

    private static func sameNumber(_ left: DecimalJS?, _ right: DecimalJS?, _ places: Int) -> Bool {
        guard let left, let right else { return false }
        return left.toDecimalPlaces(places).eq(right.toDecimalPlaces(places))
    }

    private static func decimal(_ text: String?) throws -> DecimalJS? {
        try text.map { try DecimalJS.from($0) }
    }

    /// The ledger sign of a cash row: deposits and income in, the rest out
    /// (`signedCashAmount`).
    static func signedCashAmount(_ row: some CrossFormatSource) throws -> DecimalJS {
        let direction = BrokerageRouting.instrumentLessCashDirection(kind: row.kind?.rawValue ?? row.kindRaw)
        return try DecimalJS.from(row.amount).abs.times(DecimalJS(direction ?? 1))
    }

    /// Pairs rows with candidates one to one (`pairUnique`). Rows whose candidate sets
    /// coincide and are matched back by exactly those rows are indistinguishable: they pair
    /// in order, up to the smaller count. Any partial overlap is ambiguous.
    static func pairUnique<Left, Right>(
        _ left: [Left], _ right: [Right], _ match: (Left, Right) throws -> Bool
    ) rethrows -> (pairs: [(Left, Right)], ambiguous: [Left], ambiguousRight: [Right]) {
        var candidates: [[Int]] = []
        for row in left {
            candidates.append(try right.indices.filter { try match(row, right[$0]) })
        }
        var owners = Array(repeating: [Int](), count: right.count)
        for (row, set) in candidates.enumerated() {
            for candidate in set { owners[candidate].append(row) }
        }
        // Groups keep the order their first row appears in.
        var groupOrder: [[Int]] = []
        var groupRows: [[Int]: [Int]] = [:]
        for (row, set) in candidates.enumerated() where !set.isEmpty {
            if groupRows[set] == nil { groupOrder.append(set) }
            groupRows[set, default: []].append(row)
        }
        var pairs: [(Left, Right)] = []
        var ambiguous: [Int] = []
        var ambiguousRight: [Int] = []
        for set in groupOrder {
            let rows = groupRows[set] ?? []
            let exact = set.allSatisfy { owners[$0] == rows }
            guard exact else {
                for row in rows where !ambiguous.contains(row) { ambiguous.append(row) }
                for candidate in set where !ambiguousRight.contains(candidate) { ambiguousRight.append(candidate) }
                continue
            }
            for index in 0..<min(rows.count, set.count) { pairs.append((left[rows[index]], right[set[index]])) }
        }
        return (pairs, ambiguous.map { left[$0] }, ambiguousRight.map { right[$0] })
    }

    // MARK: Saxo

    /// What the Saxo rules read from one row, computed once: its key re-parses the record.
    private struct SaxoFacts {
        let isSaxo: Bool
        let isWorkbook: Bool
        /// The booking record of one Saxo account, whichever export staged it (`saxoKey`).
        let key: String?

        init(_ row: some CrossFormatSource) {
            isSaxo = row.customConfig.fieldsFormat == .saxoTransactionHistory
            isWorkbook = PortfolioImportCrossFormat.isSaxoWorkbookRow(row)
            guard isSaxo, let account = row.optionalAccountID else {
                key = nil
                return
            }
            let identity = PortfolioImportCrossFormat.text(row.sourceAccountIdentity)
            let record = PortfolioImportCrossFormat.saxoBookingRecord(row)
            key = identity.isEmpty || record.isEmpty ? nil : "\(account)\u{0}\(identity)\u{0}\(record)"
        }
    }

    private static func isSaxoWorkbookRow(_ row: some CrossFormatSource) -> Bool {
        row.rawData?.hasPrefix(saxoWorkbookPrefix) == true
    }

    /// The row's literal `Bk Record Id`. The workbook joins its sheets on it, so its source id
    /// is always that record. A CSV row falls back to `Transactie-ID` or `Booking Id` for its
    /// own identity when the record id is blank; those ids are not the workbook's, so only
    /// the literal CSV cell counts here.
    private static func saxoBookingRecord(_ row: some CrossFormatSource) -> String {
        if isSaxoWorkbookRow(row) { return text(row.sourceReference) }
        guard let columns = row.customConfig.sourceColumns, let rawData = row.rawData,
            let records = try? CSVRecords.parse(rawData, relaxQuotes: true, relaxColumnCount: true)
        else { return "" }
        // `\s` covers the byte-order mark and the no-break spaces Saxo writes.
        var column: Int?
        for (index, header) in columns.enumerated() {
            // A header that is not text fails the whole read, as the TypeScript `replace` throws.
            guard let name = header.stringValue else { return "" }
            if ImportInterop.headerName(name) == bookingRecordHeader {
                column = index
                break
            }
        }
        guard records.count == 1, let column, let cells = records.first else { return "" }
        let record = text(column < cells.count ? cells[column] : nil)
        return isZeros(record) ? "" : record
    }

    /// The source id of a Saxo CSV row from a batch that kept no source columns, keyed like
    /// `SaxoFacts.key`. Such a row cannot show which column its id came from: the adapter
    /// takes `Bk Record Id`, else `Transactie-ID`, else `Booking Id`. It is the booking record
    /// only once a workbook row proves it (see `saxoWorkbookRecordIsOwnID`).
    private static func saxoLegacyCSVKey(_ row: some CrossFormatSource, _ facts: SaxoFacts) -> String? {
        guard facts.isSaxo, !facts.isWorkbook, let account = row.optionalAccountID, row.customConfig.sourceColumns == nil
        else { return nil }
        let identity = text(row.sourceAccountIdentity)
        let record = text(row.sourceReference)
        return identity.isEmpty || record.isEmpty || isZeros(record) ? nil : "\(account)\u{0}\(identity)\u{0}\(record)"
    }

    /// Whether a workbook row's booking record id is none of its own `Transactie-ID` or
    /// `Booking Id` values. Then a CSV row of the same event whose id equals that record id
    /// can only have taken it from `Bk Record Id`.
    private static func saxoWorkbookRecordIsOwnID(_ row: ReconciliationSourceRow) -> Bool {
        guard isSaxoWorkbookRow(row), let rawData = row.rawData,
            case .array(let records)? = JSValue.parse(rawData)?.objectValue?["records"], !records.isEmpty
        else { return false }
        // Any other shape (a record without header and cell arrays) cannot name the row's
        // own ids: not "own id".
        var others = Set<String>()
        for item in records {
            guard let record = item.objectValue, case .array(let headers)? = record["headers"],
                case .array(let cells)? = record["cells"]
            else { return false }
            for (index, header) in headers.enumerated()
            where ownIDHeaders.contains(ImportInterop.headerName(header.javaScriptString)) {
                others.insert(text(index < cells.count ? ImportInterop.cellText(cells[index]) : nil))
            }
        }
        let record = text(row.sourceReference)
        return !record.isEmpty && !others.contains(record)
    }

    /// A Saxo cash movement's direction: 1 in, -1 out, `nil` otherwise.
    private static func saxoCashDirection(_ row: some CrossFormatSource) -> Int? {
        BrokerageRouting.instrumentLessCashDirection(kind: row.kind?.rawValue ?? row.kindRaw)
    }

    private static func isTruthy(_ label: (some OpenLabel)?) -> Bool {
        label.map { !$0.rawValue.isEmpty } ?? false
    }

    /// Facts both Saxo exports state identically for one booking record.
    private static func saxoConsistent(_ row: some CrossFormatSource, _ other: some CrossFormatSource) throws -> Bool {
        if row.day != other.day { return false }
        if isTruthy(row.route), isTruthy(other.route), row.route != other.route { return false }
        if isTruthy(row.kind), isTruthy(other.kind), row.kind != other.kind { return false }
        if let investment = row.investmentID, let otherInvestment = other.investmentID, investment != otherInvestment {
            return false
        }
        if let units = row.units, let otherUnits = other.units {
            return sameNumber(try DecimalJS.from(units), try DecimalJS.from(otherUnits), 8)
        }
        if row.route == .cash, other.route == .cash {
            guard row.currency == other.currency else { return false }
            return sameNumber(try DecimalJS.from(row.amount).abs, try DecimalJS.from(other.amount).abs, 4)
        }
        return true
    }

    // MARK: IBKR funding

    /// A Transaction History deposit or withdrawal, re-read from its literal record.
    private struct IbkrCSVFunding {
        private enum Label: String {
            case deposit = "Deposit"
            case withdrawal = "Withdrawal"
        }

        let direction: FundingDirection
        let day: String
        let account: String
        let currency: CurrencyCode
        let base: DecimalJS
        let rate: DecimalJS

        init?(_ row: some CrossFormatSource) {
            guard row.customConfig.fieldsFormat == .ibkrTransactionHistory, row.route == .cash, let day = row.day,
                !day.isEmpty, let columns = row.customConfig.sourceColumns, let rawData = row.rawData,
                let records = try? CSVRecords.parse(rawData, relaxQuotes: true, relaxColumnCount: true),
                records.count == 1, let values = records.first, values.count >= 2,
                values[0] == PortfolioImportCrossFormat.transactionHistorySection,
                values[1] == PortfolioImportCrossFormat.dataDiscriminator
            else { return nil }
            // `values[columns.indexOf(name) + 2]`: a missing column reads index 1.
            func field(_ name: String) -> String {
                let index = (columns.firstIndex(of: .string(name)) ?? -1) + 2
                let cell = JavaScriptWhitespace.trim(index < values.count ? values[index] : "")
                return cell.utf8.elementsEqual("-".utf8) ? "" : cell
            }
            guard let label = Label(rawValue: field("Transaction Type")),
                let gross = IbkrStatementNumber.parse(field("Gross Amount")), gross != 0,
                let rate = IbkrStatementNumber.parse(field("Exchange Rate")), rate > 0, let currency = row.currency,
                let base = try? DecimalJS(gross).abs, let exactRate = try? DecimalJS(rate)
            else { return nil }
            direction = label == .deposit ? .deposit : .withdrawal
            self.day = day
            account = field("Account")
            self.currency = currency
            self.base = base
            self.rate = exactRate
        }
    }

    private static func ibkrFunding(_ row: some CrossFormatSource) -> IbkrFundingFacts? {
        row.customConfig.fieldsFormat == .ibkrFundingHistory && row.route == .cash
            ? IbkrFundingFacts.fromRawData(row.rawData) : nil
    }

    /// Full account equality, or a masked account with at least four literal digits.
    private static func ibkrAccountsMatch(_ left: String, _ right: String) -> Bool {
        let a = text(left)
        let b = text(right)
        if a.isEmpty || b.isEmpty { return false }
        if a == b { return true }
        // mask: `/^[UX*]+\d{4,}$/` with an `X` or `*`; full: `/^U\d+$/`.
        func masked(_ mask: String, _ full: String) -> Bool {
            let prefix = mask.prefix { "UX*".contains($0) }
            let suffix = mask[prefix.endIndex...]
            guard !prefix.isEmpty, prefix.contains(where: { $0 != "U" }), suffix.count >= 4,
                ImportInterop.isASCIIDigits(suffix), full.hasPrefix("U"), ImportInterop.isASCIIDigits(full.dropFirst())
            else { return false }
            return full.hasSuffix(suffix)
        }
        return masked(a, b) || masked(b, a)
    }

    /// Same direction, account and value (workbook amount at the CSV rate).
    private static func ibkrSameValue(_ csv: IbkrCSVFunding, _ funding: IbkrFundingFacts) throws -> Bool {
        guard csv.direction == funding.direction, ibkrAccountsMatch(csv.account, funding.sourceAccount) else {
            return false
        }
        let expected = try DecimalJS.from(funding.amount).times(funding.currency == csv.currency ? .one : csv.rate)
        let tolerance = DecimalJS.max(try DecimalJS("0.01"), csv.base.times(try DecimalJS("0.0001")))
        return expected.minus(csv.base).abs.lte(tolerance)
    }

    /// One movement: same value, dated within its request and completion.
    private static func ibkrSameMovement(_ csv: IbkrCSVFunding, _ funding: IbkrFundingFacts) throws -> Bool {
        try csv.day >= funding.day && csv.day <= funding.completedDay && ibkrSameValue(csv, funding)
    }

    /// Same value, dated outside the request and completion but close to them.
    private static func ibkrNearMovement(_ csv: IbkrCSVFunding, _ funding: IbkrFundingFacts) throws -> Bool {
        let outside =
            csv.day < funding.day
            ? ImportInterop.dayDistance(csv.day, funding.day)
            : (csv.day > funding.completedDay ? ImportInterop.dayDistance(csv.day, funding.completedDay) : 0)
        return try outside > 0 && outside <= nearFundingDays && ibkrSameValue(csv, funding)
    }

    // MARK: Decisions

    private struct Staged {
        let row: ReconciliationSourceRow
        let saxo: SaxoFacts
    }

    private struct Ledger {
        let source: CrossFormatLedgerSourceRow
        let saxo: SaxoFacts
    }

    private struct StagedCSV {
        let index: Int
        let row: ReconciliationSourceRow
        let facts: IbkrCSVFunding
    }

    private struct StagedFunding {
        let index: Int
        let row: ReconciliationSourceRow
        let facts: IbkrFundingFacts
    }

    private struct LedgerFunding {
        let index: Int
        let source: CrossFormatLedgerSourceRow
        let facts: IbkrFundingFacts
    }

    private struct LedgerCSV {
        let index: Int
        let source: CrossFormatLedgerSourceRow
        let facts: IbkrCSVFunding
    }

    private enum IdentityChoice {
        case pair(policy: AdoptionPolicy?)
        case keep
    }

    /// `planCrossFormatSources`.
    /// - Parameters:
    ///   - policyOf: the statement policy that applies to a row, if its reviewer chose one.
    ///   - rowChoiceOf: the owner's answer for one row (`row_choices`).
    static func plan(
        rows: [ReconciliationSourceRow], context: CrossFormatContext,
        policyOf: (ReconciliationSourceRow) -> AdoptionPolicy?,
        rowChoiceOf: (ReconciliationSourceRow) -> RowChoiceAnswer? = { _ in nil }
    ) throws -> [PortfolioImportRowID: CrossFormatDecision] {
        var decisions: [PortfolioImportRowID: CrossFormatDecision] = [:]
        func decide(_ row: ReconciliationSourceRow, _ decision: CrossFormatDecision) {
            if decisions[row.id] == nil { decisions[row.id] = decision }
        }
        func block(
            _ row: ReconciliationSourceRow, _ reason: ReconciliationBlockReason, _ ids: [LedgerTransactionID] = []
        ) {
            decide(row, .blocked(reason: reason, candidateTransactionIDs: ids))
        }
        let open = rows.filter { !$0.status.isSettled }.map { Staged(row: $0, saxo: SaxoFacts($0)) }
        let ledgers = context.ledgerSources.map { Ledger(source: $0, saxo: SaxoFacts($0)) }
        func inCashLedger(_ row: ReconciliationSourceRow) -> Bool {
            guard let identity = row.identity else { return false }
            return context.cashFingerprints.contains(identity) || context.correctedAliases.contains(identity)
        }
        let ledgerIdentities = Set(context.ledgerSources.compactMap(\.identity))
        /// Whether the statement policy records a likely pair once: a row an earlier review
        /// already settled keeps that pairing, otherwise every selected statement that chose
        /// a policy chose `prefer_source`. `preserve_existing` never keeps such a pair apart:
        /// the policy may have been chosen for unrelated rows, and keeping both could count
        /// one event twice.
        func pairedByPolicy(_ pair: [ReconciliationSourceRow]) -> Bool {
            if pair.contains(where: { $0.identity.map(context.settledIdentities.contains) ?? false }) { return true }
            let chosen = Set(pair.compactMap(policyOf).filter(\.isReviewerChoice))
            return chosen == [.preferSource]
        }
        /// The owner's choice for a likely pair that no source fact settles: a Saxo pair that
        /// only lacks a booking record id, or an IBKR funding movement dated just outside its
        /// workbook twin's window. Only a per-row answer decides it (`same_transaction` pairs,
        /// `keep_both` keeps both), or `prefer_source`, which records the pair once. A per-row
        /// answer outranks the statement policy; answers that disagree across the pair leave
        /// it blocked.
        func identityChoice(_ pair: ReconciliationSourceRow...) -> IdentityChoice? {
            let answers = Set(pair.compactMap(rowChoiceOf))
            if answers.isEmpty { return pairedByPolicy(pair) ? .pair(policy: .preferSource) : nil }
            guard answers.count == 1 else { return nil }
            return answers.contains(.sameTransaction) ? .pair(policy: nil) : .keep
        }
        /// Rows the owner chose to keep apart from their near match.
        var kept: [PortfolioImportRowID: [LedgerTransactionID]] = [:]
        func keep(_ row: ReconciliationSourceRow, _ transactionIDs: [LedgerTransactionID] = []) {
            kept[row.id, default: []].append(contentsOf: transactionIDs)
        }
        func undecided(_ row: ReconciliationSourceRow) -> Bool { decisions[row.id] == nil && kept[row.id] == nil }

        // Saxo: one booking record, whichever export staged it.
        var workbooks: [String: ReconciliationSourceRow] = [:]
        for item in open {
            if let key = item.saxo.key, item.saxo.isWorkbook, workbooks[key] == nil { workbooks[key] = item.row }
        }
        var saxoLedger: [String: [CrossFormatLedgerSourceRow]] = [:]
        var saxoLegacyLedger: [String: [CrossFormatLedgerSourceRow]] = [:]
        for item in ledgers {
            if let key = item.saxo.key { saxoLedger[key, default: []].append(item.source) }
            if let legacyKey = saxoLegacyCSVKey(item.source, item.saxo) {
                saxoLegacyLedger[legacyKey, default: []].append(item.source)
            }
        }
        for item in open {
            guard let key = item.saxo.key else { continue }
            let row = item.row
            if let primary = workbooks[key], primary.id != row.id, !item.saxo.isWorkbook {
                if try saxoConsistent(row, primary) {
                    decide(row, .duplicateSource(rowID: primary.id, policy: nil))
                } else {
                    block(row, .crossFormatSourceConflict)
                }
                continue
            }
            let proven = saxoLedger[key] ?? []
            // A CSV recorded before batches kept their source columns counts only when this
            // workbook row proves its id is the booking record. Otherwise it stays a keyless
            // twin below.
            let recorded = proven.isEmpty && saxoWorkbookRecordIsOwnID(row) ? (saxoLegacyLedger[key] ?? []) : proven
            // The same export repeated keeps its ordinary fingerprint duplicate path.
            guard let first = recorded.first, !recorded.contains(where: { $0.identity == row.identity }) else {
                continue
            }
            if try recorded.allSatisfy({ try saxoConsistent(row, $0) }) {
                decide(row, .duplicate(transactionID: first.transactionID, policy: nil))
            } else {
                var ids: [LedgerTransactionID] = []
                for source in recorded where !ids.contains(source.transactionID) { ids.append(source.transactionID) }
                block(row, .crossFormatSourceConflict, ids)
            }
        }

        // Saxo rows without a booking record id cannot be paired by identity. An otherwise
        // identical CSV and workbook row is still one event unless the owner says otherwise,
        // so it blocks for that choice instead of importing twice (the CSV books instrument
        // currency, the workbook account currency, so their fingerprints differ).
        func saxoTwins(
            _ left: ReconciliationSourceRow, _ leftFacts: SaxoFacts, _ right: some CrossFormatSource,
            _ rightFacts: SaxoFacts
        ) throws -> Bool {
            guard leftFacts.isSaxo, rightFacts.isSaxo, leftFacts.isWorkbook != rightFacts.isWorkbook,
                leftFacts.key == nil || rightFacts.key == nil, let account = left.accountID,
                account == right.optionalAccountID,
                text(left.sourceAccountIdentity) == text(right.sourceAccountIdentity), left.identity != right.identity,
                isTruthy(left.route), left.route == right.route
            else { return false }
            // Deposits and withdrawals carry no portfolio type: pair them by direction.
            if left.route == .cash {
                guard let direction = saxoCashDirection(left), direction == saxoCashDirection(right) else { return false }
            } else {
                guard isTruthy(left.kind), left.kind == right.kind else { return false }
            }
            if left.route == .portfolio, left.investmentID == nil || right.investmentID == nil { return false }
            guard (left.units == nil) == (right.units == nil) else { return false }
            return try saxoConsistent(left, right)
        }
        let saxoUnpaired = open.filter {
            $0.saxo.isSaxo && $0.row.status == .matched && undecided($0.row)
                && !ledgerIdentities.contains($0.row.identity ?? "")
        }
        let saxoInPlan = try pairUnique(
            saxoUnpaired.filter { !$0.saxo.isWorkbook }, saxoUnpaired.filter(\.saxo.isWorkbook)
        ) { try saxoTwins($0.row, $0.saxo, $1.row, $1.saxo) }
        for (csvItem, workbookItem) in saxoInPlan.pairs {
            switch identityChoice(csvItem.row, workbookItem.row) {
            case .pair(let policy)?: decide(csvItem.row, .duplicateSource(rowID: workbookItem.row.id, policy: policy))
            case .keep?:
                keep(csvItem.row)
                keep(workbookItem.row)
            case nil:
                block(csvItem.row, .crossFormatIdentityMissing)
                block(workbookItem.row, .crossFormatIdentityMissing)
            }
        }
        // With several look-alikes only keeping the row apart is a clear answer.
        for item in saxoInPlan.ambiguous + saxoInPlan.ambiguousRight {
            if rowChoiceOf(item.row) == .keepBoth { keep(item.row) } else { block(item.row, .crossFormatIdentityAmbiguous) }
        }
        let saxoLedgerRows = ledgers.enumerated().filter { index, item in
            item.saxo.isSaxo
                && ledgers.firstIndex {
                    $0.source.ledger == item.source.ledger && $0.source.transactionID == item.source.transactionID
                } == index
        }.map(\.element)
        let saxoToLedger = try pairUnique(saxoUnpaired.filter { undecided($0.row) }, saxoLedgerRows) {
            try saxoTwins($0.row, $0.saxo, $1.source, $1.saxo)
        }
        for (item, ledger) in saxoToLedger.pairs {
            let transactionID = ledger.source.transactionID
            switch identityChoice(item.row) {
            case .pair(let policy)?: decide(item.row, .duplicate(transactionID: transactionID, policy: policy))
            case .keep?: keep(item.row, [transactionID])
            case nil: block(item.row, .crossFormatIdentityMissing, [transactionID])
            }
        }
        let saxoLedgerCandidates = saxoToLedger.ambiguousRight.map(\.source.transactionID)
        for item in saxoToLedger.ambiguous {
            if rowChoiceOf(item.row) == .keepBoth {
                keep(item.row, saxoLedgerCandidates)
            } else {
                block(item.row, .crossFormatIdentityAmbiguous, saxoLedgerCandidates)
            }
        }

        // IBKR funding: CSV base-currency movements and native workbook movements.
        var csv: [StagedCSV] = []
        var funding: [StagedFunding] = []
        for item in open {
            let row = item.row
            if decisions[row.id] != nil || row.status != .matched || inCashLedger(row) { continue }
            if let facts = IbkrCSVFunding(row) { csv.append(StagedCSV(index: csv.count, row: row, facts: facts)) }
            if let facts = ibkrFunding(row) {
                funding.append(StagedFunding(index: funding.count, row: row, facts: facts))
            }
        }
        func sameAccount(_ left: AccountID?, _ right: AccountID?) -> Bool {
            guard let left else { return false }
            return left == right
        }
        let inPlan = try pairUnique(csv, funding) {
            try sameAccount($0.row.accountID, $1.row.accountID) && ibkrSameMovement($0.facts, $1.facts)
        }
        for (left, right) in inPlan.pairs { decide(left.row, .duplicateSource(rowID: right.row.id, policy: nil)) }
        for item in inPlan.ambiguous { block(item.row, .ambiguousFundingHistory) }
        for item in inPlan.ambiguousRight { block(item.row, .ambiguousFundingHistory) }
        // The first cash ledger source per transaction.
        var distinctCashLedger: [CrossFormatLedgerSourceRow] = []
        for source in context.ledgerSources where source.ledger == .cash {
            if !distinctCashLedger.contains(where: { $0.transactionID == source.transactionID }) {
                distinctCashLedger.append(source)
            }
        }
        var ledgerFunding: [LedgerFunding] = []
        for source in distinctCashLedger {
            if let facts = ibkrFunding(source) {
                ledgerFunding.append(LedgerFunding(index: ledgerFunding.count, source: source, facts: facts))
            }
        }
        let toLedger = try pairUnique(csv.filter { decisions[$0.row.id] == nil }, ledgerFunding) {
            try sameAccount($0.row.accountID, $1.source.accountID) && ibkrSameMovement($0.facts, $1.facts)
        }
        for (left, right) in toLedger.pairs {
            decide(left.row, .duplicate(transactionID: right.source.transactionID, policy: nil))
        }
        let toLedgerCandidates = toLedger.ambiguousRight.map(\.source.transactionID)
        for item in toLedger.ambiguous { block(item.row, .ambiguousFundingHistory, toLedgerCandidates) }
        // A base-currency deposit that an earlier CSV import recorded and that no funding
        // correction has replaced yet.
        var ledgerCSV: [LedgerCSV] = []
        for source in distinctCashLedger {
            if let facts = IbkrCSVFunding(source) {
                ledgerCSV.append(LedgerCSV(index: ledgerCSV.count, source: source, facts: facts))
            }
        }
        /// The ledger still shows what the CSV said (its amount and currency); anything else
        /// was edited since.
        func uneditedLedgerValue(_ item: LedgerCSV) throws -> CashValue? {
            guard let currency = item.source.ledgerCurrency, currency == item.facts.currency,
                let amount = item.source.ledgerAmount,
                sameNumber(try DecimalJS.from(amount), item.facts.base.times(item.facts.direction.sign), 4)
            else { return nil }
            return CashValue(amount: amount, currency: currency)
        }
        /// The funding workbook row corrects the base-currency deposit the CSV recorded.
        func correct(_ left: StagedFunding, _ right: LedgerCSV) throws {
            let transactionID = right.source.transactionID
            guard let ledgerValue = try uneditedLedgerValue(right) else {
                // Neither overwrite the edit nor record the movement a second time.
                block(left.row, .crossFormatSourceConflict, [transactionID])
                return
            }
            decide(
                left.row,
                .adoptCash(
                    CashAdoptionDecision(
                        reason: .ibkrNativeFunding, transactionID: transactionID, policy: .preferSource,
                        existing: CashLedgerValues(
                            day: right.source.ledgerDay ?? right.facts.day, amount: ledgerValue.amount,
                            currency: ledgerValue.currency),
                        after: CashValue(
                            amount: try DecimalJS.from(left.facts.amount).times(left.facts.direction.sign).toFixed,
                            currency: left.facts.currency),
                        original: .init(batchID: right.source.batchID, stagingRowID: right.source.id))))
        }
        let corrections = try pairUnique(funding.filter { decisions[$0.row.id] == nil }, ledgerCSV) {
            try sameAccount($0.row.accountID, $1.source.accountID) && ibkrSameMovement($1.facts, $0.facts)
        }
        for (left, right) in corrections.pairs { try correct(left, right) }
        let correctionCandidates = corrections.ambiguousRight.map(\.source.transactionID)
        for item in corrections.ambiguous { block(item.row, .ambiguousFundingHistory, correctionCandidates) }

        // Near matches: the same value, but the CSV date lies just outside the workbook's
        // request and completion dates. They are never imported twice or merged silently; the
        // owner decides as for a Saxo pair without a booking record id (identityChoice). With
        // several look-alikes only keeping the row apart is a clear answer.
        let pairedFunding = Set(inPlan.pairs.map(\.1.index))
        let claimedFunding = Set(toLedger.pairs.map(\.1.index))
        let claimedCSV = Set(corrections.pairs.map(\.1.index))
        func nearAmbiguous(_ rows: [ReconciliationSourceRow], _ ids: [LedgerTransactionID] = []) {
            for row in rows {
                if rowChoiceOf(row) == .keepBoth { keep(row, ids) } else { block(row, .fundingDateAmbiguous, ids) }
            }
        }
        let nearInPlan = try pairUnique(
            csv.filter { undecided($0.row) }, funding.filter { undecided($0.row) && !pairedFunding.contains($0.index) }
        ) { try sameAccount($0.row.accountID, $1.row.accountID) && ibkrNearMovement($0.facts, $1.facts) }
        for (left, right) in nearInPlan.pairs {
            switch identityChoice(left.row, right.row) {
            case .pair(let policy)?: decide(left.row, .duplicateSource(rowID: right.row.id, policy: policy))
            case .keep?:
                keep(left.row)
                keep(right.row)
            case nil:
                block(left.row, .fundingDateMismatch)
                block(right.row, .fundingDateMismatch)
            }
        }
        nearAmbiguous(nearInPlan.ambiguous.map(\.row) + nearInPlan.ambiguousRight.map(\.row))
        let nearToLedger = try pairUnique(
            csv.filter { undecided($0.row) }, ledgerFunding.filter { !claimedFunding.contains($0.index) }
        ) { try sameAccount($0.row.accountID, $1.source.accountID) && ibkrNearMovement($0.facts, $1.facts) }
        for (left, right) in nearToLedger.pairs {
            let transactionID = right.source.transactionID
            switch identityChoice(left.row) {
            case .pair(let policy)?: decide(left.row, .duplicate(transactionID: transactionID, policy: policy))
            case .keep?: keep(left.row, [transactionID])
            case nil: block(left.row, .fundingDateMismatch, [transactionID])
            }
        }
        nearAmbiguous(nearToLedger.ambiguous.map(\.row), nearToLedger.ambiguousRight.map(\.source.transactionID))
        let nearCorrections = try pairUnique(
            funding.filter { undecided($0.row) && !pairedFunding.contains($0.index) },
            ledgerCSV.filter { !claimedCSV.contains($0.index) }
        ) { try sameAccount($0.row.accountID, $1.source.accountID) && ibkrNearMovement($1.facts, $0.facts) }
        for (left, right) in nearCorrections.pairs {
            // Pairing corrects the earlier CSV deposit, whichever answer chose it.
            switch identityChoice(left.row) {
            case .keep?: keep(left.row, [right.source.transactionID])
            case nil: block(left.row, .fundingDateMismatch, [right.source.transactionID])
            case .pair?: try correct(left, right)
            }
        }
        nearAmbiguous(
            nearCorrections.ambiguous.map(\.row), nearCorrections.ambiguousRight.map(\.source.transactionID))

        // Manual cash: an unowned transaction with the same signed money.
        let cashRows = open.map(\.row).filter { (row: ReconciliationSourceRow) -> Bool in
            guard row.route == .cash, row.status == .matched, row.amount != nil, row.currency != nil else {
                return false
            }
            guard row.day != nil, row.dedupFingerprint != nil, decisions[row.id] == nil else { return false }
            return !inCashLedger(row)
        }
        func isManualTwin(_ row: ReconciliationSourceRow, _ candidate: ManualCashCandidateRow) throws -> Bool {
            try sameAccount(row.accountID, candidate.accountID) && candidate.currency == row.currency
                && sameNumber(try DecimalJS.from(candidate.amount), try signedCashAmount(row), 4)
                && ImportInterop.dayDistance(candidate.day, row.day) <= manualCashDays
        }
        let manual = try pairUnique(cashRows, context.manualCash, isManualTwin)
        for (row, candidate) in manual.pairs {
            let existing = CashLedgerValues(day: candidate.day, amount: candidate.amount, currency: candidate.currency)
            let chosen: AdoptionPolicy? = candidate.day == row.day ? .exact : policyOf(row)
            guard let policy = chosen else {
                decide(row, .policyRequired(transactionID: candidate.id, existing: existing))
                continue
            }
            decide(
                row,
                .adoptCash(
                    CashAdoptionDecision(
                        reason: .manualCash, transactionID: candidate.id, policy: policy, existing: existing,
                        after: CashValue(amount: candidate.amount, currency: candidate.currency), original: nil)))
        }
        for row in manual.ambiguous {
            block(row, .ambiguousCashHistory, try context.manualCash.filter { try isManualTwin(row, $0) }.map(\.id))
        }
        for (rowID, transactionIDs) in kept where decisions[rowID] == nil {
            decisions[rowID] = .keptApart(transactionIDs: transactionIDs)
        }
        return decisions
    }
}
