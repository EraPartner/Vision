import Foundation
import Observation

/// The inline edit of one payee row: the name and notes inputs.
public struct PayeeRowEdit: Equatable, Sendable {
    public let id: Int
    public var name: String
    public var notes: String

    public init(id: Int, name: String, notes: String) {
        self.id = id
        self.name = name
        self.notes = notes
    }
}

/// The Add payee dialog (`AddRecipientDialog`).
public struct PayeeAddDraft: Equatable, Sendable {
    /// The Name input's `maxLength`.
    public static let nameLimit = 200
    /// The Notes textarea's `maxLength`.
    public static let notesLimit = 1000

    public private(set) var name = ""
    public private(set) var notes = ""
    /// Set by a submit: the name error shows while the trimmed name is empty.
    public internal(set) var submitted = false
    public internal(set) var isSaving = false

    public init() {}

    public mutating func setName(_ text: String) {
        name = String(text.prefix(Self.nameLimit))
    }

    public mutating func setNotes(_ text: String) {
        notes = String(text.prefix(Self.notesLimit))
    }

    /// `form.nameRequired` under the name.
    public var showsNameError: Bool {
        submitted && name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

/// What the toast's action does.
enum PayeePendingAction {
    /// `undoToast`'s Undo of a status flip: the payee and the status it restores.
    case undoStatus(OpenAPI.Recipient, restore: Bool)
    /// Merge's rule suggestion: Create rule on the primary.
    case createRule(primaryId: Int, pattern: String, kind: MatchRuleKind)
}

/// The state of `/recipients` (RecipientsPage): the server-paged payees table with its View
/// menu (Show inactive, Uncategorized only), search, sort, column filters on the loaded
/// rows, infinite scroll and its load-more Retry, the inline edit, each row's ••• menu
/// (Edit, Match rules, Unmerge, Mark inactive / active with Undo, Delete), and the Add payee,
/// Merge payees and Match rules dialogs.
@MainActor
@Observable
public final class RecipientsModel {
    /// `QUERY_STALE_TIME_MS.FREQUENT` of `useVirtualRecipients`.
    public static let staleAfter: TimeInterval = 30
    /// `useAllRecipientsForMerge`'s `staleTime`.
    public static let mergeListStaleAfter: TimeInterval = 120
    /// Merge payees loads every payee in pages of 1000.
    public nonisolated static let mergePageSize = 1000
    public static let noticeDuration: Duration = .seconds(4)
    /// `DEFAULT_UNDO_TTL_MS` of `undoToast`.
    public static let undoDuration: Duration = .seconds(8)
    /// The rule suggestion toast's `duration`.
    public static let suggestionDuration: Duration = .seconds(10)

    /// The loaded payees; `nil` until the first page.
    public private(set) var rows: [OpenAPI.Recipient]?
    public private(set) var total = 0
    public private(set) var error: APIError?
    public private(set) var isFetchingMore = false
    /// `recipientsPage.loadMoreFailed` with Retry.
    public private(set) var loadMoreFailed = false
    /// The search input as typed; the URL holds the gated value.
    public var searchText = ""
    /// The column filters over the loaded rows (never sent to the server).
    public private(set) var columnFilters = ServerColumnFilters()
    /// The row in inline edit.
    public var editing: PayeeRowEdit?

    /// The Add payee dialog.
    public var add: PayeeAddDraft?
    /// Bumped when a failed Add payee submit should focus the name.
    public internal(set) var addFocusRequest = 0
    /// The Merge payees dialog and its selection, kept while the dialog is dismissed.
    public let merge: PayeeMergeState
    /// The Match rules dialog.
    public var rules: MatchRulesState?
    /// The Delete payee alert, for this payee.
    public internal(set) var pendingDelete: OpenAPI.Recipient?
    /// A write is on its way (the row menu's items disable).
    public internal(set) var isUpdating = false
    public internal(set) var isTogglingStatus = false
    public internal(set) var isDeleting = false
    public internal(set) var isUnmerging = false
    public internal(set) var notice: ScreenNotice?
    @ObservationIgnored private(set) var pendingAction: (noticeID: Int, action: PayeePendingAction)?

    @ObservationIgnored let service: any RecipientsService
    @ObservationIgnored weak var shell: NativeShellModel?
    @ObservationIgnored var notices = NoticeCounter()
    @ObservationIgnored private(set) var visible = false
    @ObservationIgnored let now: @Sendable () -> Date
    @ObservationIgnored private var loadedKey: PayeeTableKey?
    @ObservationIgnored private var fetchedAt: Date?
    @ObservationIgnored private var offset = 0
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var inFlight: (key: PayeeTableKey, task: Task<Void, Never>)?

    public init(service: any RecipientsService, now: @escaping @Sendable () -> Date = { Date() }) {
        self.service = service
        self.now = now
        merge = PayeeMergeState(service: service, now: now)
        merge.owner = self
    }

    func attach(_ shell: NativeShellModel) {
        self.shell = shell
    }

    var strings: any Localizing { shell?.strings ?? DictionaryStrings(language: .en, table: [:]) }
    public var settings: NativeAppSettings { shell?.settings ?? .defaults }

    /// The pickers the inline category edit lists (shared with Transactions).
    public var pickers: PickerDataModel? { shell?.transactions.pickers }

    // MARK: Visibility

    /// The screen appeared: the search input takes the URL's search, and the first page
    /// loads (a fresh one is reused).
    public func appear() async {
        visible = true
        if let shell { searchText = RecipientsRoutes.search(in: shell.route) }
        await load()
    }

    /// The screen went away: the inline edit, the dialogs and the alert close. Merge
    /// payees' selection stays, like the mounted-but-closed web dialog.
    public func disappear() {
        visible = false
        editing = nil
        add = nil
        rules = nil
        pendingDelete = nil
        merge.isOpen = false
    }

    /// Merge payees' selection blocks leaving the page (`useUnsavedChanges`).
    public var leaveGuard: NativeLeaveGuard {
        NativeLeaveGuard(
            id: RecipientsRoutes.path,
            hasUnsavedChanges: { [weak self] in self?.merge.hasSelection ?? false },
            discard: { [weak self] in self?.merge.reset() })
    }

    // MARK: Route state

    public var showAll: Bool {
        guard visible, let shell else { return false }
        return RecipientsRoutes.showAll(in: shell.route)
    }

    public var uncategorizedOnly: Bool {
        guard visible, let shell else { return false }
        return RecipientsRoutes.uncategorized(in: shell.route)
    }

    /// The server search in the URL.
    public var search: String {
        guard visible, let shell else { return "" }
        return RecipientsRoutes.search(in: shell.route)
    }

    public var sort: LocalTableSort? {
        guard visible, let shell else { return nil }
        return RecipientsRoutes.sort(in: shell.route)
    }

    /// `appSettings.defaultPageSize`.
    public var pageSize: Int { settings.defaultPageSize > 0 ? settings.defaultPageSize : 50 }

    /// What the first page depends on; a change reloads it.
    public var tableKey: PayeeTableKey {
        PayeeTableKey(
            query: PayeePageQuery(
                active: !showAll, search: search.isEmpty ? nil : search, uncategorized: uncategorizedOnly,
                sortBy: sort?.key, sortDir: sort.map { $0.ascending ? "asc" : "desc" }),
            pageSize: pageSize)
    }

    /// View menu: Show inactive.
    public func setShowAll(_ on: Bool) async {
        guard visible else { return }
        shell?.replaceQuery(RecipientsRoutes.showAllParameter, with: on ? "true" : nil)
        await load()
    }

    /// View menu: Uncategorized only.
    public func setUncategorizedOnly(_ on: Bool) async {
        guard visible else { return }
        shell?.replaceQuery(RecipientsRoutes.uncategorizedParameter, with: on ? "true" : nil)
        await load()
    }

    /// The debounced search: the gated text goes to the URL, then the first page.
    public func commitSearch() async {
        guard visible else { return }
        let gated = RecipientsRoutes.gate(searchText)
        if gated != search {
            shell?.replaceQuery(RecipientsRoutes.searchParameter, with: gated.isEmpty ? nil : gated)
        }
        await load()
    }

    /// A header's sort button: ascending, descending, then none, sorted by the server.
    public func toggleSort(_ key: String) async {
        await setSort(LocalTableSort.cycled(sort, key: key))
    }

    public func setSort(_ next: LocalTableSort?) async {
        guard visible, let shell else { return }
        shell.replaceQuery(RecipientsRoutes.writingSort(next, to: shell.route))
        await load()
    }

    /// A column filter (empty removes it); only the loaded rows are filtered.
    public func setColumnFilter(_ key: String, to value: String) {
        columnFilters.set(key, to: value)
    }

    /// Clear all: the search, the column filters and the sort.
    public func clearAll() async {
        guard visible, let shell else { return }
        searchText = ""
        columnFilters.removeAll()
        let cleared = RecipientsRoutes.writingSort(nil, to: shell.route.removing(RecipientsRoutes.searchParameter))
        shell.replaceQuery(cleared)
        await load()
    }

    /// The table chrome's query: the typed search, the URL's sort and the column filters.
    public var tableQuery: LocalTableQuery {
        var query = LocalTableQuery()
        query.search = searchText
        for filter in columnFilters.filters { query.setFilter(filter.key, to: filter.value) }
        if let sort {
            query.toggleSort(sort.key)
            if !sort.ascending { query.toggleSort(sort.key) }
        }
        return query
    }

    /// A change the table chrome made to `tableQuery`: Clear all, the search input and its
    /// ×, a sort button or a column filter.
    public func apply(_ next: LocalTableQuery) async {
        let current = tableQuery
        if next == current { return }
        if !next.showsClearAll && current.showsClearAll {
            await clearAll()
            return
        }
        if next.filters != current.filters {
            columnFilters.removeAll()
            for filter in next.filters { columnFilters.set(filter.key, to: filter.value) }
        }
        if next.search != current.search {
            searchText = next.search
            // The × clears at once; typing waits for the debounce.
            if next.search.isEmpty { await commitSearch() }
        }
        if next.sort != current.sort {
            await setSort(next.sort)
        }
    }

    // MARK: Loading

    public var isLoading: Bool { rows == nil && error == nil }

    /// More rows exist on the server.
    public var hasMore: Bool { rows != nil && offset < total }

    /// The rows the table shows: the loaded rows narrowed by the column filters.
    public var shownRows: [OpenAPI.Recipient] {
        let none = strings.t("recipientsPage.none")
        return columnFilters.apply(rows ?? []) { payee, key in PayeeColumns.value(payee, key: key, none: none) }
    }

    /// A column filter's value list: the distinct raw values of the loaded rows.
    public func filterValues(_ key: String) -> [String] {
        let none = strings.t("recipientsPage.none")
        return LocalTableQuery.uniqueValues(rows ?? [], key: key) { payee, key in
            PayeeColumns.value(payee, key: key, none: none)
        }
    }

    /// The first page for the current key: one request at a time, a fresh answer reused
    /// unless `force`. The loaded rows stay until the new page arrives.
    public func load(force: Bool = false) async {
        let key = tableKey
        if let inFlight, inFlight.key == key {
            await inFlight.task.value
            if !force { return }
        }
        if !force, loadedKey == key, rows != nil, error == nil, let fetchedAt,
            now().timeIntervalSince(fetchedAt) < Self.staleAfter
        {
            return
        }
        let service = service
        let task = Task { [weak self] in
            do {
                let page = try await service.payeePage(key.query, offset: 0, limit: key.pageSize)
                guard let self, self.tableKey == key || !self.visible else { return }
                self.generation += 1
                self.rows = page.items
                self.total = page.total
                self.offset = page.items.count
                self.error = nil
                self.loadMoreFailed = false
                self.loadedKey = key
                self.fetchedAt = self.now()
                if let editing = self.editing, !page.items.contains(where: { $0.id == editing.id }) {
                    self.editing = nil
                }
            } catch is CancellationError {
                return
            } catch {
                guard let self, self.tableKey == key || !self.visible else { return }
                self.error = APIError.wrapping(error)
                self.fetchedAt = nil
            }
        }
        inFlight = (key, task)
        await task.value
        if inFlight?.task == task { inFlight = nil }
    }

    /// The error state's Retry: `refetch()`.
    public func retry() async {
        await load(force: true)
    }

    /// Another screen changed the payees.
    public func invalidate() {
        fetchedAt = nil
    }

    /// Infinite scroll: the next page, appended without repeats. A failure shows the
    /// load-more alert, whose Retry asks for the same offset.
    public func loadMore() async {
        guard rows != nil, hasMore, !isFetchingMore, let key = loadedKey else { return }
        isFetchingMore = true
        loadMoreFailed = false
        let generation = generation
        defer { isFetchingMore = false }
        do {
            let page = try await service.payeePage(key.query, offset: offset, limit: key.pageSize)
            guard self.generation == generation else { return }
            let existing = Set((rows ?? []).map(\.id))
            let added = page.items.filter { !existing.contains($0.id) }
            let current = rows ?? []
            rows = current + added
            offset += page.items.count
            total = page.total
        } catch {
            if self.generation == generation { loadMoreFailed = true }
        }
    }

    /// A drawn row near the end asks for the next page.
    public func rowAppeared(_ id: Int) async {
        let shown = shownRows
        guard let index = shown.firstIndex(where: { $0.id == id }) else { return }
        let threshold = ServerTablePaging.loadMoreThreshold(pageSize: pageSize)
        guard
            ServerTablePaging.shouldLoadMore(
                rowIndex: index, shownCount: shown.count, threshold: threshold, hasMore: hasMore),
            !loadMoreFailed
        else { return }
        await loadMore()
    }

    // MARK: Rows

    /// The name link.
    public func openTransactions(_ payee: OpenAPI.Recipient) {
        guard visible else { return }
        shell?.navigate(to: RecipientsRoutes.transactionsLink(payee))
    }

    /// The default category badge's text.
    public func categoryText(_ payee: OpenAPI.Recipient) -> String {
        PayeeColumns.categoryLabel(payee.defaultCategoryName) ?? strings.t("recipientsPage.none")
    }

    /// Double-click or the row menu's Edit: inline edit of that row.
    public func startEditing(_ payee: OpenAPI.Recipient) {
        editing = PayeeRowEdit(id: payee.id, name: payee.name, notes: payee.notes ?? "")
    }

    /// Cancel (✗) or Escape.
    public func cancelEditing() {
        editing = nil
    }

    /// Save (✓) or Return: `PATCH /api/recipients/:id` with `{ name, notes, is_active }`.
    public func saveEditing() async {
        guard let edit = editing, let payee = rows?.first(where: { $0.id == edit.id }) else { return }
        editing = nil
        await update(payee.id, PayeePatch(name: edit.name, notes: edit.notes, isActive: payee.isActive))
    }

    /// The inline category combobox: edit mode ends, then the default category is set at
    /// once (`null` for none).
    public func setDefaultCategory(_ payee: OpenAPI.Recipient, to categoryId: Int?) async {
        editing = nil
        await update(payee.id, PayeePatch(defaultCategoryId: .some(categoryId)))
    }

    private func update(_ id: Int, _ patch: PayeePatch) async {
        isUpdating = true
        defer { isUpdating = false }
        do {
            try await service.updatePayee(id: id, patch: patch)
        } catch {
            post(.error, "recipients.updateFailedTitle", detail: errorText(error))
            return
        }
        post(.success, "recipients.updated")
        await refreshAfterWrite(touchesTransactions: false)
    }

    /// The row menu's Mark inactive / Mark active: the PATCH at once, then the Undo toast.
    public func toggleStatus(_ payee: OpenAPI.Recipient) async {
        guard !isTogglingStatus else { return }
        let nextActive = !payee.isActive
        isTogglingStatus = true
        defer { isTogglingStatus = false }
        do {
            try await service.updatePayee(id: payee.id, patch: PayeePatch(isActive: nextActive))
        } catch {
            post(.error, "recipientsPage.toggleFailed")
            return
        }
        let notice = notices.make(
            .success, nextActive ? "recipientsPage.toast.active" : "recipientsPage.toast.inactive", ["name": payee.name]
        )
        self.notice = notice
        pendingAction = (notice.id, .undoStatus(payee, restore: !nextActive))
        notices.offerAction(for: notice, titleKey: "common.undo", lifetime: 8, isUndo: true) { [weak self] in
            await self?.restoreStatus(id: payee.id, active: !nextActive)
        }
        await refreshAfterWrite(touchesTransactions: false)
    }

    /// The row menu's Unmerge (aliases only).
    public func unmerge(_ payee: OpenAPI.Recipient) async {
        guard payee.primaryRecipientId != nil, !isUnmerging else { return }
        isUnmerging = true
        defer { isUnmerging = false }
        do {
            try await service.unmergePayee(id: payee.id)
        } catch {
            post(.error, "recipients.unmergeFailedTitle", detail: errorText(error))
            return
        }
        post(.success, "recipients.unmerged")
        await refreshAfterWrite(touchesTransactions: true)
    }

    // MARK: Delete payee

    /// The row menu's Delete.
    public func requestDelete(_ payee: OpenAPI.Recipient) {
        pendingDelete = payee
    }

    public func cancelDelete() {
        pendingDelete = nil
    }

    /// The alert's title, message and confirm label.
    public func deleteText() -> (title: String, message: String, action: String)? {
        guard let payee = pendingDelete else { return nil }
        return (
            strings.t("recipientsPage.delete.title"),
            strings.t("recipientsPage.delete.desc", ["name": payee.name]),
            strings.t("recipientsPage.delete.confirm")
        )
    }

    /// Delete: `DELETE /api/recipients/:id`.
    public func confirmDelete() async {
        guard let payee = pendingDelete, !isDeleting else { return }
        pendingDelete = nil
        isDeleting = true
        defer { isDeleting = false }
        do {
            try await service.deletePayee(id: payee.id)
        } catch {
            post(.error, "recipients.deleteFailedTitle", detail: errorText(error))
            return
        }
        post(.success, "recipients.deleted")
        await refreshAfterWrite(touchesTransactions: false)
    }

    // MARK: Add payee

    /// The header's Add payee.
    public func openAdd() {
        add = PayeeAddDraft()
    }

    public func closeAdd() {
        add = nil
    }

    /// Add payee (button or Return): a blank name shows `form.nameRequired` and takes focus.
    public func submitAdd() async {
        guard var draft = add, !draft.isSaving else { return }
        draft.submitted = true
        add = draft
        let name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else {
            addFocusRequest += 1
            return
        }
        let notes = draft.notes.trimmingCharacters(in: .whitespacesAndNewlines)
        add?.isSaving = true
        let created: Bool
        do {
            created = try await service.createPayee(name: name, notes: notes.isEmpty ? nil : notes)
        } catch {
            add?.isSaving = false
            post(.error, "recipients.createFailedTitle", detail: errorText(error))
            return
        }
        if created {
            post(.success, "recipients.created")
        } else {
            post(.info, "recipients.exists")
        }
        add = nil
        await refreshAfterWrite(touchesTransactions: false)
    }

    // MARK: Match rules

    /// The row menu's Match rules.
    public func openRules(_ payee: OpenAPI.Recipient) async {
        let state = MatchRulesState(recipientId: payee.id, recipientName: payee.name)
        rules = state
        await reloadRules()
    }

    public func closeRules() {
        rules = nil
    }

    /// `useRecipientPatterns`: the dialog's list (a failed load shows the empty state).
    func reloadRules() async {
        guard let state = rules else { return }
        let loaded = (try? await service.matchRules(recipientId: state.recipientId)) ?? []
        guard isCurrent(state) else { return }
        rules?.patterns = loaded
    }

    /// Add pattern: an empty form.
    public func startNewRule() {
        rules?.startNew()
    }

    /// The rule menu's Edit: loads the rule into the form, or closes the form when that rule
    /// is already being edited.
    public func editRule(_ rule: OpenAPI.RecipientPattern) {
        if rules?.editingId == rule.id {
            rules?.resetForm()
        } else {
            rules?.startEdit(rule)
        }
    }

    /// The form's Cancel.
    public func cancelRuleForm() {
        rules?.resetForm()
    }

    /// Preview: the match count for the trimmed pattern; an answer for a superseded draft is
    /// dropped.
    public func previewRule() async {
        guard let state = rules, let form = state.form, !state.isPreviewing else { return }
        let pattern = form.pattern.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !pattern.isEmpty else { return }
        let version = state.previewVersion
        rules?.isPreviewing = true
        do {
            let count = try await service.previewMatchRule(
                recipientId: state.recipientId, pattern: pattern, kind: form.kind, caseSensitive: form.caseSensitive)
            guard isCurrent(state, version: version) else { return }
            rules?.previewCount = count
        } catch {
            guard isCurrent(state, version: version) else { return }
            post(.error, "recipientPatterns.toast.error")
        }
        if isCurrent(state, version: version) { rules?.isPreviewing = false }
    }

    /// The dialog is still the one `state` came from and, with `version`, has the same draft.
    private func isCurrent(_ state: MatchRulesState, version: Int? = nil) -> Bool {
        guard let rules, rules.session == state.session else { return false }
        return version.map { rules.previewVersion == $0 } ?? true
    }

    /// Save (button or Return): create, or update the rule being edited.
    public func saveRule() async {
        guard let state = rules, let form = state.form, !state.isSaving, let body = form.body else { return }
        rules?.isSaving = true
        do {
            if let editingId = state.editingId {
                try await service.updateMatchRule(
                    recipientId: state.recipientId, patternId: editingId, patch: MatchRulePatch(body))
                post(.success, "recipientPatterns.toast.updated")
            } else {
                try await service.createMatchRule(recipientId: state.recipientId, body: body)
                post(.success, "recipientPatterns.toast.created")
            }
        } catch {
            if isCurrent(state) { rules?.isSaving = false }
            post(.error, "recipientPatterns.toast.error")
            return
        }
        guard isCurrent(state) else { return }
        rules?.isSaving = false
        rules?.resetForm()
        await reloadRules()
    }

    /// A rule's Active switch: `{ is_active }`; like any update it closes the form.
    public func toggleRule(_ rule: OpenAPI.RecipientPattern) async {
        guard let state = rules, !state.isSaving else { return }
        rules?.isSaving = true
        do {
            try await service.updateMatchRule(
                recipientId: state.recipientId, patternId: rule.id, patch: .active(!rule.isActive))
        } catch {
            if isCurrent(state) { rules?.isSaving = false }
            post(.error, "recipientPatterns.toast.error")
            return
        }
        post(.success, "recipientPatterns.toast.updated")
        guard isCurrent(state) else { return }
        rules?.isSaving = false
        rules?.resetForm()
        await reloadRules()
    }

    /// The rule menu's Delete: the Delete pattern alert.
    public func requestRuleDelete(_ rule: OpenAPI.RecipientPattern) {
        rules?.pendingDelete = rule
    }

    public func cancelRuleDelete() {
        rules?.pendingDelete = nil
    }

    /// Delete: `DELETE /api/recipients/:id/patterns/:patternId`.
    public func confirmRuleDelete() async {
        guard let state = rules, let rule = state.pendingDelete else { return }
        rules?.pendingDelete = nil
        rules?.isDeleting = true
        do {
            try await service.deleteMatchRule(recipientId: state.recipientId, patternId: rule.id)
        } catch {
            if isCurrent(state) { rules?.isDeleting = false }
            post(.error, "recipientPatterns.toast.error")
            return
        }
        post(.success, "recipientPatterns.toast.deleted")
        guard isCurrent(state) else { return }
        rules?.isDeleting = false
        await reloadRules()
    }

    // MARK: Merge payees

    /// The header menu's Merge payees.
    public func openMerge() async {
        merge.isOpen = true
        await merge.loadList()
    }

    /// A merge went through: the merged toast, and the rule suggestion's Create rule.
    func merged(_ result: PayeeMergeResult) async {
        let variables = ["n": String(result.mergedIds.count), "name": result.primary.name]
        if let suggestion = result.suggestion, let kind = MatchRuleKind(rawValue: suggestion.kind) {
            let notice = notices.make(
                .success, "recipients.merged", variables,
                detail: strings.t(
                    "recipients.createRuleSuggestion",
                    ["pattern": suggestion.pattern, "n": String(suggestion.matchCount)]))
            self.notice = notice
            pendingAction = (
                notice.id, .createRule(primaryId: result.primary.id, pattern: suggestion.pattern, kind: kind)
            )
        } else {
            post(.success, "recipients.merged", variables)
        }
        await refreshAfterWrite(touchesTransactions: true)
    }

    func mergeFailed(_ error: any Error) {
        post(.error, "recipients.mergeFailedTitle", detail: errorText(error))
    }

    // MARK: Toasts

    /// The toast's action: Undo (also ⌘Z) or Create rule.
    public func performPendingAction() async {
        guard let pending = pendingAction else { return }
        pendingAction = nil
        if notice?.id == pending.noticeID { notice = nil }
        switch pending.action {
        case .undoStatus(let payee, let restore):
            await restoreStatus(id: payee.id, active: restore)
        case .createRule(let primaryId, let pattern, let kind):
            do {
                try await service.createMatchRule(
                    recipientId: primaryId,
                    body: MatchRuleBody(pattern: pattern, kind: kind, caseSensitive: false, priority: nil, notes: nil))
                post(.success, "recipientPatterns.toast.created")
            } catch {
                post(.error, "recipientPatterns.toast.error")
            }
        }
    }

    private func restoreStatus(id: Int, active: Bool) async {
        isTogglingStatus = true
        defer { isTogglingStatus = false }
        do {
            try await service.updatePayee(id: id, patch: PayeePatch(isActive: active))
        } catch {
            post(.error, "recipientsPage.toggleFailed")
            return
        }
        await refreshAfterWrite(touchesTransactions: false)
    }

    public func attachNotices(_ center: NativeNoticeCenter) {
        notices.attach(center) { [weak self] in self?.clearNotice($0) }
    }

    /// The label of the toast's action.
    public func actionTitle(for notice: ScreenNotice) -> String? {
        guard let pendingAction, pendingAction.noticeID == notice.id else { return nil }
        switch pendingAction.action {
        case .undoStatus: return strings.t("common.undo")
        case .createRule: return strings.t("recipients.createRule")
        }
    }

    /// ⌘Z answers only an Undo.
    public var actionIsUndo: Bool {
        guard let pendingAction, pendingAction.noticeID == notice?.id else { return false }
        if case .undoStatus = pendingAction.action { return true }
        return false
    }

    /// The Undo toast lives as long as its Undo; the rule suggestion 10 s.
    public func duration(of notice: ScreenNotice) -> Duration {
        guard let pendingAction, pendingAction.noticeID == notice.id else { return Self.noticeDuration }
        switch pendingAction.action {
        case .undoStatus: return Self.undoDuration
        case .createRule: return Self.suggestionDuration
        }
    }

    /// The toast was dismissed or timed out; its action goes with it.
    public func clearNotice(_ id: Int) {
        if notice?.id == id { notice = nil }
        if pendingAction?.noticeID == id { pendingAction = nil }
    }

    // MARK: After a write

    /// `invalidateQueries(recipientKeys.all)` (and the transactions after a merge or an
    /// unmerge): the first page again, and the native caches of payees refetch.
    func refreshAfterWrite(touchesTransactions: Bool) async {
        invalidate()
        merge.invalidate()
        shell?.transactions.pickers.reset()
        if touchesTransactions {
            shell?.transactions.invalidate()
            shell?.planned.invalidate()
        }
        await load(force: true)
    }

    func post(_ kind: ScreenNotice.Kind, _ key: String, _ variables: [String: String] = [:], detail: String? = nil) {
        notice = notices.make(kind, key, variables, detail: detail)
    }

    func errorText(_ error: any Error) -> String {
        APIErrorMessage.text(APIError.wrapping(error), strings: strings)
    }
}

/// The first page's inputs.
public struct PayeeTableKey: Equatable, Sendable {
    public let query: PayeePageQuery
    public let pageSize: Int
}
