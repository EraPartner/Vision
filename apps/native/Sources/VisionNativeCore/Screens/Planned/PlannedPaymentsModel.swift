import Foundation
import Observation

/// The planned-payment API calls of `/planned` (apps/frontend/src/lib/api/planned.ts and the
/// transaction lookup of the Payment history dialog), so tests can use a fake.
public protocol PlannedPaymentsService: Sendable {
    /// `getPlannedTransactions({ active: !showAll, limit: 1000 })`: the rows.
    func plannedPayments(includePaused: Bool) async throws -> [OpenAPI.PlannedTransaction]
    /// `updatePlannedTransaction(id, { is_active })`: Pause, Resume and their Undo.
    func setPlannedPaymentActive(id: Int, isActive: Bool) async throws -> OpenAPI.PlannedTransaction
    /// `deletePlannedTransaction(id)`.
    func deletePlannedPayment(id: Int) async throws
    /// `getTransactions({ transaction_id, limit: 1 })`: the transaction, if it exists.
    func transaction(id: Int) async throws -> OpenAPI.Transaction?
}

extension APIClient: PlannedPaymentsService {
    public func plannedPayments(includePaused: Bool) async throws -> [OpenAPI.PlannedTransaction] {
        try await send(OpenAPIOperations.GetPlannedTransactions(limit: 1000, active: !includePaused)).items
    }

    public func setPlannedPaymentActive(id: Int, isActive: Bool) async throws -> OpenAPI.PlannedTransaction {
        try await send(
            OpenAPIOperations.UpdatePlannedTransaction(
                id: id, body: OpenAPIOperations.UpdatePlannedTransaction.Body(isActive: isActive)))
    }

    public func deletePlannedPayment(id: Int) async throws {
        _ = try await send(OpenAPIOperations.DeletePlannedTransaction(id: id))
    }

    public func transaction(id: Int) async throws -> OpenAPI.Transaction? {
        try await send(OpenAPIOperations.GetTransactions(limit: 1, transactionId: id)).items.first
    }
}

/// The Undo action of the Pause and Resume toast (`undoToast`).
public struct PlannedUndo: Equatable, Sendable {
    /// The toast it belongs to.
    public let noticeID: Int
    public let paymentID: Int
}

/// A request to open the planned-payment sheet: `payment` is `nil` for Add payment.
public struct PlannedEditorRequest: Equatable, Sendable, Identifiable {
    public let id: Int
    public let payment: PlannedPayment?
}

/// The state of the Planned page (`PlannedPaymentsPage` with `usePlannedPayments`): the list
/// for the `show_all` view, the eight-day strip and Estimated monthly in the default currency,
/// the table's search, filters and sort, Pause and Resume with Undo, Delete behind its
/// confirmation, and the Payment history dialog.
///
/// The list is cached per `show_all` value like React Query's key (30 s stale time), and a
/// mutation writes the server's row into the current list instead of refetching.
@MainActor
@Observable
public final class PlannedPaymentsModel {
    /// The default `staleTime` of the web app's `QueryClient`.
    public static let staleAfter: TimeInterval = 30
    /// `DEFAULT_UNDO_TTL_MS`: how long the Undo toast lives.
    public static let undoDuration: Duration = .seconds(8)
    /// The default toast duration.
    public static let noticeDuration: Duration = .seconds(4)

    /// One `show_all` view's query.
    public struct ListState: Equatable, Sendable {
        /// `nil` until the first answer.
        public var payments: [PlannedPayment]?
        public var error: APIError?
        var fetchedAt: Date?
    }

    /// The empty state the table shows when it has no rows.
    public enum EmptyState: Equatable, Sendable {
        /// `plannedPage.empty` with Add payment.
        case noPayments
        /// `plannedPage.emptyFiltered` with Include paused.
        case allPaused
        /// Search or a column filter matched nothing (`table.noFilterResults`).
        case noFilterResults
    }

