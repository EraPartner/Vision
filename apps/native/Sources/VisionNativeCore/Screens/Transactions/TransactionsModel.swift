import Foundation
import Observation

/// The inline row editor (`VirtualDataTable`'s editing row): the Date and Amount editors.
public struct TransactionRowEditor: Equatable, Sendable {
    public let id: Int
    public var day: PlannedDay?
    public var amountText: String

    public init(row: TransactionRow, format: NumberFormat) {
        id = row.id
        day = PlannedDay(ymd: row.day, calendar: PlannedDates.local)
        amountText = LocaleNumber.editable(row.amount, format: format)
    }

    /// `aria-invalid`: text that does not read as a number.
    public func amountInvalid(format: NumberFormat) -> Bool {
        let trimmed = amountText.trimmingCharacters(in: .whitespaces)
        return !trimmed.isEmpty && LocaleNumber.parse(trimmed, format: format) == nil
    }

    /// `handleUpdate`'s PATCH: date, memo, amount, currency and comment of the edited row; an
    /// empty amount keeps the original. `nil` while the amount does not parse.
    public func patch(for row: TransactionRow, format: NumberFormat) -> TransactionPatch? {
        guard !amountInvalid(format: format) else { return nil }
        let trimmed = amountText.trimmingCharacters(in: .whitespaces)
        var patch = TransactionPatch()
        patch.transactionDate = day?.ymd ?? row.day
        patch.memo = .some(row.memo)
        patch.amount = trimmed.isEmpty ? row.amount : (LocaleNumber.parse(trimmed, format: format) ?? row.amount)
        patch.currency = row.currency
        patch.comment = .some(row.comment)
        return patch
    }
}

/// The action button of the page's toast.
public enum TransactionToastAction: Equatable, Sendable {
    /// `undoToast`'s Undo of a delete (also ⌘Z): recreates the row.
    case undoDelete(TransactionRow)
    /// The load-more failure's Retry.
    case retryLoadMore
}

/// The toast's action while it may still be taken.
public struct TransactionPendingAction: Equatable, Sendable {
    public let noticeID: Int
    public let action: TransactionToastAction
}

/// What an empty table says.
public enum TransactionsEmptyState: Equatable, Sendable {
    /// Client column filters hid every loaded row (`table.noFilterResults`).
    case noFilterResults
    /// `txPage.empty` with `txPage.emptySearch`.
    case noSearchResults
    /// `txPage.empty` with `transactions.noTransactions` and the Import link.
    case noTransactions
}

/// A key on a focused row (`VirtualDataTable`'s row keyboard handling).
public enum TransactionRowKey: Equatable, Sendable {
    case up
    case down
    /// Enter: selects the row and opens the inspector.
    case open
    /// Space: Quick Look.
    case quickLook
    /// Escape: closes the inspector.
    case close
}

/// The state of `/transactions` (`TransactionsPage` with `useTransactionListData`): the paged
/// list for the URL's filters, the search and the sort, the toolbar, the filter banner, the
/// client column filters, inline editing, the checkbox selection, the row actions with their
/// toasts, the inspector and Quick Look.
///
/// The URL stays the source of truth for the filters and the sort: filter changes push a
/// new route (`setSearchParams`), the search and the sort replace it, and `sync` reads the
/// route the page reports. A mutation writes the server's row into the loaded list instead of
/// collapsing the scroll position with a refetch; a create (Duplicate, Undo, Use for all)
/// reloads the first page.
@MainActor
@Observable
public final class TransactionsModel {
    /// `QUERY_STALE_TIME_MS.FREQUENT`.
    public static let staleAfter: TimeInterval = 30
    /// `DEFAULT_UNDO_TTL_MS`.
    public static let undoDuration: Duration = .seconds(8)
    public static let noticeDuration: Duration = .seconds(4)
    /// The table switches to its stacked layout below this width.
    public nonisolated static let compactWidth: Double = 960
    /// The inspector docks beside the list from this width (`lg`), otherwise it is a sheet.
    public nonisolated static let dockedInspectorWidth: Double = 1024
    public nonisolated static let inspectorWidth: Double = 332
    /// The Split transaction dialog draws natively (`SplitDialogModel`).
    public nonisolated static let splitIsNative = true

    // MARK: List state

    /// The query the loaded rows answer.
    public private(set) var query: TransactionListQuery?
    /// `nil` until the first answer; kept while a new query loads (`placeholderData`).
    public private(set) var rows: [TransactionRow]?
    public private(set) var total = 0
    public private(set) var error: APIError?
    public private(set) var isFetchingMore = false

    /// The search field's text; it drives the list and `?search=` once it settles.
    public var searchText = ""
    /// The settled search the list asks for.
    public private(set) var search = ""
    /// View › Show excluded (`showAll`, component state).
    public private(set) var showAll = false
    /// The client column filters over the loaded rows.
    public var columnFilters = ServerColumnFilters()
    public private(set) var columnVisibility = TransactionColumnVisibility()
    /// `useNeedsCategoryCount`.
    public private(set) var needsCategoryCount: Int?
    /// `useAccounts({ active: "all" })`: the Account filter's list.
    public private(set) var allAccounts: [OpenAPI.Account] = []
    /// The banner's payee lookup for `recipient_id`.
    public private(set) var bannerRecipient: BannerRecipient = .loading
    /// The Export CSV / Export JSON running.
    public private(set) var exportingFormat: ExportFormat?

    // MARK: Selection and editing

