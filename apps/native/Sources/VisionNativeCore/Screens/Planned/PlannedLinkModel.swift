import Foundation
import Observation

/// `LinkTransactionDialog` (Mark {name} as paid): the filters, the debounced candidate
/// fetch, the local search and amount match, and the selected transaction. Executing lives
/// on `PlannedPaymentsModel`, which owns the list the result updates.
@MainActor
@Observable
public final class PlannedLinkModel: Identifiable {
    /// The query-key debounce of the dialog.
    public static let debounce: Duration = .milliseconds(250)

    public let payment: PlannedPayment
    public nonisolated var id: PlannedTransactionID { payment.id }

    /// The local search (`txSearchQuery`): memo, payee or amount.
    public var search = ""
    public private(set) var filters: PlannedLinkQuery
    /// The tolerance field as typed; the filter keeps the last valid value.
    public private(set) var toleranceInput = "5"
    /// The last answer; it stays while a newer request runs (`keepPreviousData`).
    public private(set) var candidates: [OpenAPI.Transaction] = []
    /// No answer yet (`isLoading`).
    public private(set) var isLoading = true
    public private(set) var selectedTransactionId: TransactionID?
    /// Link and mark as paid is running.
    public internal(set) var isExecuting = false

    @ObservationIgnored private let service: any PlannedEditingService
    @ObservationIgnored private let pickers: any PickerDataService
    @ObservationIgnored private var inFlight: (key: PlannedLinkQuery, task: Task<Void, Never>)?
    @ObservationIgnored private var loadedKey: PlannedLinkQuery?
    @ObservationIgnored private var cluster: Task<Void, Never>?
    @ObservationIgnored private var clusterResolved = false

    public init(
        payment: PlannedPayment, service: any PlannedEditingService, pickers: any PickerDataService, calendar: Calendar
    ) {
        self.payment = payment
        self.service = service
        self.pickers = pickers
        var filters = PlannedLinkQuery()
        // A window from two weeks before the due date: direct debits often post early.
        if let due = PlannedDay(ymd: payment.dueDate.isEmpty ? nil : payment.dueDate, calendar: calendar) {
            filters.startDate = due.adding(days: -14, calendar: calendar).ymd
        }
        filters.recipientName = payment.recipient ?? ""
        filters.bankAccount = payment.wire.bankAccount ?? ""
        filters.paymentRecipient = payment.recipient
        self.filters = filters
    }

    // MARK: Loading

    /// The payee's merge-cluster root (`primary_recipient_id ?? id`): the dialog then
    /// searches by it, which includes merged payees. A failure keeps the name search.
    public func resolveCluster() async {
        if clusterResolved { return }
        if let cluster {
            await cluster.value
            return
        }
        guard let recipientId = payment.wire.recipientId, recipientId != 0 else {
            clusterResolved = true
            return
        }
        let pickers = pickers
        let task = Task { [weak self] in
            guard let found = try? await pickers.recipient(id: recipientId) else { return }
            self?.filters.recipientId = found.primaryRecipientId ?? found.id
        }
        cluster = task
        await task.value
        cluster = nil
        clusterResolved = true
    }

    /// Fetches the candidates for the current filters, unless that answer is loaded; a
    /// second caller for the same filters awaits the one in flight.
    public func load() async {
        let key = filters.requestKey
        if loadedKey == key { return }
        if let inFlight, inFlight.key == key {
            await inFlight.task.value
            return
        }
        let query = filters
        let service = service
        let task = Task { [weak self] in
            let answer = try? await service.linkCandidates(query)
            guard let self, self.filters.requestKey == key else { return }
            if let answer {
                self.candidates = answer
                self.loadedKey = key
            }
            self.isLoading = false
        }
        inFlight = (key, task)
        await task.value
        if inFlight?.key == key { inFlight = nil }
    }

    // MARK: Filters

    public func setStartDate(_ day: PlannedDay?) { filters.startDate = day?.ymd ?? "" }
    public func setEndDate(_ day: PlannedDay?) { filters.endDate = day?.ymd ?? "" }
    public func setBankAccount(_ text: String) { filters.bankAccount = text }

    /// Typing a payee drops the cluster id and searches by name.
    public func setRecipientName(_ text: String) {
        filters.recipientName = text
        filters.recipientId = nil
    }

    public func setUncategorised(_ on: Bool) { filters.uncategorised = on }
    public func setActiveOnly(_ on: Bool) { filters.active = on }
    public func setMatchAmount(_ on: Bool) { filters.matchAmount = on }

    /// A valid entry (a finite number ≥ 0) becomes the tolerance at once.
    public func setToleranceInput(_ text: String) {
        toleranceInput = text
        if let value = JSInteger.number(text), value >= 0 {
            filters.amountTolerancePct = value
        }
    }

    /// Blur: an invalid entry reverts to the tolerance in effect.
    public func commitTolerance() {
        guard let value = JSInteger.number(toleranceInput), value >= 0 else {
            toleranceInput = VisionFormat.plain(filters.amountTolerancePct)
            return
        }
    }

    /// `plannedPage.link.includesLinked` shows while the search goes by the cluster id.
    public var includesLinked: Bool { filters.recipientId != nil }

    /// The start and end filters as days, for the pickers.
    public func day(_ text: String, calendar: Calendar) -> PlannedDay? {
        text.isEmpty ? nil : PlannedDay(ymd: text, calendar: calendar)
    }

    // MARK: Candidates

    /// `filteredCandidates`: the local search, then the amount match (tolerance
    /// `max(1, planned × pct / 100)` in absolute amounts).
    public var visibleCandidates: [OpenAPI.Transaction] {
        let query = search.lowercased()
        let planned = abs(payment.amount)
        let tolerance = max(Decimal(1), planned * (filters.amountTolerancePct / 100))
        return candidates.filter { transaction in
            if !query.isEmpty {
                let matches =
                    (transaction.memo ?? "").lowercased().contains(query)
                    || (transaction.recipientName ?? "").lowercased().contains(query)
                    || VisionFormat.plain(transaction.amount).contains(query)
                if !matches { return false }
            }
            if filters.matchAmount && abs(abs(transaction.amount) - planned) > tolerance { return false }
            return true
        }
    }

    public func select(_ transactionId: TransactionID?) {
        selectedTransactionId = transactionId
    }

    /// The chosen candidate, from the loaded answer.
    public var selectedTransaction: OpenAPI.Transaction? {
        guard let selectedTransactionId else { return nil }
        return candidates.first { $0.id == selectedTransactionId }
    }

    /// The execution date: the chosen transaction's own date, without a time.
    public var executionDate: String? {
        selectedTransaction?.transactionDate.description
    }

    /// Link and mark as paid is enabled once a candidate is chosen and nothing runs.
    public var canExecute: Bool { selectedTransactionId != nil && !isExecuting }

    /// The candidate's first line: memo, payee or `plannedPage.link.txFallback`.
    public static func title(_ transaction: OpenAPI.Transaction, strings: any Localizing) -> String {
        if let memo = transaction.memo, !memo.isEmpty { return memo }
        if let payee = transaction.recipientName, !payee.isEmpty { return payee }
        return strings.t("plannedPage.link.txFallback", ["id": String(transaction.id.rawValue)])
    }

    /// "payee · date" of the non-empty parts.
    public static func detail(_ transaction: OpenAPI.Transaction, format: AppDateFormat) -> String {
        let date = VisionFormat.appDate(transaction.transactionDate, format: format)
        return [transaction.recipientName, date].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }
}
