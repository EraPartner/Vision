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
    public let restoreActive: Bool
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
    /// The open planned-payment sheet's request.
    public private(set) var editorRequest: PlannedEditorRequest?
    /// The planned-payment sheet (`PlannedPaymentForm`) while it is open.
    public private(set) var editor: PlannedPaymentFormModel?
    /// The payment the Mark as paid dialog is for.
    public private(set) var linkRequest: PlannedPayment?
    /// The Mark as paid dialog (`LinkTransactionDialog`) while it is open.
    public private(set) var link: PlannedLinkModel?
    /// `usePlannedMatchSuggestions`: planned payments with likely unlinked matches.
    public private(set) var suggestions: [PlannedMatchSuggestion] = []
    /// `RecurringDetectionPanel`.
    public let recurring: PlannedRecurringModel
    /// The shared picker lists of the sheet.
    public let pickers: PickerDataModel

    @ObservationIgnored private let service: any PlannedPaymentsService
    @ObservationIgnored private let editing: any PlannedEditingService
    @ObservationIgnored private let pickerService: any PickerDataService
    @ObservationIgnored private var suggestionsFetchedAt: Date?
    @ObservationIgnored private var suggestionsInFlight: Task<Void, Never>?
    /// The suggestions refetch Mark as paid starts after it closes (tests await it).
    @ObservationIgnored private(set) var suggestionsRefresh: Task<Void, Never>?
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private let retryDelay: Duration
    @ObservationIgnored public let calendar: Calendar
    @ObservationIgnored private var defaultCurrency = NativeAppSettings.defaults.defaultCurrency
    @ObservationIgnored private var inFlight: [Bool: Task<Void, Never>] = [:]
    @ObservationIgnored private var notices = NoticeCounter()
    @ObservationIgnored private var editorCount = 0

    public init(
        service: any PlannedPaymentsService, editing: any PlannedEditingService, pickers: any PickerDataService,
        rates: ExchangeRatesModel, dismissals: PlannedDismissalStore = .userDefaults,
        calendar: Calendar = PlannedDates.local, now: @escaping @Sendable () -> Date = { Date() },
        retryDelay: Duration = .seconds(1)
    ) {
        self.service = service
        self.retryDelay = retryDelay
        self.editing = editing
        pickerService = pickers
        self.rates = rates
        self.calendar = calendar
        self.now = now
        history = PlannedHistoryModel(service: service)
        recurring = PlannedRecurringModel(service: editing, store: dismissals, now: now)
        self.pickers = PickerDataModel(service: pickers)
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

    /// The query's `retry: 1`: a failed load is tried once more after React Query's first
    /// retry delay before the page shows its error.
    private func load(_ key: Bool) async throws -> [OpenAPI.PlannedTransaction] {
        do {
            return try await service.plannedPayments(includePaused: key)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            try await Task.sleep(for: retryDelay)
            return try await service.plannedPayments(includePaused: key)
        }
    }

    private func run(_ key: Bool) async {
        do {
            let rows = try await load(key)
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

    /// `setQueryData` on the view the mutation started on (`key`, its `show_all`): the
    /// server's row replaces the one with its id.
    private func replace(_ wire: OpenAPI.PlannedTransaction, in key: Bool) {
        guard var list = lists[key]?.payments else { return }
        let currency = defaultCurrency
        list = list.map { $0.id == wire.id ? PlannedPayment(wire, defaultCurrency: currency) : $0 }
        lists[key]?.payments = list
    }

    private func remove(id: Int, in key: Bool) {
        lists[key]?.payments?.removeAll { $0.id == id }
    }

    /// `setList((prev) => [...prev, created])` on the view the mutation started on.
    private func append(_ wire: OpenAPI.PlannedTransaction, in key: Bool) {
        guard lists[key]?.payments != nil else { return }
        lists[key]?.payments?.append(PlannedPayment(wire, defaultCurrency: defaultCurrency))
    }

    /// Another native screen moved or removed planned rows (an account merge or close): both
    /// lists and the pickers refetch on the next load.
    public func invalidate() {
        for key in Array(lists.keys) { lists[key]?.fetchedAt = nil }
        pickers.reset()
    }

    /// Track invalidated every planned list: both views go stale and the shown one refetches.
    private func invalidateLists() async {
        for key in Array(lists.keys) { lists[key]?.fetchedAt = nil }
        await fetch(showAll)
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

    /// Add payment, a strip item or Edit: the sheet opens fresh for a new payment and with
    /// the row's values for an edit.
    public func openEditor(for payment: PlannedPayment?, settings: NativeAppSettings = .defaults) {
        editorCount += 1
        editorRequest = PlannedEditorRequest(id: editorCount, payment: payment)
        editor = PlannedPaymentFormModel(
            id: editorCount, initial: payment, settings: settings, today: PlannedDay(now(), calendar: calendar),
            calendar: calendar)
    }

    /// Cancel, the close button, Escape, or Leave and discard: the sheet closes unsaved.
    public func dismissEditor() {
        editor?.resetErrors()
        editorRequest = nil
        editor = nil
    }

    /// The sheet's Add payment or Save changes (and Enter): validates, then creates or
    /// updates. Success writes the server's row into the list, toasts and closes the sheet;
    /// a failure toasts `plannedPage.saveFailed` and keeps it open.
    public func saveEditor(strings: any Localizing) async {
        guard let form = editor, !actionLoading, let submission = form.submit() else { return }
        form.resetErrors()
        let key = showAll
        actionLoading = true
        defer { actionLoading = false }
        do {
            if let initial = form.initial {
                let updated = try await editing.updatePlannedPayment(id: initial.id, patch: submission.patch)
                replace(updated, in: key)
                post(.success, "plannedPage.toast.updated", ["name": submission.name])
            } else {
                let created = try await editing.createPlannedPayment(submission.create)
                append(created, in: key)
                post(.success, "plannedPage.toast.created", ["name": submission.name])
            }
            if editor === form { dismissEditor() }
        } catch {
            post(
                .error, "plannedPage.saveFailed",
                ["msg": APIErrorMessage.text(APIError.wrapping(error), strings: strings)])
        }
    }

    /// `useUnsavedChanges(open && dirty)`: while the sheet holds edits, the shell asks before
    /// leaving `/planned`; Leave and discard closes the sheet.
    public var leaveGuard: NativeLeaveGuard {
        NativeLeaveGuard(
            id: PlannedPaymentsRoute.path,
            hasUnsavedChanges: { [weak self] in self?.editor?.isDirty ?? false },
            discard: { [weak self] in self?.dismissEditor() })
    }

    /// Mark as paid (and the match suggestions' Review).
    public func openLinkDialog(for payment: PlannedPayment) {
        linkRequest = payment
        link = PlannedLinkModel(payment: payment, service: editing, pickers: pickerService, calendar: calendar)
    }

    /// Cancel, the close button or Escape: selection and search go with the dialog.
    public func dismissLinkDialog() {
        linkRequest = nil
        link = nil
    }

    /// Link and mark as paid: `POST …/execute` with the chosen transaction and its date. On
    /// success the row updates in place, a toast confirms, the dialog closes and the
    /// suggestions refetch in the background; a failure toasts `plannedPage.link.executeFailed`
    /// and keeps it open.
    public func executeLink(strings: any Localizing) async {
        guard let dialog = link, let transactionId = dialog.selectedTransactionId, !dialog.isExecuting else { return }
        let key = showAll
        dialog.isExecuting = true
        defer { dialog.isExecuting = false }
        do {
            let updated = try await editing.executePlannedPayment(
                id: dialog.payment.id, transactionId: transactionId, executionDate: dialog.executionDate)
            replace(updated, in: key)
            post(.success, "plannedPage.toast.executed", ["name": dialog.payment.name])
            if link === dialog { dismissLinkDialog() }
            suggestionsRefresh = Task { [weak self] in await self?.loadSuggestions(force: true) }
        } catch {
            post(
                .error, "plannedPage.link.executeFailed",
                ["msg": APIErrorMessage.text(APIError.wrapping(error), strings: strings)])
        }
    }

    // MARK: Match suggestions

    /// The suggestions query (5 minute stale time); `force` refetches after a confirm. A
    /// failed fetch keeps the last answer.
    public func loadSuggestions(force: Bool = false) async {
        if let suggestionsInFlight {
            await suggestionsInFlight.value
            if !force { return }
        }
        if !force, let fetched = suggestionsFetchedAt,
            now().timeIntervalSince(fetched) < PlannedRecurringModel.staleAfter
        {
            return
        }
        let editing = editing
        let task = Task { [weak self] in
            guard let answer = try? await editing.matchSuggestions() else { return }
            guard let self else { return }
            self.suggestions = answer
            self.suggestionsFetchedAt = self.now()
        }
        suggestionsInFlight = task
        await task.value
        suggestionsInFlight = nil
    }

    /// The banner's Review: the Mark as paid dialog for the first suggestion's payment, only
    /// when that payment is in the loaded list.
    public func reviewSuggestion() {
        guard let plannedId = suggestions.first?.planned?.id,
            let payment = payments.first(where: { $0.id == plannedId })
        else { return }
        openLinkDialog(for: payment)
    }

    // MARK: Recurring detection

    /// Track: creates a recurring planned payment from the pattern (no sheet), then refreshes
    /// the patterns and the planned list.
    public func track(_ pattern: PlannedRecurringPattern, strings: any Localizing) async {
        let memo = strings.t("recurring.autoDetectedMemo", ["name": pattern.recipientName])
        do {
            _ = try await editing.trackPlannedPayment(pattern.trackBody(memo: memo))
            post(.success, "recurring.toast.created", ["name": pattern.recipientName])
            await recurring.reloadPatterns()
            await invalidateLists()
        } catch {
            post(
                .error, "recurring.toast.failed",
                ["msg": APIErrorMessage.text(APIError.wrapping(error), strings: strings)])
        }
    }

    /// Mark as paid is disabled while an action runs and on a paused row.
    public func canMarkAsPaid(_ payment: PlannedPayment) -> Bool {
        !actionLoading && payment.isActive
    }

    /// Pause or Resume: flips `is_active` of the cached row at once, then offers Undo for
    /// eight seconds. The toast names the action the row showed when it was chosen.
    public func toggleActive(_ payment: PlannedPayment) async {
        guard !actionLoading, let cached = payments.first(where: { $0.id == payment.id }) else { return }
        actionLoading = true
        defer { actionLoading = false }
        do {
            try await flipActive(id: payment.id)
            let notice = notices.make(
                .success, payment.isActive ? "plannedPage.toast.paused" : "plannedPage.toast.resumed",
                detail: payment.name)
            self.notice = notice
            undo = PlannedUndo(noticeID: notice.id, paymentID: payment.id, restoreActive: cached.isActive)
            let id = payment.id
            let restore = cached.isActive
            notices.offerAction(for: notice, titleKey: "common.undo", lifetime: 8, isUndo: true) { [weak self] in
                await self?.restoreStatus(id: id, active: restore)
            }
        } catch {
            post(.error, "plannedPage.toggleFailed")
        }
    }

    /// The toast's Undo: flips the same row back once.
    public func undoToggle() async {
        guard let undo else { return }
        self.undo = nil
        if notice?.id == undo.noticeID { notice = nil }
        await restoreStatus(id: undo.paymentID, active: undo.restoreActive)
    }

    private func restoreStatus(id: Int, active: Bool) async {
        let key = showAll
        do {
            let updated = try await service.setPlannedPaymentActive(id: id, isActive: active)
            replace(updated, in: key)
        } catch {
            post(.error, "plannedPage.toggleFailed")
        }
    }

    public func attachNotices(_ center: NativeNoticeCenter) {
        notices.attach(center) { [weak self] in self?.clearNotice($0) }
    }

    /// `toggleMutation`: the cached row's `is_active` flipped; a row no longer cached is left
    /// alone.
    private func flipActive(id: Int) async throws {
        let key = showAll
        guard let cached = payments.first(where: { $0.id == id }) else { return }
        let updated = try await service.setPlannedPaymentActive(id: id, isActive: !cached.isActive)
        replace(updated, in: key)
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
        let key = showAll
        actionLoading = true
        defer { actionLoading = false }
        do {
            try await service.deletePlannedPayment(id: payment.id)
            remove(id: payment.id, in: key)
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
        dismissEditor()
        dismissLinkDialog()
        recurring.patternsExpanded = false
        recurring.alertsExpanded = false
        pickers.reset()
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
    struct Link: Equatable, Sendable {
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
    /// The load in progress and the transaction links it covers, so the sheet's `.task` and a
    /// caller asking for the same executions share one request instead of racing (like
    /// ExchangeRatesModel); a refetch that changed the executions loads again.
    @ObservationIgnored private var inFlight: (links: [Link], task: Task<Void, Never>)?

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
        let links = Self.links(payments)
        if let inFlight, inFlight.links == links {
            await inFlight.task.value
            return
        }
        let request = Task { await run(payments: payments) }
        inFlight = (links, request)
        await request.value
        if inFlight?.task == request { inFlight = nil }
    }

    private func run(payments: [PlannedPayment]) async {
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
        inFlight = nil
        isLoading = false
    }
}