    /// The row the inspector shows.
    public private(set) var selectedId: Int?
    /// The inspector of the selected row.
    public private(set) var inspector: TransactionInspectorModel?
    /// The row focus returns to after the inspector or Quick Look closes; a row gaining focus
    /// this way is not selected again.
    public private(set) var focusRequest: Int?
    /// The checkbox selection the bulk bar acts on.
    public internal(set) var selection = ServerTableSelection()
    /// The row being edited inline.
    public var rowEditor: TransactionRowEditor?
    /// The row the Quick Look dialog shows.
    public private(set) var quickLookId: Int?
    /// The row the Delete transaction alert asks about.
    public private(set) var pendingDelete: TransactionRow?
    /// The Add transaction sheet.
    public private(set) var isAddPresented = false
    /// The Add transaction sheet's form; it stays when the sheet closes without adding.
    public internal(set) var addForm: AddTransactionModel?
    /// The Split transaction dialog's row.
    public private(set) var splitRequest: TransactionRow?
    /// The Split transaction dialog's state.
    public private(set) var splitForm: SplitDialogModel?
    /// The bulk dialog on screen.
    public internal(set) var bulkDialog: TransactionBulkDialog?
    /// The bulk alert on screen.
    public internal(set) var bulkConfirmation: TransactionBulkConfirmation?
    /// A bulk request is running (`anyBusy`).
    public internal(set) var bulkBusy = false
    /// What the bulk dialogs hold between openings.
    public internal(set) var bulkDrafts = TransactionBulkDrafts()
    public internal(set) var notice: ScreenNotice?
    public private(set) var pendingAction: TransactionPendingAction?
    public private(set) var deletePending = false
    /// Updates in flight (`updateMutation.isPending`): the Status toggles wait.
    public private(set) var updatesInFlight = 0
    /// The shared picker lists of the editors, the inspector and the toolbar.
    public let pickers: PickerDataModel

    /// Saves bytes under a suggested name (the Save panel): `true` once written. The app
    /// target sets it; exports and attachment downloads use it.
    @ObservationIgnored public var save: @MainActor (Data, String) async throws -> Bool = { _, _ in false }

    /// `/owes`, which shares the split calls.
    public let owes: OwesModel

    @ObservationIgnored let service: any TransactionsService
    @ObservationIgnored private let attachmentService: any TransactionAttachmentsService
    @ObservationIgnored let bulkService: any TransactionBulkService
    @ObservationIgnored let splitsService: any SplitsService
    @ObservationIgnored weak var shell: NativeShellModel?
    @ObservationIgnored let now: @Sendable () -> Date
    @ObservationIgnored public let calendar: Calendar
    @ObservationIgnored var fetchedAt: Date?
    @ObservationIgnored private var loadedOffset = 0
    @ObservationIgnored private var listVersion = 0
    @ObservationIgnored private var inFlight: (query: TransactionListQuery, task: Task<Void, Never>)?
    /// The `?search=` value last read or written, so only a new value from the route
    /// replaces the typed search (a palette search while the page is open).
    @ObservationIgnored private var lastSearchParam: String?
    @ObservationIgnored var notices = NoticeCounter()
    @ObservationIgnored private var visibilitySetting: JSONValue?
    @ObservationIgnored private var visibilityBaseline: JSONValue?
    @ObservationIgnored private var visibilityLoaded = false
    @ObservationIgnored private var visibilityInFlight: Task<Void, Never>?
    @ObservationIgnored private var visibilitySaves: Task<Void, Never>?
    @ObservationIgnored private var accountsInFlight: Task<Void, Never>?
    @ObservationIgnored private var countInFlight: Task<Void, Never>?
    @ObservationIgnored private var bannerRecipientId: Int?

    public init(
        service: any TransactionsService, attachments: any TransactionAttachmentsService,
        pickers: any PickerDataService, bulk: any TransactionBulkService, splits: any SplitsService,
        calendar: Calendar = PlannedDates.local, now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.service = service
        attachmentService = attachments
        bulkService = bulk
        splitsService = splits
        self.pickers = PickerDataModel(service: pickers)
        owes = OwesModel(service: splits, calendar: calendar, now: now)
        self.calendar = calendar
        self.now = now
    }

    /// The shell this screen reads its route, settings and strings from and writes the URL
    /// through. `NativeShellModel` attaches itself.
    func attach(_ shell: NativeShellModel) {
        self.shell = shell
        owes.attach(shell)
    }

    var strings: any Localizing { shell?.strings ?? DictionaryStrings(language: .en, table: [:]) }
    var settings: NativeAppSettings { shell?.settings ?? .defaults }

    /// The fallbacks for a missing category or payee in the current language.
    public var labels: TransactionLabels { TransactionLabels(strings: strings) }

    /// Today's local day, for the date presets and the export file name.
    public var today: PlannedDay { PlannedDay(now(), calendar: calendar) }

    // MARK: Route

    /// The filters of the route the screen shows.
    public var filters: TransactionFilters {
        shell.map { TransactionFilters(route: $0.route) } ?? TransactionFilters()
    }

    /// The URL's sort.
    public var sort: LocalTableSort? {
        shell.flatMap { TransactionsRoutes.sort(in: $0.route) }
    }

    /// The route moved (or the screen appeared): a palette search lands in the search field,
    /// `new=1` and `id` are handled and removed with replace, and the list loads for the
    /// filters, search, sort, Show excluded and page size.
    public func sync() async {
        guard let shell, shell.route.path == TransactionsRoutes.path else { return }
        let param = shell.route.value(TransactionsRoutes.searchParameter)
        if param != lastSearchParam {
            lastSearchParam = param
            if let param {
                searchText = param
                search = param
            }
        }
        if TransactionsRoutes.wantsNewTransaction(shell.route) {
            requestAdd()
            shell.replaceQuery(TransactionsRoutes.newParameter, with: nil)
        }
        if shell.route.value(TransactionsRoutes.selectParameter) != nil {
            if let id = TransactionsRoutes.selectedId(shell.route) { select(id) }
            shell.replaceQuery(TransactionsRoutes.selectParameter, with: nil)
        }
        await load(currentQuery())
        await loadBannerRecipient()
    }

    private func currentQuery() -> TransactionListQuery {
        let route = shell?.route ?? NativeRoute(path: TransactionsRoutes.path)
        let pageSize = settings.defaultPageSize > 0 ? settings.defaultPageSize : 50
        return TransactionListQuery(
            filters: TransactionFilters(route: route), search: search, sort: TransactionsRoutes.sort(in: route),
            includeExcluded: showAll, pageSize: pageSize)
    }