    /// `show_all` of the route the screen shows.
    public private(set) var showAll = false
    public private(set) var lists: [Bool: ListState] = [:]
    /// The table's search, column filters and sort (component state, not in the URL).
    public var table = LocalTableQuery()
    /// A Pause, Resume or Delete request is running (`actionLoading`): row actions wait.
    public private(set) var actionLoading = false
    public private(set) var notice: ScreenNotice?
    /// The Undo of the current toast, while it may still be taken.
    public private(set) var undo: PlannedUndo?
    /// The payment the Delete planned payment alert asks about.
    public private(set) var pendingDelete: PlannedPayment?
    public private(set) var isHistoryPresented = false
    public let history: PlannedHistoryModel
    /// `ExchangeRatesModel` is the web app's shared exchange-rate query.
    public let rates: ExchangeRatesModel
    // TODO(3c part B): present `PlannedPaymentForm` as a sheet for this request.
    public private(set) var editorRequest: PlannedEditorRequest?
    // TODO(3c part B): present `LinkTransactionDialog` for this payment.
    public private(set) var linkRequest: PlannedPayment?

    @ObservationIgnored private let service: any PlannedPaymentsService
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored public let calendar: Calendar
    @ObservationIgnored private var defaultCurrency = NativeAppSettings.defaults.defaultCurrency
    @ObservationIgnored private var inFlight: [Bool: Task<Void, Never>] = [:]
    @ObservationIgnored private var notices = NoticeCounter()
    @ObservationIgnored private var editorCount = 0

    public init(
        service: any PlannedPaymentsService, rates: ExchangeRatesModel, calendar: Calendar = PlannedDates.local,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.service = service
        self.rates = rates
        self.calendar = calendar
        self.now = now
        history = PlannedHistoryModel(service: service)
    }

    // MARK: List

    private var current: ListState { lists[showAll] ?? ListState() }

    /// Every loaded payment of the view (`payments`): the strip, Estimated monthly, the
    /// table subtitle and the Payment history read these.
    public var payments: [PlannedPayment] { current.payments ?? [] }

    /// The query failed (`error`): the page shows its error state, even over older data.
    public var error: APIError? { current.error }

    /// `loading`: no answer yet for this view.
    public var isLoading: Bool { current.payments == nil && current.error == nil }

    /// The page appeared or the route's `show_all` changed: fetch unless a fresh answer for
    /// that view is cached. The exchange rates load alongside.
    public func appear(showAll: Bool, defaultCurrency: String) async {
        setDefaultCurrency(defaultCurrency)
        self.showAll = showAll
        let ratesModel = rates
        let ratesTask = Task { await ratesModel.appear() }
        let state = current
        if let fetchedAt = state.fetchedAt, state.error == nil, now().timeIntervalSince(fetchedAt) < Self.staleAfter {
            await ratesTask.value
            return
        }
        await fetch(showAll)
        await ratesTask.value
    }

    /// The error state's Retry: `refetch()`.
    public func retry() async {
        await fetch(showAll)
    }

    /// `queryKey` holds the default currency: a change maps the cached rows again.
    private func setDefaultCurrency(_ code: String) {
        guard code != defaultCurrency else { return }
        defaultCurrency = code
        for (key, state) in lists {
            guard let payments = state.payments else { continue }
            lists[key]?.payments = payments.map { PlannedPayment($0.wire, defaultCurrency: code) }
        }
    }

    /// One request per view at a time: a second caller awaits the one in flight.
    private func fetch(_ key: Bool) async {
        if let running = inFlight[key] {
            await running.value
            return
        }
        let request = Task { await run(key) }
        inFlight[key] = request
        await request.value
        inFlight[key] = nil
    }