    /// A filter control's new route: pushed like `setSearchParams`.
    public func apply(_ route: NativeRoute) {
        shell?.navigate(to: route.string)
    }

    private var route: NativeRoute { shell?.route ?? NativeRoute(path: TransactionsRoutes.path) }

    public func setAccountFilter(_ account: OpenAPI.Account?) {
        var selection: (id: Int, label: String)?
        if let account { selection = (id: account.id, label: Self.accountLabel(account)) }
        apply(TransactionsRoutes.route(route, account: selection))
    }

    public func setCategoryFilter(_ id: Int?) {
        var selection: (id: Int, label: String)?
        if let id, let label = pickers.categoryLabel(id) { selection = (id: id, label: label) }
        apply(TransactionsRoutes.route(route, category: selection))
    }

    public func setDatePreset(_ preset: TransactionDatePreset) {
        apply(TransactionsRoutes.route(route, datePreset: preset, today: today, calendar: calendar))
    }

    public func setType(_ type: TransactionTypeFilter?) {
        apply(TransactionsRoutes.route(route, type: type))
    }

    public func setNeedsCategory(_ on: Bool) {
        apply(TransactionsRoutes.route(route, needsCategory: on))
    }

    /// A search suggestion: its parameters merge into the filter set.
    public func applyQuickFilter(_ parameters: [QuickFilterParameter]) {
        apply(TransactionsRoutes.route(route, applying: parameters))
    }

    /// The banner's clear: every filter goes, the sort stays.
    public func clearFilters() {
        apply(TransactionsRoutes.clearingFilters(route))
    }

    /// The banner's tag clear.
    public func clearTags() {
        apply(route.removing(TransactionsRoutes.tagsParameter))
    }

    /// The account's label: its display name, else its name.
    public nonisolated static func accountLabel(_ account: OpenAPI.Account) -> String {
        if let name = account.displayName, !name.isEmpty { return name }
        return account.name
    }

    /// The Account chip: the filtered account's label, else All accounts.
    public func accountChipLabel() -> String {
        guard let id = filters.accountId else { return strings.t("txPage.filter.allAccounts") }
        if let account = allAccounts.first(where: { $0.id == id }) { return Self.accountLabel(account) }
        return strings.t("txPage.filter.allAccounts")
    }

    /// The Category chip: the filtered category's path, else All categories.
    public func categoryChipLabel() -> String {
        filters.categoryId.flatMap { pickers.categoryLabel($0) } ?? strings.t("txPage.filter.allCategories")
    }

    /// The Date chip: the preset, or the custom range.
    public func dateChipLabel() -> String {
        if let preset = filters.datePreset(today: today, calendar: calendar) { return strings.t(preset.labelKey) }
        return filters.customDateLabel(format: settings.dateFormat) ?? strings.t("txPage.filter.date.custom")
    }

    /// The Type chip.
    public func typeChipLabel() -> String {
        filters.transactionType.map { strings.t($0.labelKey) } ?? strings.t("txPage.filter.type.all")
    }

    /// The banner's descriptor.
    public func bannerLabel() -> String {
        TransactionFilterDescriptor.label(filters, recipient: bannerRecipient, settings: settings, strings: strings)
    }

    // MARK: Search and sort

    /// The search settled (300 ms after typing): the list asks for it and `?search=` mirrors
    /// it with replace.
    public func commitSearch() async {
        guard searchText != search else { return }
        search = searchText
        let value = search.isEmpty ? nil : search
        lastSearchParam = value
        if let shell, shell.route.value(TransactionsRoutes.searchParameter) != value {
            shell.replaceQuery(TransactionsRoutes.searchParameter, with: value)
        }
        await load(currentQuery())
    }

    /// The search field's clear button.
    public func clearSearch() async {
        searchText = ""
        await commitSearch()
    }

    /// A header click: none → ascending → descending → none, written with replace.
    public func toggleSort(_ column: TransactionColumn) async {
        guard column.sortable, let shell else { return }
        let next = TransactionsRoutes.route(shell.route, sortedBy: LocalTableSort.cycled(sort, key: column.rawValue))
        shell.replaceQuery(next.query)
        await load(currentQuery())
    }

    /// Clear all: the search, the column filters and the sort; URL filters stay.
    public func clearAll() async {
        columnFilters.removeAll()
        searchText = ""
        if let shell, sort != nil {
            shell.replaceQuery(TransactionsRoutes.route(shell.route, sortedBy: nil).query)
        }
        if search.isEmpty {
            await load(currentQuery())
        } else {
            await commitSearch()
        }
    }

    /// Clear all shows with a search, a column filter or a sort.
    public var canClearAll: Bool { !searchText.isEmpty || !columnFilters.isEmpty || sort != nil }

    /// View › Show excluded.
    public func setShowAll(_ value: Bool) async {
        guard value != showAll else { return }
        showAll = value
        await load(currentQuery())
    }

    // MARK: Loading

    /// `isLoading`: no answer for the page yet.
    public var isLoading: Bool { rows == nil && error == nil }

    /// More rows exist on the server.
    public var hasMore: Bool { loadedOffset < total }

    /// The first page for `next`: one request per query at a time, and a fresh answer for
    /// the same query (30 s) is reused unless `force`.
    public func load(_ next: TransactionListQuery, force: Bool = false) async {
        if let inFlight, inFlight.query == next {
            await inFlight.task.value
            if !force { return }
        }
        if !force, query == next, rows != nil, error == nil, let fetchedAt,
            now().timeIntervalSince(fetchedAt) < Self.staleAfter
        {
            return
        }
        if let query, Self.selectionScope(query) != Self.selectionScope(next) {
            // Any filter change clears the checkbox selection.
            selection.clear()
        }
        query = next
        listVersion += 1
        isFetchingMore = false
        let mine = listVersion
        let task = Task { await run(next, version: mine) }
        inFlight = (next, task)
        await task.value
        if inFlight?.task == task { inFlight = nil }
    }

    /// The selection survives a sort or page-size change, not a filter, search or Show
    /// excluded change (`currentFilter`).
    private static func selectionScope(_ query: TransactionListQuery) -> TransactionListQuery {
        var scope = query
        scope.sort = nil
        scope.pageSize = 0
        return scope
    }

    private func run(_ next: TransactionListQuery, version: Int) async {
        do {
            let page = try await service.transactionPage(next, offset: 0)
            guard version == listVersion else { return }
            rows = page.items.map(TransactionRow.init)
            total = page.total
            loadedOffset = page.items.count
            error = nil
            fetchedAt = now()
            reconcileSelection()
        } catch is CancellationError {
            // `query` already names `next`: the rows still answer the previous query, so
            // they must not count as fresh for it.
            if version == listVersion { fetchedAt = nil }
            return
        } catch {
            guard version == listVersion else { return }
            self.error = APIError.wrapping(error)
            fetchedAt = nil
        }
    }

    /// Another native screen changed accounts or their transactions (an account create,
    /// merge, close or reconcile): the list, the account filter and the pickers refetch on the
    /// next load instead of serving a cached answer.
    public func invalidate() {
        fetchedAt = nil
        allAccounts = []
        pickers.reset()
    }

    /// The error state's Retry, and the reload after a create.
    public func reload() async {
        await load(currentQuery(), force: true)
    }

    /// `loadMore`: the next page after the loaded rows; a page answering an older query is
    /// dropped. A failure toasts `txPage.loadMoreFailed` with Retry.
    public func loadMore() async {
        guard let query, rows != nil, !isFetchingMore, hasMore, inFlight == nil, error == nil else { return }
        isFetchingMore = true
        let mine = listVersion
        do {
            let page = try await service.transactionPage(query, offset: loadedOffset)
            guard mine == listVersion else { return }
            let existing = Set((rows ?? []).map(\.id))
            rows = (rows ?? []) + page.items.filter { !existing.contains($0.id) }.map(TransactionRow.init)
            loadedOffset += page.items.count
            total = page.total
        } catch is CancellationError {
            if mine == listVersion { isFetchingMore = false }
            return
        } catch {
            guard mine == listVersion else { return }
            let notice = notices.make(.error, "txPage.loadMoreFailed", detail: strings.t("txPage.loadMoreFailedDesc"))
            self.notice = notice
            pendingAction = TransactionPendingAction(noticeID: notice.id, action: .retryLoadMore)
            notices.offerAction(for: notice, titleKey: "common.retry", lifetime: 4, isUndo: false) { [weak self] in
                await self?.loadMore()
            }
        }
        if mine == listVersion { isFetchingMore = false }
    }

    /// A row was drawn: within the threshold of the end, the next page loads.
    public func rowAppeared(_ id: Int) async {
        let shown = visibleRows
        guard let index = shown.firstIndex(where: { $0.id == id }) else { return }
        let threshold = ServerTablePaging.loadMoreThreshold(pageSize: query?.pageSize ?? 50)
        if ServerTablePaging.shouldLoadMore(
            rowIndex: index, shownCount: shown.count, threshold: threshold, hasMore: hasMore)
        {
            await loadMore()
        }
    }

    /// `useAccounts({ active: "all" })`, once per visit.
    public func loadAllAccounts() async {
        if !allAccounts.isEmpty { return }
        if let accountsInFlight {
            await accountsInFlight.value
            return
        }
        let service = service
        let task = Task { [weak self] in
            guard let list = try? await service.allAccounts() else { return }
            self?.allAccounts = list
        }
        accountsInFlight = task
        await task.value
        accountsInFlight = nil
    }

    /// `useNeedsCategoryCount`: refetched after a change.
    public func refreshNeedsCategoryCount() async {
        if let countInFlight {
            await countInFlight.value
        }
        let service = service
        let task = Task { [weak self] in
            guard let total = try? await service.uncategorisedCount(recipientId: nil) else { return }
            self?.needsCategoryCount = total
        }
        countInFlight = task
        await task.value
        if countInFlight == task { countInFlight = nil }
    }

    /// `useRecipient(recipient_id)` of the banner.
    func loadBannerRecipient() async {
        let id = filters.recipientId
        guard id != bannerRecipientId else { return }
        bannerRecipientId = id
        guard let id else {
            bannerRecipient = .loading
            return
        }
        bannerRecipient = .loading
        do {
            let found = try await service.recipient(id: id)
            if bannerRecipientId == id { bannerRecipient = .found(found.name) }
        } catch {
            if bannerRecipientId == id { bannerRecipient = .failed }
        }
    }

    // MARK: Table

    /// The rows the table shows: the loaded rows through the client column filters.
    public var visibleRows: [TransactionRow] {
        let labels = labels
        return columnFilters.apply(rows ?? []) { row, key in row.rawValue(key, labels: labels) }
    }

    /// The distinct values the column filter lists.
    public func filterValues(_ column: TransactionColumn) -> [String] {
        let labels = labels
        return LocalTableQuery.uniqueValues(rows ?? [], key: column.rawValue) { row, key in
            row.rawValue(key, labels: labels)
        }
    }

    /// The columns shown after the select box.
    public var columns: [TransactionColumn] { TransactionColumn.shown(columnVisibility) }

    /// What an empty table says.
    public var emptyState: TransactionsEmptyState {
        if !columnFilters.isEmpty && !(rows ?? []).isEmpty { return .noFilterResults }
        return search.isEmpty ? .noTransactions : .noSearchResults
    }

    /// The account display names, for the Account cells.
    public var accountNames: [Int: String] {
        var names: [Int: String] = [:]
        for account in pickers.accounts where names[account.id] == nil {
            names[account.id] = Self.accountLabel(account)
        }
        return names
    }