    private func run(_ key: Bool) async {
        do {
            let rows = try await service.plannedPayments(includePaused: key)
            let currency = defaultCurrency
            var state = lists[key] ?? ListState()
            state.payments = rows.map { PlannedPayment($0, defaultCurrency: currency) }
            state.error = nil
            state.fetchedAt = now()
            lists[key] = state
        } catch is CancellationError {
            return
        } catch {
            var state = lists[key] ?? ListState()
            state.error = (error as? APIError) ?? .network(error.localizedDescription)
            state.fetchedAt = nil
            lists[key] = state
        }
    }

    /// `setQueryData` on the current view: the server's row replaces the one with its id.
    private func replace(_ wire: OpenAPI.PlannedTransaction) {
        guard var list = lists[showAll]?.payments else { return }
        let currency = defaultCurrency
        list = list.map { $0.id == wire.id ? PlannedPayment(wire, defaultCurrency: currency) : $0 }
        lists[showAll]?.payments = list
    }

    private func remove(id: Int) {
        lists[showAll]?.payments?.removeAll { $0.id == id }
    }

    // MARK: Figures

    /// `useCurrencyConverter(defaultCurrency)` over the shared exchange-rate query.
    public var converter: PlannedCurrencyConverter {
        PlannedCurrencyConverter(rates: rates.data, target: defaultCurrency)
    }

    /// The exchange rates are still loading: the totals show skeletons.
    public var isRatesLoading: Bool { rates.isLoading }

    /// The Next 7 days strip from today.
    public var strip: PlannedStrip {
        PlannedStrip(payments: payments, today: now(), calendar: calendar, converter: converter)
    }

    /// Estimated monthly: every loaded active recurring row.
    public var estimatedMonthly: PlannedConvertedTotal {
        PlannedTotals.monthly(payments, converter: converter)
    }

    /// The Due date badge of a row, relative to today.
    public func dueState(_ payment: PlannedPayment) -> PlannedDueState {
        PlannedDueState(dueDate: payment.dueDate, today: now(), calendar: calendar)
    }

    // MARK: Table

    /// `filteredPayments`: without `show_all`, paused rows are hidden even when loaded.
    public var tablePayments: [PlannedPayment] {
        showAll ? payments : payments.filter { $0.isActive }
    }

    /// The rows the table shows: filtered, searched and sorted on the raw fields.
    public var visibleRows: [PlannedPayment] {
        table.apply(tablePayments, keys: PlannedColumn.allCases.map(\.rawValue)) { payment, key in
            payment.rawValue(key)
        }
    }

    /// The distinct values the column filter lists.
    public func filterValues(_ column: PlannedColumn) -> [String] {
        LocalTableQuery.uniqueValues(tablePayments, key: column.rawValue) { payment, key in payment.rawValue(key) }
    }

    /// What an empty table says.
    public var emptyState: EmptyState {
        if table.isNarrowed { return .noFilterResults }
        return payments.isEmpty ? .noPayments : .allPaused
    }

    // MARK: Row actions

    /// Add payment, a strip item or Edit.
    public func openEditor(for payment: PlannedPayment?) {
        editorCount += 1
        editorRequest = PlannedEditorRequest(id: editorCount, payment: payment)
    }

    public func dismissEditor() {
        editorRequest = nil
    }

    /// Mark as paid (and the match suggestions' Review).
    public func openLinkDialog(for payment: PlannedPayment) {
        linkRequest = payment
    }

    public func dismissLinkDialog() {
        linkRequest = nil
    }

    /// Mark as paid is disabled while an action runs and on a paused row.
    public func canMarkAsPaid(_ payment: PlannedPayment) -> Bool {
        !actionLoading && payment.isActive
    }

    /// Pause or Resume: flips `is_active` of the cached row at once, then offers Undo for
    /// eight seconds. The toast names the action the row showed when it was chosen.
    public func toggleActive(_ payment: PlannedPayment) async {
        guard !actionLoading else { return }
        actionLoading = true
        defer { actionLoading = false }
        do {
            try await flipActive(id: payment.id)
            let notice = notices.make(
                .success, payment.isActive ? "plannedPage.toast.paused" : "plannedPage.toast.resumed",
                detail: payment.name)
            self.notice = notice
            undo = PlannedUndo(noticeID: notice.id, paymentID: payment.id)
        } catch {
            post(.error, "plannedPage.toggleFailed")
        }
    }