    /// The header subtitle: `txPage.countInAccounts` with the active accounts, else
    /// `txPage.tableSubtitle`.
    public func subtitle() -> String {
        let accounts = pickers.accounts.count
        if accounts > 0 {
            return strings.t("txPage.countInAccounts", ["n": String(total), "m": String(accounts)])
        }
        return strings.t("txPage.tableSubtitle", ["n": String(total)])
    }

    /// The footer: `table.shownOfFiltered` while column filters hide rows, else
    /// `table.loadedOf`, with ` · ` `table.scrollForMore` while more rows exist.
    public func footer() -> String {
        let loaded = rows?.count ?? 0
        let shown = visibleRows.count
        var text =
            !columnFilters.isEmpty && shown != loaded
            ? strings.t("table.shownOfFiltered", ["shown": String(shown), "total": String(total)])
            : strings.t("table.loadedOf", ["loaded": String(loaded), "total": String(total)])
        if hasMore { text += " · " + strings.t("table.scrollForMore") }
        return text
    }

    // MARK: Column choices

    /// `useWidgetVisibility(TRANSACTIONS_COLUMNS_PAGE_KEY)`: read once per visit.
    public func loadColumnVisibility() async {
        if visibilityLoaded { return }
        if let visibilityInFlight {
            await visibilityInFlight.value
            return
        }
        let service = service
        let task = Task { [weak self] in
            do {
                let setting = try await service.setting(key: TransactionColumnVisibility.settingKey)
                guard let self else { return }
                self.visibilitySetting = setting.value
                self.visibilityBaseline = setting.expected
                self.columnVisibility = TransactionColumnVisibility.read(setting.value)
            } catch {
                if case .client(let failure)? = error as? APIError, failure.status == 404 {
                    self?.visibilityBaseline = .object(["exists": .bool(false)])
                }
            }
            self?.visibilityLoaded = true
        }
        visibilityInFlight = task
        await task.value
        visibilityInFlight = nil
    }

    /// A View menu column choice.
    public func setColumn(_ column: OptionalTransactionColumn, visible: Bool) {
        columnVisibility.stored[column.rawValue] = visible
        persistColumns()
    }

    /// View › Reset columns.
    public func resetColumns() {
        columnVisibility = TransactionColumnVisibility()
        persistColumns()
    }

    private func persistColumns() {
        let value = columnVisibility.written(into: visibilitySetting)
        visibilitySetting = value
        let previous = visibilitySaves
        let service = service
        visibilitySaves = Task { [weak self] in
            await previous?.value
            guard let self, let expected = self.visibilityBaseline else { return }
            do {
                let saved = try await service.saveSetting(
                    key: TransactionColumnVisibility.settingKey, value: value, expected: expected)
                self.visibilityBaseline = .object(["exists": .bool(true), "value": saved.value])
            } catch {
                // The choice stays for this visit; the next visit reads the stored one.
                self.visibilityBaseline = nil
            }
        }
    }

    /// Waits for the column choices queued so far.
    public func settleColumns() async {
        await visibilitySaves?.value
    }

    // MARK: Inspector and focus

    /// The selected row, while it is loaded.
    public var selectedRow: TransactionRow? {
        guard let selectedId else { return nil }
        return rows?.first { $0.id == selectedId }
    }

    public func row(_ id: Int) -> TransactionRow? {
        rows?.first { $0.id == id }
    }

    /// A row click, Enter or the row gaining focus: the inspector shows it.
    public func select(_ id: Int) {
        guard selectedId != id || inspector == nil else { return }
        selectedId = id
        if let row = row(id) {
            makeInspector(for: row)
        } else {
            inspector = nil
        }
    }

    private func makeInspector(for row: TransactionRow) {
        guard inspector?.id != row.id else { return }
        inspector = TransactionInspectorModel(
            row: row, service: service, attachments: attachmentService,
            save: { [weak self] data, name in
                guard let self else { return false }
                return try await self.save(data, name)
            })
    }

    /// Below `dockedInspectorWidth` the inspector is a sheet. While it is, the Split dialog,
    /// the Delete alert and the Add sheet present from inside it (a window shows one sheet
    /// per presenter), so its Split and Delete keep the inspector open behind them.
    public func inspectorIsSheet(pageWidth: Double) -> Bool {
        pageWidth < Self.dockedInspectorWidth && selectedRow != nil && inspector != nil
    }

    /// The close button or Escape: the row loses the inspector and gets focus back.
    public func closeInspector() {
        let id = selectedId
        selectedId = nil
        inspector = nil
        focusRequest = id
    }

    /// A row gained keyboard focus: it is selected, unless focus is returning to it.
    public func rowFocused(_ id: Int) {
        if focusRequest == id {
            focusRequest = nil
            return
        }
        select(id)
    }

    /// The view moved focus where `focusRequest` asked.
    public func focusRestored() {
        focusRequest = nil
    }

    /// A row that left the loaded list closes the inspector; one that arrived later (a
    /// deep link answered by the page) opens it.
    private func reconcileSelection() {
        if let rows {
            selection.keep(only: Set(rows.map(\.id)))
        }
        guard let selectedId else { return }
        if let row = selectedRow {
            makeInspector(for: row)
        } else if !isLoading, !(rows ?? []).isEmpty {
            self.selectedId = nil
            inspector = nil
        }
        if let quickLookId, row(quickLookId) == nil { self.quickLookId = nil }
    }

    /// A key on a focused row; returns the row focus moves to.
    public func handleRowKey(_ key: TransactionRowKey, from id: Int) -> Int? {
        let shown = visibleRows
        guard let index = shown.firstIndex(where: { $0.id == id }) else { return nil }
        switch key {
        case .up:
            return index > 0 ? shown[index - 1].id : nil
        case .down:
            return index + 1 < shown.count ? shown[index + 1].id : nil
        case .open:
            select(id)
            return nil
        case .quickLook:
            toggleQuickLook(id)
            return nil
        case .close:
            guard selectedId != nil else { return nil }
            closeInspector()
            return nil
        }
    }

    /// Space or the context menu's Quick Look; Space again closes it.
    public func toggleQuickLook(_ id: Int) {
        if quickLookId == id {
            closeQuickLook()
        } else {
            quickLookId = id
        }
    }

    /// Quick Look closed: focus returns to its row.
    public func closeQuickLook() {
        let id = quickLookId
        quickLookId = nil
        if let id { focusRequest = id }
    }

    public var quickLookRow: TransactionRow? { quickLookId.flatMap(row) }

    // MARK: Checkbox selection

    private var shownIds: [Int] { visibleRows.map(\.id) }

    public func toggleSelection(_ id: Int) {
        selection.toggle(id)
    }

    /// Shift-click: a range from the last toggled row.
    public func extendSelection(to id: Int) {
        selection.extend(to: id, in: shownIds)
    }

    /// The header box: every loaded row, or none.
    public func toggleSelectAll() {
        selection.toggleAll(shownIds)
    }

    public var allSelected: Bool { selection.allSelected(shownIds) }
    public var someSelected: Bool { selection.someSelected(shownIds) }

    public func clearSelection() {
        selection.clear()
    }

    // MARK: Inline editing

    /// The Edit pencil, a double-click or Edit in row.
    public func startEditing(_ row: TransactionRow) {
        rowEditor = TransactionRowEditor(row: row, format: settings.numberFormat)
    }

    /// Cancel or Escape: focus returns to the row.
    public func cancelEditing() {
        let id = rowEditor?.id
        rowEditor = nil
        if let id { focusRequest = id }
    }

    /// The row's Save or Enter in the amount: the PATCH, then the server's row.
    public func saveEditing() async {
        guard let editor = rowEditor, let row = row(editor.id),
            let patch = editor.patch(for: row, format: settings.numberFormat)
        else { return }
        rowEditor = nil
        focusRequest = editor.id
        _ = await update(row.id, patch: patch)
    }

    // MARK: Row actions

    /// `handleSelectCategory`: the row shows the category at once, then the server's answer;
    /// a failure puts the old category back. `nil` clears it.
    public func selectCategory(_ row: TransactionRow, categoryId: Int?) async {
        if rowEditor?.id == row.id { rowEditor = nil }
        var patch = TransactionPatch()
        patch.categoryId = .some(categoryId)
        let name = categoryId == nil ? labels.uncategorized : categoryId.flatMap { pickers.categoryName($0) }
        _ = await update(row.id, patch: patch) { edited in
            edited.categoryId = categoryId
            edited.categoryName = name
        }
        await refreshAfterCategoryChange()
    }

    /// `handleSelectRecipient`, the same for the payee.
    public func selectRecipient(_ row: TransactionRow, recipientId: Int?) async {
        if rowEditor?.id == row.id { rowEditor = nil }
        var patch = TransactionPatch()
        patch.recipientId = .some(recipientId)
        let name = recipientId == nil ? labels.unknown : recipientId.flatMap { pickers.recipientName($0) }
        _ = await update(row.id, patch: patch) { edited in
            edited.recipientId = recipientId
            edited.recipientName = name
        }
        if inspector?.id == row.id { await inspector?.load(recipientId: recipientId) }
    }

    /// Exclude from totals / Include in totals and the Status toggle.
    public func toggleActive(_ row: TransactionRow) async {
        guard updatesInFlight == 0 else { return }
        var patch = TransactionPatch()
        patch.isActive = !row.isActive
        _ = await update(row.id, patch: patch) { edited in edited.isActive = !row.isActive }
    }

    /// The PATCH every edit goes through: `optimistic` changes the loaded row first and is
    /// undone on failure. The server's row replaces it; a row excluded while Show excluded is
    /// off leaves the list, as the refetch would drop it. Toasts `transactions.updated` or
    /// `transactions.updateFailedTitle` with the reason.
    @discardableResult
    func update(
        _ id: Int, patch: TransactionPatch, optimistic: ((inout TransactionRow) -> Void)? = nil
    ) async -> Bool {
        let before = row(id)
        if let optimistic, let index = rows?.firstIndex(where: { $0.id == id }), var edited = rows?[index] {
            optimistic(&edited)
            rows?[index] = edited
        }
        updatesInFlight += 1
        defer { updatesInFlight -= 1 }
        do {
            let wire = try await service.updateTransaction(id: id, patch: patch)
            if let index = rows?.firstIndex(where: { $0.id == id }), var merged = rows?[index] {
                merged.merge(wire)
                rows?[index] = merged
                if !showAll && !merged.isActive { removeRow(id) }
            }
            if inspector?.id == id, let updated = row(id) { inspector?.tagSlugs = updated.tags.map(\.slug) }
            post(.success, "transactions.updated")
            return true
        } catch is CancellationError {
            if let before { restore(before) }
            return false
        } catch {
            if let before { restore(before) }
            post(.error, "transactions.updateFailedTitle", detail: errorText(error))
            return false
        }
    }

    private func restore(_ row: TransactionRow) {
        guard let index = rows?.firstIndex(where: { $0.id == row.id }) else { return }
        var restored = row
        // The running balance belongs to the list query.
        restored.runningBalance = rows?[index].runningBalance
        rows?[index] = restored
    }

    func removeRow(_ id: Int) {
        guard let index = rows?.firstIndex(where: { $0.id == id }) else { return }
        rows?.remove(at: index)
        total = max(0, total - 1)
        reconcileSelection()
    }

    private func refreshAfterCategoryChange() async {
        await refreshNeedsCategoryCount()
        if let inspector, let row = row(inspector.id) {
            await inspector.load(recipientId: row.recipientId, force: true)
        }
    }

    /// Duplicate: a copy confirmed as an intentional duplicate, then the first page again.
    public func duplicate(_ row: TransactionRow) async {
        guard let body = row.duplicateBody else { return }
        do {
            _ = try await service.createTransaction(body)
            post(.success, "transactions.created")
            await reload()
            await refreshNeedsCategoryCount()
        } catch {
            if case .client(let failure)? = error as? APIError, failure.code == .conflict { return }
            post(.error, "transactions.createFailedTitle", detail: errorText(error))
        }
    }