    /// The toast's Undo: flips the same row back once.
    public func undoToggle() async {
        guard let undo else { return }
        self.undo = nil
        if notice?.id == undo.noticeID { notice = nil }
        do {
            try await flipActive(id: undo.paymentID)
        } catch {
            post(.error, "plannedPage.toggleFailed")
        }
    }

    /// `toggleMutation`: the cached row's `is_active` flipped; a row no longer cached is left
    /// alone.
    private func flipActive(id: Int) async throws {
        guard let cached = payments.first(where: { $0.id == id }) else { return }
        let updated = try await service.setPlannedPaymentActive(id: id, isActive: !cached.isActive)
        replace(updated)
    }

    /// Delete: asks first (there is no restore endpoint).
    public func requestDelete(_ payment: PlannedPayment) {
        pendingDelete = payment
    }

    /// The alert's Cancel or Escape.
    public func cancelDelete() {
        pendingDelete = nil
    }

    /// The alert's Delete: `DELETE`, then the row leaves the list.
    public func confirmDelete() async {
        guard let payment = pendingDelete else { return }
        pendingDelete = nil
        actionLoading = true
        defer { actionLoading = false }
        do {
            try await service.deletePlannedPayment(id: payment.id)
            remove(id: payment.id)
            post(.success, "plannedPage.toast.deleted", ["name": payment.name])
        } catch {
            post(.error, "plannedPage.deleteFailed")
        }
    }

    // MARK: Toasts

    /// The toast was dismissed or timed out; its Undo goes with it.
    public func clearNotice(_ id: Int) {
        if notice?.id == id { notice = nil }
        if undo?.noticeID == id { undo = nil }
    }

    /// How long a toast stays: the Undo toast lives as long as its Undo.
    public func duration(of notice: ScreenNotice) -> Duration {
        undo?.noticeID == notice.id ? Self.undoDuration : Self.noticeDuration
    }

    private func post(_ kind: ScreenNotice.Kind, _ key: String, _ variables: [String: String] = [:]) {
        notice = notices.make(kind, key, variables)
    }

    // MARK: Payment history

    /// The page menu's Payment history.
    public func openHistory() {
        isHistoryPresented = true
    }

    /// The dialog closed: an answer still in flight is dropped.
    public func closeHistory() {
        isHistoryPresented = false
        history.cancel()
    }

    /// The screen went away: its dialogs, alert and table state go with it, like an
    /// unmounted page. A toast and its Undo stay.
    public func disappear() {
        closeHistory()
        pendingDelete = nil
        editorRequest = nil
        linkRequest = nil
        table = LocalTableQuery()
    }
}

/// `ExecutionHistoryDialog`: one row per execution of every loaded payment, with its linked
/// transaction.
@MainActor
@Observable
public final class PlannedHistoryModel {
    public struct Entry: Equatable, Sendable, Identifiable {
        public let plannedPaymentId: Int
        public let plannedPaymentName: String
        public let executionDate: String
        public let transactionId: Int
        public let transactionDate: String
        public let recipientName: String?
        public let categoryName: String?
        public let amount: Decimal
        public let currency: String?
        public let memo: String?

        public var id: String { "\(plannedPaymentId)-\(transactionId)-\(executionDate)" }

        /// The Linked transaction's first line: memo, payee or `plannedPage.link.txFallback`.
        public func title(_ strings: any Localizing) -> String {
            if let memo, !memo.isEmpty { return memo }
            if let recipientName, !recipientName.isEmpty { return recipientName }
            return strings.t("plannedPage.link.txFallback", ["id": String(transactionId)])
        }