    /// Show all from {payee}: a fresh filter set of the payee, the search cleared.
    public func showAllFrom(_ row: TransactionRow) {
        guard let recipientId = row.recipientId else { return }
        searchText = ""
        search = ""
        lastSearchParam = nil
        apply(TransactionsRoutes.showingAll(from: recipientId, name: row.recipient(labels)))
    }

    /// Delete…: asks first.
    public func requestDelete(_ row: TransactionRow) {
        pendingDelete = row
    }

    public func cancelDelete() {
        pendingDelete = nil
    }

    /// The alert's Delete: the inspector closes if it shows the row, the row leaves the list
    /// at once, and the toast offers Undo when the row can be recreated. A failure puts it
    /// back and toasts `transactions.deleteFailedTitle`.
    public func confirmDelete() async {
        guard let row = pendingDelete else { return }
        pendingDelete = nil
        if selectedId == row.id {
            selectedId = nil
            inspector = nil
        }
        if rowEditor?.id == row.id { rowEditor = nil }
        let index = rows?.firstIndex(where: { $0.id == row.id })
        let removed = index.flatMap { rows?[$0] }
        removeRow(row.id)
        deletePending = true
        defer { deletePending = false }
        do {
            try await service.deleteTransaction(id: row.id)
            if row.restoreBody != nil {
                let notice = notices.make(.success, "transactions.deleted")
                self.notice = notice
                pendingAction = TransactionPendingAction(noticeID: notice.id, action: .undoDelete(row))
                notices.offerAction(for: notice, titleKey: "common.undo", lifetime: 8, isUndo: true) { [weak self] in
                    await self?.restoreDeleted(row)
                }
            } else {
                post(.success, "transactions.deleted")
            }
            await refreshNeedsCategoryCount()
        } catch {
            if let index, let removed, let current = rows, !current.contains(where: { $0.id == removed.id }) {
                // Read the count before the in-place insert: an argument that reads `rows`
                // while its modify accessor is open is an exclusivity violation at runtime.
                let position = min(index, current.count)
                rows?.insert(removed, at: position)
                total += 1
            }
            post(.error, "transactions.deleteFailedTitle", detail: errorText(error))
        }
    }

    /// The toast's action: Undo (also ⌘Z) or Retry.
    public func performPendingAction() async {
        guard let pending = pendingAction else { return }
        pendingAction = nil
        if notice?.id == pending.noticeID { notice = nil }
        switch pending.action {
        case .retryLoadMore:
            await loadMore()
        case .undoDelete(let row):
            await restoreDeleted(row)
        }
    }

    private func restoreDeleted(_ row: TransactionRow) async {
        guard let body = row.restoreBody else { return }
        do {
            _ = try await service.createTransaction(body)
            post(.success, "transactions.restored")
            await reload()
            await refreshNeedsCategoryCount()
        } catch {
            post(.error, "transactions.restoreFailedTitle", detail: errorText(error))
        }
    }

    public func attachNotices(_ center: NativeNoticeCenter) {
        notices.attach(center) { [weak self] in self?.clearNotice($0) }
    }

    /// The label of the toast's action button.
    public func actionTitle(for notice: ScreenNotice) -> String? {
        guard let pendingAction, pendingAction.noticeID == notice.id else { return nil }
        switch pendingAction.action {
        case .undoDelete: return strings.t("common.undo")
        case .retryLoadMore: return strings.t("common.retry")
        }
    }

    /// ⌘Z answers only an Undo.
    public var actionIsUndo: Bool {
        if case .undoDelete? = pendingAction?.action { return true }
        return false
    }

    // MARK: Inspector actions

    /// The Details Save: the edited field's PATCH; the field stays open on failure.
    public func saveDetail() async {
        guard let inspector, let row = row(inspector.id),
            let patch = inspector.patch(accounts: pickers.accounts, format: settings.numberFormat)
        else { return }
        inspector.isSaving = true
        defer { inspector.isSaving = false }
        if await update(row.id, patch: patch) {
            inspector.cancelEdit()
        }
    }

    /// The Tags field: the chips change at once; a failure puts the row's tags back.
    public func setTags(_ slugs: [String]) async {
        guard let inspector, let row = row(inspector.id) else { return }
        inspector.tagSlugs = slugs
        var patch = TransactionPatch()
        patch.tags = slugs
        if !(await update(row.id, patch: patch)) {
            inspector.tagSlugs = (self.row(row.id) ?? row).tags.map(\.slug)
        }
    }

    /// Use for all: the payee's other uncategorised transactions get this row's category.
    public func useForAll() async {
        guard let inspector, let row = row(inspector.id), let recipientId = row.recipientId,
            let categoryId = row.categoryId
        else { return }
        do {
            let result = try await service.categorizeUncategorised(
                recipientId: recipientId, categoryId: categoryId,
                expectedCount: inspector.uncategorisedCount ?? 0)
            let toast = Self.bulkUpdatedToast(result, language: strings.language)
            notice = notices.make(.success, toast.key, toast.variables)
            await reload()
            await refreshAfterCategoryChange()
        } catch {
            post(.error, "txPage.bulk.failed", detail: errorText(error))
        }
    }

    /// `useBulkUpdateTransactions`'s toast: the plural key `tc` picks for the count, with
    /// `{count}` filled like `tc`.
    static func bulkUpdatedToast(_ result: BulkUpdateResult, language: NativeLanguage)
        -> (key: String, variables: [String: String])
    {
        func plural(_ key: String, _ count: Int, _ variables: [String: String]) -> (
            key: String, variables: [String: String]
        ) {
            let category = PluralCategory.of(count, language: language).rawValue
            return ("\(key).\(category)", variables.merging(["count": String(count)]) { given, _ in given })
        }
        if result.matched != result.requested {
            return plural(
                "txPage.bulk.updatedSelectionChanged", result.updated,
                [
                    "affected": String(result.updated), "requested": String(result.requested),
                    "matched": String(result.matched),
                ])
        }
        if result.updated == result.requested {
            return plural("txPage.bulk.updated", result.updated, ["n": String(result.updated)])
        }
        return plural(
            "txPage.bulk.updatedOf", result.requested,
            [
                "affected": String(result.updated), "requested": String(result.requested),
                "skipped": String(result.requested - result.updated),
            ])
    }