        /// "payee · category · date" of the non-empty parts.
        public func detail(format: AppDateFormat) -> String {
            [recipientName, categoryName, VisionFormat.appDate(transactionDate, format: format)]
                .compactMap { $0 }
                .filter { !$0.isEmpty }
                .joined(separator: " · ")
        }

        /// `/transactions?transaction_id={id}`.
        public var route: String { PlannedLinks.transactionRoute(transactionId) }
    }

    /// One execution to look up.
    struct Link: Sendable {
        let plannedPaymentId: Int
        let plannedPaymentName: String
        let executionDate: String
        let transactionId: Int
    }

    public private(set) var entries: [Entry] = []
    public private(set) var isLoading = false
    /// At least one lookup failed (`plannedPage.history.loadFailed` with Retry).
    public private(set) var failed = false

    @ObservationIgnored private let service: any PlannedPaymentsService
    @ObservationIgnored private var version = 0

    init(service: any PlannedPaymentsService) {
        self.service = service
    }

    /// The executions of every payment, falling back to the linked transaction with the last
    /// executed (or due) date.
    static func links(_ payments: [PlannedPayment]) -> [Link] {
        payments.flatMap { payment -> [Link] in
            if !payment.executions.isEmpty {
                return payment.executions.map { execution in
                    Link(
                        plannedPaymentId: payment.id, plannedPaymentName: payment.name,
                        executionDate: execution.executionDate, transactionId: execution.executedTransactionId)
                }
            }
            if let transactionId = payment.executedTransactionId, transactionId != 0 {
                let date = payment.lastExecutedDate.flatMap { $0.isEmpty ? nil : $0 } ?? payment.dueDate
                return [
                    Link(
                        plannedPaymentId: payment.id, plannedPaymentName: payment.name, executionDate: date,
                        transactionId: transactionId)
                ]
            }
            return []
        }
    }

    /// `loadExecutionHistory`: every lookup in parallel; a missing transaction is skipped and
    /// a failed one marks the history partial. Newest execution first.
    public func load(payments: [PlannedPayment]) async {
        version += 1
        let mine = version
        failed = false
        let links = Self.links(payments)
        guard !links.isEmpty else {
            entries = []
            isLoading = false
            return
        }
        isLoading = true
        let service = service
        let results = await withTaskGroup(of: (Int, Result<OpenAPI.Transaction?, any Error>).self) { group in
            for (index, link) in links.enumerated() {
                let transactionId = link.transactionId
                group.addTask {
                    do {
                        return (index, .success(try await service.transaction(id: transactionId)))
                    } catch {
                        return (index, .failure(error))
                    }
                }
            }
            var collected: [(Int, Result<OpenAPI.Transaction?, any Error>)] = []
            for await result in group { collected.append(result) }
            return collected
        }
        guard mine == version else { return }
        var resolved: [(Int, Entry)] = []
        var anyFailed = false
        for (index, result) in results {
            switch result {
            case .success(let transaction):
                guard let transaction else { continue }
                let link = links[index]
                resolved.append(
                    (
                        index,
                        Entry(
                            plannedPaymentId: link.plannedPaymentId, plannedPaymentName: link.plannedPaymentName,
                            executionDate: link.executionDate, transactionId: link.transactionId,
                            transactionDate: transaction.transactionDate, recipientName: transaction.recipientName,
                            categoryName: transaction.categoryName, amount: transaction.amount,
                            currency: transaction.currency, memo: transaction.memo)
                    ))
            case .failure:
                anyFailed = true
            }
        }
        // `Promise.allSettled` keeps the input order; the sort is stable on it.
        resolved.sort { left, right in
            if left.1.executionDate == right.1.executionDate { return left.0 < right.0 }
            return left.1.executionDate > right.1.executionDate
        }
        failed = anyFailed
        entries = resolved.map { $0.1 }
        isLoading = false
    }

    /// The dialog closed: an answer still in flight is dropped.
    public func cancel() {
        version += 1
        isLoading = false
    }
}