    /// Always use: the payee's default category becomes this row's.
    public func alwaysUse() async {
        guard let inspector, let row = row(inspector.id), let recipientId = row.recipientId,
            let categoryId = row.categoryId
        else { return }
        do {
            try await service.setRecipientDefaultCategory(recipientId: recipientId, categoryId: categoryId)
            post(.success, "recipients.updated")
            await inspector.load(recipientId: recipientId, force: true)
        } catch {
            post(.error, "recipients.updateFailedTitle", detail: errorText(error))
        }
    }

    /// Edit rule…: `/recipients`.
    public func editRule() {
        shell?.navigate(to: "/recipients")
    }

    /// The attachment delete failed: the page's toast.
    public func reportAttachmentDeleteFailure() {
        guard let inspector, let error = inspector.attachments.deleteError else { return }
        inspector.attachments.clearDeleteError()
        post(.error, "txPage.deleteAttachmentError", detail: APIErrorMessage.text(error, strings: strings))
    }

    /// The attachment download failed: the page's `txPage.downloadAttachmentError` toast.
    public func reportAttachmentDownloadFailure() {
        guard let inspector, let error = inspector.attachments.downloadError else { return }
        inspector.attachments.clearDownloadError()
        post(.error, "txPage.downloadAttachmentError", detail: APIErrorMessage.text(error, strings: strings))
    }

    // MARK: Export

    /// The banner's Export CSV / Export JSON: the filtered rows, saved where the Save panel
    /// says. Toasts `txPage.toast.exportSuccess` once written, or `txPage.toast.exportFailed`.
    public func export(_ format: ExportFormat) async {
        guard exportingFormat == nil else { return }
        exportingFormat = format
        defer { exportingFormat = nil }
        let query = TransactionExportQuery(filters: filters, search: search)
        do {
            let data = try await service.exportFilteredTransactions(format, query: query)
            if try await save(data, query.fileName(format, today: today)) {
                post(.success, "txPage.toast.exportSuccess")
            }
        } catch is CancellationError {
            return
        } catch {
            post(.error, "txPage.toast.exportFailed", detail: errorText(error))
        }
    }

    // MARK: Sheets

    /// Add transaction (`new=1`, ⌘N, the header button): the kept form, or a fresh one.
    public func requestAdd() {
        if addForm == nil {
            let days = calendar
            let clock = now
            addForm = AddTransactionModel(
                defaultCurrency: settings.defaultCurrency, pickers: pickers, calendar: days,
                today: { PlannedDay(clock(), calendar: days) })
        }
        isAddPresented = true
    }

    /// Cancel, Escape or the close button: the form stays for next time.
    public func dismissAdd() {
        isAddPresented = false
    }

    /// Split transaction: the dialog for the row, its existing splits loading.
    public func requestSplit(_ row: TransactionRow) {
        guard Self.splitIsNative else { return }
        splitRequest = row
        splitForm = SplitDialogModel(row: row, service: splitsService)
    }

    public func dismissSplit() {
        splitRequest = nil
        splitForm = nil
    }

    /// The Add sheet's or the Bulk tag dialog's unsaved work (`useUnsavedChanges`) holds a
    /// navigation to another page behind the Leave this page? alert.
    public var leaveGuard: NativeLeaveGuard {
        NativeLeaveGuard(
            id: TransactionsRoutes.path,
            hasUnsavedChanges: { [weak self] in self?.hasUnsavedChanges ?? false },
            discard: { [weak self] in self?.discardUnsavedChanges() })
    }

    public var hasUnsavedChanges: Bool {
        if isAddPresented, addForm?.isDirty == true { return true }
        if bulkDialog == .tag, !bulkDrafts.tagsEmpty { return true }
        return false
    }

    private func discardUnsavedChanges() {
        isAddPresented = false
        addForm = nil
        if bulkDialog == .tag { bulkDialog = nil }
        bulkDrafts.tagsToAdd = []
        bulkDrafts.tagsToRemove = []
    }

    // MARK: Toasts

    /// The toast was dismissed or timed out; its action goes with it.
    public func clearNotice(_ id: Int) {
        if notice?.id == id { notice = nil }
        if pendingAction?.noticeID == id { pendingAction = nil }
    }

    /// The Undo toast lives as long as its Undo.
    public func duration(of notice: ScreenNotice) -> Duration {
        if pendingAction?.noticeID == notice.id, actionIsUndo { return Self.undoDuration }
        return Self.noticeDuration
    }

    func post(_ kind: ScreenNotice.Kind, _ key: String, _ variables: [String: String] = [:], detail: String? = nil) {
        notice = notices.make(kind, key, variables, detail: detail)
    }

    func errorText(_ error: any Error) -> String {
        APIErrorMessage.text(APIError.wrapping(error), strings: strings)
    }

    /// The screen went away: its dialogs, editors and table state go with it, like an
    /// unmounted page. The loaded list stays cached; a toast and its Undo stay.
    public func disappear() {
        pendingDelete = nil
        rowEditor = nil
        quickLookId = nil
        isAddPresented = false
        addForm = nil
        splitRequest = nil
        splitForm = nil
        bulkDialog = nil
        bulkConfirmation = nil
        bulkDrafts = TransactionBulkDrafts()
        selectedId = nil
        inspector = nil
        focusRequest = nil
        selection.clear()
        columnFilters.removeAll()
        showAll = false
        visibilityLoaded = false
        bannerRecipientId = nil
        pickers.reset()
    }
}
